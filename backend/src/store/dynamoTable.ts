import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ConditionFailedError, MAX_TRANSACT_OPS, type Condition, type Item, type QueryOptions, type Table, type WriteOp } from './table';

/** Chỉ cần hàm send() — test truyền client giả. */
export type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
type Raw = Record<string, unknown>;

/**
 * Bảng reloop-core-table (dựng sẵn trên AWS) dùng khóa viết hoa PK / SK, GSI "GSI1" với GSI1PK / GSI1SK.
 * Nghiệp vụ vẫn dùng pk / sk / gsi1pk / gsi1sk như MemoryTable; DynamoTable đổi tên khi đọc và ghi.
 */
export const GSI1_NAME = 'GSI1';
const TO_DB: Record<string, string> = { pk: 'PK', sk: 'SK', gsi1pk: 'GSI1PK', gsi1sk: 'GSI1SK' };
const FROM_DB: Record<string, string> = Object.fromEntries(Object.entries(TO_DB).map(([a, b]) => [b, a]));

const rename = (obj: Raw, map: Record<string, string>): Raw =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [map[k] ?? k, v]));
const toDb = (item: Item): Raw => rename(item, TO_DB);
const fromDb = <T extends Item>(raw: Raw): T => rename(raw, FROM_DB) as T;

const keyLabel = (pk: string, sk: string) => `${pk} | ${sk}`;

const conditionExpr = (condition: Condition | undefined) => {
  if (!condition) return {};
  if (condition.kind === 'notExists') return { ConditionExpression: 'attribute_not_exists(PK)' };
  if (condition.kind === 'versionMissing') {
    return {
      ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#version)',
      ExpressionAttributeNames: { '#version': 'version' },
    };
  }
  return {
    ConditionExpression: '#version = :expectedVersion',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':expectedVersion': condition.version },
  };
};

/**
 * Bản thật của Table trên DynamoDB.
 * - get luôn ConsistentRead: số dư, bút toán, khóa idempotency phải đọc bản mới nhất (TL-02).
 * - query trên bảng chính cũng ConsistentRead; GSI chỉ đọc eventually consistent (giới hạn DynamoDB).
 * - transact → TransactWriteItems; điều kiện sai hoặc xung đột giao dịch → ConditionFailedError
 *   để withOptimisticRetry đọc lại và thử lại, giống MemoryTable.
 */
export class DynamoTable implements Table {
  constructor(
    private readonly tableName: string,
    private readonly client: DocumentClient = DynamoTable.defaultClient(),
  ) {
    if (!tableName) throw new Error('DynamoTable cần tên bảng (TABLE_NAME)');
  }

  static defaultClient(): DynamoDBDocumentClient {
    return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async get<T extends Item>(pk: string, sk: string): Promise<T | undefined> {
    const res = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: pk, SK: sk }, ConsistentRead: true }),
    );
    return res.Item ? fromDb<T>(res.Item) : undefined;
  }

  async query<T extends Item>(pk: string, options: QueryOptions = {}): Promise<T[]> {
    const { index, skPrefix = '', skRange, limit, ascending = true } = options;
    const onGsi = index === 'gsi1';
    const pkField = onGsi ? 'GSI1PK' : 'PK';
    const skField = onGsi ? 'GSI1SK' : 'SK';

    // Điều kiện sort key: tiền tố, hoặc khoảng [from, to] (BETWEEN / >= / <=)
    let skCondition = '';
    const values: Record<string, unknown> = { ':pk': pk };
    if (skPrefix) {
      skCondition = 'begins_with(#sk, :skPrefix)';
      values[':skPrefix'] = skPrefix;
    } else if (skRange?.from && skRange.to) {
      skCondition = '#sk BETWEEN :skFrom AND :skTo';
      Object.assign(values, { ':skFrom': skRange.from, ':skTo': skRange.to });
    } else if (skRange?.from) {
      skCondition = '#sk >= :skFrom';
      values[':skFrom'] = skRange.from;
    } else if (skRange?.to) {
      skCondition = '#sk <= :skTo';
      values[':skTo'] = skRange.to;
    }

    const input: QueryCommandInput = {
      TableName: this.tableName,
      IndexName: onGsi ? GSI1_NAME : undefined,
      ConsistentRead: onGsi ? undefined : true,
      KeyConditionExpression: skCondition ? `#pk = :pk AND ${skCondition}` : '#pk = :pk',
      ExpressionAttributeNames: skCondition ? { '#pk': pkField, '#sk': skField } : { '#pk': pkField },
      ExpressionAttributeValues: values,
      ScanIndexForward: ascending,
    };

    // DynamoDB trả tối đa 1 MB mỗi trang → đọc tiếp tới khi đủ limit hoặc hết dữ liệu.
    const items: T[] = [];
    let startKey: Raw | undefined;
    do {
      const res = await this.client.send(
        new QueryCommand({ ...input, ExclusiveStartKey: startKey, Limit: limit ? limit - items.length : undefined }),
      );
      items.push(...(res.Items ?? []).map((raw) => fromDb<T>(raw)));
      startKey = res.LastEvaluatedKey;
    } while (startKey && (!limit || items.length < limit));
    return items;
  }

  async transact(ops: WriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    if (ops.length > MAX_TRANSACT_OPS) throw new Error(`transact tối đa ${MAX_TRANSACT_OPS} thao tác`);

    const labels = ops.map((op) => (op.type === 'put' ? keyLabel(op.item.pk, op.item.sk) : keyLabel(op.pk, op.sk)));
    if (new Set(labels).size !== labels.length) throw new Error('transact không được ghi 2 lần vào cùng một item');

    const transactItems: TransactItem[] = ops.map((op) =>
      op.type === 'put'
        ? { Put: { TableName: this.tableName, Item: toDb(op.item), ...conditionExpr(op.condition) } }
        : { Delete: { TableName: this.tableName, Key: { PK: op.pk, SK: op.sk }, ...conditionExpr(op.condition) } },
    );

    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (err) {
      if (!(err instanceof TransactionCanceledException) && (err as { name?: string })?.name !== 'TransactionCanceledException') {
        throw err;
      }
      const reasons = (err as TransactionCanceledException).CancellationReasons ?? [];
      const retryable = new Set(['ConditionalCheckFailed', 'TransactionConflict']);
      // Lý do khác (ValidationError, ThrottlingError...) không phải tranh chấp ghi → ném nguyên lỗi.
      if (!reasons.some((r) => r.Code && retryable.has(r.Code))) throw err;
      if (reasons.some((r) => r.Code && r.Code !== 'None' && !retryable.has(r.Code))) throw err;
      const failed = reasons.flatMap((r, i) => (r.Code && retryable.has(r.Code) ? [labels[i]!] : []));
      throw new ConditionFailedError(failed);
    }
  }
}
