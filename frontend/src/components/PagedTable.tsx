import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { errorText } from '../lib/format';

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Danh sách phân trang dùng chung cho mọi trang Admin mới (get.md mục 1) — không trang nào tự viết phân trang.
 * fetchPage đổi (do bộ lọc đổi) → tải lại từ đầu.
 */
export function usePagedList<T>(fetchPage: (cursor?: string) => Promise<Page<T>>) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (from?: string) => {
      setLoading(true);
      try {
        const page = await fetchPage(from);
        setItems((old) => (from ? [...old, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError('');
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return { items, loading, error, hasMore: !!cursor, loadMore: () => void load(cursor), reload: () => void load() };
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

export function PagedTable<T>({
  list,
  columns,
  rowKey,
  empty = 'Không có dữ liệu.',
}: {
  list: ReturnType<typeof usePagedList<T>>;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  return (
    <div className="stack">
      {list.error && <p className="error">{list.error}</p>}
      {list.items.length === 0 && !list.loading ? (
        <p className="muted">{empty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.header} className={c.className}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.items.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td key={c.header} className={c.className}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list.loading && <p className="muted">Đang tải…</p>}
      {list.hasMore && !list.loading && (
        <button className="secondary" onClick={list.loadMore}>
          Tải thêm
        </button>
      )}
    </div>
  );
}
