import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { usePagedList, type Page } from '../components/PagedTable';
import { api, type Transaction } from '../lib/api';
import { TX_STATUS_LABEL, statusTone } from '../lib/catalog';
import { dateTime, vnd } from '../lib/format';

export function TransactionsPage({ userId }: { userId: string }) {
  // Phân trang thật: giao dịch cũ không còn bị mất khỏi danh sách
  const fetchPage = useCallback((cursor?: string) => api<Page<Transaction>>('GET', `/transactions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`), []);
  const list = usePagedList(fetchPage);
  const items = list.items.length === 0 && list.loading ? null : list.items;
  const error = list.error;

  return (
    <section className="card">
      <h2>Giao dịch</h2>
      {error && <p className="error">{error}</p>}
      {items === null ? (
        <p className="muted">Đang tải…</p>
      ) : items.length === 0 ? (
        <p className="muted">Chưa có giao dịch. Giao dịch được tạo khi chủ tin chọn một báo giá đã xác nhận.</p>
      ) : (
        <ul className="plain list">
          {items.map((t) => (
            <li key={t.transactionId}>
              <Link to={`/transactions/${t.transactionId}`} className="list-item">
                <div>
                  <strong>{t.listingTitle}</strong>
                  <div className="muted">
                    {t.ownerId === userId ? `Bán cho ${t.partnerName}` : 'Thu mua'} · {vnd(t.finalPrice ?? t.agreedPrice)} · {dateTime(t.createdAt)}
                  </div>
                </div>
                <span className={`badge ${statusTone(t.status)}`}>{TX_STATUS_LABEL[t.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {list.hasMore && !list.loading && (
        <button className="secondary" onClick={list.loadMore}>
          Tải thêm
        </button>
      )}
    </section>
  );
}
