import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { BillingCard } from '../components/BillingCard';
import { partnerLabel } from '../lib/role';
import { CreateListingPage } from './CreateListingPage';
import { MyListingsPage } from './MyListingsPage';
import { CheckGroup } from '../components/CheckGroup';
import { MapPicker, type LatLng } from '../components/MapPicker';
import { api, newIdempotencyKey, type Branch, type BusinessType, type ListingQuota, type Partner, type PartnerRequest, type PricingRule } from '../lib/api';
import {
  BUSINESS_TYPE_LABEL,
  TIER2_BUSINESS_TYPES,
  CATEGORY_LABEL,
  CONDITION_LABEL,
  HANDOVER_LABEL,
  LISTING_STATUS_LABEL,
  PARTNER_STATUS_LABEL,
  PARTNER_TIER_LABEL,
  QUOTE_STATUS_LABEL,
  UNIT_LABEL,
  statusTone,
  tierOf,
} from '../lib/catalog';
import { dateTime, errorText, km, vnd } from '../lib/format';

interface PartnerMe {
  partner: Partner | null;
  branches: Branch[];
  rules: PricingRule[];
  quota: ListingQuota | null;
}

const PLAN_LABEL: Record<string, string> = { BASIC: 'Cấp 1 — gói thường', VIP1: 'Cấp 1 — VIP 1', BUSINESS: 'Cấp 2 — đối tác ký hợp đồng' };

/**
 * Hạn mức tin đang mở cùng lúc (QĐ-41) + đăng ký VIP 1 trả trước (QĐ-44): bấm chỉ gửi yêu cầu,
 * Admin gửi hóa đơn qua thông báo, gói bật khi Admin xác nhận đã nhận tiền.
 */
function QuotaCard({ quota, onRequestVip, onCancelVip }: { quota: ListingQuota; onRequestVip: () => void; onCancelVip: (id: string) => void }) {
  const full = quota.open >= quota.limit;
  const req = quota.vipRequest;
  const pending = req && (req.status === 'REQUESTED' || req.status === 'INVOICED') ? req : undefined;
  return (
    <section className="card">
      <h2>Hạn mức đăng tin</h2>
      <div className="tiles">
        <div className="tile">
          <span className="muted">Tin đang mở</span>
          <strong className={full ? 'warn-text' : ''}>
            {quota.open} / {quota.limit}
          </strong>
          <span className="muted small">{PLAN_LABEL[quota.plan]}</span>
        </div>
        {quota.plan !== 'BUSINESS' && (
          <div className="tile">
            <span className="muted">Gói VIP 1</span>
            <strong>{quota.plan === 'VIP1' ? `Đến ${dateTime(quota.vipUntil!)}` : 'Chưa có'}</strong>
            <span className="muted small">
              {vnd(quota.vipPrice)} / {quota.vipDays} ngày · tối đa 5 tin
            </span>
          </div>
        )}
      </div>
      <p className="muted small">
        Tính tin đang chờ duyệt, đang mở và đang giao dịch. Tin bán xong, hết hạn hoặc bị hủy thì trả lại suất.
        {quota.plan === 'BUSINESS' && ' Đối tác cấp 2 được mở tối đa 10 tin.'}
      </p>
      {quota.plan !== 'BUSINESS' && pending?.status === 'REQUESTED' && (
        <div className="notice warn">
          Đã gửi yêu cầu {quota.plan === 'VIP1' ? 'gia hạn' : 'nâng lên'} VIP 1 lúc {dateTime(pending.createdAt)}. Admin sẽ gửi hóa đơn {vnd(pending.amount)} qua
          thông báo; gói chỉ bật sau khi ReLoop xác nhận đã nhận tiền.
        </div>
      )}
      {quota.plan !== 'BUSINESS' && pending?.status === 'INVOICED' && (
        <div className="notice warn">
          <strong>Hóa đơn VIP 1: {vnd(pending.amount)}</strong>
          <br />
          {quota.bank ? (
            <>
              Chuyển khoản tới {quota.bank.bankName} · STK <code>{quota.bank.accountNo}</code> · {quota.bank.accountName}
            </>
          ) : (
            'Chuyển khoản theo tài khoản ghi ở mục Phí dịch vụ'
          )}
          <br />
          Nội dung chuyển khoản: <code>{pending.paymentCode}</code>
          {pending.dueAt && ` · hạn ${dateTime(pending.dueAt)}`}
          <br />
          <span className="small">Gói VIP 1 bật ngay khi Admin xác nhận đã nhận tiền — bạn sẽ nhận thông báo.</span>
        </div>
      )}
      {quota.plan !== 'BUSINESS' && !pending && req?.status === 'REJECTED' && (
        <p className="muted small">Yêu cầu VIP 1 gần nhất bị từ chối{req.note ? `: ${req.note}` : ''}.</p>
      )}
      {quota.plan !== 'BUSINESS' && (
        <div className="row">
          {pending ? (
            <button className="secondary" onClick={() => confirm('Hủy yêu cầu VIP 1? Nếu đã chuyển khoản, hãy liên hệ Admin thay vì hủy.') && onCancelVip(pending.requestId)}>
              Hủy yêu cầu
            </button>
          ) : (
            <button
              onClick={() =>
                confirm(
                  `Đăng ký ${quota.plan === 'VIP1' ? 'gia hạn VIP 1 thêm' : 'VIP 1 trong'} ${quota.vipDays} ngày (đăng tối đa 5 tin cùng lúc), giá ${vnd(quota.vipPrice)}.\n` +
                    'Admin sẽ gửi hóa đơn qua thông báo; gói bật sau khi bạn chuyển khoản và Admin xác nhận. Gửi yêu cầu?',
                ) && onRequestVip()
              }
            >
              {quota.plan === 'VIP1' ? `Đăng ký gia hạn VIP 1 — ${vnd(quota.vipPrice)}` : `Đăng ký VIP 1 — ${vnd(quota.vipPrice)} / ${quota.vipDays} ngày`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function PartnerPage() {
  const [me, setMe] = useState<PartnerMe | null>(null);
  const [requests, setRequests] = useState<PartnerRequest[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const m = await api<PartnerMe>('GET', '/partners/me');
      setMe(m);
      if (m.partner?.status === 'APPROVED' && tierOf(m.partner) === 'BUSINESS') setRequests((await api<{ items: PartnerRequest[] }>('GET', '/partners/me/requests')).items);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

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

  if (!me) return <p className={error ? 'error' : 'muted'}>{error || 'Đang tải…'}</p>;
  const p = me.partner;
  const applyCard = (
    <ApplyCard
      partner={p}
      onSubmit={(body) => run(() => api('POST', '/partners/apply', { body }))}
      onUpdateEmail={(contactEmail) => run(() => api('PATCH', '/partners/me/contact', { body: { contactEmail } }))}
    />
  );

  // Chưa là đối tác / đang chờ duyệt / bị từ chối → form đăng ký. Hồ sơ cấp 2 đã gửi còn có Chi nhánh + Bảng giá:
  // Admin chỉ duyệt được cấp 2 khi có ≥ 1 chi nhánh (mục 23 danhgia — khối này từng bị mất khi tách trang).
  if (!p || (p.status !== 'APPROVED' && p.status !== 'SUSPENDED')) {
    return (
      <div className="stack">
        {error && <p className="error">{error}</p>}
        {applyCard}
        {p && tierOf(p) === 'BUSINESS' && (
          <>
            {me.branches.length === 0 && (
              <div className="notice warn">Thêm ít nhất 1 chi nhánh bên dưới — Admin chỉ duyệt được hồ sơ cấp 2 khi đã có chi nhánh.</div>
            )}
            <BranchesCard
              branches={me.branches}
              onAdd={(body) => run(() => api('POST', '/partners/me/branches', { body }))}
              onToggle={(b) => run(() => api('PATCH', `/partners/me/branches/${b.branchId}`, { body: { active: !b.active } }))}
            />
            <RulesCard
              branches={me.branches}
              rules={me.rules}
              onAdd={(body) => run(() => api('POST', '/partners/me/rules', { body }))}
              onToggle={(r) => run(() => api('PATCH', `/partners/me/rules/${r.ruleId}`, { body: { active: !r.active } }))}
            />
          </>
        )}
      </div>
    );
  }

  const business = tierOf(p) === 'BUSINESS';
  const label = partnerLabel(p);
  const openRequests = requests.filter((r) => r.listingStatus === 'ACTIVE').length;
  const suspendedNote = p.status === 'SUSPENDED' && (
    <div className="notice bad">
      Tài khoản đối tác đang bị tạm ngừng — chi nhánh và bảng giá chỉ xem được, không thêm / sửa / bật tắt cho tới khi Admin mở lại.
    </div>
  );
  // Khu đối tác cùng kiểu trang Admin: menu trái theo nhóm, mỗi mục 1 URL (/partner/…)
  const menu: { group: string; items: { to: string; label: string; badge?: number }[] }[] = [
    { group: 'Tổng quan', items: [{ to: '', label: 'Tổng quan' }] },
    { group: 'Bài viết', items: [{ to: 'new', label: 'Đăng tin' }, { to: 'listings', label: 'Tin của tôi', badge: me.quota?.open }] },
    ...(business
      ? [{ group: 'Thu mua', items: [{ to: 'requests', label: 'Tin phù hợp', badge: openRequests }, { to: 'branches', label: 'Chi nhánh' }, { to: 'rules', label: 'Bảng giá' }] }]
      : []),
    { group: 'Ngân hàng', items: [{ to: 'billing', label: 'Phí dịch vụ' }] },
    { group: 'Hồ sơ', items: [{ to: 'profile', label: 'Hồ sơ đối tác' }] },
  ];

  return (
    <div className="partner-shell">
      <aside className="admin-nav partner-nav">
        <strong className="brand">
          {business ? 'Cấp 2' : 'Cấp 1'} {label && <span className="badge ok">{label}</span>}
        </strong>
        <span className="muted small">{p.businessName}</span>
        {menu.map((g) => (
          <div key={g.group} className="admin-group">
            {g.items.length > 1 && <span className="admin-top">{g.group}</span>}
            {g.items.map((it) => (
              <NavLink key={it.to} to={`/partner${it.to ? `/${it.to}` : ''}`} end className={g.items.length > 1 ? 'admin-sub' : 'admin-top'}>
                {it.label} {!!it.badge && <span className="badge warn">{it.badge}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </aside>
      <div className="stack partner-main">
        {error && <p className="error">{error}</p>}
        <Routes>
          <Route
            index
            element={
              <>
                {suspendedNote}
                {me.quota && (
                  <QuotaCard
                    quota={me.quota}
                    onRequestVip={() => void run(() => api('POST', '/partners/me/vip-requests', { idempotencyKey: newIdempotencyKey() }))}
                    onCancelVip={(id) => void run(() => api('POST', `/partners/me/vip-requests/${id}/cancel`))}
                  />
                )}
                <div className="row">
                  <Link to="/partner/new" className="button">
                    + Đăng tin
                  </Link>
                  <Link to="/partner/listings">Tin của tôi</Link>
                  {business && <Link to="/partner/requests">Tin phù hợp ({openRequests})</Link>}
                </div>
              </>
            }
          />
          <Route path="new" element={<CreateListingPage />} />
          <Route path="listings" element={<MyListingsPage />} />
          {business && <Route path="requests" element={<RequestsCard requests={requests} />} />}
          {business && (
            <Route
              path="branches"
              element={
                <>
                  {suspendedNote}
                  <BranchesCard
                    branches={me.branches}
                    onAdd={(body) => run(() => api('POST', '/partners/me/branches', { body }))}
                    onToggle={(b) => run(() => api('PATCH', `/partners/me/branches/${b.branchId}`, { body: { active: !b.active } }))}
                  />
                </>
              }
            />
          )}
          {business && (
            <Route
              path="rules"
              element={
                <>
                  {suspendedNote}
                  <RulesCard
                    branches={me.branches}
                    rules={me.rules}
                    onAdd={(body) => run(() => api('POST', '/partners/me/rules', { body }))}
                    onToggle={(r) => run(() => api('PATCH', `/partners/me/rules/${r.ruleId}`, { body: { active: !r.active } }))}
                  />
                </>
              }
            />
          )}
          <Route path="billing" element={<BillingCard />} />
          <Route path="profile" element={applyCard} />
          <Route path="*" element={<Navigate to="/partner" replace />} />
        </Routes>
      </div>
    </div>
  );
}

type Tier = 'INDIVIDUAL' | 'BUSINESS';

/**
 * Yêu cầu làm đối tác (QĐ-34) — chỉ đối tác đã được Admin duyệt mới đăng tin.
 * Cấp 1: khách lẻ (họ tên + email). Cấp 2: doanh nghiệp / hộ kinh doanh (thêm loại hình + GPKD / MST).
 * Email liên hệ bắt buộc; SĐT không bắt buộc, khai ở trang Hồ sơ.
 */
function ApplyCard({
  partner,
  onSubmit,
  onUpdateEmail,
}: {
  partner: Partner | null;
  onSubmit: (b: Record<string, string>) => Promise<void>;
  onUpdateEmail: (email: string) => Promise<void>;
}) {
  const [tier, setTier] = useState<Tier>(partner ? (tierOf(partner) as Tier) : 'INDIVIDUAL');
  const [businessType, setBusinessType] = useState<BusinessType>(partner?.businessType ?? (partner && tierOf(partner) === 'BUSINESS' ? 'ENTERPRISE' : 'PERSONAL'));
  const [businessName, setBusinessName] = useState(partner?.businessName ?? '');
  const [licenseNo, setLicenseNo] = useState(partner?.licenseNo ?? '');
  const [contactEmail, setContactEmail] = useState(partner?.contactEmail ?? '');
  const editable = !partner || partner.status === 'PENDING' || partner.status === 'REJECTED';
  const business = tier === 'BUSINESS';
  const typeOptions = Object.keys(BUSINESS_TYPE_LABEL).filter((k) => !business || TIER2_BUSINESS_TYPES.includes(k));
  const personal = businessType === 'PERSONAL';
  // Đổi cấp → loại hình về mặc định hợp lệ của cấp đó
  const chooseTier = (t: Tier) => {
    setTier(t);
    setBusinessType(t === 'BUSINESS' ? 'ENTERPRISE' : 'PERSONAL');
  };

  return (
    <section className={`card ${partner ? '' : 'cta'}`}>
      <div className="row between">
        <h2>{partner ? 'Hồ sơ đối tác' : 'Yêu cầu làm đối tác'}</h2>
        {partner && <span className={`badge ${statusTone(partner.status)}`}>{PARTNER_STATUS_LABEL[partner.status]}</span>}
      </div>
      {!partner && (
        <p>
          Chỉ <strong>đối tác đã được Admin duyệt</strong> mới đăng tin được. Khách lẻ đăng ký <strong>cấp 1</strong>; doanh nghiệp / hộ kinh doanh
          đăng ký <strong>cấp 2</strong> để vừa đăng tin vừa thu mua theo chi nhánh và bảng giá. Đăng tin miễn phí; người bán trả{' '}
          <strong>10.000đ cho mỗi giao dịch hoàn tất</strong>, thanh toán gộp theo tháng.
        </p>
      )}
      {partner?.status === 'PENDING' && (
        <p className="muted">
          Hồ sơ đang chờ Admin duyệt.{tierOf(partner) === 'BUSINESS' && ' Hãy thêm ít nhất 1 chi nhánh và bảng giá.'}
        </p>
      )}
      {partner?.status === 'APPROVED' && (
        <p className="muted">
          Bạn đã có thể <Link to="/partner/new">đăng tin</Link>.
        </p>
      )}
      {partner?.reviewNote && <p className="muted">Ghi chú của Admin: {partner.reviewNote}</p>}
      {editable ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit({ tier, businessType, businessName, licenseNo, contactEmail });
          }}
        >
          <div className="tier-choice">
            {(['INDIVIDUAL', 'BUSINESS'] as Tier[]).map((t) => (
              <label key={t} className={tier === t ? 'selected' : ''}>
                <input type="radio" name="tier" checked={tier === t} onChange={() => chooseTier(t)} />
                <span>
                  <strong>{PARTNER_TIER_LABEL[t]}</strong>
                  <small>{t === 'INDIVIDUAL' ? 'Cá nhân muốn đăng bán đồ điện tử cũ, hỏng.' : 'Có giấy phép kinh doanh; đăng tin + thu mua theo chi nhánh, bảng giá.'}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="grid2">
            <label>
              Loại hình *
              <select value={businessType} onChange={(e) => setBusinessType(e.target.value as BusinessType)}>
                {typeOptions.map((k) => (
                  <option key={k} value={k}>
                    {BUSINESS_TYPE_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {personal ? 'Tên đối tác (họ tên hiển thị khi đăng tin) *' : 'Tên doanh nghiệp / cơ sở *'}
              <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required minLength={2} />
            </label>
            <label>
              {personal ? 'Mã số thuế cá nhân / số CCCD *' : 'Số giấy phép kinh doanh / mã số thuế *'}
              <input value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} required minLength={5} maxLength={30} />
            </label>
            <label>
              Email liên hệ *
              <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="lienhe@vidu.vn" required />
            </label>
          </div>
          <p className="muted">
            Email liên hệ hiện công khai trên tin đăng để khách liên lạc. Số điện thoại không bắt buộc — khai ở trang <Link to="/profile">Hồ sơ</Link> để khách
            gọi khi email chưa được phản hồi.
          </p>
          <button type="submit">{partner ? 'Cập nhật và gửi lại' : 'Gửi yêu cầu làm đối tác'}</button>
        </form>
      ) : (
        <>
          <p>
            <strong>{partner!.businessName}</strong> · {PARTNER_TIER_LABEL[tierOf(partner!)]}
            {partner!.businessType && ` (${BUSINESS_TYPE_LABEL[partner!.businessType]})`}
            {partner!.licenseNo && ` · ${partner!.businessType === 'PERSONAL' ? 'MST/CCCD' : 'GPKD/MST'} ${partner!.licenseNo}`}
          </p>
          {!partner!.contactEmail && <p className="warn-text">Hồ sơ chưa có email liên hệ — bắt buộc bổ sung để khách liên lạc được.</p>}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void onUpdateEmail(contactEmail);
            }}
          >
            <label className="grow">
              Email liên hệ *
              <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} required />
            </label>
            <button type="submit" disabled={contactEmail === partner!.contactEmail}>
              Lưu email
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function RequestsCard({ requests }: { requests: PartnerRequest[] }) {
  return (
    <section className="card">
      <h2>Tin phù hợp với bạn</h2>
      {requests.length === 0 ? (
        <p className="muted">Chưa có tin nào trong khu vực phục vụ.</p>
      ) : (
        <ul className="plain list">
          {requests.map((r) => (
            <li key={`${r.listingId}-${r.branchId}`}>
              <Link to={`/listings/${r.listingId}`} className="list-item">
                <div>
                  <strong>{r.title}</strong>
                  <div className="muted">
                    {CATEGORY_LABEL[r.category]} · {CONDITION_LABEL[r.condition]} ·{' '}
                    {r.unit === 'PER_DEVICE' ? `${r.quantity} cái` : `~${r.weightKg} kg`} · {r.area} · {km(r.distanceKm)} · {r.branchName}
                  </div>
                  <div className="muted">Đăng {dateTime(r.createdAt)}</div>
                </div>
                <div className="stack end">
                  <span className={`badge ${statusTone(r.listingStatus)}`}>{LISTING_STATUS_LABEL[r.listingStatus]}</span>
                  {r.quotes.map((q) => (
                    <span key={q.quoteId} className={`badge ${q.takenByOther ? 'warn' : statusTone(q.status)}`}>
                      {q.takenByOther ? 'Đang giao dịch với người khác' : QUOTE_STATUS_LABEL[q.status]}
                    </span>
                  ))}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BranchesCard({
  branches,
  onAdd,
  onToggle,
}: {
  branches: Branch[];
  onAdd: (b: unknown) => Promise<void>;
  onToggle: (b: Branch) => Promise<void>;
}) {
  const [adding, setAdding] = useState(branches.length === 0);
  const [name, setName] = useState('');
  const [point, setPoint] = useState<LatLng>();
  const [address, setAddress] = useState('');
  const [radiusKm, setRadiusKm] = useState(3);
  const [categories, setCategories] = useState<string[]>(['PHONE', 'LAPTOP']);
  const [conditions, setConditions] = useState<string[]>(['NOT_WORKING', 'PARTIALLY_WORKING']);
  const [handover, setHandover] = useState<string[]>(['DROP_OFF']);

  return (
    <section className="card">
      <div className="row between">
        <h2>Chi nhánh</h2>
        {!adding && (
          <button className="secondary" onClick={() => setAdding(true)}>
            + Thêm chi nhánh
          </button>
        )}
      </div>
      {branches.map((b) => (
        <div key={b.branchId} className="row between">
          <div>
            <strong>{b.name}</strong> · bán kính {b.radiusKm} km
            <div className="muted">{b.location.address}</div>
            <div className="muted">
              {b.categories.map((c) => CATEGORY_LABEL[c]).join(', ')} · {b.conditions.map((c) => CONDITION_LABEL[c]).join(', ')}
            </div>
          </div>
          <button className="secondary" onClick={() => void onToggle(b)}>
            {b.active ? 'Tạm ngừng' : 'Bật lại'}
          </button>
        </div>
      ))}
      {adding && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!point) return;
            void onAdd({ name, location: { ...point, address }, radiusKm, categories, conditions, handoverMethods: handover }).then(() => setAdding(false));
          }}
        >
          <h3>Chi nhánh mới</h3>
          <div className="grid2">
            <label>
              Tên chi nhánh
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              Địa chỉ
              <input value={address} onChange={(e) => setAddress(e.target.value)} required />
            </label>
          </div>
          <label>
            Bán kính phục vụ: {radiusKm} km
            <input type="range" min={1} max={5} step={0.5} value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))} />
          </label>
          <MapPicker value={point} onChange={setPoint} radiusKm={radiusKm} />
          <CheckGroup label="Loại thiết bị nhận" options={CATEGORY_LABEL} value={categories} onChange={setCategories} />
          <CheckGroup label="Tình trạng nhận" options={CONDITION_LABEL} value={conditions} onChange={setConditions} />
          <CheckGroup label="Hình thức bàn giao" options={HANDOVER_LABEL} value={handover} onChange={setHandover} />
          <div className="row">
            <button type="submit" disabled={!point}>
              Lưu chi nhánh
            </button>
            {branches.length > 0 && (
              <button type="button" className="secondary" onClick={() => setAdding(false)}>
                Hủy
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

function RulesCard({
  branches,
  rules,
  onAdd,
  onToggle,
}: {
  branches: Branch[];
  rules: PricingRule[];
  onAdd: (b: unknown) => Promise<void>;
  onToggle: (r: PricingRule) => Promise<void>;
}) {
  const [branchId, setBranchId] = useState('');
  const [category, setCategory] = useState('LAPTOP');
  const [conditions, setConditions] = useState<string[]>(['NOT_WORKING']);
  const [unit, setUnit] = useState('PER_DEVICE');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minQuantity, setMinQuantity] = useState('1');
  const branchName = (id: string) => branches.find((b) => b.branchId === id)?.name ?? '?';

  if (branches.length === 0) return null;
  return (
    <section className="card">
      <h2>Bảng giá tự động</h2>
      <p className="muted">Khi có tin phù hợp, hệ thống tự tạo "giá dự kiến" từ bảng này. Giá cuối do bạn xác nhận.</p>
      {rules.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Chi nhánh</th>
              <th>Thiết bị</th>
              <th className="num">Đơn giá</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.ruleId} className={r.active ? '' : 'muted'}>
                <td>{branchName(r.branchId)}</td>
                <td>
                  {CATEGORY_LABEL[r.category]} · {r.conditions.map((c) => CONDITION_LABEL[c]).join(', ')}
                </td>
                <td className="num">
                  {vnd(r.minPrice)} – {vnd(r.maxPrice)} {UNIT_LABEL[r.unit]}
                </td>
                <td>
                  <button className="link" onClick={() => void onToggle(r)}>
                    {r.active ? 'Tắt' : 'Bật'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void onAdd({
            branchId: branchId || branches[0]!.branchId,
            category,
            conditions,
            unit,
            minPrice: Number(minPrice),
            maxPrice: Number(maxPrice),
            minQuantity: Number(minQuantity),
          });
        }}
      >
        <h3>Thêm giá</h3>
        <div className="grid2">
          <label>
            Chi nhánh
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.branchId} value={b.branchId}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Loại thiết bị
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Đơn vị
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {Object.entries(UNIT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Số lượng / kg tối thiểu
            <input type="number" min={0} step="any" value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} />
          </label>
          <label>
            Đơn giá thấp nhất (VND)
            <input type="number" min={0} value={minPrice} onChange={(e) => setMinPrice(e.target.value)} required />
          </label>
          <label>
            Đơn giá cao nhất (VND)
            <input type="number" min={0} value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} required />
          </label>
        </div>
        <CheckGroup label="Áp dụng cho tình trạng" options={CONDITION_LABEL} value={conditions} onChange={setConditions} />
        <div className="row">
          <button type="submit">Thêm giá</button>
        </div>
      </form>
    </section>
  );
}
