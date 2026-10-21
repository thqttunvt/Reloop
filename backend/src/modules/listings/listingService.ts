import type { Principal } from '../../auth/auth';
import {
  CATEGORIES,
  CONDITIONS,
  HANDOVER_METHODS,
  PRICE_UNITS,
  type Category,
  type Condition,
  type HandoverMethod,
  type PriceUnit,
} from '../../domain/catalog';
import { listingMachine, quoteMachine, type ListingStatus, type QuoteStatus } from '../../domain/stateMachines';
import { HOUR_MS, type Clock } from '../../shared/clock';
import { badRequest, conflict, notFound } from '../../shared/errors';
import { geohashCellsAround, geohashEncode, haversineKm, roundDistanceKm } from '../../shared/geo';
import { log } from '../../http/log';
import { newId } from '../../shared/ids';
import { geoPoint, int, listOf, oneOf, optionalNum, str, type GeoPoint } from '../../shared/validate';
import { assertOwnImageKeys, type ImageStore } from '../../storage/imageStore';
import { gsi1, keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';
import { timerOp } from '../jobs/timers';
import type { Analysis } from '../ai/aiService';
import type { BillingService } from '../billing/billingService';
import type { RiskService } from '../risk/riskService';
import type { NotificationService } from '../notifications/notificationService';
import { LISTING_QUOTA, partnerTier, type Branch, type Partner, type PartnerService, type PricingRule } from '../partners/partnerService';
import type { UserService } from '../users/userService';

const DAY_MS = 24 * HOUR_MS;
/** Tin hết hạn sau 7 ngày (QĐ-12). */
export const LISTING_TTL_MS = 7 * DAY_MS;
/** Partner có 24h trả lời yêu cầu xác nhận giá (giaiphap D3). */
export const CONFIRMATION_TTL_MS = DAY_MS;
/** Offer hiệu lực 24h–7 ngày, mặc định 72h, không quá hạn tin (giaiphap D3). */
const OFFER_HOURS = { min: 24, max: 168, default: 72 };
/** Gỡ tin trong khoảng này sau khi giao dịch bị hủy / thất bại → nghi bán ngoài, tính phí (QĐ-39). */
export const SUSPECT_WINDOW_MS = 72 * HOUR_MS;

export interface Listing extends Item {
  listingId: string;
  ownerId: string;
  title: string;
  category: Category;
  brand?: string;
  model?: string;
  condition: Condition;
  description: string;
  unit: PriceUnit;
  quantity: number;
  weightKg?: number;
  handoverMethods: HandoverMethod[];
  /** Vị trí chính xác — chỉ Owner thấy (QĐ-20). */
  location: GeoPoint;
  /** Khu vực hiển thị cho Partner (phường/quận). */
  area: string;
  geohash: string;
  imageKeys: string[];
  status: ListingStatus;
  /** Giao dịch đang chạy (Listing MATCHED). */
  activeTransactionId?: string;
  /** Admin gỡ tin vi phạm. */
  moderated?: { note?: string; at: string };
  /** Giao dịch gần nhất bị hủy / thất bại do hai bên rồi tin mở lại — để phát hiện bán ngoài (QĐ-39). */
  lastEndedDeal?: { transactionId: string; buyerId: string; status: 'CANCELLED' | 'FAILED'; at: string };
  /** Ảnh có chữ bị gắn cờ (QĐ-36) → tin chờ Admin duyệt trước khi lên Chợ. */
  review?: {
    /** IMAGE_TEXT_FLAGGED: chữ bất thường (QĐ-36) · IMAGE_SENSITIVE_SUSPECTED: nghi ảnh nhạy cảm (QĐ-43) */
    reason: 'IMAGE_TEXT_FLAGGED' | 'IMAGE_SENSITIVE_SUSPECTED';
    images: { key: string; text: string; kind?: 'TEXT' | 'SENSITIVE' }[];
    at: string;
    decision?: { approved: boolean; note?: string; by: string; at: string };
  };
  matchingStatus: 'PENDING' | 'DONE';
  matchCount: number;
  quoteCount: number;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface Match extends Item {
  listingId: string;
  branchId: string;
  partnerId: string;
  partnerName: string;
  branchName: string;
  /** Đã làm tròn 0,5 km (giaiphap E4). */
  distanceKm: number;
  handoverMethods: HandoverMethod[];
}

export interface Quote extends Item {
  quoteId: string;
  listingId: string;
  partnerId: string;
  branchId: string;
  partnerName: string;
  branchName: string;
  distanceKm: number;
  kind: 'AUTO' | 'MANUAL';
  status: QuoteStatus;
  /** Giá dự kiến từ quy tắc giá — "chưa được Partner xác nhận" (T7.3). */
  estimate?: {
    unit: PriceUnit;
    unitMin: number;
    unitMax: number;
    quantity?: number;
    totalMin?: number;
    totalMax?: number;
    /** Rule Snapshot: sửa rule sau này không đổi báo giá đã tạo (T7.2). */
    rule: Pick<PricingRule, 'ruleId' | 'category' | 'conditions' | 'unit' | 'minPrice' | 'maxPrice' | 'minQuantity'>;
  };
  /** Giá Partner cam kết (tổng tiền VND). */
  offer?: { price: number; note?: string; validUntil: string; at: string; differsFromEstimate: boolean };
  requestedAt?: string;
  responseDeadline?: string;
  rejectNote?: string;
  createdAt: string;
  updatedAt: string;
}

const OPEN_QUOTE: QuoteStatus[] = ['ESTIMATED', 'CONFIRMATION_REQUESTED', 'CONFIRMED_OFFER'];

/** Lượng dùng để tính tổng: số cái (PER_DEVICE) hoặc số kg (PER_KG). */
const amountFor = (listing: Pick<Listing, 'unit' | 'quantity' | 'weightKg'>) =>
  listing.unit === 'PER_DEVICE' ? listing.quantity : listing.weightKg;

export class ListingService {
  /**
   * Chốt các mốc đã quá hạn của giao dịch đang chạy (vd yêu cầu hủy quá 5 phút — QĐ-38) trước khi hiển thị tin,
   * để tin quay lại Chợ đúng hạn mà không chờ job 15 phút. app.ts gán = TransactionService.loadAndSettle.
   */
  settleTransaction?: (transactionId: string) => Promise<unknown>;

  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly users: UserService,
    private readonly partners: PartnerService,
    private readonly images: ImageStore,
    private readonly notifications: NotificationService,
    private readonly billing: BillingService,
    private readonly risk: RiskService,
  ) {}

  // ------------------------------------------------------------------ Trạng thái hiệu lực
  // Chưa có job nền (Epic 10): hết hạn được tính khi đọc và khi thao tác.

  effectiveListingStatus(l: Listing, now = this.clock.now()): ListingStatus {
    return l.status === 'ACTIVE' && now.toISOString() >= l.expiresAt ? 'EXPIRED' : l.status;
  }

  effectiveQuoteStatus(q: Quote, l: Listing, now = this.clock.now()): QuoteStatus {
    if (!OPEN_QUOTE.includes(q.status)) return q.status;
    const t = now.toISOString();
    const ls = this.effectiveListingStatus(l, now);
    if (ls === 'EXPIRED' || ls === 'CANCELLED') return 'EXPIRED';
    if (ls === 'COMPLETED') return 'INVALIDATED'; // tin đã bán cho người khác
    if (q.status === 'CONFIRMATION_REQUESTED' && q.responseDeadline && t >= q.responseDeadline) return 'EXPIRED';
    if (q.status === 'CONFIRMED_OFFER' && q.offer && t >= q.offer.validUntil) return 'EXPIRED';
    return q.status;
  }

  /**
   * Báo giá để hiển thị. Tin đang giao dịch với người khác → takenByOther: báo giá vẫn giữ (giao dịch hủy thì
   * chọn lại được — QĐ-14) nhưng chưa làm gì được (mục 1b danhgia).
   */
  quoteView(q: Quote, l: Listing, now = this.clock.now()) {
    const status = this.effectiveQuoteStatus(q, l, now);
    return { ...q, status, takenByOther: l.status === 'MATCHED' && OPEN_QUOTE.includes(status) };
  }

  /** Báo cho khách đang hỏi (chat) + đơn vị thu mua đã được match: tin đã có người chốt (QĐ-38). */
  async notifyTaken(listingId: string, title: string, exclude: string[]) {
    const [convs, matches] = await Promise.all([
      this.table.query<Item & { partnerId: string }>(keys.listingPk(listingId), { skPrefix: 'CONV#' }),
      this.matchesOf(listingId),
    ]);
    const others = [...convs.map((c) => c.partnerId), ...matches.map((m) => m.partnerId)].filter((id) => !exclude.includes(id));
    if (others.length === 0) return;
    await this.notifications.notify(others, {
      type: 'LISTING_TAKEN',
      title: 'Tin bạn quan tâm đã có người chốt giá',
      body: `${title} — tin sẽ quay lại Chợ nếu giao dịch bị hủy`,
      link: `/listings/${listingId}`,
    });
  }

  /** Người bán bị tạm ngừng / khóa do nợ phí → người khác không giao dịch được với tin (mục 3 danhgia, QĐ-40). */
  async requireSellerAvailable(l: Pick<Listing, 'ownerId'>) {
    if (!(await this.partners.isAvailable(l.ownerId))) {
      throw conflict('SELLER_UNAVAILABLE', 'Người bán đang tạm ngừng hoạt động — chưa giao dịch được với tin này');
    }
  }

  /**
   * Tin kết thúc (chủ tin hủy / Admin gỡ / hết 7 ngày) → các báo giá còn mở hết hạn theo.
   * Đây là hệ quả hệ thống tự làm nên kiểm tra với vai SYSTEM qua bảng luật (quy tắc 1 — mục 9 danhgia).
   * Tối đa 98 báo giá để cả transaction ≤ 100 thao tác.
   */
  private expireOpenQuotes(quotes: Quote[], now: string): WriteOp[] {
    return quotes
      .filter((q) => OPEN_QUOTE.includes(q.status))
      .slice(0, 98)
      .map((q) => {
        quoteMachine.assertTransition(q.status, 'EXPIRED', 'SYSTEM');
        return putVersioned({ ...q, status: 'EXPIRED', updatedAt: now }, q.version ?? 1);
      });
  }

  private requireOpenListing(l: Listing) {
    const s = this.effectiveListingStatus(l);
    if (s !== 'ACTIVE') throw conflict('LISTING_NOT_ACTIVE', `Tin đang ở trạng thái ${s}`);
  }

  // ------------------------------------------------------------------ Đăng tin (T4.2)

  async create(principal: Principal, input: Record<string, unknown>) {
    await this.users.requireTerms(principal);
    const seller = await this.partners.requireCanPost(principal.userId);
    // Hạn mức tin đang mở cùng lúc: cấp 1 = 3, VIP 1 = 5, cấp 2 = 10 (QĐ-41)
    const quota = this.partners.listingQuota(seller);
    const open = await this.openListingCount(principal.userId);
    if (open >= quota.limit) {
      throw conflict(
        'LISTING_QUOTA_REACHED',
        quota.plan === 'BASIC'
          ? `Bạn đang có ${open}/${quota.limit} tin đang mở. Chờ một tin kết thúc, hoặc nâng lên VIP 1 để đăng tối đa ${LISTING_QUOTA.VIP1} tin`
          : `Bạn đang có ${open}/${quota.limit} tin đang mở — chờ một tin kết thúc rồi đăng tiếp`,
        { open, limit: quota.limit, plan: quota.plan },
      );
    }
    const unit = oneOf(input.unit, PRICE_UNITS, 'unit');
    const quantity = int(input.quantity ?? 1, 'quantity', { min: 1, max: 10_000 });
    const weightKg = optionalNum(input.weightKg, 'weightKg', { min: 0.1, max: 100_000 });
    if (unit === 'PER_KG' && weightKg === undefined) throw badRequest('INVALID_WEIGHT_KG', 'Hàng theo kg cần khối lượng ước tính');
    const location = geoPoint(input.location);
    const now = this.clock.now();
    const listingId = newId();
    const createdAt = now.toISOString();

    const listing: Listing = {
      ...keys.listing(listingId),
      ...gsi1.ownerListing(principal.userId, createdAt),
      listingId,
      ownerId: principal.userId,
      title: str(input.title, 'title', { min: 3, max: 120 })!,
      category: oneOf(input.category, CATEGORIES, 'category'),
      brand: str(input.brand, 'brand', { max: 60, optional: true }),
      model: str(input.model, 'model', { max: 80, optional: true }),
      condition: oneOf(input.condition, CONDITIONS, 'condition'),
      description: str(input.description, 'description', { min: 10, max: 2000 }),
      unit,
      quantity,
      weightKg,
      handoverMethods: listOf(input.handoverMethods, HANDOVER_METHODS, 'handoverMethods'),
      location,
      area: str(input.area, 'area', { min: 2, max: 120 })!,
      geohash: geohashEncode(location.lat, location.lng),
      imageKeys: assertOwnImageKeys(principal.userId, input.imageKeys),
      status: 'ACTIVE',
      matchingStatus: 'PENDING',
      matchCount: 0,
      quoteCount: 0,
      createdAt,
      expiresAt: new Date(now.getTime() + LISTING_TTL_MS).toISOString(),
      updatedAt: createdAt,
    };
    // Bắt buộc ít nhất 1 ảnh (môi trường không có S3 — dev local — thì bỏ qua)
    if (this.images.enabled && listing.imageKeys.length === 0) throw badRequest('IMAGES_REQUIRED', 'Cần ít nhất 1 ảnh thiết bị');
    // Đăng tin miễn phí — phí dịch vụ tính theo giao dịch hoàn tất (QĐ-37, thay phí đăng bài QĐ-33).
    await this.images.assertModerated(listing.imageKeys); // ảnh phải qua kiểm duyệt Rekognition
    await this.images.markAttached(listing.imageKeys); // ảnh có chủ → không bị xóa như ảnh rác (QĐ-27)
    const label = await this.aiLabelOp(principal.userId, input.aiAnalysisId, listing);

    // QĐ-36: có ảnh bị gắn cờ → chưa lên Chợ, chưa matching; chờ Admin duyệt
    const flagged = await this.flaggedImages(principal.userId, listing.imageKeys);
    if (flagged.length > 0) {
      const reason = flagged.some((f) => f.kind === 'SENSITIVE') ? 'IMAGE_SENSITIVE_SUSPECTED' : 'IMAGE_TEXT_FLAGGED';
      const pending: Listing = { ...listing, status: 'PENDING_REVIEW', review: { reason, images: flagged, at: createdAt } };
      await this.table.transact([
        putVersioned(pending, 0),
        putNew({ ...keys.listingReview(createdAt, listingId), listingId }),
        ...(label ? [label] : []),
      ]);
      log('warn', 'listing_flagged', { listingId, ownerId: principal.userId, images: flagged.length });
      await this.notifications.notify(principal.userId, {
        type: 'LISTING_PENDING_REVIEW',
        title: 'Tin đăng đang chờ Admin duyệt (1–3 ngày)',
        body: `${listing.title} — ${reason === 'IMAGE_SENSITIVE_SUSPECTED' ? 'ảnh cần kiểm tra nội dung' : 'ảnh có chữ bất thường cần kiểm tra'}`,
        link: `/listings/${listingId}`,
      });
      return { ...pending, version: 1 };
    }

    await this.table.transact([
      putVersioned(listing, 0),
      timerOp('LISTING_EXPIRE', listingId, listing.expiresAt),
      putNew({ ...keys.feedItem(createdAt.slice(0, 7), createdAt, listingId), listingId }),
      ...(label ? [label] : []),
    ]);
    // TODO(QĐ-13): chuyển matching sang Lambda chạy nền; hiện chạy ngay trong request (≤ 9 query).
    return this.runMatching({ ...listing, version: 1 });
  }

  /**
   * Bộ dữ liệu nhãn để sau này huấn luyện / đánh giá model: AI gợi ý gì ↔ người đăng chốt gì khi bấm Đăng.
   * Chỉ ghi khi tin dùng một lượt phân tích AI thành công của chính người đăng; sai / thiếu thì bỏ qua, không chặn đăng tin.
   */
  private async aiLabelOp(userId: string, rawAnalysisId: unknown, listing: Listing): Promise<WriteOp | undefined> {
    if (typeof rawAnalysisId !== 'string' || !/^[a-f0-9]{32}$/.test(rawAnalysisId)) return undefined;
    const k = keys.aiAnalysis(userId, rawAnalysisId);
    const analysis = await this.table.get<Analysis>(k.pk, k.sk);
    if (analysis?.status !== 'COMPLETED' || !analysis.result) return undefined;
    const ai = analysis.result;
    const final = { category: listing.category, brand: listing.brand ?? null, model: listing.model ?? null, condition: listing.condition };
    const same = (a: string | null, b: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
    const changed = (Object.keys(final) as (keyof typeof final)[]).filter((f) => !same(ai[f], final[f]));
    return putNew({
      ...keys.aiLabel(listing.createdAt.slice(0, 7), listing.createdAt, listing.listingId),
      listingId: listing.listingId,
      userId,
      analysisId: analysis.analysisId,
      modelId: analysis.modelId,
      imageKeys: analysis.imageKeys,
      ai: { category: ai.category, brand: ai.brand, model: ai.model, condition: ai.condition, visibleDamage: ai.visibleDamage, confidence: ai.confidence },
      final: { ...final, title: listing.title, description: listing.description },
      changed,
      createdAt: listing.createdAt,
    });
  }

  // ------------------------------------------------------------------ Duyệt tin bị gắn cờ (QĐ-36)

  /** Ghi nhận ảnh có chữ bị gắn cờ lúc upload; giữ 3 ngày (đủ để đăng tin), sau đó DynamoDB TTL tự xóa. */
  async recordImageFlag(userId: string, imageKey: string, text: string, kind: 'TEXT' | 'SENSITIVE' = 'TEXT') {
    const at = this.clock.now();
    await this.table.transact([
      { type: 'put', item: { ...keys.imageFlag(userId, imageKey), imageKey, text: text.slice(0, 2000), kind, at: at.toISOString(), ttl: Math.floor(at.getTime() / 1000) + 3 * 86_400 } },
    ]);
  }

  private async flaggedImages(userId: string, imageKeys: string[]) {
    if (imageKeys.length === 0) return [];
    const flags = await this.table.query<Item & { imageKey: string; text: string; kind?: 'TEXT' | 'SENSITIVE' }>(keys.userPk(userId), { skPrefix: 'IMGFLAG#' });
    return flags.filter((f) => imageKeys.includes(f.imageKey)).map((f) => ({ key: f.imageKey, text: f.text, kind: f.kind ?? 'TEXT' }));
  }

  /** Hàng đợi duyệt cho Admin, cũ nhất trước — kèm ảnh, chữ đọc được và người đăng. */
  async listPendingReview() {
    const refs = await this.table.query<Item & { listingId: string }>(keys.listingReviewPk(), { limit: 100 });
    const items = await Promise.all(
      refs.map(async (r) => {
        const k = keys.listing(r.listingId);
        const listing = await this.table.get<Listing>(k.pk, k.sk);
        if (!listing || listing.status !== 'PENDING_REVIEW') return undefined;
        const [seller, images] = await Promise.all([this.sellerOf(listing.ownerId), this.imageUrls(listing)]);
        const { location: _location, geohash: _geohash, ...rest } = listing;
        return { listing: rest, seller, images };
      }),
    );
    return items.filter((x) => !!x);
  }

  /**
   * Admin duyệt: tin lên Chợ, chạy matching, hạn 7 ngày tính từ lúc duyệt.
   * Từ chối: tin CANCELLED kèm lý do. Cả hai đều báo cho chủ tin.
   */
  async reviewListing(adminId: string, listingId: string, approve: boolean, note?: string) {
    const decided = await withOptimisticRetry(async () => {
      const listing = await this.load(listingId);
      if (listing.status !== 'PENDING_REVIEW') throw conflict('LISTING_NOT_PENDING_REVIEW', `Tin đang ở trạng thái ${listing.status}`);
      const to: ListingStatus = approve ? 'ACTIVE' : 'CANCELLED';
      listingMachine.assertTransition('PENDING_REVIEW', to, 'ADMIN');
      const now = this.clock.now();
      const at = now.toISOString();
      const decision = { approved: approve, note, by: adminId, at };
      const next: Listing = approve
        ? { ...listing, status: 'ACTIVE', expiresAt: new Date(now.getTime() + LISTING_TTL_MS).toISOString(), review: { ...listing.review!, decision }, updatedAt: at }
        : { ...listing, status: 'CANCELLED', moderated: { note, at }, review: { ...listing.review!, decision }, updatedAt: at };
      const ops: WriteOp[] = [
        putVersioned(next, listing.version ?? 1),
        { type: 'delete', ...keys.listingReview(listing.review?.at ?? listing.createdAt, listingId) },
      ];
      if (approve) {
        ops.push(timerOp('LISTING_EXPIRE', listingId, next.expiresAt), putNew({ ...keys.feedItem(at.slice(0, 7), at, listingId), listingId }));
      }
      await this.table.transact(ops);
      return { ...next, version: (listing.version ?? 1) + 1 };
    });
    // Admin từ chối tin (ảnh vi phạm) → tính 1 lần vi phạm của người đăng (QĐ-43)
    if (!approve) await this.risk.recordViolation(decided.ownerId, 'LISTING_REJECTED', { type: 'LISTING', id: listingId, title: decided.title }, note);
    await this.notifications.notify(decided.ownerId, {
      type: approve ? 'LISTING_APPROVED' : 'LISTING_REJECTED',
      title: approve ? 'Tin đăng đã được Admin duyệt và đang hiện trên Chợ' : 'Tin đăng bị Admin từ chối',
      body: note ?? decided.title,
      link: `/listings/${listingId}`,
    });
    return approve ? this.runMatching(decided) : decided;
  }

  // ------------------------------------------------------------------ Matching + Auto-Quote (T6.1, T7.2)

  private async runMatching(listing: Listing): Promise<Listing> {
    const { lat, lng } = listing.location;
    const candidates = new Map<string, Branch>();
    for (const b of await this.partners.branchesInCells(geohashCellsAround(lat, lng))) {
      candidates.set(`${b.partnerId}#${b.branchId}`, b);
    }

    const partnerCache = new Map<string, Promise<Partner | undefined>>();
    const ruleCache = new Map<string, Promise<PricingRule[]>>();
    const now = this.clock.now().toISOString();
    const amount = amountFor(listing);
    const ops: WriteOp[] = [];
    let matchCount = 0;
    let quoteCount = 0;
    const matchedPartners = new Set<string>();

    for (const b of candidates.values()) {
      if (!b.active || b.partnerId === listing.ownerId) continue;
      if (!b.categories.includes(listing.category) || !b.conditions.includes(listing.condition)) continue;
      if (!b.handoverMethods.some((m) => listing.handoverMethods.includes(m))) continue;
      const km = haversineKm(lat, lng, b.location.lat, b.location.lng);
      if (km > b.radiusKm) continue;
      if (!partnerCache.has(b.partnerId)) partnerCache.set(b.partnerId, this.partners.get(b.partnerId));
      const partner = await partnerCache.get(b.partnerId)!;
      // Chỉ đối tác cấp 2 thu mua (QĐ-34); chi nhánh còn sót của hồ sơ đã đổi sang cấp 1 bị bỏ qua
      if (partner?.status !== 'APPROVED' || partnerTier(partner) !== 'BUSINESS') continue;

      const distanceKm = roundDistanceKm(km);
      const base = { listingId: listing.listingId, branchId: b.branchId, partnerId: b.partnerId, partnerName: partner.businessName, branchName: b.name, distanceKm };
      matchCount++;
      matchedPartners.add(b.partnerId);
      ops.push(
        { type: 'put', item: { ...keys.match(listing.listingId, b.branchId), ...base, handoverMethods: b.handoverMethods.filter((m) => listing.handoverMethods.includes(m)) } },
        {
          type: 'put',
          item: {
            ...keys.partnerRequest(b.partnerId, listing.createdAt, listing.listingId, b.branchId),
            ...base,
            title: listing.title,
            category: listing.category,
            condition: listing.condition,
            unit: listing.unit,
            quantity: listing.quantity,
            weightKg: listing.weightKg,
            area: listing.area,
            createdAt: listing.createdAt,
            expiresAt: listing.expiresAt,
          },
        },
      );

      if (!ruleCache.has(b.partnerId)) ruleCache.set(b.partnerId, this.partners.listRules(b.partnerId));
      const rule = (await ruleCache.get(b.partnerId)!).find(
        (r) =>
          r.active &&
          r.branchId === b.branchId &&
          r.category === listing.category &&
          r.conditions.includes(listing.condition) &&
          r.unit === listing.unit &&
          (amount ?? 0) >= r.minQuantity,
      );
      // Không có rule phù hợp → không tạo giá giả; Partner gửi offer thủ công (§23.3).
      if (!rule) continue;
      quoteCount++;
      const quoteId = `A${b.branchId}`; // 1 báo giá tự động / chi nhánh / tin → chạy lại không nhân bản
      const quote: Quote = {
        ...keys.quote(listing.listingId, quoteId),
        ...base,
        quoteId,
        kind: 'AUTO',
        status: 'ESTIMATED',
        estimate: {
          unit: rule.unit,
          unitMin: rule.minPrice,
          unitMax: rule.maxPrice,
          quantity: amount,
          totalMin: amount === undefined ? undefined : Math.round(rule.minPrice * amount),
          totalMax: amount === undefined ? undefined : Math.round(rule.maxPrice * amount),
          rule: {
            ruleId: rule.ruleId,
            category: rule.category,
            conditions: rule.conditions,
            unit: rule.unit,
            minPrice: rule.minPrice,
            maxPrice: rule.maxPrice,
            minQuantity: rule.minQuantity,
          },
        },
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      ops.push({ type: 'put', item: quote });
    }

    for (let i = 0; i < ops.length; i += 25) await this.table.transact(ops.slice(i, i + 25));

    // Đọc lại tin mỗi lần thử: chủ tin có thể vừa hủy / sửa tin trong lúc ghép (mục 10 danhgia) → không văng 500
    const done = await withOptimisticRetry(async () => {
      const current = await this.load(listing.listingId);
      const next: Listing = { ...current, matchingStatus: 'DONE', matchCount, quoteCount, updatedAt: now };
      await this.table.transact([putVersioned(next, current.version ?? 1)]);
      return { ...next, version: (current.version ?? 1) + 1 };
    });
    await this.notifications.notify([...matchedPartners], {
      type: 'NEW_MATCH',
      title: 'Có tin mới phù hợp khu vực của bạn',
      body: listing.title,
      link: `/listings/${listing.listingId}`,
    });
    if (matchCount === 0) {
      await this.notifications.notify(listing.ownerId, {
        type: 'NO_MATCH',
        title: 'Chưa có đơn vị thu mua phù hợp trong 5 km',
        body: listing.title,
        link: `/listings/${listing.listingId}`,
      });
    }
    return done;
  }

  // ------------------------------------------------------------------ Đọc

  private async load(listingId: string): Promise<Listing> {
    const k = keys.listing(listingId);
    const listing = await this.table.get<Listing>(k.pk, k.sk);
    if (!listing) throw notFound('tin đăng');
    return listing;
  }

  /**
   * Số tin đang mở cùng lúc của người bán (QĐ-41): chờ duyệt, đang mở (chưa hết hạn), đang giao dịch.
   * Đọc tin tạo trong 60 ngày gần nhất qua GSI1 (tin mở tối đa 7 ngày; giao dịch kéo dài hơn 60 ngày rất hiếm).
   */
  async openListingCount(ownerId: string) {
    const now = this.clock.now();
    const from = `LISTING#${new Date(now.getTime() - 60 * DAY_MS).toISOString()}`;
    const mine = await this.table.query<Listing>(gsi1.ownerListingPk(ownerId), { index: 'gsi1', skRange: { from } });
    return mine.filter((l) => ['PENDING_REVIEW', 'ACTIVE', 'MATCHED'].includes(this.effectiveListingStatus(l, now))).length;
  }

  /** Đọc tin, đã chốt mốc quá hạn của giao dịch đang chạy (dùng cho chat — QĐ-38). */
  async current(listingId: string): Promise<Listing> {
    return this.settled(await this.load(listingId));
  }

  /** Tin đang giao dịch → chốt mốc quá hạn của giao dịch rồi đọc lại tin (trạng thái có thể đã đổi). */
  private async settled(listing: Listing): Promise<Listing> {
    if (listing.status !== 'MATCHED' || !listing.activeTransactionId || !this.settleTransaction) return listing;
    await this.settleTransaction(listing.activeTransactionId);
    const k = keys.listing(listing.listingId);
    return (await this.table.get<Listing>(k.pk, k.sk)) ?? listing;
  }

  private quotesOf(listingId: string) {
    return this.table.query<Quote>(keys.listingPk(listingId), { skPrefix: 'QUOTE#' });
  }

  private matchesOf(listingId: string) {
    return this.table.query<Match>(keys.listingPk(listingId), { skPrefix: 'MATCH#' });
  }

  private async imageUrls(listing: Listing) {
    if (!this.images.enabled) return [];
    return Promise.all(listing.imageKeys.map((k) => this.images.viewUrl(k)));
  }

  async listMine(ownerId: string) {
    const items = await Promise.all(
      (await this.table.query<Listing>(gsi1.ownerListingPk(ownerId), { index: 'gsi1', ascending: false, limit: 50 })).map((l) => this.settled(l)),
    );
    return items.map((l) => ({ ...l, status: this.effectiveListingStatus(l) }));
  }

  /**
   * Thông tin công khai của người bán: tên trong hồ sơ đối tác + liên hệ (email, SĐT nếu có) để khách
   * liên lạc (QĐ-34). Không bao giờ có địa chỉ / vị trí chính xác (QĐ-20).
   */
  async sellerOf(ownerId: string) {
    const [profile, partner] = await Promise.all([this.users.get(ownerId), this.partners.get(ownerId)]);
    const approved = partner?.status === 'APPROVED' ? partner : undefined;
    return {
      displayName: approved?.businessName ?? profile?.fullName ?? (profile?.email ? profile.email.split('@')[0]! : 'Người bán'),
      memberSince: profile?.createdAt,
      tier: approved ? partnerTier(approved) : undefined,
      contact: approved ? await this.partners.contactOf(approved) : undefined,
    };
  }

  private publicView(listing: Listing) {
    const { location: _location, geohash: _geohash, lastEndedDeal: _deal, ...rest } = listing;
    return { ...rest, status: this.effectiveListingStatus(listing) };
  }

  /**
   * Bảng tin kiểu chợ (mọi người đã đăng nhập): tin đang mở, mới nhất trước.
   * Tin chỉ mở 7 ngày kể từ lúc lên Chợ → chỉ đọc con trỏ trong 7 ngày gần nhất, theo từng đợt `batch`
   * bằng điều kiện sort key (không giới hạn số tin / tháng — mục 11 danhgia). cursor = sort key của tin cuối trang trước.
   */
  async feed(viewerId: string, cursor?: string, limit = 20, batch = 50) {
    const now = this.clock.now();
    const items: Awaited<ReturnType<ListingService['feedCard']>>[] = [];
    let nextCursor: string | undefined;
    const available = new Map<string, Promise<boolean>>();
    const sellerOk = (ownerId: string) => {
      if (!available.has(ownerId)) available.set(ownerId, this.partners.isAvailable(ownerId));
      return available.get(ownerId)!;
    };
    for await (const r of this.feedRefs(now, cursor, batch)) {
      const k = keys.listing(r.listingId);
      const raw = await this.table.get<Listing>(k.pk, k.sk);
      const listing = raw && (await this.settled(raw));
      if (!listing || this.effectiveListingStatus(listing, now) !== 'ACTIVE') continue;
      if (listing.ownerId !== viewerId && !(await sellerOk(listing.ownerId))) continue; // người bán tạm ngừng → ẩn khỏi Chợ
      items.push(await this.feedCard(listing, viewerId));
      if (items.length >= limit) {
        nextCursor = r.sk;
        break;
      }
    }
    return { items, nextCursor };
  }

  /** Con trỏ bảng tin trong 7 ngày gần nhất, mới nhất trước, sau `cursor`; đọc từng đợt, sang ngăn tháng trước khi hết. */
  private async *feedRefs(now: Date, cursor: string | undefined, batch: number) {
    const from = new Date(now.getTime() - LISTING_TTL_MS).toISOString();
    const months = [...new Set([now.toISOString().slice(0, 7), from.slice(0, 7)])];
    batch = Math.max(2, batch); // mỗi đợt phải có ít nhất 1 con trỏ mới ngoài chính con trỏ cũ
    let to = cursor;
    for (const month of months) {
      if (to && to.slice(0, 7) < month) continue; // cursor đã ở ngăn tháng cũ hơn
      for (;;) {
        const raw = await this.table.query<Item & { listingId: string }>(keys.feedPk(month), { skRange: { from, to }, ascending: false, limit: batch });
        for (const r of raw) if (r.sk !== to) yield r; // khoảng gồm cả 2 đầu → bỏ chính con trỏ
        if (raw.length < batch) break; // hết ngăn tháng này
        to = raw[raw.length - 1]!.sk;
      }
    }
  }

  private async feedCard(listing: Listing, viewerId: string) {
    const [seller, images] = await Promise.all([this.sellerOf(listing.ownerId), this.imageUrls(listing)]);
    return { listing: this.publicView(listing), seller, images, isMine: listing.ownerId === viewerId };
  }

  /**
   * Owner xem đầy đủ; Partner được match thấy thêm báo giá của mình;
   * người khác (đã đăng nhập) xem dạng công khai như trên bảng tin — chỉ khu vực, không có vị trí chính xác (QĐ-20).
   */
  async getForViewer(listingId: string, viewerId: string) {
    const listing = await this.settled(await this.load(listingId));
    const now = this.clock.now();
    const [matches, quotes, images] = await Promise.all([this.matchesOf(listingId), this.quotesOf(listingId), this.imageUrls(listing)]);
    const withStatus = (q: Quote) => this.quoteView(q, listing, now);

    if (listing.ownerId === viewerId) {
      return {
        role: 'OWNER' as const,
        listing: { ...listing, status: this.effectiveListingStatus(listing, now) },
        images,
        seller: await this.sellerOf(listing.ownerId),
        matches,
        quotes: quotes.map(withStatus),
      };
    }
    const seller = await this.sellerOf(listing.ownerId);
    const myMatches = matches.filter((m) => m.partnerId === viewerId);
    if (myMatches.length === 0) {
      if (!['ACTIVE', 'MATCHED'].includes(this.effectiveListingStatus(listing, now))) throw notFound('tin đăng');
      // Chỉ người mua trong giao dịch mới thấy đường dẫn tới giao dịch (QĐ-38)
      const txId = listing.activeTransactionId;
      const tk = txId ? keys.transaction(txId) : undefined;
      const buyerId = tk ? (await this.table.get<Item & { partnerId: string }>(tk.pk, tk.sk))?.partnerId : undefined;
      // Người bán bị tạm ngừng / khóa → tin ẩn với người ngoài (người mua đang giao dịch vẫn xem được)
      if (buyerId !== viewerId && !(await this.partners.isAvailable(listing.ownerId))) throw notFound('tin đăng');
      const view = { ...this.publicView(listing), activeTransactionId: buyerId === viewerId ? txId : undefined };
      return { role: 'VIEWER' as const, listing: view, images, seller, matches: [], quotes: [] };
    }
    return {
      role: 'PARTNER' as const,
      listing: this.publicView(listing),
      images,
      seller,
      matches: myMatches,
      quotes: quotes.filter((q) => q.partnerId === viewerId).map(withStatus),
    };
  }

  /** Matching Requests của Partner (T7.5), kèm trạng thái tin và báo giá của chính Partner. */
  async partnerRequests(partnerId: string) {
    const reqs = await this.table.query<Item & { listingId: string; branchId: string }>(keys.partnerPk(partnerId), {
      skPrefix: 'REQ#',
      ascending: false,
      limit: 50,
    });
    const now = this.clock.now();
    return Promise.all(
      reqs.map(async (r) => {
        const k = keys.listing(r.listingId);
        const [listing, quotes] = await Promise.all([this.table.get<Listing>(k.pk, k.sk), this.quotesOf(r.listingId)]);
        const mine = listing ? quotes.filter((q) => q.branchId === r.branchId).map((q) => this.quoteView(q, listing, now)) : [];
        return { ...r, listingStatus: listing ? this.effectiveListingStatus(listing, now) : 'CANCELLED', quotes: mine };
      }),
    );
  }

  // ------------------------------------------------------------------ Owner

  /**
   * Hủy (gỡ) tin khi chưa có giao dịch; đóng các báo giá đang mở (giaiphap B7).
   * Gỡ trong 72 giờ sau khi giao dịch bị hủy / thất bại → tính phí nghi bán ngoài ReLoop (QĐ-39).
   */
  async cancel(ownerId: string, listingId: string) {
    const done = await withOptimisticRetry(async () => {
      const listing = await this.load(listingId);
      if (listing.ownerId !== ownerId) throw notFound('tin đăng');
      // Chủ tin hủy được cả khi tin còn chờ Admin duyệt (QĐ-36)
      const pendingReview = listing.status === 'PENDING_REVIEW';
      if (!pendingReview) this.requireOpenListing(listing);
      listingMachine.assertTransition(pendingReview ? 'PENDING_REVIEW' : 'ACTIVE', 'CANCELLED', 'OWNER');
      const now = this.clock.now().toISOString();
      const next: Listing = { ...listing, status: 'CANCELLED', updatedAt: now };
      const quoteOps = this.expireOpenQuotes(await this.quotesOf(listingId), now);
      const reviewOps: WriteOp[] = pendingReview ? [{ type: 'delete', ...keys.listingReview(listing.review?.at ?? listing.createdAt, listingId) }] : [];
      const deal = pendingReview ? undefined : this.suspectedDeal(listing);
      const feeOps: WriteOp[] = deal
        ? [...this.billing.suspectedFeeOps(ownerId, listing, deal.transactionId, now), this.risk.suspicionOp(ownerId, listing, deal.transactionId, now)]
        : [];
      await this.table.transact([putVersioned(next, listing.version ?? 1), ...quoteOps, ...reviewOps, ...feeOps]);
      return { ...next, version: (listing.version ?? 1) + 1, suspectedFee: !!deal };
    });
    if (done.suspectedFee) {
      log('warn', 'suspected_offline_sale', { listingId, ownerId });
      await this.notifications.notify(ownerId, {
        type: 'FEE_SUSPECTED',
        title: `Đã tính phí ${this.billing.feePerTransaction.toLocaleString('vi-VN')}đ: gỡ tin ngay sau khi hủy giao dịch`,
        body: `${done.title} — nếu bạn không bán bên ngoài, hãy khiếu nại ở trang Đối tác → Phí dịch vụ`,
        link: '/partner',
      });
      await this.risk.evaluate(ownerId).catch((err) => log('error', 'risk_evaluate_failed', { ownerId, error: err instanceof Error ? err.message : String(err) }));
    }
    return done;
  }

  /** Giao dịch vừa hủy / thất bại trong 72 giờ → gỡ tin lúc này bị nghi đã bán ngoài (QĐ-39). */
  suspectedDeal(listing: Listing, now = this.clock.now()) {
    const deal = listing.lastEndedDeal;
    return deal && now.getTime() - Date.parse(deal.at) < SUSPECT_WINDOW_MS ? deal : undefined;
  }

  /**
   * Admin gỡ tin vi phạm (T14.5, QĐ-43): tin đang mở / chờ duyệt → CANCELLED, đóng báo giá.
   * Tin đang giao dịch → ném LISTING_IN_TRANSACTION (gọi trước khi đóng báo cáo → báo cáo vẫn mở).
   * Tin đã kết thúc (hủy / hết hạn / hoàn tất) → không còn trên Chợ, không làm gì.
   */
  async adminHide(listingId: string, note?: string, opts: { notify?: boolean } = {}) {
    const hidden = await withOptimisticRetry(async () => {
      const listing = await this.load(listingId);
      if (listing.status === 'MATCHED') {
        throw conflict('LISTING_IN_TRANSACTION', 'Tin đang giao dịch — chưa gỡ được. Xử lý qua giao dịch / tranh chấp, hoặc chọn Tạm ngừng');
      }
      if (listing.status !== 'ACTIVE' && listing.status !== 'PENDING_REVIEW') return undefined;
      listingMachine.assertTransition(listing.status, 'CANCELLED', 'ADMIN');
      const reviewOps: WriteOp[] =
        listing.status === 'PENDING_REVIEW' ? [{ type: 'delete', ...keys.listingReview(listing.review?.at ?? listing.createdAt, listingId) }] : [];
      const now = this.clock.now().toISOString();
      const quoteOps = this.expireOpenQuotes(await this.quotesOf(listingId), now);
      const next: Listing = { ...listing, status: 'CANCELLED', moderated: { note, at: now }, updatedAt: now };
      await this.table.transact([putVersioned(next, listing.version ?? 1), ...quoteOps, ...reviewOps]);
      return next;
    });
    if (hidden && opts.notify !== false) {
      await this.notifications.notify(hidden.ownerId, {
        type: 'LISTING_HIDDEN',
        title: 'Tin đăng bị Admin gỡ do vi phạm',
        body: note ?? hidden.title,
        link: `/listings/${listingId}`,
      });
    }
  }

  /** Job nền: tin quá 7 ngày chưa chọn đối tác → EXPIRED, đóng báo giá đang mở (QĐ-12, giaiphap B7). */
  async expireIfDue(listingId: string) {
    const expired = await withOptimisticRetry(async () => {
      const k = keys.listing(listingId);
      const listing = await this.table.get<Listing>(k.pk, k.sk);
      if (!listing || listing.status !== 'ACTIVE' || this.clock.now().toISOString() < listing.expiresAt) return undefined;
      listingMachine.assertTransition('ACTIVE', 'EXPIRED', 'SYSTEM');
      const now = this.clock.now().toISOString();
      const quoteOps = this.expireOpenQuotes(await this.quotesOf(listingId), now);
      const next: Listing = { ...listing, status: 'EXPIRED', updatedAt: now };
      await this.table.transact([putVersioned(next, listing.version ?? 1), ...quoteOps]);
      return next;
    });
    if (expired) {
      await this.notifications.notify(expired.ownerId, {
        type: 'LISTING_EXPIRED',
        title: 'Tin đăng đã hết hạn 7 ngày',
        body: expired.title,
        link: `/listings/${listingId}`,
      });
    }
  }

  /** Owner yêu cầu Partner xác nhận giá dự kiến (T7.3). */
  async requestConfirmation(ownerId: string, listingId: string, quoteId: string) {
    await this.partners.requireSeller(ownerId);
    const q = await this.changeQuote(listingId, quoteId, (listing, quote, now) => {
      if (listing.ownerId !== ownerId) throw notFound('tin đăng');
      this.requireOpenListing(listing);
      quoteMachine.assertTransition(this.effectiveQuoteStatus(quote, listing, now), 'CONFIRMATION_REQUESTED', 'OWNER');
      const deadline = Math.min(now.getTime() + CONFIRMATION_TTL_MS, Date.parse(listing.expiresAt));
      return { ...quote, status: 'CONFIRMATION_REQUESTED', requestedAt: now.toISOString(), responseDeadline: new Date(deadline).toISOString() };
    });
    await this.notifications.notify(q.partnerId, {
      type: 'CONFIRMATION_REQUESTED',
      title: 'Chủ tin yêu cầu bạn xác nhận giá (trong 24 giờ)',
      link: `/listings/${listingId}`,
    });
    return q;
  }

  // ------------------------------------------------------------------ Partner

  /** Partner xác nhận bằng một giá cụ thể — được khác khoảng dự kiến, Owner thấy cảnh báo (QĐ-16). */
  async confirm(partnerId: string, listingId: string, quoteId: string, input: Record<string, unknown>) {
    await this.partners.requireApprovedBusiness(partnerId);
    const price = int(input.price, 'price', { min: 1, max: 1_000_000_000 });
    const note = str(input.note, 'note', { max: 500, optional: true });
    const hours = int(input.validHours ?? OFFER_HOURS.default, 'validHours', OFFER_HOURS);
    const sellerOk = await this.partners.isAvailable((await this.load(listingId)).ownerId);
    const q = await this.changeQuote(listingId, quoteId, (listing, quote, now) => {
      if (quote.partnerId !== partnerId) throw notFound('báo giá');
      this.requireOpenListing(listing);
      quoteMachine.assertTransition(this.effectiveQuoteStatus(quote, listing, now), 'CONFIRMED_OFFER', 'PARTNER');
      if (!sellerOk) throw conflict('SELLER_UNAVAILABLE', 'Người bán đang tạm ngừng hoạt động — chưa giao dịch được với tin này');
      const e = quote.estimate;
      const differsFromEstimate = !!e && e.totalMin !== undefined && e.totalMax !== undefined && (price < e.totalMin || price > e.totalMax);
      return { ...quote, status: 'CONFIRMED_OFFER', offer: this.offer(listing, now, price, hours, note, differsFromEstimate) };
    });
    await this.notifyOwner(listingId, 'QUOTE_CONFIRMED', `${q.partnerName} đã xác nhận giá ${price.toLocaleString('vi-VN')}đ`);
    return q;
  }

  async reject(partnerId: string, listingId: string, quoteId: string, input: Record<string, unknown>) {
    await this.partners.requireApprovedBusiness(partnerId);
    const note = str(input.note, 'note', { max: 500, optional: true });
    const q = await this.changeQuote(listingId, quoteId, (listing, quote, now) => {
      if (quote.partnerId !== partnerId) throw notFound('báo giá');
      quoteMachine.assertTransition(this.effectiveQuoteStatus(quote, listing, now), 'REJECTED', 'PARTNER');
      return { ...quote, status: 'REJECTED', rejectNote: note };
    });
    await this.notifyOwner(listingId, 'QUOTE_REJECTED', `${q.partnerName} từ chối xác nhận giá`);
    return q;
  }

  /** Rút offer chưa được chọn (giaiphap D5). */
  async withdraw(partnerId: string, listingId: string, quoteId: string) {
    await this.partners.requireApprovedBusiness(partnerId);
    return this.changeQuote(listingId, quoteId, (listing, quote, now) => {
      if (quote.partnerId !== partnerId) throw notFound('báo giá');
      quoteMachine.assertTransition(this.effectiveQuoteStatus(quote, listing, now), 'WITHDRAWN', 'PARTNER');
      return { ...quote, status: 'WITHDRAWN' };
    });
  }

  /** Manual Offer (T7.4): chỉ chi nhánh đã được match; mỗi chi nhánh tối đa 1 offer đang mở. */
  async manualOffer(partnerId: string, listingId: string, input: Record<string, unknown>) {
    await this.partners.requireApprovedBusiness(partnerId);
    const branchId = str(input.branchId, 'branchId', { max: 64 })!;
    const price = int(input.price, 'price', { min: 1, max: 1_000_000_000 });
    const note = str(input.note, 'note', { max: 500, optional: true });
    const hours = int(input.validHours ?? OFFER_HOURS.default, 'validHours', OFFER_HOURS);

    const listing = await this.load(listingId);
    this.requireOpenListing(listing);
    await this.requireSellerAvailable(listing);
    const mk = keys.match(listingId, branchId);
    const match = await this.table.get<Match>(mk.pk, mk.sk);
    if (!match || match.partnerId !== partnerId) throw notFound('tin đăng');
    const now = this.clock.now();
    const open = (await this.quotesOf(listingId)).some(
      (q) => q.branchId === branchId && q.kind === 'MANUAL' && this.effectiveQuoteStatus(q, listing, now) === 'CONFIRMED_OFFER',
    );
    if (open) throw conflict('OFFER_ALREADY_OPEN', 'Chi nhánh đã có một offer đang hiệu lực cho tin này');

    const quoteId = `M${newId()}`;
    const quote: Quote = {
      ...keys.quote(listingId, quoteId),
      quoteId,
      listingId,
      partnerId,
      branchId,
      partnerName: match.partnerName,
      branchName: match.branchName,
      distanceKm: match.distanceKm,
      kind: 'MANUAL',
      status: 'CONFIRMED_OFFER',
      offer: this.offer(listing, now, price, hours, note, false),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.table.transact([putVersioned(quote, 0)]);
    await this.notifyOwner(listingId, 'NEW_OFFER', `${match.partnerName} gửi báo giá ${price.toLocaleString('vi-VN')}đ`);
    return { ...quote, version: 1 };
  }

  private async notifyOwner(listingId: string, type: string, title: string) {
    const k = keys.listing(listingId);
    const listing = await this.table.get<Listing>(k.pk, k.sk);
    if (listing) await this.notifications.notify(listing.ownerId, { type, title, body: listing.title, link: `/listings/${listingId}` });
  }

  private offer(listing: Listing, now: Date, price: number, hours: number, note: string | undefined, differsFromEstimate: boolean) {
    const validUntil = Math.min(now.getTime() + hours * HOUR_MS, Date.parse(listing.expiresAt));
    return { price, note, validUntil: new Date(validUntil).toISOString(), at: now.toISOString(), differsFromEstimate };
  }

  private changeQuote(listingId: string, quoteId: string, change: (l: Listing, q: Quote, now: Date) => Quote): Promise<Quote> {
    return withOptimisticRetry(async () => {
      const listing = await this.load(listingId);
      const k = keys.quote(listingId, quoteId);
      const quote = await this.table.get<Quote>(k.pk, k.sk);
      if (!quote) throw notFound('báo giá');
      const now = this.clock.now();
      const next = { ...change(listing, quote, now), updatedAt: now.toISOString() };
      await this.table.transact([putVersioned(next, quote.version ?? 1)]);
      return { ...next, version: (quote.version ?? 1) + 1 };
    });
  }
}
