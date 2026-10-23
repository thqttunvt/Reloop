import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ReportButton } from '../components/ReportButton';
import { ApiError, api, uploadImage, type ChatMessage, type Conversation, type TransactionDetail } from '../lib/api';
import { FAILURE_LABEL, HANDOVER_LABEL, PARTY_LABEL, TX_STATUS_LABEL, statusTone } from '../lib/catalog';
import { dateTime, errorText, vnd } from '../lib/format';

export function TransactionDetailPage() {
  const { id } = useParams();
  const [d, setD] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setD(await api<TransactionDetail>('GET', `/transactions/${id}`));
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  // Đang chờ hủy: tải lại đúng lúc hết 5 phút để thấy giao dịch đã hủy (QĐ-38)
  const cancelAt = d?.transaction.cancelRequest?.effectiveAt;
  useEffect(() => {
    if (!cancelAt) return;
    const timer = setTimeout(() => void load(), Math.max(0, Date.parse(cancelAt) - Date.now()) + 1500);
    return () => clearTimeout(timer);
  }, [cancelAt, load]);

  const act = async (method: string, path: string, body?: unknown) => {
    try {
      await api(method, `/transactions/${id}${path}`, { body });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!d) return <p className={error ? 'error' : 'muted'}>{error || 'Đang tải…'}</p>;
  const t = d.transaction;
  const me = d.role;
  const open = ['HANDOVER_PENDING', 'PRICE_ADJUSTMENT_PENDING', 'AWAITING_COUNTERPARTY'].includes(t.status);

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <div className="row between">
          <h2>{t.listingTitle}</h2>
          <span className={`badge ${statusTone(t.status)}`}>{TX_STATUS_LABEL[t.status]}</span>
        </div>
        <p>
          Giá thỏa thuận: <strong>{vnd(t.agreedPrice)}</strong>
          {t.agreedPrice !== t.originalPrice && <span className="muted"> (ban đầu {vnd(t.originalPrice)})</span>}
          {t.finalPrice !== undefined && (
            <>
              {' '}
              · Giá cuối: <strong>{vnd(t.finalPrice)}</strong>
            </>
          )}
        </p>
        <p className="muted">
          Thanh toán trực tiếp khi bàn giao. <Link to={`/listings/${t.listingId}`}>Xem tin đăng</Link>
          {t.conversationId && me !== 'ADMIN' && (
            <>
              {' '}
              · <Link to={`/chat/${t.conversationId}`}>Nhắn tin / ra giá mới</Link>
            </>
          )}
        </p>
        {me !== 'ADMIN' && <ReportButton targetType="TRANSACTION" targetId={t.transactionId} />}
        <div className="grid2">
          <div className="quote">
            <strong>Chủ tin</strong>
            <span>{d.contacts.owner.fullName ?? '—'}</span>
            {d.contacts.owner.email && <span>{d.contacts.owner.email}</span>}
            <span>{d.contacts.owner.phone ?? 'chưa khai SĐT'}</span>
            <span className="muted">{d.contacts.owner.address}</span>
          </div>
          <div className="quote">
            <strong>{t.source === 'CHAT' ? 'Người mua' : 'Đối tác'}</strong>
            <span>
              {d.contacts.partner.businessName}
              {d.contacts.partner.branchName && ` — ${d.contacts.partner.branchName}`}
            </span>
            {d.contacts.partner.email && <span>{d.contacts.partner.email}</span>}
            <span>{d.contacts.partner.phone ?? 'chưa khai SĐT'}</span>
            <span className="muted">{d.contacts.partner.address}</span>
          </div>
        </div>
      </section>

      {t.cancelRequest ? (
        <CancelRequestCard d={d} act={act} />
      ) : (
        <>
          {me !== 'ADMIN' && open && <HandoverCard d={d} act={act} />}
          {me !== 'ADMIN' && <PriceCard d={d} act={act} />}
          {me !== 'ADMIN' && open && <CompletionCard d={d} act={act} />}
        </>
      )}
      <OutcomeCard d={d} />
      {me === 'ADMIN' && <AdminChatsCard listingId={t.listingId} />}
      {me !== 'ADMIN' && <ReviewCard d={d} act={act} />}

      <section className="card">
        <h2>Lịch sử</h2>
        <table>
          <tbody>
            {d.events.map((e, i) => (
              <tr key={i}>
                <td>{dateTime(e.at)}</td>
                <td>{PARTY_LABEL[e.actor] ?? e.actor}</td>
                <td>{e.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

type Act = (method: string, path: string, body?: unknown) => Promise<void>;

/** Một bên đã bấm hủy → 5 phút sau tự hủy (QĐ-38). */
function CancelRequestCard({ d, act }: { d: TransactionDetail; act: Act }) {
  const r = d.transaction.cancelRequest!;
  const mine = r.by === d.role;
  return (
    <section className="card">
      <div className="notice warn">
        <strong>{mine ? 'Bạn đã yêu cầu hủy giao dịch' : `${PARTY_LABEL[r.by]} yêu cầu hủy giao dịch`}</strong>: {r.reason}
        <br />
        Giao dịch tự hủy lúc <strong>{dateTime(r.effectiveAt)}</strong>, tin sẽ quay lại Chợ nếu còn hạn. Trong lúc chờ, các thao tác khác tạm khóa.
      </div>
      {d.role !== 'ADMIN' && (
        <div className="row">
          {mine ? (
            <button className="secondary" onClick={() => void act('POST', '/cancel/withdraw')}>
              Rút yêu cầu hủy
            </button>
          ) : (
            <button className="danger" onClick={() => void act('POST', '/cancel/confirm')}>
              Đồng ý hủy ngay
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function HandoverCard({ d, act }: { d: TransactionDetail; act: Act }) {
  const plan = d.transaction.handoverPlan;
  const [method, setMethod] = useState(plan?.method ?? 'DROP_OFF');
  const [time, setTime] = useState('');
  const [place, setPlace] = useState(plan?.place ?? '');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(!plan);

  return (
    <section className="card">
      <h2>Lịch bàn giao</h2>
      {plan && (
        <div className="quote">
          <div className="row between">
            <strong>
              {HANDOVER_LABEL[plan.method]} · {dateTime(plan.time)}
            </strong>
            <span className={`badge ${plan.status === 'AGREED' ? 'ok' : 'warn'}`}>{plan.status === 'AGREED' ? 'Đã thống nhất' : `${PARTY_LABEL[plan.proposedBy]} đề xuất`}</span>
          </div>
          <span>{plan.place}</span>
          {plan.note && <span className="muted">{plan.note}</span>}
          {plan.status === 'PROPOSED' && plan.proposedBy !== d.role && (
            <div className="row">
              <button onClick={() => void act('POST', '/handover-plan/accept')}>Chấp nhận</button>
            </div>
          )}
        </div>
      )}
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act('PUT', '/handover-plan', { method, time: new Date(time).toISOString(), place, note: note || undefined }).then(() => setEditing(false));
          }}
        >
          <div className="grid2">
            <label>
              Hình thức
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {Object.entries(HANDOVER_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Thời gian
              <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} required />
            </label>
          </div>
          <label>
            Địa điểm
            <input value={place} onChange={(e) => setPlace(e.target.value)} required />
          </label>
          <label>
            Ghi chú
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit">Gửi đề xuất</button>
        </form>
      ) : (
        <button className="secondary" onClick={() => setEditing(true)}>
          Đề xuất lịch khác
        </button>
      )}
    </section>
  );
}

function PriceCard({ d, act }: { d: TransactionDetail; act: Act }) {
  const t = d.transaction;
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [imgError, setImgError] = useState('');
  const canPropose = d.role === 'PARTNER' && t.status === 'HANDOVER_PENDING' && t.priceAdjustments.length < 2;
  const pending = t.status === 'PRICE_ADJUSTMENT_PENDING' ? t.priceAdjustments[t.priceAdjustments.length - 1] : undefined;
  if (t.priceAdjustments.length === 0 && !canPropose) return null;

  return (
    <section className="card">
      <h2>Điều chỉnh giá</h2>
      {t.priceAdjustments.map((a, i) => (
        <div key={i} className="row between">
          <span>
            {vnd(a.price)} — {a.reason}
          </span>
          <span className={`badge ${a.outcome === 'ACCEPTED' ? 'ok' : a.outcome === 'REJECTED' ? 'bad' : 'warn'}`}>
            {a.outcome === 'ACCEPTED' ? 'Đã đồng ý' : a.outcome === 'REJECTED' ? 'Đã từ chối' : 'Chờ chủ tin'}
          </span>
        </div>
      ))}
      {d.adjustmentImages.length > 0 && (
        <div className="gallery">
          {d.adjustmentImages.map((src) => (
            <a key={src} href={src} target="_blank" rel="noreferrer">
              <img src={src} alt="" />
            </a>
          ))}
        </div>
      )}
      {pending && d.role === 'OWNER' && (
        <div className="row">
          <button onClick={() => void act('POST', '/price-adjustment/accept')}>Đồng ý giá {vnd(pending.price)}</button>
          <button className="danger" onClick={() => void act('POST', '/price-adjustment/reject')}>
            Từ chối (giữ giá cũ)
          </button>
        </div>
      )}
      {canPropose && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act('POST', '/price-adjustment', { price: Number(price), reason, imageKeys: keys });
          }}
        >
          <p className="muted">Chỉ được giảm giá, cần lý do và ảnh, tối đa 2 lần. Chủ tin phải đồng ý.</p>
          <div className="grid2">
            <label>
              Giá mới (VND)
              <input type="number" min={0} max={t.agreedPrice - 1} value={price} onChange={(e) => setPrice(e.target.value)} required />
            </label>
            <label>
              Lý do
              <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
            </label>
          </div>
          <label>
            Ảnh chứng minh
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const { key: k } = await uploadImage(f);
                  setKeys((ks) => [...ks, k]);
                } catch (err) {
                  setImgError(err instanceof ApiError && err.code === 'IMAGES_DISABLED' ? 'Upload ảnh chưa bật ở môi trường này' : errorText(err));
                }
              }}
            />
          </label>
          {keys.length > 0 && <span className="muted">Đã tải {keys.length} ảnh</span>}
          {imgError && <span className="muted">{imgError}</span>}
          <button type="submit">Gửi đề nghị giá</button>
        </form>
      )}
    </section>
  );
}

function CompletionCard({ d, act }: { d: TransactionDetail; act: Act }) {
  const t = d.transaction;
  const me = d.role as 'OWNER' | 'PARTNER';
  const [finalPrice, setFinalPrice] = useState(String(t.agreedPrice));
  const [reason, setReason] = useState('');
  const [failReason, setFailReason] = useState('OTHER');
  const confirmedByMe = !!t.completion[me];
  /** Bên kia xác nhận trước → mình chỉ Chấp nhận giá đó hoặc Khiếu nại (mục 7 danhgia) */
  const otherConfirm = t.completion[me === 'OWNER' ? 'PARTNER' : 'OWNER'];
  // Ô giá trống → Number('') = 0 → từng gửi giá cuối 0đ (rà soát 24/10). Giá cuối bên kia chỉ chấp nhận / khiếu nại → hỏi lại.
  const price = Number(finalPrice);
  const priceOk = finalPrice.trim() !== '' && Number.isInteger(price) && price >= 0;
  const confirmFinal = () =>
    confirm(`Xác nhận đã bàn giao xong với giá cuối ${vnd(price)}?\nBên kia sẽ Chấp nhận hoặc Khiếu nại; im lặng 48 giờ thì tự hoàn tất với giá này.`) &&
    void act('POST', '/confirm-completion', { finalPrice: price });

  return (
    <section className="card">
      <h2>Kết thúc giao dịch</h2>
      {confirmedByMe && (
        <p className="muted">
          Bạn đã xác nhận giá cuối {vnd(t.completion[me]!.finalPrice)}. Đang chờ bên kia chấp nhận (quá 48 giờ hệ thống tự hoàn tất).
        </p>
      )}
      {t.status === 'HANDOVER_PENDING' && !confirmedByMe && (
        <div className="row">
          <label>
            Giá cuối đã nhận / trả (VND)
            <input type="number" min={0} step={1000} value={finalPrice} onChange={(e) => setFinalPrice(e.target.value)} />
          </label>
          <button onClick={confirmFinal} disabled={!priceOk} title={priceOk ? '' : 'Nhập giá cuối (số nguyên VND)'}>
            Xác nhận đã bàn giao xong
          </button>
        </div>
      )}
      {t.status === 'AWAITING_COUNTERPARTY' && otherConfirm && !confirmedByMe && (
        <>
          <div className="notice warn">
            Bên kia xác nhận đã bàn giao với giá cuối <strong>{vnd(otherConfirm.finalPrice)}</strong>. Bấm <strong>Chấp nhận</strong> để hoàn tất, hoặc{' '}
            <strong>Khiếu nại</strong> nếu không đúng — trước {t.counterpartyDeadline && dateTime(t.counterpartyDeadline)}, quá hạn hệ thống tự hoàn tất
            với giá này.
          </div>
          <div className="row">
            <button onClick={() => void act('POST', '/confirm-completion')}>Chấp nhận — hoàn tất giao dịch</button>
          </div>
          <div className="row">
            <input className="grow" placeholder="Lý do khiếu nại (ít nhất 5 ký tự)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="danger" onClick={() => void act('POST', '/dispute', { reason })} disabled={reason.trim().length < 5}>
              Khiếu nại
            </button>
          </div>
        </>
      )}
      {t.status === 'HANDOVER_PENDING' && (
        <div className="row">
          <button className="danger" onClick={() => { const r = prompt('Lý do hủy? Giao dịch sẽ tự hủy sau 5 phút (bạn rút lại được trong lúc chờ).'); if (r) void act('POST', '/cancel', { reason: r }); }}>
            Hủy giao dịch
          </button>
        </div>
      )}
      {(t.status === 'HANDOVER_PENDING' || t.status === 'PRICE_ADJUSTMENT_PENDING') && (
        <div className="row">
          <select value={failReason} onChange={(e) => setFailReason(e.target.value)}>
            {Object.entries(FAILURE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button
            className="danger"
            onClick={() =>
              confirm(`Báo giao dịch THẤT BẠI (${FAILURE_LABEL[failReason]})? Không hoàn tác được; tin quay lại Chợ nếu còn hạn.`) &&
              void act('POST', '/report-failure', { reason: failReason })
            }
          >
            Báo thất bại
          </button>
        </div>
      )}
    </section>
  );
}

function OutcomeCard({ d }: { d: TransactionDetail }) {
  const t = d.transaction;
  if (!t.cancel && !t.failure && !t.dispute) return null;
  return (
    <section className="card">
      <h2>Kết quả</h2>
      {t.cancel && (
        <p>
          {PARTY_LABEL[t.cancel.by]} hủy: {t.cancel.reason}
        </p>
      )}
      {t.failure && (
        <p>
          {PARTY_LABEL[t.failure.by]} báo thất bại: {FAILURE_LABEL[t.failure.reason]} {t.failure.note}
        </p>
      )}
      {t.dispute && (
        <p>
          Tranh chấp ({PARTY_LABEL[t.dispute.by]}): {t.dispute.reason}
          {t.dispute.resolution && (
            <>
              <br />
              Admin kết luận {TX_STATUS_LABEL[t.dispute.resolution.outcome]}: {t.dispute.resolution.note}
            </>
          )}
        </p>
      )}
    </section>
  );
}

function ReviewCard({ d, act }: { d: TransactionDetail; act: Act }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  if (!d.canReview && d.reviews.length === 0) return null;
  return (
    <section className="card">
      <h2>Đánh giá</h2>
      {d.reviews.map((r) => (
        <p key={r.by}>
          {PARTY_LABEL[r.by]}: {'★'.repeat(r.rating)}
          {'☆'.repeat(5 - r.rating)} {r.comment}
        </p>
      ))}
      {d.canReview && (
        <div className="row">
          <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n} sao
              </option>
            ))}
          </select>
          <input placeholder="Nhận xét" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button onClick={() => void act('POST', '/review', { rating, comment: comment || undefined })}>Gửi đánh giá</button>
        </div>
      )}
    </section>
  );
}

/**
 * Admin xem mọi cuộc trò chuyện về tin của giao dịch (chỉ đọc) — khi xét tranh chấp, khiếu nại phí, cờ nghi né phí.
 * Chỉ tải khi Admin bấm xem; mỗi lần xem được ghi log (mục 20 danhgia).
 */
export function AdminChatsCard({ listingId }: { listingId: string }) {
  const [data, setData] = useState<{ conversations: { conversation: Conversation; messages: ChatMessage[] }[] } | null>(null);
  const [error, setError] = useState('');
  const show = async () => {
    try {
      setData(await api('GET', `/admin/listings/${listingId}/chats`));
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="card">
      <h2>Tin nhắn về tin này (Admin xem)</h2>
      <p className="muted small">Chỉ đọc. Mỗi lần xem được ghi lại (admin nào xem, lúc nào) để đối chiếu khi cần.</p>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <button className="secondary" onClick={() => void show()}>
          Xem các cuộc trò chuyện
        </button>
      ) : data.conversations.length === 0 ? (
        <p className="muted">Không có cuộc trò chuyện nào.</p>
      ) : (
        data.conversations.map(({ conversation: c, messages }) => (
          <details key={c.conversationId} className="quote">
            <summary>
              Người bán ↔ {c.partnerName} · {messages.length} tin nhắn
            </summary>
            <div className="messages">
              {messages.map((m) => (
                <div key={m.messageId} className={m.kind === 'SYSTEM' ? 'chat-system' : `bubble ${m.senderRole === 'OWNER' ? 'mine' : ''}`}>
                  <span className="small">{m.senderRole === 'OWNER' ? 'Người bán' : c.partnerName}</span>
                  <span>{m.kind === 'OFFER' ? `Ra giá ${vnd(m.price ?? 0)}` : m.text}</span>
                  <span className="time">{dateTime(m.at)}</span>
                </div>
              ))}
            </div>
          </details>
        ))
      )}
    </section>
  );
}
