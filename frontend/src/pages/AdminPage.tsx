import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Branch, type Listing, type Partner, type Seller, type PartnerStatus, type Report, type Transaction } from '../lib/api';
import { BUSINESS_TYPE_LABEL, CATEGORY_LABEL, PARTNER_STATUS_LABEL, PARTNER_TIER_LABEL, PARTY_LABEL, statusTone, tierOf } from '../lib/catalog';
import { dateTime, errorText, vnd } from '../lib/format';

type PartnerRow = Partner & { applicant: { email?: string; fullName?: string }; branches: Branch[] };

export function AdminPage() {
  return (
    <div className="stack">
      <StatsAdmin />
      <ListingReviewAdmin />
      <PartnersAdmin />
      <DisputesAdmin />
      <ReportsAdmin />
    </div>
  );
}

/** Duyệt / tạm ngừng đối tác (T14.1). */
function PartnersAdmin() {
  const [status, setStatus] = useState<PartnerStatus>('PENDING');
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
            <strong>{p.businessName}</strong>
            <span className={`badge ${statusTone(p.status)}`}>{PARTNER_STATUS_LABEL[p.status]}</span>
          </div>
          <div>
            <span className="badge">{PARTNER_TIER_LABEL[tierOf(p)]}</span>
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
function DisputesAdmin() {
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
              Giá thỏa thuận {vnd(t.agreedPrice)} · {PARTY_LABEL[t.dispute!.by]} khiếu nại {dateTime(t.dispute!.at)}: {t.dispute!.reason}
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

function StatsAdmin() {
  const [stats, setStats] = useState<{ partners: Record<string, number>; openDisputes: number; openReports: number; pendingListings?: number } | null>(null);
  useEffect(() => {
    api<NonNullable<typeof stats>>('GET', '/admin/stats').then(setStats).catch(() => undefined);
  }, []);
  if (!stats) return null;
  return (
    <section className="card">
      <h2>Tổng quan</h2>
      <div className="tiles">
        {Object.entries(stats.partners).map(([k, v]) => (
          <div key={k} className="tile">
            <span className="muted">Đối tác {PARTNER_STATUS_LABEL[k]?.toLowerCase()}</span>
            <strong>{v}</strong>
          </div>
        ))}
        <div className="tile">
          <span className="muted">Tin chờ duyệt (ảnh bị gắn cờ)</span>
          <strong>{stats.pendingListings ?? 0}</strong>
        </div>
        <div className="tile">
          <span className="muted">Tranh chấp đang mở</span>
          <strong>{stats.openDisputes}</strong>
        </div>
        <div className="tile">
          <span className="muted">Báo cáo vi phạm chờ xử lý</span>
          <strong>{stats.openReports}</strong>
        </div>
      </div>
    </section>
  );
}

type ReviewItem = { listing: Listing; seller: Seller; images: string[] };

/**
 * Tin có ảnh bị gắn cờ chữ bất thường (QĐ-36): Admin xem ảnh + chữ hệ thống đọc được, duyệt hoặc từ chối.
 * Cam kết xử lý trong 1–3 ngày; tin chờ lâu nhất ở trên cùng.
 */
function ListingReviewAdmin() {
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
      <h2>Tin chờ duyệt — ảnh có chữ bất thường</h2>
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
              {seller.displayName} · {seller.contact?.email} · gửi {dateTime(l.createdAt)} · {l.area}
            </span>
            <span>{l.description}</span>
            {l.review?.images.map((f) => (
              <div key={f.key} className="notice warn">
                Chữ đọc được trong ảnh: <em>“{f.text}”</em>
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

/** Báo cáo vi phạm (T14.5). */
function ReportsAdmin() {
  const [items, setItems] = useState<Report[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Report[] }>('GET', '/admin/reports')).items);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const resolve = async (r: Report, action: 'DISMISS' | 'HIDE_LISTING' | 'WARN') => {
    try {
      await api('POST', `/admin/reports/${r.reportId}/resolve`, { body: { action, note: notes[r.reportId] || undefined } });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const link = (r: Report) =>
    r.targetType === 'LISTING' ? `/listings/${r.targetId}` : r.targetType === 'TRANSACTION' ? `/transactions/${r.targetId}` : undefined;
  return (
    <section className="card">
      <h2>Báo cáo vi phạm</h2>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">Không có báo cáo chờ xử lý.</p>}
      {items.map((r) => (
        <div key={r.reportId} className="quote">
          <div className="row between">
            <strong>
              {r.targetType} {link(r) ? <Link to={link(r)!}>{r.targetId}</Link> : r.targetId}
            </strong>
            <span className="muted">{dateTime(r.createdAt)}</span>
          </div>
          <span>{r.reason}</span>
          <div className="row">
            <input placeholder="Ghi chú" value={notes[r.reportId] ?? ''} onChange={(e) => setNotes({ ...notes, [r.reportId]: e.target.value })} />
            {r.targetType === 'LISTING' && (
              <button className="danger" onClick={() => void resolve(r, 'HIDE_LISTING')}>
                Gỡ tin
              </button>
            )}
            <button className="secondary" onClick={() => void resolve(r, 'WARN')}>
              Đã nhắc nhở
            </button>
            <button className="secondary" onClick={() => void resolve(r, 'DISMISS')}>
              Bỏ qua
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
