import { describe, expect, it } from 'vitest';
import { TERMS_VERSION } from '../src/modules/users/userService';
import { ADMIN, OWNER_AT, approvedPartner, approvedSeller, businessApply, listingBody, post } from './fixtures';
import { makeTestApp } from './helpers';

describe('Điều khoản sử dụng (QĐ-28)', () => {
  it('chưa đồng ý → không đăng tin / đăng ký đối tác được; đồng ý lưu phiên bản + thời điểm', async () => {
    const t = makeTestApp();
    const raw = (path: string, body: unknown) => t.call('POST', path, { user: 'u1', body, headers: { 'idempotency-key': path } });
    expect((await raw('/listings', listingBody())).status).toBe(403);
    expect((await raw('/partners/apply', businessApply('u1'))).status).toBe(403);
    expect((await t.call('GET', '/me', { user: 'u1' })).body).toMatchObject({ currentTermsVersion: TERMS_VERSION });
    expect((await raw('/me/accept-terms', { version: 'cu' })).body.code).toBe('TERMS_VERSION_MISMATCH');
    const ok = await raw('/me/accept-terms', { version: TERMS_VERSION });
    expect(ok.body.terms).toMatchObject({ version: TERMS_VERSION, acceptedAt: '2026-01-01T00:00:00.000Z' });
    await approvedSeller(t, 'u1');
    expect((await raw('/listings', listingBody())).status).toBe(201);
  });
});

describe('Địa điểm đã lưu (T2.1)', () => {
  it('địa điểm đầu tiên là mặc định; đặt mặc định mới thì bỏ cái cũ; xóa mặc định → cái còn lại thành mặc định', async () => {
    const t = makeTestApp();
    const a = (await post(t, '/locations', 'u1', { name: 'Nhà', location: OWNER_AT, area: 'Thủ Đức' })).body;
    const b = (await post(t, '/locations', 'u1', { name: 'Công ty', location: OWNER_AT, area: 'Quận 1' })).body;
    expect([a.isDefault, b.isDefault]).toEqual([true, false]);
    await t.call('PATCH', `/locations/${b.locationId}`, { user: 'u1', body: { isDefault: true } });
    const list = async () => (await t.call('GET', '/locations', { user: 'u1' })).body.items as { locationId: string; isDefault: boolean }[];
    expect((await list()).filter((l) => l.isDefault).map((l) => l.locationId)).toEqual([b.locationId]);
    await t.call('DELETE', `/locations/${b.locationId}`, { user: 'u1' });
    expect((await list()).map((l) => [l.locationId, l.isDefault])).toEqual([[a.locationId, true]]);
    expect((await t.call('GET', '/locations', { user: 'u2' })).body.items).toEqual([]);
  });
});

describe('Báo cáo vi phạm & kiểm duyệt (C13, T14.5, T14.6)', () => {
  it('Partner báo cáo tin → Admin gỡ tin → tin CANCELLED, chủ tin nhận thông báo', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const report = (await post(t, '/reports', 'near', { targetType: 'LISTING', targetId: listingId, reason: 'Ảnh không phải thiết bị' })).body;

    expect((await t.call('GET', '/admin/reports', { user: 'near' })).status).toBe(403);
    expect((await t.call('GET', '/admin/stats', ADMIN)).body).toMatchObject({ openReports: 1, openDisputes: 0, partners: { APPROVED: 2 } }); // near (cấp 2) + owner (cấp 1)

    const res = await t.call('POST', `/admin/reports/${report.reportId}/resolve`, { ...ADMIN, body: { action: 'HIDE_LISTING', note: 'Spam' } });
    expect(res.body.status).toBe('RESOLVED');
    expect((await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.listing.status).toBe('CANCELLED');
    const ownerTypes = (await t.call('GET', '/notifications', { user: 'owner' })).body.items.map((n: { type: string }) => n.type);
    expect(ownerTypes).toContain('LISTING_HIDDEN');
    expect((await t.call('GET', '/admin/reports', ADMIN)).body.items).toHaveLength(0);
  });
});
