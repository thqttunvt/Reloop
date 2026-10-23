import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type AdminListingView } from '../../lib/api';
import { CATEGORY_LABEL, CONDITION_LABEL, HANDOVER_LABEL, LISTING_STATUS_LABEL, PARTNER_STATUS_LABEL, QUOTE_STATUS_LABEL, statusTone } from '../../lib/catalog';
import { dateTime, errorText, vnd } from '../../lib/format';
import { AdminChatsCard } from '../TransactionDetailPage';

/** Link tin dùng trong trang Admin: luôn mở trang xem của Admin (mọi trạng thái), không phải trang người mua. */
export const adminListingLink = (link: string) => (link.startsWith('/listings/') ? `/admin${link}` : link);

/**
 * Admin xem 1 tin ở mọi trạng thái (mục 24 danhgia): tin đã hủy / hết hạn / chờ duyệt / của người bị tạm ngừng.
 * Chỉ đọc — gỡ tin vẫn qua luồng phản ánh; mỗi lần mở được ghi nhật ký (có vị trí chính xác).
 */
export function AdminListingPage() {
  const { id = '' } = useParams();
  const [d, setD] = useState<AdminListingView>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<AdminListingView>('GET', `/admin/listings/${encodeURIComponent(id)}`)
      .then((x) => (setD(x), setError('')))
      .catch((e) => setError(errorText(e)));
  }, [id]);

  if (!d) return <p className={error ? 'error' : 'muted'}>{error || 'Đang tải…'}</p>;
  const l = d.listing;
  return (
    <div className="stack">
      <section className="card">
        <div className="row between">
          <h2>{l.title}</h2>
          <span className={`badge ${statusTone(l.status)}`}>{LISTING_STATUS_LABEL[l.status] ?? l.status}</span>
        </div>
        <p className="muted">
          Người bán: <Link to={`/admin/users/${encodeURIComponent(l.ownerId)}`}>{d.seller.displayName}</Link>
          {d.seller.partnerStatus && (
            <>
              {' '}
              <span className={`badge ${statusTone(d.seller.partnerStatus)}`}>{PARTNER_STATUS_LABEL[d.seller.partnerStatus]}</span>
            </>
          )}
          {d.seller.contact?.email && ` · ${d.seller.contact.email}`}
          {d.seller.contact?.phone && ` · ${d.seller.contact.phone}`}
        </p>
        <p>
          {CATEGORY_LABEL[l.category] ?? l.category} · {CONDITION_LABEL[l.condition] ?? l.condition}
          {l.brand && ` · ${l.brand}`}
          {l.model && ` ${l.model}`} · {l.unit === 'PER_KG' ? `${l.weightKg ?? '?'} kg` : `${l.quantity} cái`} ·{' '}
          {l.handoverMethods.map((m) => HANDOVER_LABEL[m] ?? m).join(', ')}
        </p>
        <p>{l.description}</p>
        <p className="muted">
          Khu vực {l.area}
          {l.location?.address && ` · địa chỉ ${l.location.address}`} · đăng {dateTime(l.createdAt)} · hết hạn {dateTime(l.expiresAt)}
        </p>
        {l.moderated && <div className="notice bad">Admin đã gỡ tin {dateTime(l.moderated.at)}{l.moderated.note && `: ${l.moderated.note}`}</div>}
        {l.review && (
          <div className="notice warn">
            Ảnh bị gắn cờ ({l.review.reason === 'IMAGE_SENSITIVE_SUSPECTED' ? 'nghi nhạy cảm' : 'chữ bất thường'}) lúc {dateTime(l.review.at)}
            {l.review.decision
              ? ` — ${l.review.decision.approved ? 'đã duyệt' : 'đã từ chối'} ${dateTime(l.review.decision.at)}${l.review.decision.note ? `: ${l.review.decision.note}` : ''}`
              : ' — đang chờ duyệt'}
          </div>
        )}
        {l.lastEndedDeal && (
          <p className="muted small">
            Giao dịch gần nhất {l.lastEndedDeal.status === 'CANCELLED' ? 'bị hủy' : 'thất bại'} {dateTime(l.lastEndedDeal.at)} ·{' '}
            <Link to={`/transactions/${l.lastEndedDeal.transactionId}`}>xem giao dịch</Link>
          </p>
        )}
        {l.activeTransactionId && (
          <p>
            <Link to={`/transactions/${l.activeTransactionId}`}>Giao dịch đang chạy →</Link>
          </p>
        )}
        {d.images.length > 0 && (
          <div className="gallery">
            {d.images.map((src) => (
              <a key={src} href={src} target="_blank" rel="noreferrer">
                <img src={src} alt="" />
              </a>
            ))}
          </div>
        )}
      </section>

      {(d.matches.length > 0 || d.quotes.length > 0) && (
        <section className="card">
          <h3>Đơn vị thu mua được ghép ({d.matches.length}) · báo giá ({d.quotes.length})</h3>
          <ul className="plain">
            {d.quotes.map((q) => (
              <li key={q.quoteId}>
                <span className={`badge ${statusTone(q.status)}`}>{QUOTE_STATUS_LABEL[q.status] ?? q.status}</span> {q.partnerName} · {q.branchName}
                {q.offer && ` · ${vnd(q.offer.price)}`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <AdminChatsCard listingId={l.listingId} />
    </div>
  );
}
