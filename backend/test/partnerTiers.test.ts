import { describe, expect, it } from 'vitest';
import { ADMIN, NEAR, acceptTerms, approvedPartner, approvedSeller, branchBody, businessApply, listingBody } from './fixtures';
import { makeTestApp } from './helpers';

const individual = (id: string, extra: Record<string, unknown> = {}) => ({
  tier: 'INDIVIDUAL',
  businessType: 'PERSONAL',
  businessName: `Khách ${id}`,
  licenseNo: '001099012345',
  contactEmail: `${id}@mail.vn`,
  ...extra,
});

describe('Đối tác cấp 1 / cấp 2 (QĐ-34)', () => {
  it('chỉ đối tác đã duyệt mới đăng tin; cấp 1 không cần chi nhánh, chờ Admin duyệt', async () => {
    const t = makeTestApp();
    await acceptTerms(t, 'u1');
    const postListing = () => t.call('POST', '/listings', { user: 'u1', body: listingBody(), headers: { 'idempotency-key': `k${Math.random()}` } });

    expect((await postListing()).body.code).toBe('PARTNER_REQUIRED');
    const applied = await t.call('POST', '/partners/apply', { user: 'u1', body: individual('u1') });
    expect(applied.body).toMatchObject({ tier: 'INDIVIDUAL', businessType: 'PERSONAL', licenseNo: '001099012345', status: 'PENDING', contactEmail: 'u1@mail.vn' });
    expect((await postListing()).body.code).toBe('PARTNER_REQUIRED'); // đang chờ duyệt

    expect((await t.call('POST', '/admin/partners/u1/review', { ...ADMIN, body: { approve: true } })).body.status).toBe('APPROVED');
    expect((await postListing()).status).toBe(201);
  });

  it('cả 2 cấp bắt buộc loại hình, số giấy tờ, email liên hệ; cấp 2 không được chọn "cá nhân"', async () => {
    const t = makeTestApp();
    await acceptTerms(t, 'u1');
    const apply = (body: Record<string, unknown>) => t.call('POST', '/partners/apply', { user: 'u1', body });
    expect((await apply(individual('u1', { contactEmail: undefined }))).body.code).toBe('INVALID_CONTACT_EMAIL');
    expect((await apply(individual('u1', { contactEmail: 'khong-phai-email' }))).body.code).toBe('INVALID_CONTACT_EMAIL');
    expect((await apply({ ...businessApply('u1'), contactEmail: '' })).body.code).toBe('INVALID_CONTACT_EMAIL');
    expect((await apply({ ...businessApply('u1'), licenseNo: undefined })).body.code).toBe('INVALID_LICENSE_NO');
    expect((await apply({ ...businessApply('u1'), businessType: 'XYZ' })).body.code).toBe('INVALID_BUSINESS_TYPE');
    expect((await apply({ ...businessApply('u1'), businessType: 'PERSONAL' })).body.code).toBe('INVALID_BUSINESS_TYPE');
    expect((await apply(individual('u1', { licenseNo: undefined }))).body.code).toBe('INVALID_LICENSE_NO');
    expect((await apply(individual('u1', { businessType: undefined }))).body.code).toBe('INVALID_BUSINESS_TYPE');
    expect((await apply(individual('u1', { businessType: 'HOUSEHOLD' }))).body).toMatchObject({ tier: 'INDIVIDUAL', businessType: 'HOUSEHOLD' });
    const ok = await apply({ ...businessApply('u1'), businessType: 'HOUSEHOLD', contactEmail: 'Lien.He@ThuMua.vn' });
    expect(ok.body).toMatchObject({ tier: 'BUSINESS', businessType: 'HOUSEHOLD', contactEmail: 'lien.he@thumua.vn' });
  });

  it('cấp 1 không có chi nhánh / bảng giá và không được match để thu mua', async () => {
    const t = makeTestApp();
    await acceptTerms(t, 'p1');
    // Đăng ký cấp 2, thêm chi nhánh, rồi đổi hồ sơ sang cấp 1 khi còn chờ duyệt
    await t.call('POST', '/partners/apply', { user: 'p1', body: businessApply('p1') });
    expect((await t.call('POST', '/partners/me/branches', { user: 'p1', body: branchBody(NEAR) })).status).toBe(201);
    await t.call('POST', '/partners/apply', { user: 'p1', body: individual('p1') });
    expect((await t.call('POST', '/partners/me/branches', { user: 'p1', body: branchBody(NEAR) })).status).toBe(403);
    await t.call('POST', '/admin/partners/p1/review', { ...ADMIN, body: { approve: true } });

    await approvedPartner(t, 'biz');
    await approvedSeller(t, 'owner');
    const listing = (await t.call('POST', '/listings', { user: 'owner', body: listingBody(), headers: { 'idempotency-key': 'x' } })).body;
    expect(listing.matchCount).toBe(1); // chỉ "biz", không có chi nhánh còn sót của p1
  });

  it('bảng tin hiện tên trong hồ sơ đối tác + email liên hệ + SĐT (nếu có) của người bán', async () => {
    const t = makeTestApp();
    await acceptTerms(t, 'seller');
    await t.call('POST', '/partners/apply', { user: 'seller', body: individual('seller', { businessName: 'Chị Lan đồ cũ' }) });
    await t.call('POST', '/admin/partners/seller/review', { ...ADMIN, body: { approve: true } });
    await t.call('POST', '/listings', { user: 'seller', body: listingBody(), headers: { 'idempotency-key': 'a' } });

    const card = () => t.call('GET', '/feed', { user: 'buyer' }).then((r) => r.body.items[0].seller);
    expect(await card()).toMatchObject({ displayName: 'Chị Lan đồ cũ', tier: 'INDIVIDUAL', contact: { email: 'seller@mail.vn' } });
    expect((await card()).contact.phone).toBeUndefined();
    await t.call('PATCH', '/me', { user: 'seller', body: { phone: '0907777777' } });
    expect((await card()).contact.phone).toBe('0907777777');
  });

  it('đối tác đã duyệt (hồ sơ cũ thiếu email) tự bổ sung email liên hệ mà không phải duyệt lại', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'old');
    const k = { pk: 'PARTNER#old', sk: 'PROFILE' };
    const legacy = (await t.table.get<Record<string, unknown> & typeof k>(k.pk, k.sk))!;
    delete legacy.contactEmail;
    delete legacy.tier;
    await t.table.transact([{ type: 'put', item: legacy }]);

    expect((await t.call('PATCH', '/partners/me/contact', { user: 'old', body: { contactEmail: 'sai' } })).body.code).toBe('INVALID_CONTACT_EMAIL');
    const res = await t.call('PATCH', '/partners/me/contact', { user: 'old', body: { contactEmail: 'moi@thumua.vn' } });
    expect(res.body).toMatchObject({ status: 'APPROVED', contactEmail: 'moi@thumua.vn' });
    expect((await t.call('GET', '/partners/old/public', { user: 'x' })).body).toMatchObject({ tier: 'BUSINESS', contact: { email: 'moi@thumua.vn' } });
  });
});

describe('Sửa chi nhánh / bảng giá cùng điều kiện như thêm mới (mục 8 danhgia)', () => {
  it('bị Admin tạm ngừng → không sửa được chi nhánh / bảng giá; mở lại thì sửa được', async () => {
    const t = makeTestApp();
    const branch = await approvedPartner(t, 'near');
    const rule = (await t.call('GET', '/partners/me', { user: 'near' })).body.rules[0];
    const patchBranch = () => t.call('PATCH', `/partners/me/branches/${branch.branchId}`, { user: 'near', body: { radiusKm: 2 } });
    const patchRule = () => t.call('PATCH', `/partners/me/rules/${rule.ruleId}`, { user: 'near', body: { maxPrice: 900_000 } });

    await t.call('POST', '/admin/partners/near/suspend', { ...ADMIN, body: { note: 'Vi phạm' } });
    expect((await patchBranch()).status).toBe(403);
    expect((await patchRule()).status).toBe(403);
    const after = (await t.call('GET', '/partners/me', { user: 'near' })).body;
    expect(after.branches[0].radiusKm).toBe(5); // không đổi gì trong lúc bị ngừng
    expect(after.rules[0].maxPrice).toBe(500_000);

    await t.call('POST', '/admin/partners/near/reactivate', ADMIN);
    expect((await patchBranch()).body.radiusKm).toBe(2);
    expect((await patchRule()).body.maxPrice).toBe(900_000);
  });

  it('hồ sơ chuyển từ cấp 2 sang cấp 1 → chi nhánh cũ không sửa được', async () => {
    const t = makeTestApp();
    await acceptTerms(t, 'shop');
    await t.call('POST', '/partners/apply', { user: 'shop', body: businessApply('shop') });
    const branch = (await t.call('POST', '/partners/me/branches', { user: 'shop', body: branchBody(NEAR) })).body;
    await t.call('POST', '/partners/apply', { user: 'shop', body: { tier: 'INDIVIDUAL', businessType: 'PERSONAL', businessName: 'Cá nhân', licenseNo: '001099012345', contactEmail: 'shop@mail.vn' } });
    expect((await t.call('PATCH', `/partners/me/branches/${branch.branchId}`, { user: 'shop', body: { active: true } })).status).toBe(403);
  });
});
