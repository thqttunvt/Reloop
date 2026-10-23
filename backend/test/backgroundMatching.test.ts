import { describe, expect, it } from 'vitest';
import type { Listing } from '../src/modules/listings/listingService';
import { approvedPartner, listingBody, post, type T } from './fixtures';
import { makeTestApp } from './helpers';

const MIN = 60 * 1000;

const types = async (t: T, user: string) => ((await t.call('GET', '/notifications', { user })).body.items as { type: string }[]).map((n) => n.type);
const listingOf = async (t: T, id: string) => (await t.call('GET', `/listings/${id}`, { user: 'owner' })).body.listing as Listing;

describe('Ghép tin chạy nền (QĐ-13, B7)', () => {
  it('đăng tin trả ngay với matchingStatus PENDING; worker không chạy → job sau 5 phút ghép, báo đối tác 1 lần', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    t.services.listings.dispatchMatching = async () => {}; // AWS: Lambda async — ở đây giả như worker chưa / không chạy

    const res = await post(t, '/listings', 'owner', listingBody());
    expect(res).toMatchObject({ status: 201, body: { status: 'ACTIVE', matchingStatus: 'PENDING', matchCount: 0 } });
    const id = res.body.listingId;
    expect(await types(t, 'near')).not.toContain('NEW_MATCH');

    await t.app.sweeper.sweep(); // chưa tới 5 phút → chưa chạy
    expect((await listingOf(t, id)).matchingStatus).toBe('PENDING');
    t.clock.advance(6 * MIN);
    await t.app.sweeper.sweep();
    expect(await listingOf(t, id)).toMatchObject({ matchingStatus: 'DONE', matchCount: 1, quoteCount: 1 });
    expect((await types(t, 'near')).filter((x) => x === 'NEW_MATCH')).toHaveLength(1);
  });

  it('gọi worker lỗi vẫn đăng tin được; job dự phòng ghép sau', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    t.services.listings.dispatchMatching = async () => {
      throw new Error('Lambda throttled');
    };
    const res = await post(t, '/listings', 'owner', listingBody());
    expect(res.body).toMatchObject({ matchingStatus: 'PENDING' });
    t.clock.advance(6 * MIN);
    await t.app.sweeper.sweep();
    expect((await listingOf(t, res.body.listingId)).matchingStatus).toBe('DONE');
  });

  it('ghép chạy lại (worker tới muộn) không ghi đè báo giá chủ tin đã thao tác, không báo trùng', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const quoteId = (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0].quoteId;
    await post(t, `/listings/${listingId}/quotes/${quoteId}/request-confirmation`, 'owner');

    // Mô phỏng lượt ghép thứ 2 tới sau khi lượt đầu đã xong
    const svc = t.services.listings as unknown as { runMatching: (l: Listing) => Promise<Listing> };
    await svc.runMatching({ ...(await listingOf(t, listingId)), matchingStatus: 'PENDING' });
    await t.services.listings.matchIfPending(listingId); // DONE rồi → không làm gì

    const quote = (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0];
    expect(quote.status).toBe('CONFIRMATION_REQUESTED');
    expect((await types(t, 'near')).filter((x) => x === 'NEW_MATCH')).toHaveLength(1);
  });
});

describe('Lịch sử giao dịch 30 ngày của người bán trên tin (QĐ-39 hướng A)', () => {
  it('người xem thấy số giao dịch hoàn tất / bị hủy; chủ tin không cần', async () => {
    const t = makeTestApp();
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'buyer')).body.conversationId;
    const deal = async (price: number) => {
      const offer = (await post(t, `/conversations/${conv}/offers`, 'buyer', { price })).body;
      return (await post(t, `/conversations/${conv}/offers/${offer.offerId}/accept`, 'owner')).body.transactionId as string;
    };

    // 1 giao dịch bị hủy (tin quay lại Chợ) rồi 1 giao dịch hoàn tất
    const first = await deal(200_000);
    await post(t, `/transactions/${first}/cancel`, 'buyer', { reason: 'Đổi ý' });
    await post(t, `/transactions/${first}/cancel/confirm`, 'owner');
    const second = await deal(250_000);
    await post(t, `/transactions/${second}/confirm-completion`, 'owner', { finalPrice: 250_000 });
    await post(t, `/transactions/${second}/confirm-completion`, 'buyer');

    const other = (await post(t, '/listings', 'owner', listingBody({ title: 'Điện thoại cũ' }))).body.listingId;
    expect((await t.call('GET', `/listings/${other}`, { user: 'stranger' })).body.sellerHistory).toEqual({ days: 30, completed: 1, cancelled: 1 });
    expect((await t.call('GET', `/listings/${other}`, { user: 'owner' })).body.sellerHistory).toBeUndefined();

    // Quá 30 ngày → không còn đếm
    t.clock.advance(31 * 24 * 60 * MIN);
    const third = (await post(t, '/listings', 'owner', listingBody({ title: 'Máy tính bảng' }))).body.listingId;
    expect((await t.call('GET', `/listings/${third}`, { user: 'stranger' })).body.sellerHistory).toEqual({ days: 30, completed: 0, cancelled: 0 });
  });
});
