/**
 * Cổng lưu trữ single-table, cố ý chỉ dùng những gì DynamoDB làm được:
 *  - get / query theo partition key (+ tiền tố sort key), hoặc theo GSI1
 *  - transact: tối đa 100 thao tác, nguyên tử, mỗi thao tác có thể kèm điều kiện
 * Điều kiện ánh xạ 1-1 sang ConditionExpression:
 *  - notExists       → attribute_not_exists(pk)
 *  - versionEquals   → #version = :v   (optimistic locking)
 *  - versionMissing  → item đã có nhưng chưa có version (bản ghi do hệ thống khác tạo, vd Lambda Cognito)
 */
export interface Item {
  pk: string;
  sk: string;
  version?: number;
  gsi1pk?: string;
  gsi1sk?: string;
  [key: string]: unknown;
}

export type Condition = { kind: 'notExists' } | { kind: 'versionEquals'; version: number } | { kind: 'versionMissing' };

export type WriteOp =
  | { type: 'put'; item: Item; condition?: Condition }
  | { type: 'delete'; pk: string; sk: string; condition?: Condition };

export interface QueryOptions {
  index?: 'gsi1';
  skPrefix?: string;
  limit?: number;
  /** false = sort key giảm dần (mới nhất trước) */
  ascending?: boolean;
}

export interface Table {
  get<T extends Item>(pk: string, sk: string): Promise<T | undefined>;
  query<T extends Item>(pk: string, options?: QueryOptions): Promise<T[]>;
  /** Nguyên tử: hoặc tất cả thành công, hoặc ném ConditionFailedError và không ghi gì. */
  transact(ops: WriteOp[]): Promise<void>;
}

export class ConditionFailedError extends Error {
  constructor(readonly failedKeys: string[]) {
    super(`Điều kiện ghi thất bại: ${failedKeys.join(', ')}`);
    this.name = 'ConditionFailedError';
  }
}

export const MAX_TRANSACT_OPS = 100;

/**
 * Ghi đè item có khóa lạc quan. expectedVersion = 0 nghĩa là item chưa tồn tại.
 * Item ghi ra luôn có version = expectedVersion + 1.
 */
export const putVersioned = (item: Item, expectedVersion: number): WriteOp => ({
  type: 'put',
  item: { ...item, version: expectedVersion + 1 },
  condition: expectedVersion === 0 ? { kind: 'notExists' } : { kind: 'versionEquals', version: expectedVersion },
});

export const putNew = (item: Item): WriteOp => ({ type: 'put', item, condition: { kind: 'notExists' } });
