import { TERMS_VERSION } from '../src/modules/users/userService';
import { makeTestApp } from './helpers';

// Thủ Đức, TP.HCM
export const OWNER_AT = { lat: 10.87, lng: 106.803, address: '1 Võ Văn Ngân, Thủ Đức' };
export const NEAR = { lat: 10.88, lng: 106.81, address: 'Cửa hàng gần (~1,3 km)' };
export const FAR = { lat: 10.95, lng: 106.9, address: 'Cửa hàng xa (~14 km)' };

export const ADMIN = { user: 'admin1', groups: ['admin'] }; // dev local: header x-dev-groups dùng thẳng tên quyền

export type T = ReturnType<typeof makeTestApp>;
let seq = 0;
const accepted = new WeakMap<T, Set<string>>();

/** Người dùng đã đồng ý điều khoản hiện hành (QĐ-28) — test nghiệp vụ không phải lặp lại bước này. */
export async function acceptTerms(t: T, user: string) {
  const done = accepted.get(t) ?? new Set<string>();
  accepted.set(t, done);
  if (done.has(user)) return;
  done.add(user);
  await t.call('POST', '/me/accept-terms', { user, body: { version: TERMS_VERSION } });
}

export const post = async (t: T, path: string, user: string, body: unknown = {}, groups?: string[]) => {
  await acceptTerms(t, user);
  if (path === '/listings') await approvedSeller(t, user);
  return t.call('POST', path, { user, groups, body, headers: { 'idempotency-key': `k${++seq}` } });
};

export const businessApply = (id: string) => ({
  tier: 'BUSINESS',
  businessType: 'ENTERPRISE',
  businessName: `Thu mua ${id}`,
  licenseNo: '0312345678',
  contactEmail: `${id}@thumua.vn`,
});

const sellers = new WeakMap<T, Set<string>>();

/**
 * Chỉ đối tác đã duyệt mới đăng tin (QĐ-34). Người đăng tin trong test chưa có hồ sơ đối tác
 * → tự đăng ký cấp 1 (khách lẻ) và được Admin duyệt, như bước điều khoản ở trên.
 */
export async function approvedSeller(t: T, user: string) {
  const done = sellers.get(t) ?? new Set<string>();
  sellers.set(t, done);
  if (done.has(user)) return;
  done.add(user);
  if ((await t.call('GET', '/partners/me', { user })).body.partner) return;
  await acceptTerms(t, user);
  await t.call('POST', '/partners/apply', { user, body: { tier: 'INDIVIDUAL', businessName: `Người bán ${user}`, contactEmail: `${user}@mail.vn` } });
  await t.call('POST', `/admin/partners/${user}/review`, { ...ADMIN, body: { approve: true } });
}

export const branchBody = (location = NEAR, extra: Record<string, unknown> = {}) => ({
  name: 'Chi nhánh Thủ Đức',
  location,
  radiusKm: 5,
  categories: ['LAPTOP', 'PHONE'],
  conditions: ['NOT_WORKING', 'PARTIALLY_WORKING', 'UNKNOWN'],
  handoverMethods: ['DROP_OFF', 'PICKUP'],
  ...extra,
});

/** Partner đã duyệt, có 1 chi nhánh + (tùy chọn) 1 rule giá laptop hỏng 300–500k/cái. */
export async function approvedPartner(t: T, id: string, opts: { location?: typeof NEAR; rule?: boolean; approve?: boolean } = {}) {
  await post(t, '/partners/apply', id, businessApply(id));
  await t.call('PATCH', '/me', { user: id, body: { phone: '0901234567' } }); // SĐT liên hệ nằm ở hồ sơ, không bắt buộc
  const branch = (await post(t, '/partners/me/branches', id, branchBody(opts.location))).body;
  if (opts.rule !== false) {
    await post(t, '/partners/me/rules', id, {
      branchId: branch.branchId,
      category: 'LAPTOP',
      conditions: ['NOT_WORKING'],
      unit: 'PER_DEVICE',
      minPrice: 300_000,
      maxPrice: 500_000,
    });
  }
  if (opts.approve !== false) {
    const a = ADMIN;
    await t.call('POST', `/admin/partners/${id}/review`, { user: a.user, groups: a.groups, body: { approve: true } });
  }
  return branch;
}

export const listingBody = (extra: Record<string, unknown> = {}) => ({
  title: 'Laptop Dell hỏng màn hình',
  category: 'LAPTOP',
  condition: 'NOT_WORKING',
  unit: 'PER_DEVICE',
  quantity: 2,
  description: 'Màn hình vỡ, không lên nguồn',
  handoverMethods: ['DROP_OFF'],
  location: OWNER_AT,
  area: 'Phường Linh Trung, TP Thủ Đức',
  ...extra,
});
