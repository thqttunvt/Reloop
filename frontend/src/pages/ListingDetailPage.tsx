import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ContactLine } from '../components/ContactLine';
import { ReportButton } from '../components/ReportButton';
import { api, newIdempotencyKey, type Conversation, type ListingDetail, type Quote, type Reputation, type Transaction } from '../lib/api';
import {
  CATEGORY_LABEL,
  CONDITION_LABEL,
  HANDOVER_LABEL,
  LISTING_STATUS_LABEL,
  PARTNER_TIER_LABEL,
  QUOTE_STATUS_LABEL,
  UNIT_LABEL,
  statusTone,
} from '../lib/catalog';
import { dateTime, errorText, km, vnd } from '../lib/format';

/** Gỡ tin trong 72 giờ sau khi giao dịch bị hủy / thất bại → tính phí nghi bán ngoài (QĐ-39): cảnh báo trước. */
const removeWarning = (l: ListingDetail['listing']) => {
  const deal = l.lastEndedDeal;
  const deadline = deal ? Date.parse(deal.at) + 72 * 3600_000 : 0;
  if (!deal || Date.now() >= deadline) return 'Hủy tin này?';
  return (
    `Tin vừa có giao dịch bị ${deal.status === 'CANCELLED' ? 'hủy' : 'báo thất bại'} lúc ${dateTime(deal.at)}.\n` +
    `Gỡ tin trước ${dateTime(new Date(deadline).toISOString())} sẽ bị coi như đã bán bên ngoài ReLoop và tính phí 10.000đ ` +
    '(bạn có thể khiếu nại nếu không phải vậy).\n\nVẫn gỡ tin?'
  );
};

export function ListingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<ListingDetail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<ListingDetail>('GET', `/listings/${id}`));
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  // Ghép tin chạy nền (B7): vừa đăng xong → hỏi lại 3 giây/lần tới khi ghép xong (tối đa ~1 phút)
  const [matchPolls, setMatchPolls] = useState(0);
  const matching = data?.role === 'OWNER' && data.listing.status === 'ACTIVE' && data.listing.matchingStatus === 'PENDING';
  useEffect(() => {
    if (!matching || matchPolls >= 20) return;
    const timer = setTimeout(() => {
      setMatchPolls((n) => n + 1);
      void load();
    }, 3_000);
    return () => clearTimeout(timer);
  }, [matching, matchPolls, load]);

  useEffect(() => {
    void load();
    // Báo giá thay đổi khi bên kia thao tác → làm mới 30 giây/lần khi tab đang mở (giaiphap E8).
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (path: string, body?: unknown, idempotent = false) => {
    try {
      await api('POST', path, { body, idempotencyKey: idempotent ? newIdempotencyKey() : undefined });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const select = async (q: Quote) => {
    if (!confirm(`Chọn ${q.partnerName} với giá ${vnd(q.offer!.price)}? Các báo giá khác sẽ tạm khóa.`)) return;
    try {
      const tx = await api<Transaction>('POST', '/transactions', {
        idempotencyKey: newIdempotencyKey(),
        body: { listingId: q.listingId, quoteId: q.quoteId },
      });
      navigate(`/transactions/${tx.transactionId}`);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** Mở chat: đối tác nhắn người bán; chủ tin nhắn một đối tác đã match. */
  const chat = async (partnerId?: string) => {
    try {
      const c = await api<Conversation>('POST', `/listings/${id}/conversations`, { body: partnerId ? { partnerId } : {} });
      navigate(`/chat/${c.conversationId}`);
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!data) return <p className={error ? 'error' : 'muted'}>{error || 'Đang tải…'}</p>;
  const { listing: l, role } = data;
  const base = `/listings/${l.listingId}`;

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <div className="row between">
          <h2>{l.title}</h2>
          <span className={`badge ${statusTone(l.status)}`}>{LISTING_STATUS_LABEL[l.status]}</span>
        </div>
        <p className="muted">
          {CATEGORY_LABEL[l.category]}
          {l.brand && ` · ${l.brand}`}
          {l.model && ` ${l.model}`} · {CONDITION_LABEL[l.condition]} ·{' '}
          {l.unit === 'PER_DEVICE' ? `${l.quantity} cái` : `~${l.weightKg} kg`} ({UNIT_LABEL[l.unit]})
        </p>
        {l.description && <p>{l.description}</p>}
        <p className="muted">
          Bàn giao: {l.handoverMethods.map((m) => HANDOVER_LABEL[m]).join(', ')} · Khu vực: {l.area}
          {role === 'OWNER' && l.location && ` · ${l.location.address}`}
        </p>
        <p className="muted">
          Đăng {dateTime(l.createdAt)} · hết hạn {dateTime(l.expiresAt)}
        </p>
        {role !== 'OWNER' && (
          <div className="seller-box">
            <div className="seller">
              <span className="avatar">{data.seller.displayName.charAt(0).toUpperCase()}</span>
              <div>
                <div>
                  <span className="muted small">Người bán</span> <strong>{data.seller.displayName}</strong>
                </div>
                <div className="muted small">
                  {data.seller.tier && `${PARTNER_TIER_LABEL[data.seller.tier]} · `}
                  {!data.sellerReputation || data.sellerReputation.averageRating === null
                    ? 'Chưa đủ đánh giá'
                    : `${data.sellerReputation.averageRating}★ (${data.sellerReputation.reviewCount} đánh giá)`}
                </div>
                {data.sellerHistory && (
                  <div className="muted small">
                    {data.sellerHistory.days} ngày qua: {data.sellerHistory.completed} giao dịch hoàn tất
                    {data.sellerHistory.cancelled > 0 ? (
                      <span className="warn-text"> · {data.sellerHistory.cancelled} bị hủy / thất bại</span>
                    ) : (
                      ' · không có giao dịch bị hủy'
                    )}
                  </div>
                )}
              </div>
            </div>
            <ContactLine contact={data.seller.contact} />
            {l.status === 'MATCHED' && !l.activeTransactionId && (
              <div className="notice warn">Tin đã có người chốt giá. Tin sẽ quay lại Chợ nếu giao dịch bị hủy.</div>
            )}
            <div className="row actions">
              {/* Tin đã có người chốt → chỉ người mua trong giao dịch còn nhắn được (QĐ-38) */}
              {(l.status === 'ACTIVE' || (l.status === 'MATCHED' && l.activeTransactionId)) && (
                <button onClick={() => void chat()}>💬 {l.status === 'ACTIVE' ? 'Nhắn tin / ra giá với người bán' : 'Nhắn tin với người bán'}</button>
              )}
              <ReportButton targetType="LISTING" targetId={l.listingId} />
            </div>
          </div>
        )}
        {data.images.length > 0 && (
          <div className="gallery">
            {data.images.map((src) => (
              <a key={src} href={src} target="_blank" rel="noreferrer">
                <img src={src} alt="" />
              </a>
            ))}
          </div>
        )}
        {l.activeTransactionId && (
          <p>
            <Link to={`/transactions/${l.activeTransactionId}`}>→ Xem giao dịch đang thực hiện</Link>
          </p>
        )}
        {role === 'OWNER' && l.status === 'PENDING_REVIEW' && (
          <div className="notice warn">
            <strong>⏳ Tin đang chờ Admin duyệt (thường 1–3 ngày).</strong> Ảnh cần kiểm tra (chữ bất thường hoặc nghi nội dung nhạy cảm) nên tin chưa
            hiện trên Chợ và chưa gửi tới đơn vị thu mua. Khi được duyệt, tin mở 7 ngày tính từ lúc duyệt.
          </div>
        )}
        {role === 'OWNER' && l.status === 'CANCELLED' && l.moderated && (
          <div className="notice bad">Admin {l.review?.decision ? 'từ chối' : 'gỡ'} tin này{l.moderated.note ? `: ${l.moderated.note}` : '.'}</div>
        )}
        {role === 'OWNER' && (l.status === 'ACTIVE' || l.status === 'PENDING_REVIEW') && (
          <div className="row">
            <button className="danger" onClick={() => confirm(removeWarning(l)) && void act(`${base}/cancel`)}>
              Hủy tin
            </button>
          </div>
        )}
      </section>

      {role === 'OWNER' ? (
        <section className="card">
          <h2>Báo giá</h2>
          <p className="muted">
            {matching
              ? 'Đang tìm đơn vị thu mua phù hợp quanh bạn… (vài giây)'
              : l.matchCount === 0
                ? 'Chưa có đơn vị thu mua phù hợp trong bán kính 5 km.'
                : `${l.matchCount} đơn vị thu mua phù hợp, ${data.quotes.length} báo giá.`}
          </p>
          {data.quotes.map((q) => (
            <QuoteCard key={q.quoteId} q={q} reputation={data.reputation[q.partnerId]}>
              {q.status === 'ESTIMATED' && l.status === 'ACTIVE' && (
                <button onClick={() => void act(`${base}/quotes/${q.quoteId}/request-confirmation`)}>Yêu cầu xác nhận giá</button>
              )}
              {q.status === 'CONFIRMED_OFFER' && l.status === 'ACTIVE' && <button onClick={() => void select(q)}>Chọn đối tác này</button>}
            </QuoteCard>
          ))}
          {data.matches.length > 0 && ['ACTIVE', 'MATCHED'].includes(l.status) && (
            <>
              <h3>Nhắn tin với đơn vị thu mua</h3>
              <div className="row">
                {[...new Map(data.matches.map((m) => [m.partnerId, m])).values()].map((m) => (
                  <button key={m.partnerId} className="secondary" onClick={() => void chat(m.partnerId)}>
                    💬 {m.partnerName}
                  </button>
                ))}
              </div>
            </>
          )}
          {data.matches.some((m) => !data.quotes.some((q) => q.branchId === m.branchId)) && (
            <p className="muted">Một số đơn vị chưa có bảng giá cho thiết bị này — họ có thể gửi báo giá thủ công.</p>
          )}
        </section>
      ) : role === 'PARTNER' ? (
        <PartnerPanel data={data} act={act} />
      ) : null}
    </div>
  );
}

function QuoteCard({ q, reputation, children }: { q: Quote; reputation?: Reputation; children?: React.ReactNode }) {
  return (
    <div className="quote">
      <div className="row between">
        <strong>
          {q.partnerName} — {q.branchName}
        </strong>
        {q.takenByOther ? (
          <span className="badge warn">Tin đang giao dịch với người khác</span>
        ) : (
          <span className={`badge ${statusTone(q.status)}`}>{QUOTE_STATUS_LABEL[q.status]}</span>
        )}
      </div>
      <div className="muted">
        {km(q.distanceKm)}
        {reputation && (
          <>
            {' · '}
            {reputation.averageRating === null ? 'Chưa đủ dữ liệu đánh giá' : `${reputation.averageRating}★ (${reputation.reviewCount})`}
            {` · ${reputation.completedCount} giao dịch hoàn tất`}
          </>
        )}
      </div>
      {q.estimate && (
        <div>
          Giá dự kiến: {vnd(q.estimate.unitMin)} – {vnd(q.estimate.unitMax)} / {q.estimate.unit === 'PER_KG' ? 'kg' : 'cái'}
          {q.estimate.totalMin !== undefined && (
            <>
              {' '}
              · tổng {vnd(q.estimate.totalMin)} – {vnd(q.estimate.totalMax!)}
            </>
          )}
        </div>
      )}
      {q.offer && (
        <div>
          <strong>Giá đối tác cam kết: {vnd(q.offer.price)}</strong> · hiệu lực đến {dateTime(q.offer.validUntil)}
          {q.offer.differsFromEstimate && <div className="warn-text">⚠ Giá xác nhận khác khoảng giá dự kiến</div>}
          {q.offer.note && <div className="muted">Ghi chú: {q.offer.note}</div>}
        </div>
      )}
      {q.status === 'CONFIRMATION_REQUESTED' && q.responseDeadline && (
        <div className="muted">Đối tác cần trả lời trước {dateTime(q.responseDeadline)}</div>
      )}
      {q.rejectNote && <div className="muted">Lý do từ chối: {q.rejectNote}</div>}
      {children && <div className="row">{children}</div>}
    </div>
  );
}

function PartnerPanel({ data, act }: { data: ListingDetail; act: (path: string, body?: unknown, idem?: boolean) => Promise<void> }) {
  const base = `/listings/${data.listing.listingId}`;
  const open = data.listing.status === 'ACTIVE';
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <section className="card">
      <h2>Báo giá của bạn</h2>
      {data.matches.map((m) => {
        const quotes = data.quotes.filter((q) => q.branchId === m.branchId);
        const hasOpenOffer = quotes.some((q) => q.status === 'CONFIRMED_OFFER');
        return (
          <div key={m.branchId} className="stack">
            <h3>
              {m.branchName} · {km(m.distanceKm)}
            </h3>
            {quotes.map((q) => (
              <QuoteCard key={q.quoteId} q={q}>
                {q.takenByOther && (
                  <span className="muted small">Chủ tin đã chọn người khác. Báo giá của bạn được giữ lại — nếu giao dịch đó bị hủy, chủ tin có thể chọn lại.</span>
                )}
                {!q.takenByOther && q.status === 'CONFIRMATION_REQUESTED' && (
                  <>
                    <input
                      type="number"
                      placeholder="Giá xác nhận (tổng, VND)"
                      value={prices[q.quoteId] ?? ''}
                      onChange={(e) => setPrices({ ...prices, [q.quoteId]: e.target.value })}
                    />
                    <button onClick={() => void act(`${base}/quotes/${q.quoteId}/confirm`, { price: Number(prices[q.quoteId]) })}>Xác nhận giá</button>
                    <button className="danger" onClick={() => void act(`${base}/quotes/${q.quoteId}/reject`, {})}>
                      Từ chối
                    </button>
                  </>
                )}
                {!q.takenByOther && q.status === 'CONFIRMED_OFFER' && (
                  <button className="danger" onClick={() => void act(`${base}/quotes/${q.quoteId}/withdraw`)}>
                    Rút báo giá
                  </button>
                )}
              </QuoteCard>
            ))}
            {open && !hasOpenOffer && (
              <div className="row">
                <input
                  type="number"
                  placeholder="Giá đề nghị (tổng, VND)"
                  value={prices[m.branchId] ?? ''}
                  onChange={(e) => setPrices({ ...prices, [m.branchId]: e.target.value })}
                />
                <input placeholder="Ghi chú" value={notes[m.branchId] ?? ''} onChange={(e) => setNotes({ ...notes, [m.branchId]: e.target.value })} />
                <button
                  onClick={() =>
                    void act(`${base}/offers`, { branchId: m.branchId, price: Number(prices[m.branchId]), note: notes[m.branchId] || undefined }, true)
                  }
                >
                  Gửi báo giá
                </button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
