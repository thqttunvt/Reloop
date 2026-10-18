import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConditionFailedError, MAX_TRANSACT_OPS, type Item, type QueryOptions, type Table, type WriteOp } from './table';

const keyOf = (pk: string, sk: string) => `${pk}\u0000${sk}`;

/**
 * Bản giả lập DynamoDB chạy trong bộ nhớ, dùng cho dev local và test.
 * transact() không có await bên trong nên nguyên tử trong event loop của Node.
 * Truyền filePath để lưu ra JSON (dữ liệu còn sau khi tắt server dev).
 */
export class MemoryTable implements Table {
  private readonly items = new Map<string, Item>();

  constructor(private readonly filePath?: string) {
    if (filePath && existsSync(filePath)) {
      const saved = JSON.parse(readFileSync(filePath, 'utf8')) as Item[];
      for (const item of saved) this.items.set(keyOf(item.pk, item.sk), item);
    }
  }

  async get<T extends Item>(pk: string, sk: string): Promise<T | undefined> {
    const item = this.items.get(keyOf(pk, sk));
    return item ? (structuredClone(item) as T) : undefined;
  }

  async query<T extends Item>(pk: string, options: QueryOptions = {}): Promise<T[]> {
    const { index, skPrefix = '', limit, ascending = true } = options;
    const pkField = index === 'gsi1' ? 'gsi1pk' : 'pk';
    const skField = index === 'gsi1' ? 'gsi1sk' : 'sk';
    const matched = [...this.items.values()]
      .filter((it) => it[pkField] === pk && String(it[skField] ?? '').startsWith(skPrefix))
      .sort((a, b) => String(a[skField]).localeCompare(String(b[skField])));
    if (!ascending) matched.reverse();
    return (limit ? matched.slice(0, limit) : matched).map((it) => structuredClone(it) as T);
  }

  async transact(ops: WriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    if (ops.length > MAX_TRANSACT_OPS) throw new Error(`transact tối đa ${MAX_TRANSACT_OPS} thao tác`);

    const keys = ops.map((op) => (op.type === 'put' ? keyOf(op.item.pk, op.item.sk) : keyOf(op.pk, op.sk)));
    if (new Set(keys).size !== keys.length) throw new Error('transact không được ghi 2 lần vào cùng một item');

    const failed: string[] = [];
    ops.forEach((op, i) => {
      if (!op.condition) return;
      const current = this.items.get(keys[i]!);
      const ok =
        op.condition.kind === 'notExists'
          ? !current
          : op.condition.kind === 'versionMissing'
            ? current !== undefined && current.version === undefined
            : current !== undefined && current.version === op.condition.version;
      if (!ok) failed.push(keys[i]!.replace('\u0000', ' | '));
    });
    if (failed.length) throw new ConditionFailedError(failed);

    ops.forEach((op, i) => {
      if (op.type === 'put') this.items.set(keys[i]!, structuredClone(op.item));
      else this.items.delete(keys[i]!);
    });
    this.persist();
  }

  /** Chỉ dùng cho test / job đối soát local. */
  dump(): Item[] {
    return [...this.items.values()].map((it) => structuredClone(it));
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...this.items.values()], null, 1));
  }
}
