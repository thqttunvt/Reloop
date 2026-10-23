import { useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { usePagedList, type Page } from '../components/PagedTable';
import { api, type Listing } from '../lib/api';
import { CATEGORY_LABEL, CONDITION_LABEL, LISTING_STATUS_LABEL, statusTone } from '../lib/catalog';
import { dateTime } from '../lib/format';

export function MyListingsPage() {
  // Phân trang thật: tin cũ không còn bị mất khỏi danh sách
  const fetchPage = useCallback((cursor?: string) => api<Page<Listing>>('GET', `/listings/mine${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`), []);
  const list = usePagedList(fetchPage);
  const items = list.items.length === 0 && list.loading ? null : list.items;
  const error = list.error;
  // Trang này dùng ở 3 nơi — nút Đăng tin giữ người dùng trong khu đang đứng (mục 31 danhgia)
  const { pathname } = useLocation();
  const newPath = pathname.startsWith('/partner') ? '/partner/new' : pathname.startsWith('/admin') ? '/admin/posts/new' : '/listings/new';

  return (
    <section className="card">
      <div className="row between">
        <h2>Tin của tôi</h2>
        <Link to={newPath} className="button">
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
      {list.hasMore && !list.loading && (
        <button className="secondary" onClick={list.loadMore}>
          Tải thêm
        </button>
      )}
    </section>
  );
}
