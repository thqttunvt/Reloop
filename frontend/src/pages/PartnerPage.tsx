import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckGroup } from '../components/CheckGroup';
import { MapPicker, type LatLng } from '../components/MapPicker';
import { api, type Branch, type Partner, type PartnerRequest, type PricingRule } from '../lib/api';
import {
  BUSINESS_TYPE_LABEL,
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

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <ApplyCard
        partner={p}
        onSubmit={(body) => run(() => api('POST', '/partners/apply', { body }))}
        onUpdateEmail={(contactEmail) => run(() => api('PATCH', '/partners/me/contact', { body: { contactEmail } }))}
      />

      {p && tierOf(p) === 'BUSINESS' && (
        <>
          {p.status === 'APPROVED' && <RequestsCard requests={requests} />}
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
  const [businessType, setBusinessType] = useState(partner?.businessType ?? 'ENTERPRISE');
  const [businessName, setBusinessName] = useState(partner?.businessName ?? '');
  const [licenseNo, setLicenseNo] = useState(partner?.licenseNo ?? '');
  const [contactEmail, setContactEmail] = useState(partner?.contactEmail ?? '');
  const editable = !partner || partner.status === 'PENDING' || partner.status === 'REJECTED';
  const business = tier === 'BUSINESS';

  return (
    <section className={`card ${partner ? '' : 'cta'}`}>
      <div className="row between">
        <h2>{partner ? 'Hồ sơ đối tác' : 'Yêu cầu làm đối tác'}</h2>
        {partner && <span className={`badge ${statusTone(partner.status)}`}>{PARTNER_STATUS_LABEL[partner.status]}</span>}
      </div>
      {!partner && (
        <p>
          Chỉ <strong>đối tác đã được Admin duyệt</strong> mới đăng tin được. Khách lẻ đăng ký <strong>cấp 1</strong>; doanh nghiệp / hộ kinh doanh
          đăng ký <strong>cấp 2</strong> để vừa đăng tin vừa thu mua theo chi nhánh và bảng giá.
        </p>
      )}
      {partner?.status === 'PENDING' && (
        <p className="muted">
          Hồ sơ đang chờ Admin duyệt.{tierOf(partner) === 'BUSINESS' && ' Hãy thêm ít nhất 1 chi nhánh và bảng giá.'}
        </p>
      )}
      {partner?.status === 'APPROVED' && (
        <p className="muted">
          Bạn đã có thể <Link to="/listings/new">đăng tin</Link>.
        </p>
      )}
      {partner?.reviewNote && <p className="muted">Ghi chú của Admin: {partner.reviewNote}</p>}
      {editable ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit(business ? { tier, businessType, businessName, licenseNo, contactEmail } : { tier, businessName, contactEmail });
          }}
        >
          <div className="tier-choice">
            {(['INDIVIDUAL', 'BUSINESS'] as Tier[]).map((t) => (
              <label key={t} className={tier === t ? 'selected' : ''}>
                <input type="radio" name="tier" checked={tier === t} onChange={() => setTier(t)} />
                <span>
                  <strong>{PARTNER_TIER_LABEL[t]}</strong>
                  <small>{t === 'INDIVIDUAL' ? 'Cá nhân muốn đăng bán đồ điện tử cũ, hỏng.' : 'Có giấy phép kinh doanh; đăng tin + thu mua theo chi nhánh, bảng giá.'}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="grid2">
            {business && (
              <label>
                Loại hình
                <select value={businessType} onChange={(e) => setBusinessType(e.target.value as 'ENTERPRISE' | 'HOUSEHOLD')}>
                  {Object.entries(BUSINESS_TYPE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {business ? 'Tên doanh nghiệp / cơ sở' : 'Tên đối tác (họ tên hiển thị khi đăng tin)'}
              <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} required minLength={2} />
            </label>
            {business && (
              <label>
                Số giấy phép kinh doanh / mã số thuế
                <input value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} required minLength={5} />
              </label>
            )}
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
            {partner!.licenseNo && ` · GPKD ${partner!.licenseNo}`}
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
                    <span key={q.quoteId} className={`badge ${statusTone(q.status)}`}>
                      {QUOTE_STATUS_LABEL[q.status]}
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
