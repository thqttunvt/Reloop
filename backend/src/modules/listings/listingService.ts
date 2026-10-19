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
import type { NotificationService } from '../notifications/notificationService';
import { partnerTier, type Branch, type Partner, type PartnerService, type PricingRule } from '../partners/partnerService';
import type { UserService } from '../users/userService';

const DAY_MS = 24 * HOUR_MS;
/** Tin hết hạn sau 7 ngày (QĐ-12). */
export const LISTING_TTL_MS = 7 * DAY_MS;
/** Partner có 24h trả lời yêu cầu xác nhận giá (giaiphap D3). */
export const CONFIRMATION_TTL_MS = DAY_MS;
/** Offer hiệu lực 24h–7 ngày, mặc định 72h, không quá hạn tin (giaiphap D3). */
const OFFER_HOURS = { min: 24, max: 168, default: 72 };

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
  /** Ảnh có chữ bị gắn cờ (QĐ-36) → tin chờ Admin duyệt trước khi lên Chợ. */
  review?: {
    reason: 'IMAGE_TEXT_FLAGGED';
    images: { key: string; text: string }[];
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
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly users: UserService,
    private readonly partners: PartnerService,
    private readonly images: ImageStore,
    private readonly notifications: NotificationService,
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
    if (q.status === 'CONFIRMATION_REQUESTED' && q.responseDeadline && t >= q.responseDeadline) return 'EXPIRED';
    if (q.status === 'CONFIRMED_OFFER' && q.offer && t >= q.offer.validUntil) return 'EXPIRED';
    return q.status;
  }

  private requireOpenListing(l: Listing) {
    const s = this.effectiveListingStatus(l);
    if (s !== 'ACTIVE') throw conflict('LISTING_NOT_ACTIVE', `Tin đang ở trạng thái ${s}`);
  }

  // ------------------------------------------------------------------ Đăng tin (T4.2)

  async create(principal: Principal, input: Record<string, unknown>) {
    await this.users.requireTerms(principal);
    await this.partners.requireCanPost(principal.userId);
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
    // TODO(T8.15): thu phí đăng bài khi đã có cách nạp tiền vào ví.
    await this.images.assertModerated(listing.imageKeys); // ảnh phải qua kiểm duyệt Rekognition
    await this.images.markAttached(listing.imageKeys); // ảnh có chủ → không bị xóa như ảnh rác (QĐ-27)
    const label = await this.aiLabelOp(principal.userId, input.aiAnalysisId, listing);

    // QĐ-36: có ảnh bị gắn cờ → chưa lên Chợ, chưa matching; chờ Admin duyệt
    const flagged = await this.flaggedImages(principal.userId, listing.imageKeys);
    if (flagged.length > 0) {
      const pending: Listing = { ...listing, status: 'PENDING_REVIEW', review: { reason: 'IMAGE_TEXT_FLAGGED', images: flagged, at: createdAt } };
      await this.table.transact([
        putVersioned(pending, 0),
        putNew({ ...keys.listingReview(createdAt, listingId), listingId }),
        ...(label ? [label] : []),
      ]);
      log('warn', 'listing_flagged', { listingId, ownerId: principal.userId, images: flagged.length });
      await this.notifications.notify(principal.userId, {
        type: 'LISTING_PENDING_REVIEW',
        title: 'Tin đăng đang chờ Admin duyệt (1–3 ngày)',
        body: `${listing.title} — ảnh có chữ bất thường cần kiểm tra`,
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
  async recordImageFlag(userId: string, imageKey: string, text: string) {
    const at = this.clock.now();
    await this.table.transact([
      { type: 'put', item: { ...keys.imageFlag(userId, imageKey), imageKey, text: text.slice(0, 2000), at: at.toISOString(), ttl: Math.floor(at.getTime() / 1000) + 3 * 86_400 } },
    ]);
  }

  private async flaggedImages(userId: string, imageKeys: string[]) {
    if (imageKeys.length === 0) return [];
    const flags = await this.table.query<Item & { imageKey: string; text: string }>(keys.userPk(userId), { skPrefix: 'IMGFLAG#' });
    return flags.filter((f) => imageKeys.includes(f.imageKey)).map((f) => ({ key: f.imageKey, text: f.text }));
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

    const done: Listing = { ...listing, matchingStatus: 'DONE', matchCount, quoteCount, updatedAt: now };
    await this.table.transact([putVersioned(done, listing.version ?? 1)]);
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
    return { ...done, version: (listing.version ?? 1) + 1 };
  }

  // ------------------------------------------------------------------ Đọc

  private async load(listingId: string): Promise<Listing> {
    const k = keys.listing(listingId);
    const listing = await this.table.get<Listing>(k.pk, k.sk);
    if (!listing) throw notFound('tin đăng');
    return listing;
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
    const items = await this.table.query<Listing>(gsi1.ownerListingPk(ownerId), { index: 'gsi1', ascending: false, limit: 50 });
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
    const { location: _location, geohash: _geohash, ...rest } = listing;
    return { ...rest, status: this.effectiveListingStatus(listing) };
  }

  /**
   * Bảng tin kiểu chợ (mọi người đã đăng nhập): tin đang mở, mới nhất trước.
   * Đọc 2 ngăn tháng gần nhất (tin chỉ mở 7 ngày). cursor = createdAt của tin cuối trang trước.
   */
  async feed(viewerId: string, cursor?: string, limit = 20) {
    const now = this.clock.now();
    const months = [now.toISOString().slice(0, 7), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)];
    const refs = (await Promise.all(months.map((m) => this.table.query<Item & { listingId: string }>(keys.feedPk(m), { ascending: false, limit: 200 }))))
      .flat()
      .filter((r) => !cursor || r.sk < cursor)
      .sort((a, b) => b.sk.localeCompare(a.sk));
    const items: Awaited<ReturnType<ListingService['feedCard']>>[] = [];
    let nextCursor: string | undefined;
    for (const r of refs) {
      const k = keys.listing(r.listingId);
      const listing = await this.table.get<Listing>(k.pk, k.sk);
      if (!listing || this.effectiveListingStatus(listing, now) !== 'ACTIVE') continue;
      items.push(await this.feedCard(listing, viewerId));
      if (items.length >= limit) {
        nextCursor = r.sk;
        break;
      }
    }
    return { items, nextCursor };
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
    const listing = await this.load(listingId);
    const now = this.clock.now();
    const [matches, quotes, images] = await Promise.all([this.matchesOf(listingId), this.quotesOf(listingId), this.imageUrls(listing)]);
    const withStatus = (q: Quote) => ({ ...q, status: this.effectiveQuoteStatus(q, listing, now) });

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
      return { role: 'VIEWER' as const, listing: this.publicView(listing), images, seller, matches: [], quotes: [] };
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
        const mine = listing
          ? quotes.filter((q) => q.branchId === r.branchId).map((q) => ({ ...q, status: this.effectiveQuoteStatus(q, listing, now) }))
          : [];
        return { ...r, listingStatus: listing ? this.effectiveListingStatus(listing, now) : 'CANCELLED', quotes: mine };
      }),
    );
  }

  // ------------------------------------------------------------------ Owner

  /** Hủy tin khi chưa có giao dịch; đóng các báo giá đang mở (giaiphap B7). */
  async cancel(ownerId: string, listingId: string) {
    return withOptimisticRetry(async () => {
      const listing = await this.load(listingId);
      if (listing.ownerId !== ownerId) throw notFound('tin đăng');
      // Chủ tin hủy được cả khi tin còn chờ Admin duyệt (QĐ-36)
      const pendingReview = listing.status === 'PENDING_REVIEW';
      if (!pendingReview) this.requireOpenListing(listing);
      listingMachine.assertTransition(pendingReview ? 'PENDING_REVIEW' : 'ACTIVE', 'CANCELLED', 'OWNER');
      const now = this.clock.now().toISOString();
      const next: Listing = { ...listing, status: 'CANCELLED', updatedAt: now };
      const quoteOps: WriteOp[] = (await this.quotesOf(listingId))
        .filter((q) => OPEN_QUOTE.includes(q.status))
        .slice(0, 98)
        .map((q) => putVersioned({ ...q, status: 'EXPIRED', updatedAt: now }, q.version ?? 1));
      const reviewOps: WriteOp[] = pendingReview ? [{ type: 'delete', ...keys.listingReview(listing.review?.at ?? listing.createdAt, listingId) }] : [];
      await this.table.transact([putVersioned(next, listing.version ?? 1), ...quoteOps, ...reviewOps]);
      return { ...next, version: (listing.version ?? 1) + 1 };
    });
  }

  /** Admin ẩn tin vi phạm (T14.5): tin đang mở → CANCELLED, đóng báo giá. */
  async adminHide(listingId: string, note?: string) {
    const hidden = await withOptimisticRetry(async () => {
      const listing = await this.load(listingId);
      if (listing.status !== 'ACTIVE') return undefined;
      listingMachine.assertTransition('ACTIVE', 'CANCELLED', 'ADMIN');
      const now = this.clock.now().toISOString();
      const quoteOps: WriteOp[] = (await this.quotesOf(listingId))
        .filter((q) => OPEN_QUOTE.includes(q.status))
        .slice(0, 98)
        .map((q) => putVersioned({ ...q, status: 'EXPIRED', updatedAt: now }, q.version ?? 1));
      const next: Listing = { ...listing, status: 'CANCELLED', moderated: { note, at: now }, updatedAt: now };
      await this.table.transact([putVersioned(next, listing.version ?? 1), ...quoteOps]);
      return next;
    });
    if (hidden) {
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
      const quoteOps: WriteOp[] = (await this.quotesOf(listingId))
        .filter((q) => OPEN_QUOTE.includes(q.status))
        .slice(0, 98)
        .map((q) => putVersioned({ ...q, status: 'EXPIRED', updatedAt: now }, q.version ?? 1));
      const next: Listing = { ...listing, status: 'EXPIRED', updatedAt: now };
      await this.table.transact([putVersioned(next, listing.version ?? 1), ...quoteOps]);
      return next;
    });
    if (expired) {
      // TODO(T8.15): hoàn phí đăng bài khi bật lại thu phí.
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
    const q = await this.changeQuote(listingId, quoteId, (listing, quote, now) => {
      if (quote.partnerId !== partnerId) throw notFound('báo giá');
      this.requireOpenListing(listing);
      quoteMachine.assertTransition(this.effectiveQuoteStatus(quote, listing, now), 'CONFIRMED_OFFER', 'PARTNER');
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
