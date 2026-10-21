import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoTable, type DocumentClient } from '../src/store/dynamoTable';
import { MemoryTable } from '../src/store/memoryTable';
import { ConditionFailedError, putNew, putVersioned, type Table } from '../src/store/table';

/** Client giả: ghi lại lệnh đã gửi, trả lời theo hàng đợi. */
function fakeClient(responses: unknown[] = []) {
  const sent: { name: string; input: any }[] = [];
  const client: DocumentClient = {
    send: (async (cmd: { constructor: { name: string }; input: unknown }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    }) as DocumentClient['send'],
  };
  return { client, sent };
}

const cancelled = (codes: string[]) =>
  new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('DynamoTable — ánh xạ sang lệnh DynamoDB', () => {
  it('get dùng ConsistentRead, đổi tên khóa PK/SK/GSI1PK của bảng sang pk/sk/gsi1pk', async () => {
    const { client, sent } = fakeClient([{ Item: { PK: 'A', SK: '1', GSI1PK: 'G', GSI1SK: 'g', v: 1 } }]);
    const item = await new DynamoTable('t', client).get('A', '1');
    expect(item).toEqual({ pk: 'A', sk: '1', gsi1pk: 'G', gsi1sk: 'g', v: 1 });
    expect(sent[0]).toMatchObject({
      name: GetCommand.name,
      input: { TableName: 't', Key: { PK: 'A', SK: '1' }, ConsistentRead: true },
    });
  });

  it('query bảng chính: begins_with, thứ tự, đọc tiếp nhiều trang tới đủ limit', async () => {
    const { client, sent } = fakeClient([
      { Items: [{ PK: 'U', SK: 'X#3' }], LastEvaluatedKey: { PK: 'U', SK: 'X#3' } },
      { Items: [{ PK: 'U', SK: 'X#2' }], LastEvaluatedKey: { PK: 'U', SK: 'X#2' } },
    ]);
    const items = await new DynamoTable('t', client).query('U', { skPrefix: 'X#', ascending: false, limit: 2 });
    expect(items.map((i) => i.sk)).toEqual(['X#3', 'X#2']);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': 'U', ':skPrefix': 'X#' },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: 2,
    });
    expect(sent[1]!.input).toMatchObject({ ExclusiveStartKey: { PK: 'U', SK: 'X#3' }, Limit: 1 });
  });

  it('query GSI1: IndexName, khóa gsi1pk, không ConsistentRead, đọc hết các trang khi không có limit', async () => {
    const { client, sent } = fakeClient([
      { Items: [{ PK: 'a', SK: '1' }], LastEvaluatedKey: { x: 1 } },
      { Items: [{ PK: 'b', SK: '1' }] },
    ]);
    const items = await new DynamoTable('t', client).query('WALLETS', { index: 'gsi1' });
    expect(items).toHaveLength(2);
    expect(sent[0]!.input).toMatchObject({
      IndexName: 'GSI1',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'GSI1PK' },
    });
    expect(sent[0]!.input.ConsistentRead).toBeUndefined();
  });

  it('query khoảng sort key: BETWEEN / >= / <=', async () => {
    const { client, sent } = fakeClient([{ Items: [] }, { Items: [] }, { Items: [] }]);
    const table = new DynamoTable('t', client);
    await table.query('F', { skRange: { from: 'a', to: 'b' }, ascending: false });
    await table.query('F', { skRange: { from: 'a' } });
    await table.query('F', { skRange: { to: 'b' } });
    expect(sent[0]!.input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :skFrom AND :skTo',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': 'F', ':skFrom': 'a', ':skTo': 'b' },
      ScanIndexForward: false,
    });
    expect(sent[1]!.input.KeyConditionExpression).toBe('#pk = :pk AND #sk >= :skFrom');
    expect(sent[2]!.input.KeyConditionExpression).toBe('#pk = :pk AND #sk <= :skTo');
  });

  it('transact: điều kiện notExists / versionEquals / versionMissing và delete', async () => {
    const { client, sent } = fakeClient();
    await new DynamoTable('t', client).transact([
      putNew({ pk: 'A', sk: '1', gsi1pk: 'G', gsi1sk: 'g' }),
      putVersioned({ pk: 'W', sk: 'B', n: 2 }, 3),
      { type: 'delete', pk: 'I', sk: 'k' },
      { type: 'put', item: { pk: 'L', sk: 'P' }, condition: { kind: 'versionMissing' } },
    ]);
    expect(sent[0]!.name).toBe(TransactWriteCommand.name);
    const [put1, put2, del, put3] = sent[0]!.input.TransactItems;
    expect(put1.Put).toMatchObject({
      TableName: 't',
      Item: { PK: 'A', SK: '1', GSI1PK: 'G', GSI1SK: 'g' },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
    expect(put1.Put.Item.pk).toBeUndefined();
    expect(put2.Put).toMatchObject({
      Item: { PK: 'W', SK: 'B', n: 2, version: 4 },
      ConditionExpression: '#version = :expectedVersion',
      ExpressionAttributeValues: { ':expectedVersion': 3 },
    });
    expect(del.Delete).toEqual({ TableName: 't', Key: { PK: 'I', SK: 'k' } });
    expect(put3.Put.ConditionExpression).toBe('attribute_exists(PK) AND attribute_not_exists(#version)');
  });

  it('điều kiện sai hoặc xung đột giao dịch → ConditionFailedError kèm khóa lỗi', async () => {
    const { client } = fakeClient([cancelled(['None', 'ConditionalCheckFailed']), cancelled(['TransactionConflict'])]);
    const t = new DynamoTable('t', client);
    const err = await t.transact([putNew({ pk: 'A', sk: '1' }), putNew({ pk: 'B', sk: '2' })]).catch((e) => e);
    expect(err).toBeInstanceOf(ConditionFailedError);
    expect(err.failedKeys).toEqual(['B | 2']);
    await expect(t.transact([putNew({ pk: 'A', sk: '1' })])).rejects.toBeInstanceOf(ConditionFailedError);
  });

  it('lỗi khác (throttle, validation) được ném nguyên, không bị coi là tranh chấp ghi', async () => {
    const throttled = cancelled(['ThrottlingError']);
    const { client } = fakeClient([throttled, new Error('network down')]);
    const t = new DynamoTable('t', client);
    await expect(t.transact([putNew({ pk: 'A', sk: '1' })])).rejects.toBe(throttled);
    await expect(t.transact([putNew({ pk: 'A', sk: '1' })])).rejects.toThrow('network down');
  });

  it('chặn trước các lỗi DynamoDB sẽ từ chối: ghi trùng item, quá 100 thao tác', async () => {
    const { client, sent } = fakeClient();
    const t = new DynamoTable('t', client);
    await expect(t.transact([putNew({ pk: 'A', sk: '1' }), { type: 'delete', pk: 'A', sk: '1' }])).rejects.toThrow();
    await expect(t.transact(Array.from({ length: 101 }, (_, i) => putNew({ pk: 'A', sk: String(i) })))).rejects.toThrow();
    await t.transact([]);
    expect(sent).toHaveLength(0);
  });
});

/**
 * Cùng một bộ test hành vi cho MemoryTable và DynamoTable thật.
 * Chạy với bảng thật: DYNAMODB_TEST_TABLE=<tên bảng dev> npm test
 * (cần quyền AWS; dữ liệu test ghi dưới tiền tố TEST#<ngẫu nhiên>).
 */
const contract = (name: string, make: () => Table) =>
  describe(`Hợp đồng Table — ${name}`, () => {
    const ns = `TEST#${Math.random().toString(36).slice(2, 10)}#`;

    it('transact nguyên tử + optimistic locking', async () => {
      const t = make();
      await t.transact([putVersioned({ pk: `${ns}W`, sk: 'B', n: 1 }, 0)]);
      await expect(
        t.transact([putNew({ pk: `${ns}X`, sk: '1' }), putVersioned({ pk: `${ns}W`, sk: 'B', n: 9 }, 0)]),
      ).rejects.toBeInstanceOf(ConditionFailedError);
      expect(await t.get(`${ns}X`, '1')).toBeUndefined();
      await t.transact([putVersioned({ pk: `${ns}W`, sk: 'B', n: 2 }, 1)]);
      expect(await t.get(`${ns}W`, 'B')).toMatchObject({ n: 2, version: 2 });
      await t.transact([
        { type: 'delete', pk: `${ns}W`, sk: 'B' },
        { type: 'delete', pk: `${ns}X`, sk: '1' },
      ]);
      expect(await t.get(`${ns}W`, 'B')).toBeUndefined();
    });

    it('versionMissing: chỉ ghi được lên item có sẵn mà chưa có version', async () => {
      const t = make();
      const k = { pk: `${ns}L`, sk: 'P' };
      const legacy = { type: 'put' as const, item: { ...k, n: 1, version: 1 }, condition: { kind: 'versionMissing' as const } };
      await expect(t.transact([legacy])).rejects.toBeInstanceOf(ConditionFailedError);
      await t.transact([{ type: 'put', item: { ...k, n: 0 } }]);
      await t.transact([legacy]);
      await expect(t.transact([legacy])).rejects.toBeInstanceOf(ConditionFailedError);
      await t.transact([{ type: 'delete', ...k }]);
    });

    it('query theo tiền tố sort key, có thứ tự và limit', async () => {
      const t = make();
      const pk = `${ns}U`;
      await t.transact([putNew({ pk, sk: 'X#2' }), putNew({ pk, sk: 'X#1' }), putNew({ pk, sk: 'Y#1' })]);
      expect((await t.query(pk, { skPrefix: 'X#' })).map((i) => i.sk)).toEqual(['X#1', 'X#2']);
      expect((await t.query(pk, { ascending: false, limit: 2 })).map((i) => i.sk)).toEqual(['Y#1', 'X#2']);
      expect((await t.query(pk, { skRange: { from: 'X#2', to: 'Y#1' } })).map((i) => i.sk)).toEqual(['X#2', 'Y#1']); // gồm cả 2 đầu
      expect((await t.query(pk, { skRange: { to: 'X#2' }, ascending: false })).map((i) => i.sk)).toEqual(['X#2', 'X#1']);
      await t.transact(['X#1', 'X#2', 'Y#1'].map((sk) => ({ type: 'delete' as const, pk, sk })));
    });
  });

contract('MemoryTable', () => new MemoryTable());
const realTable = process.env.DYNAMODB_TEST_TABLE;
if (realTable) contract(`DynamoTable (${realTable})`, () => new DynamoTable(realTable));
