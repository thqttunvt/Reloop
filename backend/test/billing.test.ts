import { describe, expect, it } from 'vitest';
import { vnMonth } from '../src/modules/billing/billingService';
import { HOUR_MS } from '../src/shared/clock';
import { ADMIN, approvedPartner, listingBody, post, type T } from './fixtures';
import { makeTestApp } from './helpers';

const FINANCE = { user: 'admin1', groups: ['admin', 'admin_finance'] };
const DAY = 24 * HOUR_MS;

/** Người bán "owner" (đối tác cấp 1) đăng tin → đơn vị thu mua "near" (cấp 2) xác nhận giá → chọn → giao dịch. */
async function openTransaction(t: T) {
  const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
  const quoteId = (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0].quoteId;
  await post(t, `/listings/${listingId}/quotes/${quoteId}/request-confirmation`, 'owner');
  await post(t, `/listings/${listingId}/quotes/${quoteId}/confirm`, 'near', { price: 400_000 });
  return (await post(t, '/transactions', 'owner', { listingId, quoteId })).body.transactionId as string;
}

async function completedTransaction(t: T) {
  const txId = await openTransaction(t);
  await post(t, `/transactions/${txId}/confirm-completion`, 'owner');
  await post(t, `/transactions/${txId}/confirm-completion`, 'near');
  return txId;
}

const billingOf = async (t: T, user: string) => (await t.call('GET', '/billing/me', { user })).body;

describe('Phí dịch vụ 10.000đ / giao dịch hoàn tất, người bán trả, theo tháng (QĐ-37)', () => {
  it('chỉ giao dịch HOÀN TẤT mới tính phí, chỉ NGƯỜI BÁN trả; hủy / thất bại không tính', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const done = await completedTransaction(t);

    const cancelled = await openTransaction(t);
    await post(t, `/transactions/${cancelled}/cancel`, 'owner', { reason: 'Đổi ý' });
    const failed = await openTransaction(t);
    await post(t, `/transactions/${failed}/report-failure`, 'near', { reason: 'DEVICE_MISMATCH' });

    const seller = await billingOf(t, 'owner');
    expect(seller.currentMonth).toMatchObject({ month: '2026-01', transactionCount: 1, amount: 10_000 });
    expect(seller.currentMonth.lines[0].transactionId).toBe(done);
    expect((await billingOf(t, 'near')).currentMonth.transactionCount).toBe(0); // bên mua không trả
    expect((await t.call('GET', '/fees', { user: 'x' })).body).toMatchObject({ feePerTransaction: 10_000, payer: 'SELLER' });
  });

  it('tự hoàn tất sau 48h và Admin kết luận hoàn tất cũng tính phí — đúng 1 lần mỗi giao dịch', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const auto = await openTransaction(t);
    await post(t, `/transactions/${auto}/confirm-completion`, 'owner');
    t.clock.advance(49 * HOUR_MS);
    await t.app.sweeper.sweep();
    await t.call('GET', `/transactions/${auto}`, { user: 'owner' }); // đọc lại cũng không tính lần 2

    const disputed = await openTransaction(t);
    await post(t, `/transactions/${disputed}/confirm-completion`, 'owner', { finalPrice: 400_000 });
    await post(t, `/transactions/${disputed}/confirm-completion`, 'near', { finalPrice: 300_000 }); // lệch giá → tranh chấp
    await t.call('POST', `/admin/transactions/${disputed}/resolve`, { ...ADMIN, body: { outcome: 'COMPLETED', note: 'Theo cân thực tế', finalPrice: 300_000 } });

    expect((await billingOf(t, 'owner')).currentMonth).toMatchObject({ transactionCount: 2, amount: 20_000 });
  });

  it('tháng tính theo giờ Việt Nam (UTC+7)', () => {
    expect(vnMonth('2026-01-31T16:59:00.000Z')).toBe('2026-01'); // 23:59 ngày 31/1 giờ VN
    expect(vnMonth('2026-01-31T17:00:00.000Z')).toBe('2026-02'); // 00:00 ngày 1/2 giờ VN
  });

  it('ngày 1 tháng sau: job tự lập hóa đơn = số giao dịch × 10.000đ, chạy lại không lập trùng', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    await completedTransaction(t);
    await completedTransaction(t);
    expect((await t.call('POST', '/admin/billing/issue', { ...FINANCE, body: { month: '2026-01' } })).body.code).toBe('MONTH_NOT_ENDED');

    t.clock.advance(31 * DAY); // sang tháng 2
    await t.app.sweeper.sweep();
    await t.app.sweeper.sweep();
    expect((await t.call('POST', '/admin/billing/issue', { ...FINANCE, body: { month: '2026-01' } })).body.issued).toBe(0);

    const [invoice] = (await billingOf(t, 'owner')).invoices;
    expect(invoice).toMatchObject({ month: '2026-01', transactionCount: 2, amount: 20_000, status: 'ISSUED', overdue: false });
    expect(invoice.paymentCode).toMatch(/^RLF[A-Z2-9]{6}$/);
    expect(Date.parse(invoice.dueAt) - Date.parse(invoice.issuedAt)).toBe(7 * DAY);
    expect((await billingOf(t, 'near')).invoices).toHaveLength(0);
    const notes = (await t.call('GET', '/notifications', { user: 'owner' })).body.items.map((n: { type: string }) => n.type);
    expect(notes).toContain('INVOICE_ISSUED');
  });

  it('quá hạn 7 ngày → khóa đăng tin; Admin tài chính xác nhận đã thu → mở khóa', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    await completedTransaction(t);
    t.clock.advance(31 * DAY);
    await t.app.sweeper.sweep();

    t.clock.advance(8 * DAY);
    const blocked = await post(t, '/listings', 'owner', listingBody());
    expect(blocked.body).toMatchObject({ code: 'INVOICE_OVERDUE', details: { month: '2026-01', amount: 10_000 } });
    expect((await t.call('GET', '/admin/invoices?status=ISSUED', ADMIN)).body.items[0]).toMatchObject({ userId: 'owner', overdue: true, partnerName: 'Người bán owner' });

    // Chỉ admin_finance được xác nhận thu tiền (TL-05)
    expect((await t.call('POST', '/admin/invoices/owner/2026-01/paid', { ...ADMIN, body: {} })).status).toBe(403);
    const paid = await t.call('POST', '/admin/invoices/owner/2026-01/paid', { ...FINANCE, body: { note: 'VCB 12/02' } });
    expect(paid.body).toMatchObject({ status: 'PAID', paidBy: 'admin1' });
    expect((await t.call('POST', '/admin/invoices/owner/2026-01/paid', { ...FINANCE, body: {} })).body.code).toBe('INVOICE_ALREADY_PAID');
    expect((await post(t, '/listings', 'owner', listingBody())).status).toBe(201);
  });

  it('đơn vị thu mua (cấp 2) nợ quá hạn với tư cách người bán → bị khóa cả báo giá', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    await approvedPartner(t, 'biz2', { location: { lat: 10.871, lng: 106.804, address: 'gần' } });
    // "near" đăng bán, "biz2" thu mua, hoàn tất → "near" có phí
    const { listingId } = (await post(t, '/listings', 'near', listingBody())).body;
    const quoteId = (await t.call('GET', `/listings/${listingId}`, { user: 'near' })).body.quotes.find((q: { partnerId: string }) => q.partnerId === 'biz2').quoteId;
    await post(t, `/listings/${listingId}/quotes/${quoteId}/request-confirmation`, 'near');
    await post(t, `/listings/${listingId}/quotes/${quoteId}/confirm`, 'biz2', { price: 100_000 });
    const tx = (await post(t, '/transactions', 'near', { listingId, quoteId })).body.transactionId;
    await post(t, `/transactions/${tx}/confirm-completion`, 'near');
    await post(t, `/transactions/${tx}/confirm-completion`, 'biz2');
    t.clock.advance(31 * DAY + 8 * DAY);
    await t.app.sweeper.sweep();
    t.clock.advance(8 * DAY);

    const other = (await post(t, '/listings', 'owner', listingBody())).body;
    const q = (await t.call('GET', `/listings/${other.listingId}`, { user: 'owner' })).body.quotes.find((x: { partnerId: string }) => x.partnerId === 'near');
    await post(t, `/listings/${other.listingId}/quotes/${q.quoteId}/request-confirmation`, 'owner');
    expect((await post(t, `/listings/${other.listingId}/quotes/${q.quoteId}/confirm`, 'near', { price: 1 })).body.code).toBe('INVOICE_OVERDUE');
  });
});
