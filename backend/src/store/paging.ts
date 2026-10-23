import { badRequest } from '../shared/errors';
import type { Item, Table } from './table';

/**
 * Phân trang dùng chung cho mọi danh sách mới (trang Admin), mới nhất trước.
 * Table.query không trả LastEvaluatedKey và skRange gồm cả 2 đầu → cursor nhớ sort key của dòng cuối
 * + khóa chính (pk|sk, luôn duy nhất) của MỌI dòng trang trước có cùng sort key đó, để bỏ đúng những dòng đã trả.
 * Cursor là base64url(JSON) — client chỉ gửi lại nguyên văn.
 */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

interface Cursor {
  sk: string;
  ids: string[];
}

const idOf = (it: Item) => `${it.pk}|${it.sk}`;

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.sk === 'string' && Array.isArray(c.ids) && c.ids.every((x) => typeof x === 'string')) return c;
  } catch {
    // rơi xuống lỗi bên dưới
  }
  throw badRequest('INVALID_CURSOR', 'cursor không hợp lệ');
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

export async function pageQuery<T extends Item>(
  table: Table,
  pk: string,
  /** prefix: chỉ lấy sort key bắt đầu bằng tiền tố (partition có nhiều loại item, vd USER#<id> → 'TX#'). */
  opts: { index?: 'gsi1'; limit?: number; cursor?: string; prefix?: string } = {},
): Promise<Page<T>> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const cursor = decodeCursor(opts.cursor);
  const skOf = (it: Item) => String((opts.index ? it.gsi1sk : it.sk) ?? '');
  const seen = new Set(cursor?.ids);
  const raw = await table.query<T>(pk, {
    index: opts.index,
    ascending: false,
    skRange: opts.prefix ? { from: opts.prefix, to: cursor?.sk ?? `${opts.prefix}\uffff` } : cursor ? { to: cursor.sk } : undefined,
    limit: limit + seen.size + 1,
  });
  const fresh = raw.filter((it) => !(cursor && skOf(it) === cursor.sk && seen.has(idOf(it))));
  const items = fresh.slice(0, limit);
  if (fresh.length <= limit) return { items };
  const lastSk = skOf(items[items.length - 1]!);
  // Dòng cùng sort key ở các trang trước vẫn phải bỏ qua tiếp
  const ids = [...(cursor?.sk === lastSk ? cursor.ids : []), ...items.filter((it) => skOf(it) === lastSk).map(idOf)];
  return { items, nextCursor: encodeCursor({ sk: lastSk, ids }) };
}
