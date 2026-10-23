import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../src/shared/clock';
import { ADMIN, approvedPartner, listingBody, post, type T } from './fixtures';
import { makeTestApp } from './helpers';

const FINANCE = { user: 'fin1', groups: ['admin', 'admin_finance'] };

/** Người bán đăng tin, khách ra giá 200k trong chat, người bán chấp nhận → giao dịch (QĐ-38). */
async function chatDeal(t: T, buyer = 'd', seller = 'seller') {
  const { listingId } = (await post(t, '/listings', seller, listingBody())).body;
  const conv = (await post(t, `/listings/${listingId}/conversations`, buyer)).body.conversationId;
  const offer = (await post(t, `/conversations/${conv}/offers`, buyer, { price: 200_000 })).body;
  const { transactionId } = (await post(t, `/conversations/${conv}/offers/${offer.offerId}/accept`, seller)).body;
  return { listingId: listingId as string, txId: transactionId as string };
}

/** Khách yêu cầu hủy, người bán đồng ý ngay → giao dịch CANCELLED, tin mở lại. */
async function cancelNow(t: T, txId: string, buyer = 'd', seller = 'seller') {
  await post(t, `/transactions/${txId}/cancel`, buyer, { reason: 'Không mua nữa' });
  expect((await post(t, `/transactions/${txId}/cancel/confirm`, seller)).body.status).toBe('CANCELLED');
}

const removeListing = async (t: T, listingId: string, seller = 'seller') => (await post(t, `/listings/${listingId}/cancel`, seller)).body;
const billingOf = async (t: T, user = 'seller') => (await t.call('GET', '/billing/me', { user })).body;
const notes = async (t: T, user: string) => (await t.call('GET', '/notifications', { user })).body.items.map((n: { type: string }) => n.type);
const flags = async (t: T) => (await t.call('GET', '/admin/risk-flags', ADMIN)).body.items;

describe('Phí nghi bán ngoài ReLoop: hủy giao dịch rồi gỡ tin trong 72 giờ (QĐ-39 — C)', () => {
  it('gỡ tin trong 72 giờ sau khi hủy / báo thất bại → tính 10.000đ; quá 72 giờ thì không', async () => {
    const t = makeTestApp();
    const a = await chatDeal(t);
    await cancelNow(t, a.txId);
    const asOwner = (await t.call('GET', `/listings/${a.listingId}`, { user: 'seller' })).body.listing;
    expect(asOwner).toMatchObject({ status: 'ACTIVE', lastEndedDeal: { transactionId: a.txId, buyerId: 'd', status: 'CANCELLED' } });
    expect((await t.call('GET', `/listings/${a.listingId}`, { user: 'x' })).body.listing.lastEndedDeal).toBeUndefined(); // người ngoài không thấy

    expect((await removeListing(t, a.listingId)).suspectedFee).toBe(true);
    const bill = await billingOf(t);
    expect(bill.currentMonth).toMatchObject({ amount: 10_000, transactionCount: 1 });
    expect(bill.suspected).toEqual([expect.objectContaining({ transactionId: a.txId, kind: 'SUSPECTED_OFFLINE', amount: 10_000 })]);
    expect(await notes(t, 'seller')).toContain('FEE_SUSPECTED');

    // Quá 72 giờ mới gỡ → không tính
    const b = await chatDeal(t);
    await cancelNow(t, b.txId);
    t.clock.advance(73 * HOUR_MS);
    expect((await removeListing(t, b.listingId)).suspectedFee).toBe(false);

    // Báo thất bại rồi gỡ ngay → cũng tính
    const c = await chatDeal(t);
    await post(t, `/transactions/${c.txId}/report-failure`, 'd', { reason: 'PRICE_DISAGREEMENT' });
    expect((await removeListing(t, c.listingId)).suspectedFee).toBe(true);
    expect((await billingOf(t)).currentMonth.amount).toBe(20_000);
  });

  it('Admin kết luận tranh chấp thất bại → gỡ tin không bị tính; bán được cho người khác thì không gỡ được nữa', async () => {
    const t = makeTestApp();
    const a = await chatDeal(t);
    await post(t, `/transactions/${a.txId}/confirm-completion`, 'seller', { finalPrice: 200_000 });
    await post(t, `/transactions/${a.txId}/dispute`, 'd', { reason: 'Thiết bị khác mô tả' });
    await t.call('POST', `/admin/transactions/${a.txId}/resolve`, { ...ADMIN, body: { outcome: 'FAILED', note: 'Sai mô tả' } });
    expect((await removeListing(t, a.listingId)).suspectedFee).toBe(false);
    expect((await billingOf(t)).currentMonth.amount).toBe(0);
  });

  it('khiếu nại → Admin tài chính miễn: dòng phí về 0đ, hóa đơn chưa thu được tính lại', async () => {
    const t = makeTestApp();
    const done = await chatDeal(t); // giao dịch hoàn tất bình thường → 10.000đ
    await post(t, `/transactions/${done.txId}/confirm-completion`, 'seller');
    await post(t, `/transactions/${done.txId}/confirm-completion`, 'd');
    const a = await chatDeal(t);
    await cancelNow(t, a.txId);
    await removeListing(t, a.listingId);
    const month = (await billingOf(t)).currentMonth.month;

    // Sang tháng sau, lập hóa đơn tháng trước: 2 dòng = 20.000đ
    t.clock.advance(32 * 24 * HOUR_MS);
    await t.call('POST', '/admin/billing/issue', { ...FINANCE, body: { month } });
    const invoice = () => billingOf(t).then((b) => b.invoices[0]);
    expect(await invoice()).toMatchObject({ month, amount: 20_000, transactionCount: 2, status: 'ISSUED' });

    const appealPath = (txId: string) => `/billing/fees/${month}/${txId}/appeal`;
    expect((await post(t, appealPath(done.txId), 'seller', { reason: 'Phí giao dịch hoàn tất bình thường' })).body.code).toBe('FEE_NOT_APPEALABLE');
    expect((await post(t, appealPath(a.txId), 'seller', { reason: 'ngắn' })).body.code).toBe('INVALID_REASON');
    expect((await post(t, appealPath(a.txId), 'seller', { reason: 'Máy hỏng thêm nên tôi không bán nữa' })).status).toBe(200);
    expect((await post(t, appealPath(a.txId), 'seller', { reason: 'Khiếu nại lần hai cho chắc' })).body.code).toBe('APPEAL_EXISTS');
    expect((await billingOf(t)).suspected[0].appeal.status).toBe('OPEN'); // phí tháng trước vẫn hiện để theo dõi

    const appeals = (await t.call('GET', '/admin/fee-appeals', ADMIN)).body.items;
    expect(appeals).toEqual([expect.objectContaining({ transactionId: a.txId, partnerName: 'Người bán seller' })]);
    const resolvePath = `/admin/fee-appeals/seller/${month}/${a.txId}/resolve`;
    expect((await t.call('POST', resolvePath, { ...ADMIN, body: { waive: true } })).status).toBe(403); // cần admin_finance
    expect((await t.call('POST', resolvePath, { ...FINANCE, body: { waive: true, note: 'Hợp lý' } })).body.line).toMatchObject({ amount: 0, appeal: { status: 'WAIVED' } });

    expect(await invoice()).toMatchObject({ amount: 10_000, transactionCount: 1, status: 'ISSUED' });
    expect(await notes(t, 'seller')).toContain('FEE_WAIVED');
    expect((await t.call('GET', '/admin/fee-appeals', ADMIN)).body.items).toHaveLength(0);
    expect((await t.call('POST', resolvePath, { ...FINANCE, body: { waive: false } })).body.code).toBe('APPEAL_NOT_OPEN');
  });
});

describe('Cờ "nghi né phí" cho Admin (QĐ-39 — B)', () => {
  it('2 lần hủy với cùng người mua → cờ; Admin cảnh cáo; sự việc cũ không mở lại cờ; tái phạm → tạm ngừng', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'seller'); // cấp 2 (10 tin) — test mở 5 tin cùng lúc
    await cancelNow(t, (await chatDeal(t)).txId);
    expect(await flags(t)).toHaveLength(0);
    await cancelNow(t, (await chatDeal(t)).txId);

    const [flag] = await flags(t);
    expect(flag).toMatchObject({ userId: 'seller', sellerName: 'Thu mua seller', reasons: [{ code: 'REPEAT_PAIR', count: 2 }] });
    expect(flag.dealsEnded).toHaveLength(2);
    expect((await t.call('GET', '/admin/stats', ADMIN)).body.riskFlags).toBe(1);
    expect((await t.call('GET', '/admin/risk-flags', { user: 'seller' })).status).toBe(403);

    await t.call('POST', '/admin/risk-flags/seller/resolve', { ...ADMIN, body: { action: 'WARN', note: 'Lần đầu nhắc nhở' } });
    expect(await notes(t, 'seller')).toContain('RISK_WARNING');
    expect(await flags(t)).toHaveLength(0);

    // Sự việc mới với người mua khác: 2 lần cũ với "d" đã được xem → không mở lại cờ
    t.clock.advance(60_000);
    await cancelNow(t, (await chatDeal(t, 'e')).txId, 'e');
    expect(await flags(t)).toHaveLength(0);

    // Tái phạm với "d" 2 lần → cờ mở lại → tạm ngừng đối tác
    await cancelNow(t, (await chatDeal(t)).txId);
    await cancelNow(t, (await chatDeal(t)).txId);
    expect(await flags(t)).toHaveLength(1);
    await t.call('POST', '/admin/risk-flags/seller/resolve', { ...ADMIN, body: { action: 'SUSPEND' } });
    expect((await t.call('GET', '/partners/me', { user: 'seller' })).body.partner.status).toBe('SUSPENDED');
    expect((await t.call('POST', '/admin/risk-flags/seller/resolve', { ...ADMIN, body: { action: 'DISMISS' } })).body.code).toBe('RISK_FLAG_RESOLVED');
  });

  it('3 lần hủy rồi gỡ tin (người mua khác nhau) → cờ CANCEL_THEN_REMOVE', async () => {
    const t = makeTestApp();
    for (const buyer of ['x', 'y', 'z']) {
      const deal = await chatDeal(t, buyer);
      await cancelNow(t, deal.txId, buyer);
      await removeListing(t, deal.listingId);
    }
    const [flag] = await flags(t);
    expect(flag.reasons).toEqual([expect.objectContaining({ code: 'CANCEL_THEN_REMOVE', count: 3 })]);
    expect(flag.cancelThenRemove).toHaveLength(3);
  });
});
