import type { Principal } from '../../auth/auth';
import type { Clock } from '../../shared/clock';
import { badRequest, forbidden } from '../../shared/errors';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { ConditionFailedError, putVersioned, type Item, type Table } from '../../store/table';

export type BusinessRole = 'OWNER' | 'PARTNER';

export interface UserProfile extends Item {
  userId: string;
  email?: string;
  fullName?: string;
  /** Không bắt buộc — mở cho bên kia khi có giao dịch để tiện liên lạc. */
  phone?: string;
  roles: BusinessRole[];
  /** Đồng ý Điều khoản sử dụng + Chính sách quyền riêng tư (QĐ-28). */
  terms?: { version: string; acceptedAt: string };
  createdAt: string;
  updatedAt: string;
}

/** Phiên bản điều khoản hiện hành. Đổi chuỗi này → mọi người phải đồng ý lại. */
export const TERMS_VERSION = '2026-10-18';

/**
 * Hồ sơ do Lambda Cognito "reloop-auth-post-confirmation" ghi khi xác nhận đăng ký:
 * { role: 'Owner', fullName: name | 'Unknown', status, email, createdAt } — chưa có version, roles.
 */
interface TriggerProfile extends Item {
  role?: string;
  fullName?: string;
  email?: string;
  createdAt?: string;
}

const ROLE_FROM_TRIGGER: Record<string, BusinessRole> = { owner: 'OWNER', partner: 'PARTNER' };

const PHONE_RE = /^(0|\+84)\d{9}$/;

export class UserService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
  ) {}

  /** Tạo hồ sơ ở lần gọi đầu tiên sau khi đăng nhập; tài khoản mới mặc định OWNER (§4.1). */
  async getOrCreate(principal: Principal): Promise<UserProfile> {
    const k = keys.userProfile(principal.userId);
    const existing = await this.table.get<UserProfile>(k.pk, k.sk);
    if (existing) return existing.version === undefined ? this.adoptTriggerProfile(principal.userId) : existing;

    const now = this.clock.now().toISOString();
    const profile: UserProfile = {
      ...k,
      userId: principal.userId,
      email: principal.email,
      roles: ['OWNER'],
      createdAt: now,
      updatedAt: now,
    };
    return withOptimisticRetry(async () => {
      const again = await this.table.get<UserProfile>(k.pk, k.sk);
      if (again) return again;
      await this.table.transact([putVersioned(profile, 0)]);
      return { ...profile, version: 1 };
    });
  }

  /**
   * Chuẩn hóa hồ sơ do Lambda Cognito tạo sang schema của backend (giữ nguyên các trường khác như
   * role, status, GSI1). Chỉ ghi khi item vẫn chưa có version → chạy song song cũng chỉ ghi 1 lần.
   */
  private async adoptTriggerProfile(userId: string): Promise<UserProfile> {
    const k = keys.userProfile(userId);
    for (;;) {
      const raw = await this.table.get<TriggerProfile>(k.pk, k.sk);
      if (!raw) throw badRequest('PROFILE_NOT_FOUND', 'Chưa có hồ sơ người dùng');
      if (raw.version !== undefined) return raw as unknown as UserProfile;
      const now = this.clock.now().toISOString();
      const role = ROLE_FROM_TRIGGER[String(raw.role ?? '').toLowerCase()] ?? 'OWNER';
      const profile: UserProfile = {
        ...raw,
        userId,
        fullName: raw.fullName && raw.fullName !== 'Unknown' ? raw.fullName : undefined,
          roles: [role],
        createdAt: raw.createdAt ?? now,
        updatedAt: now,
        version: 1,
      };
      try {
        await this.table.transact([{ type: 'put', item: profile, condition: { kind: 'versionMissing' } }]);
        return profile;
      } catch (err) {
        if (!(err instanceof ConditionFailedError)) throw err;
      }
    }
  }

  async get(userId: string): Promise<UserProfile | undefined> {
    const k = keys.userProfile(userId);
    return this.table.get<UserProfile>(k.pk, k.sk);
  }

  async update(principal: Principal, patch: { fullName?: unknown; phone?: unknown }): Promise<UserProfile> {
    if (patch.fullName !== undefined && (typeof patch.fullName !== 'string' || patch.fullName.trim().length < 2)) {
      throw badRequest('INVALID_FULL_NAME', 'Họ tên không hợp lệ');
    }
    // SĐT không bắt buộc: chuỗi rỗng = xóa SĐT
    if (patch.phone !== undefined && patch.phone !== '' && (typeof patch.phone !== 'string' || !PHONE_RE.test(patch.phone))) {
      throw badRequest('INVALID_PHONE', 'Số điện thoại không hợp lệ');
    }
    await this.getOrCreate(principal);
    return this.mutate(principal.userId, (p) => {
      if (typeof patch.fullName === 'string') p.fullName = patch.fullName.trim();
      if (patch.phone === '') delete p.phone;
      else if (typeof patch.phone === 'string') p.phone = patch.phone;
    });
  }

  /** Lưu thời điểm + phiên bản điều khoản người dùng đã đồng ý (QĐ-28). */
  async acceptTerms(principal: Principal, version: unknown): Promise<UserProfile> {
    if (version !== TERMS_VERSION) throw badRequest('TERMS_VERSION_MISMATCH', 'Phiên bản điều khoản không còn hiệu lực, hãy tải lại trang');
    await this.getOrCreate(principal);
    return this.mutate(principal.userId, (p) => {
      p.terms = { version: TERMS_VERSION, acceptedAt: this.clock.now().toISOString() };
    });
  }

  /** Chặn thao tác nghiệp vụ khi chưa đồng ý điều khoản hiện hành. */
  async requireTerms(principal: Principal): Promise<UserProfile> {
    const profile = await this.getOrCreate(principal);
    if (profile.terms?.version !== TERMS_VERSION) throw forbidden('Cần đồng ý Điều khoản sử dụng trước (QĐ-28)');
    return profile;
  }

  /** Gán thêm vai trò nghiệp vụ (vd PARTNER khi Admin duyệt hồ sơ đối tác — D11). */
  async addRole(userId: string, role: BusinessRole): Promise<UserProfile> {
    return this.mutate(userId, (p) => {
      if (!p.roles.includes(role)) p.roles = [...p.roles, role];
    });
  }

  private mutate(userId: string, change: (p: UserProfile) => void): Promise<UserProfile> {
    const k = keys.userProfile(userId);
    return withOptimisticRetry(async () => {
      let current = await this.table.get<UserProfile>(k.pk, k.sk);
      if (!current) throw badRequest('PROFILE_NOT_FOUND', 'Chưa có hồ sơ người dùng');
      if (current.version === undefined) current = await this.adoptTriggerProfile(userId);
      const next = structuredClone(current);
      change(next);
      next.updatedAt = this.clock.now().toISOString();
      await this.table.transact([putVersioned(next, current.version ?? 0)]);
      return { ...next, version: (current.version ?? 0) + 1 };
    });
  }
}
