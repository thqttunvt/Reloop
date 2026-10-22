import type { Partner } from './api';
import { tierOf } from './catalog';

/**
 * Nhãn vai trò (get.md B1) — suy ra từ dữ liệu có sẵn, không lưu DB:
 * Admin · PN1 (đối tác cấp 1, 3 tin) · PN1V (cấp 1 có VIP 1 còn hạn, 5 tin) · PN2 (cấp 2, 10 tin) · khách hàng: không nhãn.
 */
export type RoleLabel = 'Admin' | 'PN1' | 'PN1V' | 'PN2';

export function roleLabel(partner: Partner | null | undefined, groups: string[], now = new Date()): RoleLabel | undefined {
  if (groups.includes('admin') || groups.includes('admin_finance')) return 'Admin';
  return partnerLabel(partner, now);
}

/** Nhãn đối tác (bỏ qua quyền Admin) — dùng ở menu người dùng và trang Admin. */
export function partnerLabel(partner: Partner | null | undefined, now = new Date()): RoleLabel | undefined {
  if (partner?.status !== 'APPROVED') return undefined;
  if (tierOf(partner) === 'BUSINESS') return 'PN2';
  return partner.vip && now.toISOString() < partner.vip.until ? 'PN1V' : 'PN1';
}
