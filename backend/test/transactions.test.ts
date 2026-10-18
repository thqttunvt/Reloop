import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../src/shared/clock';
import { ADMIN, approvedPartner, listingBody, post, type T } from './fixtures';
import { makeTestApp } from './helpers';

/** Tin có 1 offer đã xác nhận 400.000đ từ Partner "near". */
async function withConfirmedOffer() {
  const t = makeTestApp();
  await t.call('PATCH', '/me', { user: 'owner', body: { fullName: 'Nguyễn Văn An', phone: '0901111111' } });
  await approvedPartner(t, 'near');
  const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
  const quoteId = (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0].quoteId;
  await post(t, `/listings/${listingId}/quotes/${quoteId}/request-confirmation`, 'owner');
  await post(t, `/listings/${listingId}/quotes/${quoteId}/confirm`, 'near', { price: 400_000 });
  return { t, listingId, quoteId };
}

async function withTransaction() {
  const ctx = await withConfirmedOffer();
  const tx = (await post(ctx.t, '/transactions', 'owner', { listingId: ctx.listingId, quoteId: ctx.quoteId })).body;
  return { ...ctx, txId: tx.transactionId as string, tx };
}

const listingStatus = async (t: T, listingId: string) => (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.listing.status;

describe('Chọn offer → giao dịch (T9.1)', () => {
  it('tạo giao dịch chờ bàn giao, tin → MATCHED, offer → SELECTED, mở liên lạc 2 bên', async () => {
    const { t, listingId, txId, tx } = await withTransaction();
    expect(tx).toMatchObject({ status: 'HANDOVER_PENDING', agreedPrice: 400_000, paymentMode: 'OFFLINE', partnerId: 'near' });
    expect(await listingStatus(t, listingId)).toBe('MATCHED');
    expect((await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0].status).toBe('SELECTED');

    const asPartner = await t.call('GET', `/transactions/${txId}`, { user: 'near' });
    expect(asPartner.body.role).toBe('PARTNER');
    expect(asPartner.body.contacts.owner).toMatchObject({ phone: '0901111111', address: '1 Võ Văn Ngân, Thủ Đức' });
    expect(asPartner.body.contacts.partner.phone).toBe('0901234567');
    expect((await t.call('GET', `/transactions/${txId}`, { user: 'stranger' })).status).toBe(404);
    expect((await t.call('GET', '/transactions', { user: 'near' })).body.items).toHaveLength(1);
  });

  it('2 request chọn offer đồng thời → chỉ 1 giao dịch (T15.8)', async () => {
    const { t, listingId, quoteId } = await withConfirmedOffer();
    const results = await Promise.all([
      post(t, '/transactions', 'owner', { listingId, quoteId }),
      post(t, '/transactions', 'owner', { listingId, quoteId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await t.call('GET', '/transactions', { user: 'owner' })).body.items).toHaveLength(1);
  });

  it('không chọn được giá dự kiến chưa xác nhận', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const quoteId = (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0].quoteId;
    expect((await post(t, '/transactions', 'owner', { listingId, quoteId })).body.code).toBe('OFFER_NOT_SELECTABLE');
  });
});

describe('Bàn giao, điều chỉnh giá, hoàn tất (T9.4–T9.6)', () => {
  it('đề xuất lịch bàn giao → bên kia chấp nhận; bên đề xuất không tự chấp nhận được', async () => {
    const { t, txId } = await withTransaction();
    const plan = { method: 'DROP_OFF', time: '2026-01-02T09:00:00Z', place: 'Cửa hàng Thủ Đức' };
    await t.call('PUT', `/transactions/${txId}/handover-plan`, { user: 'near', body: plan });
    expect((await post(t, `/transactions/${txId}/handover-plan/accept`, 'near')).body.code).toBe('OWN_PROPOSAL');
    expect((await post(t, `/transactions/${txId}/handover-plan/accept`, 'owner')).body.handoverPlan.status).toBe('AGREED');
  });

  it('điều chỉnh giá: chỉ giảm, Owner đồng ý → giá mới; tối đa 2 lần (QĐ-15)', async () => {
    const { t, txId } = await withTransaction();
    const adj = (price: number) => post(t, `/transactions/${txId}/price-adjustment`, 'near', { price, reason: 'Màn hình nứt thêm' });
    expect((await adj(450_000)).body.code).toBe('PRICE_NOT_LOWER');
    expect((await post(t, `/transactions/${txId}/price-adjustment`, 'owner', { price: 1, reason: 'không hợp lệ' })).status).toBe(403);
    expect((await adj(350_000)).body.status).toBe('PRICE_ADJUSTMENT_PENDING');
    expect((await post(t, `/transactions/${txId}/price-adjustment/accept`, 'owner')).body).toMatchObject({ status: 'HANDOVER_PENDING', agreedPrice: 350_000 });
    await adj(300_000);
    expect((await post(t, `/transactions/${txId}/price-adjustment/reject`, 'owner')).body.agreedPrice).toBe(350_000);
    expect((await adj(200_000)).body.code).toBe('ADJUSTMENT_LIMIT');
  });

  it('hai bên xác nhận → COMPLETED, tin COMPLETED', async () => {
    const { t, txId, listingId } = await withTransaction();
    expect((await post(t, `/transactions/${txId}/confirm-completion`, 'near')).body.status).toBe('AWAITING_COUNTERPARTY');
    expect((await post(t, `/transactions/${txId}/confirm-completion`, 'near')).status).toBe(409);
    expect((await post(t, `/transactions/${txId}/confirm-completion`, 'owner')).body).toMatchObject({ status: 'COMPLETED', finalPrice: 400_000 });
    expect(await listingStatus(t, listingId)).toBe('COMPLETED');
  });

  it('bên kia im lặng quá 48h → tự hoàn tất (QĐ-18)', async () => {
    const { t, txId } = await withTransaction();
    await post(t, `/transactions/${txId}/confirm-completion`, 'owner');
    t.clock.advance(47 * HOUR_MS);
    expect((await t.call('GET', `/transactions/${txId}`, { user: 'owner' })).body.transaction.status).toBe('AWAITING_COUNTERPARTY');
    t.clock.advance(2 * HOUR_MS);
    expect((await t.call('GET', `/transactions/${txId}`, { user: 'owner' })).body.transaction.status).toBe('COMPLETED');
  });

  it('giá cuối 2 bên khác nhau → tranh chấp → Admin quyết (giaiphap C7, B6)', async () => {
    const { t, txId, listingId } = await withTransaction();
    await post(t, `/transactions/${txId}/confirm-completion`, 'owner', { finalPrice: 400_000 });
    expect((await post(t, `/transactions/${txId}/confirm-completion`, 'near', { finalPrice: 300_000 })).body.status).toBe('DISPUTED');
    const queue = await t.call('GET', '/admin/disputes', ADMIN);
    expect(queue.body.items.map((x: { transactionId: string }) => x.transactionId)).toEqual([txId]);
    expect((await t.call('GET', '/admin/disputes', { user: 'owner' })).status).toBe(403);

    const resolved = await t.call('POST', `/admin/transactions/${txId}/resolve`, { ...ADMIN, body: { outcome: 'FAILED', note: 'Thiết bị khác mô tả' } });
    expect(resolved.body.status).toBe('FAILED');
    expect(await listingStatus(t, listingId)).toBe('ACTIVE'); // còn hạn → mở lại (A5)
    expect((await t.call('GET', '/admin/disputes', ADMIN)).body.items).toHaveLength(0);
  });
});

describe('Hủy / thất bại (T9.7)', () => {
  it('hủy trước khi gặp → tin mở lại; offer khác vẫn chọn được', async () => {
    const { t, txId, listingId } = await withTransaction();
    expect((await post(t, `/transactions/${txId}/cancel`, 'near', { reason: 'Bận đột xuất' })).body).toMatchObject({ status: 'CANCELLED', cancel: { by: 'PARTNER' } });
    expect(await listingStatus(t, listingId)).toBe('ACTIVE');
  });

  it('báo thất bại khi tin đã hết hạn → tin EXPIRED', async () => {
    const { t, txId, listingId } = await withTransaction();
    t.clock.advance(8 * 24 * HOUR_MS);
    expect((await post(t, `/transactions/${txId}/report-failure`, 'owner', { reason: 'NO_SHOW_PARTNER' })).body.status).toBe('FAILED');
    expect(await listingStatus(t, listingId)).toBe('EXPIRED');
  });
});

describe('Đánh giá hai chiều & uy tín (Epic 12)', () => {
  it('mỗi bên đánh giá 1 lần sau khi hoàn tất; chưa xong thì không đánh giá được', async () => {
    const { t, txId } = await withTransaction();
    expect((await post(t, `/transactions/${txId}/review`, 'owner', { rating: 5 })).body.code).toBe('REVIEW_NOT_ALLOWED');
    await post(t, `/transactions/${txId}/confirm-completion`, 'owner');
    await post(t, `/transactions/${txId}/confirm-completion`, 'near');
    expect((await post(t, `/transactions/${txId}/review`, 'owner', { rating: 5, comment: 'Nhanh gọn' })).body).toMatchObject({ label: 'VERIFIED_TRANSACTION', revieweeId: 'near' });
    expect((await post(t, `/transactions/${txId}/review`, 'owner', { rating: 1 })).body.code).toBe('REVIEW_NOT_ALLOWED');
    expect((await post(t, `/transactions/${txId}/review`, 'near', { rating: 4 })).status).toBe(201);

    const pub = await t.call('GET', '/partners/near/public', { user: 'owner' });
    // < 3 review → "Chưa đủ dữ liệu"
    expect(pub.body.reputation).toMatchObject({ averageRating: null, reviewCount: 1, completedCount: 1 });
  });
});

describe('Thông báo (Epic 11)', () => {
  it('Partner nhận thông báo khi có tin phù hợp, được chọn; đánh dấu đã đọc', async () => {
    const { t } = await withTransaction();
    const list = await t.call('GET', '/notifications', { user: 'near' });
    const types = list.body.items.map((n: { type: string }) => n.type);
    expect(types).toEqual(expect.arrayContaining(['PARTNER_APPROVED', 'NEW_MATCH', 'CONFIRMATION_REQUESTED', 'TX_CREATED']));
    const count = (await t.call('GET', '/notifications/unread-count', { user: 'near' })).body.count;
    expect(count).toBe(types.length);
    await post(t, '/notifications/read-all', 'near');
    expect((await t.call('GET', '/notifications/unread-count', { user: 'near' })).body.count).toBe(0);
    // Owner nhận thông báo khi đối tác xác nhận giá
    const ownerTypes = (await t.call('GET', '/notifications', { user: 'owner' })).body.items.map((n: { type: string }) => n.type);
    expect(ownerTypes).toContain('QUOTE_CONFIRMED');
  });
});
