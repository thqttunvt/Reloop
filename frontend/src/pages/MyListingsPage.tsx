import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Listing } from '../lib/api';
import { CATEGORY_LABEL, CONDITION_LABEL, LISTING_STATUS_LABEL, statusTone } from '../lib/catalog';
import { dateTime, errorText } from '../lib/format';

export function MyListingsPage() {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: Listing[] }>('GET', '/listings/mine')
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <section className="card">
      <div className="row between">
        <h2>Tin của tôi</h2>
        <Link to="/listings/new" className="button">
          + Đăng tin
        </Link>
      </div>
      {error && <p className="error">{error}</p>}
      {items === null ? (
        <p className="muted">Đang tải…</p>
      ) : items.length === 0 ? (
        <p className="muted">Bạn chưa đăng tin nào. Đăng thiết bị cũ, hỏng để nhận báo giá từ các đơn vị thu mua gần bạn.</p>
      ) : (
        <ul className="plain list">
          {items.map((l) => (
            <li key={l.listingId}>
              <Link to={`/listings/${l.listingId}`} className="list-item">
                <div>
                  <strong>{l.title}</strong>
                  <div className="muted">
                    {CATEGORY_LABEL[l.category]} · {CONDITION_LABEL[l.condition]} · đăng {dateTime(l.createdAt)}
                  </div>
                </div>
                <div className="row">
                  <span className="badge">{l.quoteCount} báo giá</span>
                  <span className={`badge ${statusTone(l.status)}`}>{LISTING_STATUS_LABEL[l.status]}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
