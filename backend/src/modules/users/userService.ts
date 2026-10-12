import type { Principal } from '../../auth/auth';
import type { Clock } from '../../shared/clock';
import { badRequest, forbidden } from '../../shared/errors';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putVersioned, type Item, type Table } from '../../store/table';

export type BusinessRole = 'OWNER' | 'PARTNER';

export interface UserProfile extends Item {
  userId: string;
  email?: string;
  fullName?: string;
  phone?: string;
  phoneVerified: boolean;
  roles: BusinessRole[];
  createdAt: string;
  updatedAt: string;
}

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
    if (existing) return existing;

    const now = this.clock.now().toISOString();
    const profile: UserProfile = {
      ...k,
      userId: principal.userId,
      email: principal.email,
      phoneVerified: false,
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

  async get(userId: string): Promise<UserProfile | undefined> {
    const k = keys.userProfile(userId);
    return this.table.get<UserProfile>(k.pk, k.sk);
  }

  async update(principal: Principal, patch: { fullName?: unknown; phone?: unknown }): Promise<UserProfile> {
    if (patch.fullName !== undefined && (typeof patch.fullName !== 'string' || patch.fullName.trim().length < 2)) {
      throw badRequest('INVALID_FULL_NAME', 'Họ tên không hợp lệ');
    }
    if (patch.phone !== undefined && (typeof patch.phone !== 'string' || !PHONE_RE.test(patch.phone))) {
      throw badRequest('INVALID_PHONE', 'Số điện thoại không hợp lệ');
    }
    await this.getOrCreate(principal);
    return this.mutate(principal.userId, (p) => {
      if (typeof patch.fullName === 'string') p.fullName = patch.fullName.trim();
      if (typeof patch.phone === 'string' && patch.phone !== p.phone) {
        p.phone = patch.phone;
        p.phoneVerified = false; // đổi số thì phải xác minh lại
      }
    });
  }

  /** Gọi sau khi OTP đúng. Bản local gọi qua /dev/verify-phone. */
  async markPhoneVerified(userId: string): Promise<UserProfile> {
    return this.mutate(userId, (p) => {
      if (!p.phone) throw badRequest('PHONE_REQUIRED', 'Chưa khai báo số điện thoại');
      p.phoneVerified = true;
    });
  }

  async requirePhoneVerified(userId: string): Promise<UserProfile> {
    const profile = await this.get(userId);
    if (!profile?.phoneVerified) throw forbidden('Cần xác minh số điện thoại trước (QĐ-09)');
    return profile;
  }

  private mutate(userId: string, change: (p: UserProfile) => void): Promise<UserProfile> {
    const k = keys.userProfile(userId);
    return withOptimisticRetry(async () => {
      const current = await this.table.get<UserProfile>(k.pk, k.sk);
      if (!current) throw badRequest('PROFILE_NOT_FOUND', 'Chưa có hồ sơ người dùng');
      const next = structuredClone(current);
      change(next);
      next.updatedAt = this.clock.now().toISOString();
      await this.table.transact([putVersioned(next, current.version ?? 0)]);
      return { ...next, version: (current.version ?? 0) + 1 };
    });
  }
}
