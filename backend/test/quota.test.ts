import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../src/shared/clock';
import { ADMIN, approvedPartner, listingBody, post, type T } from './fixtures';
import { makeTestApp } from './helpers';

const DAY = 24 * HOUR_MS;
const FINANCE = { user: 'fin1', groups: ['admin', 'admin_finance'] };

const postListing = async (t: T, user = 'owner') => post(t, '/listings', user, listingBody());
const quotaOf = async (t: T, user = 'owner') => (await t.call('GET', '/partners/me', { user })).body.quota;

describe('Hạn mức tin đang mở cùng lúc (QĐ-41) + gói VIP 1 trả trước (QĐ-44)', () => {
  it('cấp 1: tối đa 3 tin đang mở; tin kết thúc thì trả lại suất', async () => {
    const t = makeTestApp();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await postListing(t)).body.listingId);
    expect(await quotaOf(t)).toMatchObject({ plan: 'BASIC', limit: 3, open: 3 });
    const blocked = await postListing(t);
    expect(blocked).toMatchObject({ status: 409, body: { code: 'LISTING_QUOTA_REACHED', details: { open: 3, limit: 3, plan: 'BASIC' } } });

    await post(t, `/listings/${ids[0]}/cancel`, 'owner'); // gỡ 1 tin → còn 2
    expect((await postListing(t)).status).toBe(201);
    t.clock.advance(8 * DAY); // tất cả hết hạn 7 ngày → về 0
    expect((await quotaOf(t)).open).toBe(0);
  });

  it('đăng ký VIP 1 chỉ tạo yêu cầu: KHÔNG bật gói, KHÔNG cộng phí tháng cho tới khi Admin xác nhận đã thu', async () => {
    const t = makeTestApp();
    for (let i = 0; i < 3; i++) await postListing(t);
    const req = await post(t, '/partners/me/vip-requests', 'owner');
    expect(req).toMatchObject({ status: 201, body: { status: 'REQUESTED', amount: 10_000, days: 30 } });
    const id = req.body.requestId;

    // Chưa trả tiền → vẫn gói thường, vẫn chặn tin thứ 4, phí tháng không đổi
    expect(await quotaOf(t)).toMatchObject({ plan: 'BASIC', limit: 3, vipRequest: { requestId: id, status: 'REQUESTED' } });
    expect((await postListing(t)).body.code).toBe('LISTING_QUOTA_REACHED');
    expect((await t.call('GET', '/billing/me', { user: 'owner' })).body.currentMonth.amount).toBe(0);
    // Không gửi trùng khi còn 1 yêu cầu mở
    expect((await post(t, '/partners/me/vip-requests', 'owner')).body.code).toBe('VIP_REQUEST_OPEN');
    // Admin thường xem được hàng đợi + có thông báo, nhưng không gửi hóa đơn được
    expect((await t.call('GET', '/admin/vip-requests', ADMIN)).body.items).toEqual([expect.objectContaining({ requestId: id, userId: 'owner' })]);
    expect((await t.call('GET', '/admin/notifications', ADMIN)).body.items.map((n: { type: string }) => n.type)).toContain('ADMIN_VIP_REQUEST');
    expect((await t.call('GET', '/admin/stats', ADMIN)).body.vipRequests).toBe(1);
    expect((await t.call('POST', `/admin/vip-requests/owner/${id}/invoice`, { ...ADMIN, body: {} })).status).toBe(403);
    // Chưa gửi hóa đơn thì chưa duyệt được (không có đường tắt REQUESTED → APPROVED)
    expect((await t.call('POST', `/admin/vip-requests/owner/${id}/approve`, { ...FINANCE, body: {} })).body.code).toBe('INVALID_STATE_TRANSITION');

    // Admin tài chính gửi hóa đơn → người bán nhận mã chuyển khoản
    const invoiced = (await t.call('POST', `/admin/vip-requests/owner/${id}/invoice`, { ...FINANCE, body: {} })).body;
    expect(invoiced).toMatchObject({ status: 'INVOICED', paymentCode: expect.stringMatching(/^RLV/) });
    const notes = (await t.call('GET', '/notifications', { user: 'owner' })).body.items;
    expect(notes.find((n: { type: string }) => n.type === 'VIP_INVOICE')).toMatchObject({ title: expect.stringContaining(invoiced.paymentCode) });
    expect(await quotaOf(t)).toMatchObject({ plan: 'BASIC', vipRequest: { status: 'INVOICED', paymentCode: invoiced.paymentCode } });

    // Xác nhận đã thu → gói bật 30 ngày, đăng thêm được 2 tin; phí tháng vẫn 0 (đã trả trước)
    const approved = (await t.call('POST', `/admin/vip-requests/owner/${id}/approve`, { ...FINANCE, body: {} })).body;
    const until = approved.partner.vip.until;
    expect(Date.parse(until) - Date.parse('2026-01-01T00:00:00.000Z')).toBe(30 * DAY);
    expect(await quotaOf(t)).toMatchObject({ plan: 'VIP1', limit: 5, vipUntil: until, vipRequest: { status: 'APPROVED' } });
    expect((await postListing(t)).status).toBe(201);
    expect((await postListing(t)).status).toBe(201);
    expect((await postListing(t)).body.code).toBe('LISTING_QUOTA_REACHED');
    expect((await t.call('GET', '/billing/me', { user: 'owner' })).body.currentMonth.amount).toBe(0);
    expect((await t.call('GET', '/notifications', { user: 'owner' })).body.items.map((n: { type: string }) => n.type)).toContain('VIP_ACTIVATED');
    expect((await t.call('GET', '/admin/stats', ADMIN)).body.vipRequests).toBe(0);
    // Duyệt lại lần nữa không cộng thêm ngày
    expect((await t.call('POST', `/admin/vip-requests/owner/${id}/approve`, { ...FINANCE, body: {} })).body.code).toBe('INVALID_STATE_TRANSITION');

    // Gia hạn khi còn hạn → cộng dồn 30 ngày
    const id2 = (await post(t, '/partners/me/vip-requests', 'owner')).body.requestId;
    await t.call('POST', `/admin/vip-requests/owner/${id2}/invoice`, { ...FINANCE, body: {} });
    const renewed = (await t.call('POST', `/admin/vip-requests/owner/${id2}/approve`, { ...FINANCE, body: {} })).body.partner.vip.until;
    expect(Date.parse(renewed) - Date.parse(until)).toBe(30 * DAY);

    // Hết hạn VIP → hạn mức về 3
    t.clock.advance(61 * DAY);
    expect(await quotaOf(t)).toMatchObject({ plan: 'BASIC', limit: 3, open: 0 });
  });

  it('từ chối cần lý do, sau đó gửi được yêu cầu mới; người bán tự hủy được khi chưa duyệt', async () => {
    const t = makeTestApp();
    await postListing(t);
    const id = (await post(t, '/partners/me/vip-requests', 'owner')).body.requestId;
    await t.call('POST', `/admin/vip-requests/owner/${id}/invoice`, { ...FINANCE, body: {} });
    expect((await t.call('POST', `/admin/vip-requests/owner/${id}/reject`, { ...FINANCE, body: { note: 'x' } })).body.code).toBe('NOTE_REQUIRED');
    const rejected = await t.call('POST', `/admin/vip-requests/owner/${id}/reject`, { ...FINANCE, body: { note: 'Quá hạn chưa chuyển khoản' } });
    expect(rejected.body.status).toBe('REJECTED');
    expect((await t.call('GET', '/notifications', { user: 'owner' })).body.items.find((n: { type: string }) => n.type === 'VIP_REJECTED')).toMatchObject({ body: 'Quá hạn chưa chuyển khoản' });
    expect((await quotaOf(t)).plan).toBe('BASIC');

    const id2 = (await post(t, '/partners/me/vip-requests', 'owner')).body.requestId;
    expect((await post(t, `/partners/me/vip-requests/${id2}/cancel`, 'owner')).body.status).toBe('CANCELLED');
    expect((await post(t, '/partners/me/vip-requests', 'owner')).status).toBe(201);
    // Đã hủy thì Admin không gửi hóa đơn được nữa
    expect((await t.call('POST', `/admin/vip-requests/owner/${id2}/invoice`, { ...FINANCE, body: {} })).body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('cấp 2: tối đa 10 tin, không đăng ký VIP 1', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'biz');
    for (let i = 0; i < 10; i++) expect((await postListing(t, 'biz')).status).toBe(201);
    expect((await postListing(t, 'biz')).body).toMatchObject({ code: 'LISTING_QUOTA_REACHED', details: { limit: 10, plan: 'BUSINESS' } });
    expect((await post(t, '/partners/me/vip-requests', 'biz')).body.code).toBe('VIP_NOT_AVAILABLE');
    expect(await quotaOf(t, 'biz')).toMatchObject({ plan: 'BUSINESS', limit: 10, open: 10 });
  });

  it('chưa là đối tác / bị tạm ngừng thì không đăng ký được VIP', async () => {
    const t = makeTestApp();
    expect((await post(t, '/partners/me/vip-requests', 'nobody')).body.code).toBe('PARTNER_REQUIRED');
    await postListing(t); // "owner" thành đối tác cấp 1 đã duyệt
    await t.services.partners.setSuspended('admin1', 'owner', true);
    expect((await post(t, '/partners/me/vip-requests', 'owner')).body.code).toBe('PARTNER_REQUIRED');
  });
});
