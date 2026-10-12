import { describe, expect, it } from 'vitest';
import { MemoryTable } from '../src/store/memoryTable';
import { ConditionFailedError, putNew, putVersioned } from '../src/store/table';

describe('MemoryTable (giả lập DynamoDB)', () => {
  it('transact nguyên tử: một điều kiện sai thì không ghi gì', async () => {
    const t = new MemoryTable();
    await t.transact([putNew({ pk: 'A', sk: '1', v: 1 })]);
    await expect(
      t.transact([putNew({ pk: 'B', sk: '1' }), putNew({ pk: 'A', sk: '1', v: 2 })]),
    ).rejects.toBeInstanceOf(ConditionFailedError);
    expect(await t.get('B', '1')).toBeUndefined();
    expect((await t.get<{ pk: string; sk: string; v: number }>('A', '1'))?.v).toBe(1);
  });

  it('optimistic locking: ghi với version cũ bị từ chối', async () => {
    const t = new MemoryTable();
    await t.transact([putVersioned({ pk: 'W', sk: 'B', n: 1 }, 0)]);
    await t.transact([putVersioned({ pk: 'W', sk: 'B', n: 2 }, 1)]);
    await expect(t.transact([putVersioned({ pk: 'W', sk: 'B', n: 3 }, 1)])).rejects.toBeInstanceOf(ConditionFailedError);
  });

  it('query theo tiền tố sort key và GSI1, có thứ tự', async () => {
    const t = new MemoryTable();
    await t.transact([
      putNew({ pk: 'U', sk: 'X#2', gsi1pk: 'S', gsi1sk: '2' }),
      putNew({ pk: 'U', sk: 'X#1', gsi1pk: 'S', gsi1sk: '1' }),
      putNew({ pk: 'U', sk: 'Y#1' }),
    ]);
    expect((await t.query('U', { skPrefix: 'X#' })).map((i) => i.sk)).toEqual(['X#1', 'X#2']);
    expect((await t.query('S', { index: 'gsi1', ascending: false })).map((i) => i.gsi1sk)).toEqual(['2', '1']);
  });
});
