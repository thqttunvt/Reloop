import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckGroup } from '../components/CheckGroup';
import { MapPicker, type LatLng } from '../components/MapPicker';
import {
  ApiError,
  api,
  newIdempotencyKey,
  uploadImage,
  type AiAnalysis,
  type BillingSummary,
  type DebtStatus,
  type Features,
  type Listing,
  type ListingQuota,
  type Partner,
  type SavedLocation,
} from '../lib/api';
import { CATEGORY_LABEL, CONDITION_LABEL, HANDOVER_LABEL, UNIT_LABEL } from '../lib/catalog';
import { errorText, vnd } from '../lib/format';

const MAX_IMAGES = 6;

export function CreateListingPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('LAPTOP');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [condition, setCondition] = useState('NOT_WORKING');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState<'PER_DEVICE' | 'PER_KG'>('PER_DEVICE');
  const [quantity, setQuantity] = useState(1);
  const [weightKg, setWeightKg] = useState('');
  const [handover, setHandover] = useState<string[]>(['DROP_OFF', 'PICKUP']);
  const [point, setPoint] = useState<LatLng>();
  const [address, setAddress] = useState('');
  const [area, setArea] = useState('');
  const [imageKeys, setImageKeys] = useState<string[]>([]);
  /** Ảnh có chữ bất thường (QĐ-36) → tin sẽ chờ Admin duyệt */
  const [flaggedKeys, setFlaggedKeys] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [imagesOff, setImagesOff] = useState(false);
  const [idemKey] = useState(newIdempotencyKey);
  const [features, setFeatures] = useState<Features>({ images: true, ai: false });
  const [aiState, setAiState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [aiNote, setAiNote] = useState('');
  /** Lượt AI đã điền form — gửi kèm khi đăng để lưu "AI gợi ý ↔ bạn chốt" làm dữ liệu cải thiện AI. */
  const [aiAnalysisId, setAiAnalysisId] = useState<string>();

  /** undefined = đang tải; null = chưa đăng ký đối tác. Chỉ đối tác đã duyệt mới đăng tin (QĐ-34). */
  const [partner, setPartner] = useState<Partner | null | undefined>(undefined);
  /** Hạn mức tin đang mở cùng lúc (QĐ-41) */
  const [quota, setQuota] = useState<ListingQuota | null>(null);
  const quotaFull = !!quota && quota.open >= quota.limit;
  const canPost = partner?.status === 'APPROVED';

  useEffect(() => {
    api<{ partner: Partner | null; quota: ListingQuota | null }>('GET', '/partners/me')
      .then((r) => {
        setPartner(r.partner);
        setQuota(r.quota);
      })
      .catch(() => setPartner(null));
  }, []);

  /** Nợ phí quá hạn > 3 ngày → không đăng tin mới; tin đang có vẫn bình thường (QĐ-40). */
  const [debt, setDebt] = useState<DebtStatus>();
  useEffect(() => {
    api<BillingSummary>('GET', '/billing/me')
      .then((b) => setDebt(b.debt))
      .catch(() => undefined);
  }, []);
  const debtBlocked = debt?.level === 'NO_POSTING' || debt?.level === 'FULL';

  const [saved, setSaved] = useState<SavedLocation[]>([]);
  const [saveLocation, setSaveLocation] = useState(false);

  // Địa điểm mặc định chọn sẵn (spec T3.5)
  useEffect(() => {
    api<{ items: SavedLocation[] }>('GET', '/locations')
      .then(({ items }) => {
        setSaved(items);
        const d = items.find((l) => l.isDefault);
        if (d) pickSaved(d);
      })
      .catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pickSaved = (l: SavedLocation) => {
    setPoint({ lat: l.location.lat, lng: l.location.lng });
    setAddress(l.location.address);
    setArea(l.area);
  };

  useEffect(() => {
    api<Features>('GET', '/features')
      .then((f) => {
        setFeatures(f);
        if (!f.images) setImagesOff(true);
      })
      .catch(() => undefined);
  }, []);

  /** AI chạy nền (QĐ-13): tạo job rồi hỏi lại 2 giây/lần, tối đa 60 giây; lỗi → nhập tay. */
  const analyze = async () => {
    setAiState('running');
    setAiNote('');
    setAiAnalysisId(undefined);
    try {
      const job = await api<AiAnalysis>('POST', '/ai/analyses', { body: { imageKeys: imageKeys.slice(0, 3) } });
      let a = job;
      for (let i = 0; i < 30 && a.status === 'PENDING'; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        a = await api<AiAnalysis>('GET', `/ai/analyses/${job.analysisId}`);
      }
      const r = a.result;
      if (a.status !== 'COMPLETED' || !r) throw new Error(a.error ?? 'AI phân tích quá lâu');
      if (r.isInappropriate || !r.isElectronicDevice) {
        setAiState('failed');
        setAiNote(r.isInappropriate ? 'Ảnh không phù hợp — vui lòng dùng ảnh khác.' : 'AI không nhận ra thiết bị điện tử trong ảnh — hãy kiểm tra lại ảnh hoặc nhập tay.');
        return;
      }
      setCategory(r.category);
      setCondition(r.condition);
      if (r.brand) setBrand(r.brand);
      if (r.model) setModel(r.model);
      if (!title && r.suggestedTitle) setTitle(r.suggestedTitle);
      const damage = r.visibleDamage.length ? `Hư hỏng thấy được: ${r.visibleDamage.join(', ')}.\n` : '';
      if (!description) setDescription(`${damage}${r.suggestedDescription}`.trim());
      setAiAnalysisId(a.analysisId);
      setAiState('done');
      setAiNote(`AI đã điền gợi ý (độ tin cậy: ${r.confidence === 'high' ? 'cao' : r.confidence === 'medium' ? 'trung bình' : 'thấp'}). Hãy kiểm tra lại trước khi đăng — AI không khẳng định máy còn chạy.`);
    } catch (e) {
      setAiState('failed');
      setAiNote(`${errorText(e)} — hãy nhập thông tin thủ công.`);
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const addImages = async (files: FileList | null) => {
    if (!files) return;
    setUploading(true);
    setError('');
    try {
      for (const f of Array.from(files).slice(0, MAX_IMAGES - imageKeys.length)) {
        const { key, flagged } = await uploadImage(f);
        setImageKeys((ks) => [...ks, key]);
        if (flagged) setFlaggedKeys((ks) => [...ks, key]);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'IMAGES_DISABLED') setImagesOff(true);
      else setError(errorText(e));
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!point) return setError('Hãy ghim vị trí trên bản đồ');
    if (!imagesOff && imageKeys.length === 0) return setError('Cần ít nhất 1 ảnh thiết bị');
    if (description.trim().length < 10) return setError('Mô tả cần ít nhất 10 ký tự');
    setBusy(true);
    setError('');
    try {
      const listing = await api<Listing>('POST', '/listings', {
        idempotencyKey: idemKey,
        body: {
          title,
          category,
          brand: brand || undefined,
          model: model || undefined,
          condition,
          description,
          unit,
          quantity,
          weightKg: unit === 'PER_KG' ? Number(weightKg) : undefined,
          handoverMethods: handover,
          location: { ...point, address },
          area,
          imageKeys,
          aiAnalysisId,
        },
      });
      if (saveLocation) {
        await api('POST', '/locations', { body: { name: area, location: { ...point, address }, area } }).catch(() => undefined);
      }
      navigate(`/listings/${listing.listingId}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
    {partner !== undefined && !canPost && <PartnerCta partner={partner} />}
    {canPost && quotaFull && (
      <div className="notice warn">
        <strong>
          Bạn đang có {quota!.open}/{quota!.limit} tin đang mở.
        </strong>{' '}
        Chờ một tin bán xong / hết hạn, hoặc gỡ bớt tin
        {quota!.plan === 'BASIC' && (
          <>
            {' '}
            — hay <Link to="/partner">đăng ký VIP 1</Link> ({vnd(quota!.vipPrice)} / {quota!.vipDays} ngày) để đăng tối đa 5 tin
          </>
        )}
        .
      </div>
    )}
    {debtBlocked && debt?.invoice && (
      <div className="notice bad">
        <strong>Tạm dừng đăng tin mới:</strong> hóa đơn phí tháng {debt.invoice.month} đã quá hạn {debt.daysOverdue} ngày. Hãy chuyển khoản{' '}
        {vnd(debt.overdueAmount)} với nội dung <strong>{debt.invoice.paymentCode}</strong> (xem ở trang <Link to="/partner">Đối tác</Link>). Các tin
        đang có vẫn hoạt động bình thường.
      </div>
    )}
    <form className="card" onSubmit={submit}>
      <h2>Đăng tin thiết bị</h2>

      <label>
        Tiêu đề *
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Laptop Dell Latitude hỏng màn hình" required minLength={3} />
      </label>
      <div className="grid2">
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
          Tình trạng
          <select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {Object.entries(CONDITION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hãng (không bắt buộc)
          <input value={brand} onChange={(e) => setBrand(e.target.value)} />
        </label>
        <label>
          Model (không bắt buộc)
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label>
          Tính giá
          <select value={unit} onChange={(e) => setUnit(e.target.value as 'PER_DEVICE' | 'PER_KG')}>
            {Object.entries(UNIT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {unit === 'PER_DEVICE' ? (
          <label>
            Số lượng (cái)
            <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
          </label>
        ) : (
          <label>
            Khối lượng ước tính (kg)
            <input type="number" min={0.1} step={0.1} value={weightKg} onChange={(e) => setWeightKg(e.target.value)} required />
          </label>
        )}
      </div>
      <label>
        Mô tả lỗi / tình trạng *
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          required
          minLength={10}
          placeholder="VD: Màn hình vỡ góc trái, không lên nguồn, còn sạc zin (ít nhất 10 ký tự)"
        />
      </label>

      <CheckGroup label="Hình thức bàn giao" options={HANDOVER_LABEL} value={handover} onChange={setHandover} />

      <h3>Ảnh * ({imageKeys.length}/{MAX_IMAGES}) — ít nhất 1 ảnh</h3>
      {imagesOff ? (
        <p className="muted">Upload ảnh chưa bật ở môi trường này — vẫn đăng tin được.</p>
      ) : (
        <label>
          JPEG, PNG hoặc WebP, tối đa 5 MB mỗi ảnh
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={uploading || imageKeys.length >= MAX_IMAGES}
            onChange={(e) => void addImages(e.target.files)}
          />
        </label>
      )}
      {uploading && <p className="muted">Đang tải ảnh lên…</p>}
      {flaggedKeys.length > 0 && (
        <div className="notice warn">
          <strong>⚠ {flaggedKeys.length} ảnh cần Admin kiểm tra.</strong> Hệ thống phát hiện chữ trong ảnh giống câu lệnh, hoặc ảnh có thể chứa nội
          dung nhạy cảm. Bạn vẫn đăng được, nhưng tin sẽ <strong>chờ Admin duyệt (1–3 ngày)</strong> trước khi hiện trên Chợ. Nếu ảnh bình thường,
          Admin sẽ duyệt. Muốn đăng ngay, hãy tải lại trang và dùng ảnh khác.
        </div>
      )}
      {features.ai && imageKeys.length > 0 && (
        <div className="row">
          <button type="button" className="secondary" onClick={() => void analyze()} disabled={aiState === 'running' || uploading}>
            {aiState === 'running' ? 'AI đang phân tích…' : '✨ Phân tích ảnh bằng AI'}
          </button>
        </div>
      )}
      {aiNote && <p className={aiState === 'failed' ? 'warn-text' : 'muted'}>{aiNote}</p>}

      <h3>Vị trí</h3>
      <p className="muted">Đối tác chỉ thấy khu vực và khoảng cách ước tính, không thấy địa chỉ chính xác của bạn.</p>
      {saved.length > 0 && (
        <label>
          Địa điểm đã lưu
          <select onChange={(e) => { const l = saved.find((x) => x.locationId === e.target.value); if (l) pickSaved(l); }} defaultValue="">
            <option value="" disabled>
              Chọn…
            </option>
            {saved.map((l) => (
              <option key={l.locationId} value={l.locationId}>
                {l.name}
                {l.isDefault ? ' (mặc định)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <MapPicker value={point} onChange={setPoint} />
      <div className="grid2">
        <label>
          Địa chỉ (chỉ bạn thấy)
          <input value={address} onChange={(e) => setAddress(e.target.value)} required />
        </label>
        <label>
          Khu vực hiển thị cho đối tác (phường, quận)
          <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="VD: Phường Linh Trung, TP Thủ Đức" required minLength={2} />
        </label>
      </div>

      <label className="check">
        <input type="checkbox" checked={saveLocation} onChange={(e) => setSaveLocation(e.target.checked)} />
        Lưu địa điểm này cho lần sau
      </label>
      <p className="muted">* bắt buộc. Cần đủ thông tin, ít nhất 1 ảnh và vị trí trên bản đồ mới đăng được.</p>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" disabled={!canPost || debtBlocked || quotaFull || busy || uploading || handover.length === 0 || !point || (!imagesOff && imageKeys.length === 0)}>
          {busy ? 'Đang đăng…' : flaggedKeys.length > 0 ? 'Gửi tin để Admin duyệt' : 'Đăng tin'}
        </button>
        {partner !== undefined && !canPost && <span className="muted">Cần được duyệt làm đối tác trước khi đăng.</span>}
      </div>
    </form>
    </div>
  );
}

/** Làm nổi bật yêu cầu làm đối tác cho người chưa được duyệt (QĐ-34). */
function PartnerCta({ partner }: { partner: Partner | null }) {
  if (partner?.status === 'PENDING') {
    return (
      <section className="card cta">
        <h3>⏳ Yêu cầu làm đối tác đang chờ Admin duyệt</h3>
        <p>Bạn có thể soạn sẵn tin; nút "Đăng tin" mở khi hồ sơ được duyệt. <Link to="/partner">Xem / sửa hồ sơ đối tác</Link></p>
      </section>
    );
  }
  if (partner?.status === 'SUSPENDED') {
    return (
      <section className="card cta">
        <h3>Tài khoản đối tác đang tạm ngừng</h3>
        <p>Liên hệ Admin để được mở lại.{partner.reviewNote && ` Ghi chú: ${partner.reviewNote}`}</p>
      </section>
    );
  }
  return (
    <section className="card cta">
      <h3>🤝 Trở thành đối tác để đăng tin</h3>
      <p>
        Chỉ đối tác đã được Admin duyệt mới đăng tin được. <strong>Khách lẻ</strong> đăng ký đối tác cấp 1;{' '}
        <strong>doanh nghiệp / hộ kinh doanh</strong> đăng ký cấp 2. Đăng tin miễn phí; chỉ thu 10.000đ cho mỗi giao dịch hoàn tất, trả gộp theo tháng.
        {partner?.status === 'REJECTED' && ' Hồ sơ trước đã bị từ chối — bạn có thể sửa và gửi lại.'}
      </p>
      <Link to="/partner" className="button">
        {partner?.status === 'REJECTED' ? 'Sửa và gửi lại yêu cầu' : 'Gửi yêu cầu làm đối tác'}
      </Link>
    </section>
  );
}
