import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type Branch,
  type FeeLine,
  type Invoice,
  type Listing,
  type Partner,
  type PartnerStatus,
  type Report,
  type RiskFlag,
  type Seller,
  type Transaction,
} from '../../lib/api';
import { BUSINESS_TYPE_LABEL, CATEGORY_LABEL, PARTNER_STATUS_LABEL, PARTNER_TIER_LABEL, PARTY_LABEL, statusTone, tierOf } from '../../lib/catalog';
import { dateTime, errorText, vnd } from '../../lib/format';
import { loadSession } from '../../lib/session';
import { partnerLabel } from '../../lib/role';

/** Thao tác tiền (Đã thu, Lập hóa đơn, Miễn / Giữ phí) cần quyền admin_finance — người khác chỉ xem (TL-05, mục 6 danhgia). */
type ReportAction = 'DISMISS' | 'WARN' | 'HIDE_AND_WARN' | 'HIDE_AND_SUSPEND' | 'SUSPEND';

/** Lý do soạn sẵn — chọn là tự điền, vẫn sửa thêm được (QĐ-43). */
const LISTING_REASONS = [
  'Đăng bán hàng cấm / hàng vi phạm pháp luật',
  'Nghi hàng gian, không rõ nguồn gốc',
  'Thông tin / mô tả sai sự thật',
  'Ảnh không phải thiết bị hoặc không phù hợp',
  'Có dấu hiệu lừa đảo',
  'Spam, đăng trùng nhiều tin',
];
const TRANSACTION_REASONS = [
  'Hẹn bàn giao nhưng không đến',
  'Đòi thêm tiền / ép giá khi gặp',
  'Thiết bị khác xa mô tả',
  'Thái độ thiếu tôn trọng, đe dọa',
  'Có dấu hiệu lừa đảo',
];
const LISTING_REJECT_REASONS = [
  'Ảnh có nội dung nhạy cảm / không phù hợp',
  'Ảnh chứa chữ nhằm lừa hệ thống AI',
  'Ảnh không phải thiết bị điện tử',
  'Ảnh không khớp với thiết bị trong tin',
];

const isFinance = () => loadSession()?.groups.includes('admin_finance') ?? false;
const FINANCE_NOTE = 'Cần quyền Admin tài chính (FinanceAdmins) để thao tác.';

type PartnerRow = Partner & { applicant: { email?: string; fullName?: string }; branches: Branch[] };

/** Tên người → hồ sơ gộp ở mục Thành viên (get.md A2). */
const UserLink = ({ id, children }: { id: string; children: React.ReactNode }) => <Link to={`/admin/users/${encodeURIComponent(id)}`}>{children}</Link>;

/** Bộ lọc nằm trên URL (?status=) để F5 / gửi link vẫn giữ (get.md A0). */
function useStatusParam<S extends string>(fallback: S): [S, (s: S) => void] {
  const [params, setParams] = useSearchParams();
  return [(params.get('status') as S | null) ?? fallback, (s) => setParams({ status: s }, { replace: true })];
}

/** Duyệt / tạm ngừng đối tác (T14.1). */
export function PartnersAdmin() {
  const [status, setStatus] = useStatusParam<PartnerStatus>('PENDING');
  const [items, setItems] = useState<PartnerRow[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: PartnerRow[] }>('GET', `/admin/partners?status=${status}`)).items);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const call = async (path: string, body: unknown) => {
    try {
      await api('POST', path, { body });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const review = (p: PartnerRow, approve: boolean) => call(`/admin/partners/${p.partnerId}/review`, { approve, note: notes[p.partnerId] });

  return (
    <section className="card">
      <div className="row between">
        <h2>Duyệt đối tác</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as PartnerStatus)}>
          {Object.entries(PARTNER_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">Không có hồ sơ.</p>}
      {items.map((p) => {
        const business = tierOf(p) === 'BUSINESS';
        return (
        <div key={p.partnerId} className="quote">
          <div className="row between">
            <strong>
              <UserLink id={p.partnerId}>{p.businessName}</UserLink>
            </strong>
            <span className={`badge ${statusTone(p.status)}`}>{PARTNER_STATUS_LABEL[p.status]}</span>
          </div>
          <div>
            {partnerLabel(p) && <span className="badge ok">{partnerLabel(p)}</span>} <span className="badge">{PARTNER_TIER_LABEL[tierOf(p)]}</span>
            {p.businessType && <span className="muted"> · {BUSINESS_TYPE_LABEL[p.businessType]}</span>}
          </div>
          <div className="muted">
            {p.businessType === 'PERSONAL' ? 'MST/CCCD' : 'GPKD/MST'} {p.licenseNo ?? '—'} · email liên hệ {p.contactEmail ?? '— chưa có'}
            {p.phone && ` · ${p.phone}`} · tài khoản {p.applicant.fullName ?? ''} {p.applicant.email ?? ''} · gửi {dateTime(p.createdAt)}
          </div>
          <ul className="plain">
            {business && p.branches.length === 0 && <li className="warn-text">Chưa có chi nhánh — chưa duyệt được</li>}
            {p.branches.map((b) => (
              <li key={b.branchId}>
                {b.name} · {b.location.address} · {b.radiusKm} km · {b.categories.map((c) => CATEGORY_LABEL[c]).join(', ')}
              </li>
            ))}
          </ul>
          {p.status === 'PENDING' && (
            <div className="row">
              <input placeholder="Ghi chú (không bắt buộc)" value={notes[p.partnerId] ?? ''} onChange={(e) => setNotes({ ...notes, [p.partnerId]: e.target.value })} />
              <button onClick={() => void review(p, true)} disabled={business && p.branches.length === 0}>
                Duyệt
              </button>
              <button className="danger" onClick={() => void review(p, false)}>
                Từ chối
              </button>
            </div>
          )}
          {p.status === 'APPROVED' && (
            <div className="row">
              <input placeholder="Lý do tạm ngừng" value={notes[p.partnerId] ?? ''} onChange={(e) => setNotes({ ...notes, [p.partnerId]: e.target.value })} />
              <button className="danger" onClick={() => void call(`/admin/partners/${p.partnerId}/suspend`, { note: notes[p.partnerId] })}>
                Tạm ngừng
              </button>
            </div>
          )}
          {p.status === 'SUSPENDED' && (
            <div className="row">
              <button onClick={() => void call(`/admin/partners/${p.partnerId}/reactivate`, {})}>Mở lại</button>
            </div>
          )}
        </div>
        );
      })}
    </section>
  );
}

/** Tranh chấp (T13.3): Admin kết luận hoàn tất (kèm giá cuối) hoặc thất bại. */
export function DisputesAdmin() {
  const [items, setItems] = useState<Transaction[]>([]);
  const [form, setForm] = useState<Record<string, { note: string; price: string }>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Transaction[] }>('GET', '/admin/disputes')).items);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (t: Transaction, outcome: 'COMPLETED' | 'FAILED') => {
    const f = form[t.transactionId] ?? { note: '', price: String(t.agreedPrice) };
    try {
      await api('POST', `/admin/transactions/${t.transactionId}/resolve`, {
        body: { outcome, note: f.note, finalPrice: outcome === 'COMPLETED' ? Number(f.price) : undefined },
      });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card">
      <h2>Tranh chấp</h2>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">Không có tranh chấp đang mở.</p>}
      {items.map((t) => {
        const f = form[t.transactionId] ?? { note: '', price: String(t.agreedPrice) };
        const set = (patch: Partial<typeof f>) => setForm({ ...form, [t.transactionId]: { ...f, ...patch } });
        return (
          <div key={t.transactionId} className="quote">
            <div className="row between">
              <Link to={`/transactions/${t.transactionId}`}>
                <strong>{t.listingTitle}</strong>
              </Link>
              <span className="muted">{t.partnerName}</span>
            </div>
            <span>
              Giá thỏa thuận {vnd(t.agreedPrice)} · {PARTY_LABEL[t.dispute!.by]} khiếu nại {dateTime(t.dispute!.at)}: {t.dispute!.reason}{' '}
              {(() => {
                const days = Math.floor((Date.now() - Date.parse(t.dispute!.at)) / 86_400_000);
                return <span className={`badge ${days >= 5 ? 'bad' : 'warn'}`}>đã chờ {days} / 7 ngày</span>;
              })()}
            </span>
            <span className="muted small">
              Người bán: <UserLink id={t.ownerId}>{t.ownerId}</UserLink> · Người mua: <UserLink id={t.partnerId}>{t.partnerName}</UserLink>
            </span>
            <div className="row">
              <input placeholder="Kết luận của Admin" value={f.note} onChange={(e) => set({ note: e.target.value })} />
              <input type="number" value={f.price} onChange={(e) => set({ price: e.target.value })} />
              <button onClick={() => void resolve(t, 'COMPLETED')} disabled={f.note.trim().length < 3}>
                Hoàn tất với giá này
              </button>
              <button className="danger" onClick={() => void resolve(t, 'FAILED')} disabled={f.note.trim().length < 3}>
                Kết luận thất bại
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

type ReviewItem = { listing: Listing; seller: Seller; images: string[] };

/**
 * Tin có ảnh bị gắn cờ chữ bất thường (QĐ-36): Admin xem ảnh + chữ hệ thống đọc được, duyệt hoặc từ chối.
 * Cam kết xử lý trong 1–3 ngày; tin chờ lâu nhất ở trên cùng.
 */
export function ListingReviewAdmin() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: ReviewItem[] }>('GET', '/admin/listings/review')).items);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const decide = async (id: string, approve: boolean) => {
    try {
      await api('POST', `/admin/listings/${id}/review`, { body: { approve, note: notes[id] || undefined } });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const waitedDays = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

  return (
    <section className="card">
      <h2>Tin chờ duyệt — ảnh bị gắn cờ</h2>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">Không có tin nào chờ duyệt.</p>}
      {items.map(({ listing: l, seller, images }) => {
        const days = waitedDays(l.review?.at ?? l.createdAt);
        return (
          <div key={l.listingId} className="quote">
            <div className="row between">
              <strong>{l.title}</strong>
              <span className={`badge ${days >= 3 ? 'bad' : 'warn'}`}>{days === 0 ? 'hôm nay' : `chờ ${days} ngày`}</span>
            </div>
            <span className="muted">
              <UserLink id={l.ownerId}>{seller.displayName}</UserLink> · {seller.contact?.email} · gửi {dateTime(l.createdAt)} · {l.area}
            </span>
            <span>{l.description}</span>
            {l.review?.images.map((f) => (
              <div key={f.key} className="notice warn">
                {f.kind === 'SENSITIVE' ? (
                  <>Rekognition {f.text.charAt(0).toLowerCase() + f.text.slice(1)} — mở ảnh để kiểm tra.</>
                ) : (
                  <>
                    Chữ đọc được trong ảnh: <em>“{f.text}”</em>
                  </>
                )}
              </div>
            ))}
            {images.length > 0 && (
              <div className="gallery">
                {images.map((src) => (
                  <a key={src} href={src} target="_blank" rel="noreferrer">
                    <img src={src} alt="" />
                  </a>
                ))}
              </div>
            )}
            <div className="row">
              <select value="" onChange={(e) => e.target.value && setNotes({ ...notes, [l.listingId]: e.target.value })}>
                <option value="">— Lý do từ chối mẫu —</option>
                {LISTING_REJECT_REASONS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              <input
                className="grow"
                placeholder="Ghi chú (bắt buộc khi từ chối — gửi cho người đăng)"
                value={notes[l.listingId] ?? ''}
                onChange={(e) => setNotes({ ...notes, [l.listingId]: e.target.value })}
              />
              <button onClick={() => void decide(l.listingId, true)}>Duyệt — lên Chợ</button>
              <button className="danger" onClick={() => void decide(l.listingId, false)} disabled={!notes[l.listingId]?.trim()}>
                Từ chối
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * Hóa đơn phí dịch vụ (QĐ-37): đối chiếu chuyển khoản theo mã RLF… rồi bấm "Đã thu" (cần quyền admin_finance).
 * Lập hóa đơn tay cho tháng đã kết thúc (job nền tự chạy ngày 1 hằng tháng).
 */
export function InvoicesAdmin() {
  const [status, setStatus] = useStatusParam<'ISSUED' | 'PAID'>('ISSUED');
  const [items, setItems] = useState<Invoice[]>([]);
  const [month, setMonth] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Invoice[] }>('GET', `/admin/invoices?status=${status}`)).items);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const total = items.reduce((s, i) => s + i.amount, 0);
  const finance = isFinance();

  return (
    <section className="card">
      <div className="row between">
        <h2>Hóa đơn phí dịch vụ</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as 'ISSUED' | 'PAID')}>
          <option value="ISSUED">Chưa thu</option>
          <option value="PAID">Đã thu</option>
        </select>
      </div>
      <p className="muted">10.000đ / giao dịch hoàn tất, người bán trả. Đối chiếu nội dung chuyển khoản với mã hóa đơn trước khi bấm "Đã thu".</p>
      {error && <p className="error">{error}</p>}
      {items.length === 0 ? (
        <p className="muted">Không có hóa đơn.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Đối tác</th>
              <th>Tháng</th>
              <th className="num">Giao dịch</th>
              <th className="num">Số tiền</th>
              <th>Mã CK</th>
              <th>{status === 'ISSUED' ? 'Hạn' : 'Đã thu'}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={`${i.userId}-${i.month}`}>
                <td>
                  <UserLink id={i.userId}>{i.partnerName ?? i.userId}</UserLink>
                </td>
                <td>{i.month}</td>
                <td className="num">{i.transactionCount}</td>
                <td className="num">{vnd(i.amount)}</td>
                <td>
                  <code>{i.paymentCode}</code>
                </td>
                <td>
                  {status === 'ISSUED' ? (
                    <span className={`badge ${i.overdue ? 'bad' : 'warn'}`}>{dateTime(i.dueAt)}</span>
                  ) : (
                    i.paidAt && dateTime(i.paidAt)
                  )}
                </td>
                <td>
                  {status === 'ISSUED' && finance && (
                    <button className="secondary" onClick={() => confirm(`Xác nhận đã nhận ${vnd(i.amount)} (mã ${i.paymentCode})?`) && void run(() => api('POST', `/admin/invoices/${i.userId}/${i.month}/paid`, { body: {} }))}>
                      Đã thu
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {items.length > 0 && <p className="muted">Tổng: {vnd(total)}</p>}
      {!finance && <p className="muted small">{FINANCE_NOTE}</p>}
      {finance && (
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setMsg(`Đã lập ${(await api<{ issued: number }>('POST', '/admin/billing/issue', { body: { month } })).issued} hóa đơn tháng ${month}`));
        }}
      >
        <input placeholder="Tháng đã kết thúc, vd 2026-10" value={month} onChange={(e) => setMonth(e.target.value)} pattern="\d{4}-\d{2}" required />
        <button type="submit" className="secondary">
          Lập hóa đơn
        </button>
        {msg && <span className="muted">{msg}</span>}
      </form>
      )}
    </section>
  );
}

/** Phản ánh vi phạm (T14.5). */
export function ReportsAdmin() {
  const [items, setItems] = useState<Report[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Report[] }>('GET', '/admin/reports')).items);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (r: Report, action: ReportAction) => {
    const note = notes[r.reportId]?.trim() || undefined;
    if (action === 'HIDE_AND_SUSPEND' || action === 'SUSPEND') {
      const v = r.violator!;
      const history =
        v.violations30d === 0
          ? `⚠ ${v.name} CHƯA có vi phạm nào trong 30 ngày.\nBạn chắc chắn TẠM NGỪNG tài khoản thay vì ${r.targetType === 'LISTING' ? 'Gỡ tin + cảnh cáo' : 'Cảnh cáo'}?`
          : `${v.name} đã có ${v.violations30d} vi phạm trong 30 ngày. Tạm ngừng tài khoản đối tác?`;
      if (!confirm(`${history}\n\nLý do gửi cho người bị tạm ngừng: "${note}"\n(Mở lại được ở mục Duyệt đối tác.)`)) return;
    }
    try {
      await api('POST', `/admin/reports/${r.reportId}/resolve`, { body: { action, note } });
      await load();
    } catch (e) {
      setError(errorText(e)); // vd tin đang giao dịch → báo cáo vẫn mở
    }
  };

  return (
    <section className="card">
      <h2>Phản ánh vi phạm đang mở</h2>
      <p className="muted small">
        Chọn mức xử lý theo mức độ. Người vi phạm nhận thông báo kèm lý do; mỗi lần xử lý (trừ Bỏ qua) tính 1 vi phạm — đủ 5 lần / 30 ngày sẽ vào danh
        sách cờ. Tạm ngừng bắt buộc có lý do.
      </p>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">Không có phản ánh chờ xử lý.</p>}
      {items.map((r) => {
        const v = r.violator;
        const note = notes[r.reportId] ?? '';
        const canSuspend = !!v && (v.partnerStatus === 'APPROVED' || v.partnerStatus === 'SUSPENDED');
        const noteOk = note.trim().length >= 5;
        const templates = r.targetType === 'TRANSACTION' ? TRANSACTION_REASONS : LISTING_REASONS;
        return (
          <div key={r.reportId} className="quote">
            <div className="row between">
              <strong>
                {r.targetType === 'LISTING' ? 'Tin đăng' : r.targetType === 'TRANSACTION' ? 'Giao dịch' : r.targetType}
                {' · '}
                {r.target?.link ? <Link to={r.target.link}>{r.target.title} →</Link> : (r.target?.title ?? r.targetId)}
              </strong>
              <span className="muted">{dateTime(r.createdAt)}</span>
            </div>
            <span>
              Lý do phản ánh: <em>{r.reason}</em>
            </span>
            {v ? (
              <span>
                Người vi phạm: <strong>
                  <UserLink id={v.userId}>{v.name}</UserLink>
                </strong>{' '}
                <span className={`badge ${v.violations30d >= 3 ? 'bad' : v.violations30d > 0 ? 'warn' : 'ok'}`}>{v.violations30d} vi phạm / 30 ngày</span>
                {v.partnerStatus === 'SUSPENDED' && <span className="badge bad">đang tạm ngừng</span>}
              </span>
            ) : (
              <span className="muted">Không xác định được người vi phạm — chỉ Bỏ qua được.</span>
            )}
            <div className="row">
              <select value="" onChange={(e) => e.target.value && setNotes({ ...notes, [r.reportId]: e.target.value })}>
                <option value="">— Chọn lý do mẫu —</option>
                {templates.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              <input
                className="grow"
                placeholder="Lý do gửi người vi phạm (bắt buộc khi tạm ngừng)"
                value={note}
                onChange={(e) => setNotes({ ...notes, [r.reportId]: e.target.value })}
              />
            </div>
            <div className="row">
              {v && <button onClick={() => void resolve(r, 'WARN')}>Cảnh cáo</button>}
              {v && r.targetType === 'LISTING' && (
                <button className="danger" onClick={() => void resolve(r, 'HIDE_AND_WARN')}>
                  Gỡ tin + cảnh cáo
                </button>
              )}
              {v && canSuspend && (
                <button
                  className="danger"
                  disabled={!noteOk}
                  title={noteOk ? '' : 'Cần ghi lý do (ít nhất 5 ký tự) trước khi tạm ngừng'}
                  onClick={() => void resolve(r, r.targetType === 'LISTING' ? 'HIDE_AND_SUSPEND' : 'SUSPEND')}
                >
                  {r.targetType === 'LISTING' ? 'Gỡ tin + tạm ngừng' : 'Tạm ngừng'}
                </button>
              )}
              <button className="secondary" onClick={() => void resolve(r, 'DISMISS')}>
                Bỏ qua
              </button>
            </div>
            {v && !canSuspend && <span className="muted small">Người này không phải đối tác — chỉ cảnh cáo được.</span>}
          </div>
        );
      })}
    </section>
  );
}

type AppealRow = FeeLine & { userId: string; partnerName?: string };

/** Khiếu nại phí nghi bán ngoài (QĐ-39): Admin tài chính miễn hoặc giữ phí. */
export function FeeAppealsAdmin() {
  const [items, setItems] = useState<AppealRow[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: AppealRow[] }>('GET', '/admin/fee-appeals')).items);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const resolve = async (a: AppealRow, waive: boolean) => {
    try {
      const r = await api<{ refundDue: number }>('POST', `/admin/fee-appeals/${a.userId}/${a.month}/${a.transactionId}/resolve`, {
        body: { waive, note: notes[a.transactionId] || undefined },
      });
      setMsg(r.refundDue > 0 ? `Hóa đơn tháng ${a.month} đã thu — cần hoàn ${vnd(r.refundDue)} cho người bán bằng chuyển khoản.` : '');
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card">
      <h2>Khiếu nại phí nghi bán ngoài</h2>
      <p className="muted">
        Người bán gỡ tin trong 72 giờ sau khi giao dịch bị hủy / thất bại bị tính 10.000đ. Xem lý do, đối chiếu giao dịch rồi quyết (cần quyền tài
        chính).
      </p>
      {error && <p className="error">{error}</p>}
      {msg && <div className="notice warn">{msg}</div>}
      {items.length === 0 ? (
        <p className="muted">Không có khiếu nại.</p>
      ) : (
        items.map((a) => (
          <div key={`${a.userId}-${a.transactionId}`} className="quote">
            <strong>
              <UserLink id={a.userId}>{a.partnerName ?? a.userId}</UserLink> · {a.listingTitle}
            </strong>
            <span className="muted">
              Tháng {a.month} · gỡ tin {dateTime(a.completedAt)} · khiếu nại {a.appeal && dateTime(a.appeal.at)} ·{' '}
              <Link to={`/transactions/${a.transactionId}`}>Xem giao dịch đã hủy</Link>
            </span>
            <span>Lý do: {a.appeal?.reason}</span>
            {isFinance() ? (
              <div className="row">
                <input
                  className="grow"
                  placeholder="Ghi chú gửi người bán (không bắt buộc)"
                  value={notes[a.transactionId] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [a.transactionId]: e.target.value })}
                />
                <button onClick={() => void resolve(a, true)}>Miễn phí</button>
                <button className="danger" onClick={() => void resolve(a, false)}>
                  Giữ phí
                </button>
              </div>
            ) : (
              <span className="muted small">{FINANCE_NOTE}</span>
            )}
          </div>
        ))
      )}
    </section>
  );
}

const VIOLATION_LABEL: Record<string, string> = {
  REPORT_WARNING: 'Bị cảnh cáo',
  REPORT_HIDDEN: 'Bị gỡ tin + cảnh cáo',
  REPORT_SUSPENDED: 'Bị tạm ngừng',
  IMAGE_REJECTED: 'Ảnh nhạy cảm bị chặn',
  LISTING_REJECTED: 'Tin bị Admin từ chối khi duyệt',
};

const DEAL_END_LABEL: Record<string, string> = { CANCELLED: 'hủy', FAILED: 'thất bại' };

/** Cờ "nghi né phí" (QĐ-39): nhiều lần hủy với cùng người mua, hoặc hủy rồi gỡ tin nhiều lần. */
export function RiskFlagsAdmin() {
  const [items, setItems] = useState<RiskFlag[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: RiskFlag[] }>('GET', '/admin/risk-flags')).items);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const resolve = async (f: RiskFlag, action: 'DISMISS' | 'WARN' | 'SUSPEND') => {
    if (action === 'SUSPEND' && !confirm(`Tạm ngừng đối tác ${f.sellerName ?? f.userId}?`)) return;
    try {
      await api('POST', `/admin/risk-flags/${f.userId}/resolve`, { body: { action, note: notes[f.userId] || undefined } });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card">
      <h2>Người dùng bị gắn cờ (nghi né phí / vi phạm nhiều lần)</h2>
      <p className="muted">
        Gắn cờ khi trong 30 ngày có ≥ 2 giao dịch hủy / thất bại với cùng người mua, ≥ 3 lần hủy rồi gỡ tin, hoặc ≥ 5 lần vi phạm. Xử lý xong, các
        sự việc cũ không bị đếm lại.
      </p>
      {error && <p className="error">{error}</p>}
      {items.length === 0 ? (
        <p className="muted">Không có người bán bị gắn cờ.</p>
      ) : (
        items.map((f) => (
          <div key={f.userId} className="quote">
            <strong>
              <UserLink id={f.userId}>{f.sellerName ?? f.userId}</UserLink>
            </strong>
            <span className="muted">Gắn cờ {dateTime(f.openedAt)}</span>
            <ul>
              {f.reasons.map((r) => (
                <li key={r.code + r.text}>{r.text}</li>
              ))}
            </ul>
            {f.dealsEnded.length > 0 && (
              <details>
                <summary>Giao dịch hủy / thất bại ({f.dealsEnded.length})</summary>
                <ul>
                  {f.dealsEnded.map((d) => (
                    <li key={d.transactionId}>
                      {dateTime(d.at)} · {DEAL_END_LABEL[d.status]} với {d.buyerName} · <Link to={`/transactions/${d.transactionId}`}>{d.listingTitle}</Link>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {f.violations && f.violations.length > 0 && (
              <details>
                <summary>Vi phạm ({f.violations.length})</summary>
                <ul>
                  {f.violations.map((x) => (
                    <li key={x.violationId}>
                      {dateTime(x.at)} · {VIOLATION_LABEL[x.kind] ?? x.kind}
                      {x.ref.title && ` · ${x.ref.title}`}
                      {x.note && ` — ${x.note}`}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {f.cancelThenRemove.length > 0 && (
              <details>
                <summary>Hủy rồi gỡ tin ({f.cancelThenRemove.length})</summary>
                <ul>
                  {f.cancelThenRemove.map((d) => (
                    <li key={d.transactionId}>
                      {dateTime(d.at)} · <Link to={`/transactions/${d.transactionId}`}>{d.listingTitle}</Link>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="row">
              <input
                className="grow"
                placeholder="Ghi chú / nội dung cảnh cáo"
                value={notes[f.userId] ?? ''}
                onChange={(e) => setNotes({ ...notes, [f.userId]: e.target.value })}
              />
              <button className="secondary" onClick={() => void resolve(f, 'DISMISS')}>
                Bỏ qua
              </button>
              <button onClick={() => void resolve(f, 'WARN')}>Cảnh cáo</button>
              <button className="danger" onClick={() => void resolve(f, 'SUSPEND')}>
                Tạm ngừng
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
