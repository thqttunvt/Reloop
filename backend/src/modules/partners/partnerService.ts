import type { Principal } from '../../auth/auth';
import {
  CATEGORIES,
  CONDITIONS,
  HANDOVER_METHODS,
  MAX_RADIUS_KM,
  MIN_RADIUS_KM,
  PRICE_UNITS,
  type Category,
  type Condition,
  type HandoverMethod,
  type PriceUnit,
} from '../../domain/catalog';
import type { Clock } from '../../shared/clock';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors';
import { geohashEncode } from '../../shared/geo';
import { newId } from '../../shared/ids';
import { bool, geoPoint, int, listOf, num, oneOf, str, type GeoPoint } from '../../shared/validate';
import { gsi1, keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putVersioned, type Item, type Table } from '../../store/table';
import type { NotificationService } from '../notifications/notificationService';
import type { UserService } from '../users/userService';

export const PARTNER_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/**
 * Cấp đối tác (QĐ-34):
 *  INDIVIDUAL — cấp 1: khách lẻ, được đăng tin bán.
 *  BUSINESS   — cấp 2: doanh nghiệp / hộ kinh doanh, được đăng tin + có chi nhánh, bảng giá, nhận tin phù hợp.
 */
export const PARTNER_TIERS = ['INDIVIDUAL', 'BUSINESS'] as const;
export type PartnerTier = (typeof PARTNER_TIERS)[number];
export const BUSINESS_TYPES = ['ENTERPRISE', 'HOUSEHOLD'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export interface Partner extends Item {
  partnerId: string;
  /** Hồ sơ cũ (trước QĐ-34) không có tier → coi là cấp 2. Đọc qua partnerTier(). */
  tier?: PartnerTier;
  /** Cấp 2: doanh nghiệp hay hộ kinh doanh. */
  businessType?: BusinessType;
  /** Tên hiển thị của đối tác: họ tên (cấp 1) hoặc tên doanh nghiệp / cơ sở (cấp 2). */
  businessName: string;
  /** Số giấy phép kinh doanh / mã số thuế (QĐ-10) — chỉ cấp 2. */
  licenseNo?: string;
  /** Email liên hệ, bắt buộc cả 2 cấp (hồ sơ cũ có thể thiếu). */
  contactEmail?: string;
  /** Hồ sơ cũ: SĐT khai khi đăng ký. Hiện SĐT liên hệ lấy từ hồ sơ người dùng (không bắt buộc). */
  phone?: string;
  status: PartnerStatus;
  reviewNote?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Branch extends Item {
  branchId: string;
  partnerId: string;
  name: string;
  location: GeoPoint;
  geohash: string;
  radiusKm: number;
  categories: Category[];
  conditions: Condition[];
  handoverMethods: HandoverMethod[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PricingRule extends Item {
  ruleId: string;
  partnerId: string;
  branchId: string;
  category: Category;
  conditions: Condition[];
  unit: PriceUnit;
  /** Đơn giá VND (theo cái hoặc theo kg). */
  minPrice: number;
  maxPrice: number;
  /** Số lượng (cái) hoặc khối lượng (kg) tối thiểu. */
  minQuantity: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const parseEmail = (value: unknown): string => {
  const email = str(value, 'contactEmail', { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('INVALID_CONTACT_EMAIL', 'Email liên hệ không hợp lệ');
  return email;
};

export const partnerTier =(p: Pick<Partner, 'tier'>): PartnerTier => p.tier ?? 'BUSINESS';

export class PartnerService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly users: UserService,
    private readonly notifications: NotificationService,
  ) {}

  // ------------------------------------------------------------------ Hồ sơ đối tác (T3.1)

  async get(partnerId: string): Promise<Partner | undefined> {
    const k = keys.partner(partnerId);
    return this.table.get<Partner>(k.pk, k.sk);
  }

  /** Đăng ký làm Partner, hoặc sửa hồ sơ khi đang chờ duyệt / bị từ chối (gửi lại → PENDING). */
  async apply(principal: Principal, input: Record<string, unknown>): Promise<Partner> {
    const tier = oneOf(input.tier ?? 'BUSINESS', PARTNER_TIERS, 'tier');
    const businessName = str(input.businessName, 'businessName', { min: 2, max: 200 })!;
    const contactEmail = parseEmail(input.contactEmail);
    const business =
      tier === 'BUSINESS'
        ? {
            businessType: oneOf(input.businessType, BUSINESS_TYPES, 'businessType'),
            licenseNo: str(input.licenseNo, 'licenseNo', { min: 5, max: 30 }),
          }
        : {};
    await this.users.requireTerms(principal);

    const partnerId = principal.userId;
    const k = keys.partner(partnerId);
    return withOptimisticRetry(async () => {
      const current = await this.table.get<Partner>(k.pk, k.sk);
      if (current && (current.status === 'APPROVED' || current.status === 'SUSPENDED')) {
        throw conflict('PARTNER_ALREADY_REVIEWED', 'Hồ sơ đã được duyệt, liên hệ Admin để thay đổi');
      }
      const now = this.clock.now().toISOString();
      const next: Partner = {
        ...k,
        ...gsi1.byStatus('PARTNER', 'PENDING', current?.createdAt ?? now),
        partnerId,
        tier,
        ...business,
        businessName,
        contactEmail,
        status: 'PENDING',
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await this.table.transact([putVersioned(next, current?.version ?? 0)]);
      return { ...next, version: (current?.version ?? 0) + 1 };
    });
  }

  /** Đổi email liên hệ ở mọi trạng thái, không phải duyệt lại (hồ sơ cũ thiếu email phải tự bổ sung). */
  updateContact(partnerId: string, input: Record<string, unknown>): Promise<Partner> {
    const contactEmail = parseEmail(input.contactEmail);
    const k = keys.partner(partnerId);
    return withOptimisticRetry(async () => {
      const current = await this.table.get<Partner>(k.pk, k.sk);
      if (!current) throw conflict('PARTNER_NOT_APPLIED', 'Cần đăng ký đối tác trước');
      const next: Partner = { ...current, contactEmail, updatedAt: this.clock.now().toISOString() };
      await this.table.transact([putVersioned(next, current.version ?? 0)]);
      return { ...next, version: (current.version ?? 0) + 1 };
    });
  }

  async listByStatus(status: PartnerStatus) {
    const partners = await this.table.query<Partner>(gsi1.statusPk('PARTNER', status), { index: 'gsi1' });
    return Promise.all(
      partners.map(async (p) => {
        const [profile, branches] = await Promise.all([this.users.get(p.partnerId), this.listBranches(p.partnerId)]);
        return { ...p, applicant: { email: profile?.email, fullName: profile?.fullName }, branches };
      }),
    );
  }

  /** Admin duyệt / từ chối (T14.1). Duyệt → user có thêm vai trò PARTNER. */
  async review(adminId: string, partnerId: string, approve: boolean, note?: string): Promise<Partner> {
    const k = keys.partner(partnerId);
    const updated = await withOptimisticRetry(async () => {
      const current = await this.table.get<Partner>(k.pk, k.sk);
      if (!current) throw notFound('hồ sơ đối tác');
      if (current.status !== 'PENDING') throw conflict('PARTNER_NOT_PENDING', `Hồ sơ đang ở trạng thái ${current.status}`);
      // Cấp 1 (khách lẻ) không có chi nhánh; cấp 2 cần ít nhất 1 chi nhánh
      if (approve && partnerTier(current) === 'BUSINESS' && (await this.listBranches(partnerId)).length === 0) {
        throw conflict('PARTNER_NO_BRANCH', 'Đối tác cần ít nhất 1 chi nhánh trước khi được duyệt');
      }
      const now = this.clock.now().toISOString();
      const status: PartnerStatus = approve ? 'APPROVED' : 'REJECTED';
      const next: Partner = {
        ...current,
        ...gsi1.byStatus('PARTNER', status, current.createdAt),
        status,
        reviewNote: note,
        reviewedBy: adminId,
        reviewedAt: now,
        updatedAt: now,
      };
      await this.table.transact([putVersioned(next, current.version ?? 0)]);
      return { ...next, version: (current.version ?? 0) + 1 };
    });
    if (approve) await this.users.addRole(partnerId, 'PARTNER');
    await this.notifications.notify(partnerId, {
      type: approve ? 'PARTNER_APPROVED' : 'PARTNER_REJECTED',
      title: approve ? 'Hồ sơ đối tác đã được duyệt' : 'Hồ sơ đối tác bị từ chối',
      body: note,
      link: '/partner',
    });
    return updated;
  }

  /** Thao tác chỉ dành cho Partner đã duyệt (gửi báo giá, xác nhận giá…). */
  async requireApproved(partnerId: string): Promise<Partner> {
    const partner = await this.get(partnerId);
    if (partner?.status !== 'APPROVED') throw forbidden('Chỉ đối tác đã được duyệt mới thực hiện được');
    return partner;
  }

  /** Thu mua (báo giá, offer): chỉ đối tác cấp 2 đã duyệt. */
  async requireApprovedBusiness(partnerId: string): Promise<Partner> {
    const partner = await this.requireApproved(partnerId);
    if (partnerTier(partner) !== 'BUSINESS') throw forbidden('Chỉ đối tác cấp 2 (doanh nghiệp / hộ kinh doanh) mới thu mua được');
    return partner;
  }

  /** Đăng tin (QĐ-34): chỉ người có hồ sơ đối tác (cấp 1 hoặc cấp 2) đã được Admin duyệt. */
  async requireCanPost(userId: string): Promise<Partner> {
    const partner = await this.get(userId);
    if (partner?.status !== 'APPROVED') {
      throw new AppError(403, 'PARTNER_REQUIRED', 'Chỉ đối tác đã được Admin duyệt mới đăng tin được — hãy gửi yêu cầu làm đối tác');
    }
    return partner;
  }

  /** Liên hệ công khai của đối tác: email (bắt buộc) + SĐT trong hồ sơ người dùng (không bắt buộc). */
  async contactOf(partner: Partner) {
    const profile = await this.users.get(partner.partnerId);
    return { email: partner.contactEmail, phone: profile?.phone ?? partner.phone };
  }

  private async requireApplied(partnerId: string): Promise<Partner> {
    const partner = await this.get(partnerId);
    if (!partner) throw conflict('PARTNER_NOT_APPLIED', 'Cần đăng ký đối tác trước');
    if (partner.status === 'SUSPENDED') throw forbidden('Tài khoản đối tác đang bị tạm ngừng');
    return partner;
  }

  /** Chi nhánh và bảng giá chỉ dành cho cấp 2. */
  private async requireAppliedBusiness(partnerId: string): Promise<Partner> {
    const partner = await this.requireApplied(partnerId);
    if (partnerTier(partner) !== 'BUSINESS') {
      throw forbidden('Chỉ đối tác cấp 2 (doanh nghiệp / hộ kinh doanh) mới có chi nhánh và bảng giá');
    }
    return partner;
  }

  /** Tạm ngừng / mở lại đối tác (T14.1, giaiphap D8): tạm ngừng → không được match, không gửi báo giá mới. */
  async setSuspended(adminId: string, partnerId: string, suspended: boolean, note?: string): Promise<Partner> {
    const k = keys.partner(partnerId);
    const updated = await withOptimisticRetry(async () => {
      const current = await this.table.get<Partner>(k.pk, k.sk);
      if (!current) throw notFound('hồ sơ đối tác');
      const from: PartnerStatus = suspended ? 'APPROVED' : 'SUSPENDED';
      if (current.status !== from) throw conflict('PARTNER_INVALID_STATUS', `Hồ sơ đang ở trạng thái ${current.status}`);
      const now = this.clock.now().toISOString();
      const status: PartnerStatus = suspended ? 'SUSPENDED' : 'APPROVED';
      const next: Partner = {
        ...current,
        ...gsi1.byStatus('PARTNER', status, current.createdAt),
        status,
        reviewNote: note,
        reviewedBy: adminId,
        reviewedAt: now,
        updatedAt: now,
      };
      await this.table.transact([putVersioned(next, current.version ?? 0)]);
      return { ...next, version: (current.version ?? 0) + 1 };
    });
    await this.notifications.notify(partnerId, {
      type: suspended ? 'PARTNER_SUSPENDED' : 'PARTNER_REACTIVATED',
      title: suspended ? 'Tài khoản đối tác bị tạm ngừng' : 'Tài khoản đối tác đã được mở lại',
      body: note,
      link: '/partner',
    });
    return updated;
  }

  // ------------------------------------------------------------------ Chi nhánh (T3.2)

  listBranches(partnerId: string) {
    return this.table.query<Branch>(keys.partnerPk(partnerId), { skPrefix: 'BRANCH#' });
  }

  async getBranch(partnerId: string, branchId: string) {
    const k = keys.branch(partnerId, branchId);
    return this.table.get<Branch>(k.pk, k.sk);
  }

  async addBranch(partnerId: string, input: Record<string, unknown>): Promise<Branch> {
    await this.requireAppliedBusiness(partnerId);
    const branchId = newId();
    const now = this.clock.now().toISOString();
    const location = geoPoint(input.location);
    const geohash = geohashEncode(location.lat, location.lng);
    const branch: Branch = {
      ...keys.branch(partnerId, branchId),
      ...gsi1.geo(geohash, partnerId, branchId),
      branchId,
      partnerId,
      name: str(input.name, 'name', { min: 2, max: 120 })!,
      location,
      geohash,
      radiusKm: num(input.radiusKm, 'radiusKm', { min: MIN_RADIUS_KM, max: MAX_RADIUS_KM }),
      categories: listOf(input.categories, CATEGORIES, 'categories'),
      conditions: listOf(input.conditions, CONDITIONS, 'conditions'),
      handoverMethods: listOf(input.handoverMethods, HANDOVER_METHODS, 'handoverMethods'),
      active: input.active === undefined ? true : bool(input.active, 'active'),
      createdAt: now,
      updatedAt: now,
    };
    await this.table.transact([putVersioned(branch, 0)]);
    return { ...branch, version: 1 };
  }

  /** Sửa chi nhánh. Chỉ ảnh hưởng matching từ thời điểm này (giaiphap D9). */
  updateBranch(partnerId: string, branchId: string, input: Record<string, unknown>): Promise<Branch> {
    return withOptimisticRetry(async () => {
      const current = await this.getBranch(partnerId, branchId);
      if (!current) throw notFound('chi nhánh');
      const next: Branch = { ...current, updatedAt: this.clock.now().toISOString() };
      if (input.name !== undefined) next.name = str(input.name, 'name', { min: 2, max: 120 })!;
      if (input.location !== undefined) {
        next.location = geoPoint(input.location);
        next.geohash = geohashEncode(next.location.lat, next.location.lng);
        Object.assign(next, gsi1.geo(next.geohash, partnerId, branchId));
      }
      if (input.radiusKm !== undefined) next.radiusKm = num(input.radiusKm, 'radiusKm', { min: MIN_RADIUS_KM, max: MAX_RADIUS_KM });
      if (input.categories !== undefined) next.categories = listOf(input.categories, CATEGORIES, 'categories');
      if (input.conditions !== undefined) next.conditions = listOf(input.conditions, CONDITIONS, 'conditions');
      if (input.handoverMethods !== undefined) next.handoverMethods = listOf(input.handoverMethods, HANDOVER_METHODS, 'handoverMethods');
      if (input.active !== undefined) next.active = bool(input.active, 'active');
      await this.table.transact([putVersioned(next, current.version ?? 0)]);
      return { ...next, version: (current.version ?? 0) + 1 };
    });
  }

  /** Chi nhánh trong các ô geohash (đọc từ GSI1). */
  async branchesInCells(cells: string[]): Promise<Branch[]> {
    const lists = await Promise.all(cells.map((c) => this.table.query<Branch>(gsi1.geoPk(c), { index: 'gsi1' })));
    return lists.flat();
  }

  // ------------------------------------------------------------------ Quy tắc giá (T7.1)

  listRules(partnerId: string) {
    return this.table.query<PricingRule>(keys.partnerPk(partnerId), { skPrefix: 'RULE#' });
  }

  async addRule(partnerId: string, input: Record<string, unknown>): Promise<PricingRule> {
    await this.requireAppliedBusiness(partnerId);
    const branchId = str(input.branchId, 'branchId', { max: 64 })!;
    if (!(await this.getBranch(partnerId, branchId))) throw notFound('chi nhánh');
    const minPrice = int(input.minPrice, 'minPrice', { min: 0, max: 100_000_000 });
    const maxPrice = int(input.maxPrice, 'maxPrice', { min: 0, max: 100_000_000 });
    if (maxPrice < minPrice) throw badRequest('INVALID_PRICE_RANGE', 'Giá tối đa phải ≥ giá tối thiểu');
    const ruleId = newId();
    const now = this.clock.now().toISOString();
    const rule: PricingRule = {
      ...keys.rule(partnerId, ruleId),
      ruleId,
      partnerId,
      branchId,
      category: oneOf(input.category, CATEGORIES, 'category'),
      conditions: listOf(input.conditions, CONDITIONS, 'conditions'),
      unit: oneOf(input.unit, PRICE_UNITS, 'unit'),
      minPrice,
      maxPrice,
      minQuantity: num(input.minQuantity ?? 1, 'minQuantity', { min: 0, max: 100_000 }),
      active: input.active === undefined ? true : bool(input.active, 'active'),
      createdAt: now,
      updatedAt: now,
    };
    await this.table.transact([putVersioned(rule, 0)]);
    return { ...rule, version: 1 };
  }

  /** Sửa rule không đổi các báo giá đã tạo — báo giá giữ Rule Snapshot (T7.2). */
  updateRule(partnerId: string, ruleId: string, input: Record<string, unknown>): Promise<PricingRule> {
    return withOptimisticRetry(async () => {
      const k = keys.rule(partnerId, ruleId);
      const current = await this.table.get<PricingRule>(k.pk, k.sk);
      if (!current) throw notFound('quy tắc giá');
      const next: PricingRule = { ...current, updatedAt: this.clock.now().toISOString() };
      if (input.conditions !== undefined) next.conditions = listOf(input.conditions, CONDITIONS, 'conditions');
      if (input.minPrice !== undefined) next.minPrice = int(input.minPrice, 'minPrice', { min: 0, max: 100_000_000 });
      if (input.maxPrice !== undefined) next.maxPrice = int(input.maxPrice, 'maxPrice', { min: 0, max: 100_000_000 });
      if (next.maxPrice < next.minPrice) throw badRequest('INVALID_PRICE_RANGE', 'Giá tối đa phải ≥ giá tối thiểu');
      if (input.minQuantity !== undefined) next.minQuantity = num(input.minQuantity, 'minQuantity', { min: 0, max: 100_000 });
      if (input.active !== undefined) next.active = bool(input.active, 'active');
      await this.table.transact([putVersioned(next, current.version ?? 0)]);
      return { ...next, version: (current.version ?? 0) + 1 };
    });
  }
}
