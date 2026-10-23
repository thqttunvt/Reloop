import { describe, expect, it } from 'vitest';
import { ADMIN, listingBody, post } from './fixtures';
import { makeTestApp } from './helpers';

const FINANCE = { user: 'fin1', groups: ['admin', 'admin_finance'] };

/** Các sửa trong đợt rà soát đêm 24/10 (fix.txt). */
describe('Rà soát 24/10 — đợt 2', () => {
  it('thông báo cũ hơn 100 cái gần nhất vẫn đánh dấu đã đọc được khi web gửi kèm thời điểm', async () => {
    const t = makeTestApp();
    await t.services.notifications.notify('u1', { type: 'OLD', title: 'cũ nhất' });
    t.clock.advance(1000);
    for (let i = 0; i < 101; i++) await t.services.notifications.notify('u1', { type: 'NEW', title: `mới ${i}` });
    const old = (await t.services.notifications.list('u1', 500)).find((n) => n.type === 'OLD')!;
    expect((await t.call('POST', `/notifications/${old.notificationId}/read`, { user: 'u1' })).status).toBe(404); // cách cũ: chỉ tìm trong 100
    const ok = await t.call('POST', `/notifications/${old.notificationId}/read?at=${encodeURIComponent(old.createdAt)}`, { user: 'u1' });
    expect(ok).toMatchObject({ status: 200, body: { read: true } });
  });

  it('chat: tin gửi cùng mili giây với tin cuối web đã có vẫn lấy được (after là mốc gồm cả biên)', async () => {
    const t = makeTestApp();
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'buyer')).body.conversationId;
    const first = (await post(t, `/conversations/${conv}/messages`, 'buyer', { text: 'Còn máy không?' })).body;
    await post(t, `/conversations/${conv}/messages`, 'owner', { text: 'Còn bạn ơi' }); // đồng hồ test đứng yên → cùng thời điểm
    const items = (await t.call('GET', `/conversations/${conv}/messages?after=${encodeURIComponent(first.at)}`, { user: 'buyer' })).body.items;
    expect(items.map((m: { text: string }) => m.text)).toContain('Còn bạn ơi');
  });

  it('phản ánh REVIEW không còn nhận (Admin không xử lý được)', async () => {
    const t = makeTestApp();
    const res = await post(t, '/reports', 'u1', { targetType: 'REVIEW', targetId: 'x', reason: 'Đánh giá sai sự thật' });
    expect(res.status).toBe(400);
  });

  it('danh sách Admin có tên người bán; số liệu tháng có VIP 1 đã thu; thông báo phí dẫn tới mục Phí dịch vụ', async () => {
    const t = makeTestApp();
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'buyer')).body.conversationId;
    const offer = (await post(t, `/conversations/${conv}/offers`, 'buyer', { price: 300_000 })).body;
    const { transactionId } = (await post(t, `/conversations/${conv}/offers/${offer.offerId}/accept`, 'owner')).body;
    expect((await t.call('GET', '/admin/transactions?status=HANDOVER_PENDING', ADMIN)).body.items[0]).toMatchObject({ ownerName: 'Người bán owner' });
    expect((await t.call('GET', '/admin/listings?month=2026-01', ADMIN)).body.items[0]).toMatchObject({ ownerName: 'Người bán owner' });

    const id = (await post(t, '/partners/me/vip-requests', 'owner')).body.requestId;
    await t.call('POST', `/admin/vip-requests/owner/${id}/invoice`, { ...FINANCE, body: {} });
    await t.call('POST', `/admin/vip-requests/owner/${id}/approve`, { ...FINANCE, body: {} });
    expect((await t.call('GET', '/admin/stats?month=2026-01', ADMIN)).body.month).toMatchObject({ vipSold: 1, vipPaid: 10_000 });
    expect((await t.call('GET', '/admin/stats?month=2026-02', ADMIN)).body.month).toMatchObject({ vipSold: 0, vipPaid: 0 });

    // Giao dịch hoàn tất → ngày 1 tháng sau lập hóa đơn → thông báo dẫn thẳng tới /partner/billing
    await post(t, `/transactions/${transactionId}/confirm-completion`, 'owner', { finalPrice: 300_000 });
    await post(t, `/transactions/${transactionId}/confirm-completion`, 'buyer');
    t.clock.advance(40 * 24 * 3_600_000);
    await t.app.sweeper.sweep();
    const invoiceNotes = (await t.call('GET', '/notifications', { user: 'owner' })).body.items.filter((n: { type: string }) => n.type === 'INVOICE_ISSUED');
    expect(invoiceNotes).toHaveLength(1);
    expect(invoiceNotes[0].link).toBe('/partner/billing');
  });
});
