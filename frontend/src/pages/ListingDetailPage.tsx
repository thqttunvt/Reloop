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
  QUOTE_STATUS_LABEL,
  UNIT_LABEL,
  statusTone,
} from '../lib/catalog';
import { dateTime, errorText, km, vnd } from '../lib/format';

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
          <>
            <p>
              Người bán: <strong>{data.seller.displayName}</strong>
              {data.sellerReputation && (
                <span className="muted">
                  {' '}
                  ·{' '}
                  {data.sellerReputation.averageRating === null
                    ? 'chưa đủ đánh giá'
                    : `${data.sellerReputation.averageRating}★ (${data.sellerReputation.reviewCount})`}
                </span>
              )}
            </p>
            <ContactLine contact={data.seller.contact} />
            <div className="row">
              {['ACTIVE', 'MATCHED'].includes(l.status) && <button onClick={() => void chat()}>💬 Nhắn tin với người bán</button>}
              <ReportButton targetType="LISTING" targetId={l.listingId} />
            </div>
          </>
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
        {role === 'OWNER' && l.status === 'ACTIVE' && (
          <div className="row">
            <button className="danger" onClick={() => confirm('Hủy tin này?') && void act(`${base}/cancel`)}>
              Hủy tin
            </button>
          </div>
        )}
      </section>

      {role === 'OWNER' ? (
        <section className="card">
          <h2>Báo giá</h2>
          <p className="muted">
            {l.matchCount === 0
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
        <span className={`badge ${statusTone(q.status)}`}>{QUOTE_STATUS_LABEL[q.status]}</span>
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
                {q.status === 'CONFIRMATION_REQUESTED' && (
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
                {q.status === 'CONFIRMED_OFFER' && (
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
