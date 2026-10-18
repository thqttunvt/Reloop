import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Transaction } from '../lib/api';
import { TX_STATUS_LABEL, statusTone } from '../lib/catalog';
import { dateTime, errorText, vnd } from '../lib/format';

export function TransactionsPage({ userId }: { userId: string }) {
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: Transaction[] }>('GET', '/transactions')
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  }, []);

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
    </section>
  );
}
