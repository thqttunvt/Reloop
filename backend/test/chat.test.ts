import { describe, expect, it } from 'vitest';
import { buildApp, loadConfig } from '../src/app';
import { ManualClock } from '../src/shared/clock';
import type { ImageStore } from '../src/storage/imageStore';
import { TERMS_VERSION } from '../src/modules/users/userService';
import { MemoryTable } from '../src/store/memoryTable';
import { FAR, approvedPartner, listingBody, post } from './fixtures';
import { makeTestApp } from './helpers';

async function setup() {
  const t = makeTestApp();
  await approvedPartner(t, 'near');
  const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
  return { t, listingId };
}

describe('Chat người bán ↔ đơn vị thu mua', () => {
  it('đối tác được match mở chat, hai bên nhắn qua lại, đếm chưa đọc, thông báo ở tin đầu tiên', async () => {
    const { t, listingId } = await setup();
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'near')).body;
    expect(conv).toMatchObject({ listingId, ownerId: 'owner', partnerId: 'near', partnerName: 'Thu mua near' });
    // mở lại → cùng cuộc trò chuyện
    expect((await post(t, `/listings/${listingId}/conversations`, 'near')).body.conversationId).toBe(conv.conversationId);

    const path = `/conversations/${conv.conversationId}/messages`;
    expect((await post(t, path, 'near', { text: 'Máy còn sạc không bạn?' })).status).toBe(201);
    await post(t, path, 'near', { text: 'Mình qua lấy chiều nay được không?' });
    await post(t, path, 'owner', { text: 'Còn sạc nhé' });

    const msgs = (await t.call('GET', path, { user: 'owner' })).body;
    expect(msgs.open).toBe(true);
    expect(msgs.items.map((m: { text: string; senderRole: string }) => `${m.senderRole}:${m.text}`)).toEqual([
      'PARTNER:Máy còn sạc không bạn?',
      'PARTNER:Mình qua lấy chiều nay được không?',
      'OWNER:Còn sạc nhé',
    ]);

    const ownerList = (await t.call('GET', '/conversations', { user: 'owner' })).body.items;
    expect(ownerList[0]).toMatchObject({ myRole: 'OWNER', myUnread: 2, lastMessage: 'Còn sạc nhé' });
    await post(t, `/conversations/${conv.conversationId}/read`, 'owner');
    expect((await t.call('GET', '/conversations', { user: 'owner' })).body.items[0].myUnread).toBe(0);

    // 2 tin liên tiếp chưa đọc → chỉ 1 thông báo
    const chatNotes = (await t.call('GET', '/notifications', { user: 'owner' })).body.items.filter((n: { type: string }) => n.type === 'CHAT_MESSAGE');
    expect(chatNotes).toHaveLength(1);
  });

  it('chủ tin chủ động nhắn đối tác đã match; người ngoài không đọc được cuộc trò chuyện của người khác', async () => {
    const { t, listingId } = await setup();
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'owner', { partnerId: 'near' })).body;
    expect(conv.partnerId).toBe('near');
    expect((await t.call('GET', `/conversations/${conv.conversationId}/messages`, { user: 'stranger' })).status).toBe(404);
    expect((await post(t, `/conversations/${conv.conversationId}/messages`, 'stranger', { text: 'hi' })).status).toBe(404);

    // Chủ tin không tự mở chat với người chưa từng nhắn / không được match
    await approvedPartner(t, 'far', { location: FAR });
    expect((await post(t, `/listings/${listingId}/conversations`, 'owner', { partnerId: 'far' })).status).toBe(404);
  });

  it('tin đã hủy → không gửi tin nhắn được nữa', async () => {
    const { t, listingId } = await setup();
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'near')).body;
    await post(t, `/listings/${listingId}/cancel`, 'owner');
    expect((await post(t, `/conversations/${conv.conversationId}/messages`, 'near', { text: 'còn không?' })).body.code).toBe('CHAT_CLOSED');
  });
});

describe('Đăng tin phải đủ thông tin', () => {
  it('thiếu mô tả → 400', async () => {
    const t = makeTestApp();
    const { description: _d, ...noDesc } = listingBody();
    expect((await post(t, '/listings', 'owner', noDesc)).body.code).toBe('INVALID_DESCRIPTION');
  });

  it('có S3 thì bắt buộc ít nhất 1 ảnh', async () => {
    const images: ImageStore = {
      enabled: true,
      createUpload: async () => ({ key: 'k', url: 'u', fields: {}, expiresInSeconds: 1 }),
      viewUrl: async () => '',
      markAttached: async () => undefined,
      markModerated: async () => undefined,
      assertModerated: async () => undefined,
      remove: async () => undefined,
      read: async () => ({ mediaType: 'image/jpeg', data: '' }),
    };
    const app = buildApp({ ...loadConfig({ STAGE: 'local' }), dataFile: undefined }, { table: new MemoryTable(), clock: new ManualClock(), images });
    const listings = app.services.listings;
    await app.services.users.acceptTerms({ userId: 'owner', groups: [] }, TERMS_VERSION);
    await app.services.partners.apply({ userId: 'owner', groups: [] }, { tier: 'INDIVIDUAL', businessType: 'PERSONAL', businessName: 'Người bán', licenseNo: '001099012345', contactEmail: 'owner@mail.vn' });
    await app.services.partners.review('admin1', 'owner', true);
    await expect(listings.create({ userId: 'owner', groups: [] }, listingBody())).rejects.toMatchObject({ code: 'IMAGES_REQUIRED' });
    const ok = await listings.create({ userId: 'owner', groups: [] }, listingBody({ imageKeys: ['listings/owner/a.jpg'] }));
    expect(ok.imageKeys).toEqual(['listings/owner/a.jpg']);
  });
});

describe('Bảng tin kiểu chợ', () => {
  it('mọi người đã đăng nhập thấy tin đang mở, mới nhất trước, có tên người bán, không có vị trí; tin đã hủy biến mất', async () => {
    const t = makeTestApp();
    await t.call('PATCH', '/me', { user: 'owner', body: { fullName: 'Nguyễn Văn An' } });
    const a = (await post(t, '/listings', 'owner', listingBody({ title: 'Tin A cũ' }))).body;
    t.clock.advance(60_000);
    const b = (await post(t, '/listings', 'owner', listingBody({ title: 'Tin B mới' }))).body;

    const feed = (await t.call('GET', '/feed', { user: 'buyer' })).body;
    expect(feed.items.map((i: { listing: { title: string } }) => i.listing.title)).toEqual(['Tin B mới', 'Tin A cũ']);
    expect(feed.items[0]).toMatchObject({ isMine: false, seller: { displayName: 'Người bán owner' } }); // tên trong hồ sơ đối tác (QĐ-34)
    expect(feed.items[0].listing.location).toBeUndefined();
    expect((await t.call('GET', '/feed', { user: 'owner' })).body.items[0].isMine).toBe(true);

    await post(t, `/listings/${a.listingId}/cancel`, 'owner');
    const after = (await t.call('GET', '/feed', { user: 'buyer' })).body.items.map((i: { listing: { listingId: string } }) => i.listing.listingId);
    expect(after).toEqual([b.listingId]);
  });

  it('phân trang bằng cursor', async () => {
    const t = makeTestApp();
    for (let i = 0; i < 3; i++) {
      await post(t, '/listings', 'owner', listingBody({ title: `Tin ${i}` }));
      t.clock.advance(1000);
    }
    const app = t.app.services.listings;
    const p1 = await app.feed('buyer', undefined, 2);
    expect(p1.items.map((i) => i.listing.title)).toEqual(['Tin 2', 'Tin 1']);
    const p2 = await app.feed('buyer', p1.nextCursor, 2);
    expect(p2.items.map((i) => i.listing.title)).toEqual(['Tin 0']);
    expect(p2.nextCursor).toBeUndefined();
  });

  it('phân trang thật: nhiều đợt đọc nhỏ, vắt qua 2 tháng, bỏ tin đã hủy, không trùng / sót (mục 11 danhgia)', async () => {
    const t = makeTestApp();
    t.clock.advance(29 * 24 * 3600_000); // 30/01
    const titles: string[] = [];
    for (let i = 0; i < 9; i++) {
      if (i === 5) t.clock.advance(3 * 24 * 3600_000); // sang 02/02 → 4 tin cuối nằm ở ngăn tháng 2
      const seller = `s${i % 3}`; // 3 người bán cấp 1, mỗi người ≤ 3 tin đang mở (QĐ-41)
      const l = (await post(t, '/listings', seller, listingBody({ title: `Tin ${i}` }))).body;
      if (i === 3) await post(t, `/listings/${l.listingId}/cancel`, seller);
      else titles.unshift(`Tin ${i}`);
      t.clock.advance(60_000);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await t.app.services.listings.feed('buyer', cursor, 3, 2);
      seen.push(...page.items.map((i) => i.listing.title));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(titles); // 8 tin, mới nhất trước, đủ cả 2 tháng
  });

  it('người mua bất kỳ (không phải đối tác) nhắn tin cho người bán từ bảng tin', async () => {
    const t = makeTestApp();
    await t.call('PATCH', '/me', { user: 'buyer', body: { fullName: 'Lê Thị Mua' } });
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'buyer')).body;
    expect(conv).toMatchObject({ ownerId: 'owner', partnerId: 'buyer', partnerName: 'Lê Thị Mua' });
    await post(t, `/conversations/${conv.conversationId}/messages`, 'buyer', { text: 'Còn bán không ạ?' });
    const ownerConvs = (await t.call('GET', '/conversations', { user: 'owner' })).body.items;
    expect(ownerConvs[0]).toMatchObject({ partnerName: 'Lê Thị Mua', myUnread: 1, lastMessage: 'Còn bán không ạ?' });
    // chủ tin không tự "mua" tin của mình
    expect((await post(t, `/listings/${listingId}/conversations`, 'owner')).status).toBe(400);
  });
});

describe('Ra giá trong chat → chốt giao dịch (QĐ-38)', () => {
  /** Anh A (seller) đăng tin; khách B, C, D mở chat. */
  async function market() {
    const t = makeTestApp();
    const { listingId } = (await post(t, '/listings', 'seller', listingBody())).body;
    const conv: Record<string, string> = {};
    for (const buyer of ['b', 'c', 'd']) {
      await t.call('PATCH', '/me', { user: buyer, body: { fullName: `Khách ${buyer.toUpperCase()}` } });
      conv[buyer] = (await post(t, `/listings/${listingId}/conversations`, buyer)).body.conversationId;
    }
    const offer = async (user: string, buyer: string, price: number) =>
      (await post(t, `/conversations/${conv[buyer]}/offers`, user, { price })).body;
    const respond = (user: string, buyer: string, offerId: string, accept = true) =>
      post(t, `/conversations/${conv[buyer]}/offers/${offerId}/${accept ? 'accept' : 'reject'}`, user);
    const feedIds = async (user: string) =>
      (await t.call('GET', '/feed', { user })).body.items.map((i: { listing: { listingId: string } }) => i.listing.listingId);
    return { t, listingId, conv, offer, respond, feedIds };
  }

  it('khách D ra giá 200k, người bán chấp nhận → giao dịch; B, C được báo, tin rời Chợ, chat của B / C khóa', async () => {
    const { t, listingId, conv, offer, respond, feedIds } = await market();
    const fromB = await offer('b', 'b', 150_000);
    await offer('c', 'c', 170_000);
    const fromD = await offer('d', 'd', 200_000);
    expect(fromD).toMatchObject({ kind: 'OFFER', price: 200_000, senderRole: 'PARTNER' });
    expect((await respond('d', 'd', fromD.offerId)).body.code).toBe('OWN_OFFER'); // không tự chấp nhận giá của mình

    const deal = (await respond('seller', 'd', fromD.offerId)).body;
    expect(deal.transactionId).toBeTruthy();
    const tx = (await t.call('GET', `/transactions/${deal.transactionId}`, { user: 'd' })).body;
    expect(tx).toMatchObject({ role: 'PARTNER', transaction: { source: 'CHAT', status: 'HANDOVER_PENDING', agreedPrice: 200_000, ownerId: 'seller', partnerId: 'd', partnerName: 'Khách D' } });
    expect(tx.contacts.partner.businessName).toBe('Khách D');

    // Tin rời Chợ; B, C được báo; chat của B khóa, giá của B không chấp nhận được nữa
    expect(await feedIds('b')).not.toContain(listingId);
    const noteB = (await t.call('GET', '/notifications', { user: 'b' })).body.items.map((n: { type: string }) => n.type);
    expect(noteB).toContain('LISTING_TAKEN');
    expect((await t.call('GET', '/notifications', { user: 'd' })).body.items.map((n: { type: string }) => n.type)).not.toContain('LISTING_TAKEN');
    expect((await post(t, `/conversations/${conv.b}/messages`, 'b', { text: 'Còn không?' })).body.code).toBe('CHAT_CLOSED');
    expect((await respond('seller', 'b', fromB.offerId)).body.code).toBe('CHAT_CLOSED');
    expect((await t.call('GET', `/conversations/${conv.b}/messages`, { user: 'b' })).body.open).toBe(false);
    // Người mua mới không mở chat được; chỉ D thấy đường dẫn tới giao dịch
    expect((await post(t, `/listings/${listingId}/conversations`, 'e')).body.code).toBe('CHAT_CLOSED');
    expect((await t.call('GET', `/listings/${listingId}`, { user: 'b' })).body.listing.activeTransactionId).toBeUndefined();
    expect((await t.call('GET', `/listings/${listingId}`, { user: 'd' })).body.listing.activeTransactionId).toBe(deal.transactionId);

    // Chat giữa người bán và D vẫn mở; ra giá mới trong lúc giao dịch → đổi giá
    const chatD = (await t.call('GET', `/conversations/${conv.d}/messages`, { user: 'd' })).body;
    expect(chatD).toMatchObject({ open: true, transactionId: deal.transactionId });
    const counter = await offer('seller', 'd', 180_000);
    expect((await respond('d', 'd', counter.offerId)).body.transactionId).toBe(deal.transactionId);
    expect((await t.call('GET', `/transactions/${deal.transactionId}`, { user: 'seller' })).body.transaction.agreedPrice).toBe(180_000);

    // Hoàn tất → người bán trả phí 10.000đ (QĐ-37)
    await post(t, `/transactions/${deal.transactionId}/confirm-completion`, 'seller');
    expect((await post(t, `/transactions/${deal.transactionId}/confirm-completion`, 'd')).body.status).toBe('COMPLETED');
    expect((await t.call('GET', '/billing/me', { user: 'seller' })).body.currentMonth.amount).toBe(10_000);
    expect((await post(t, `/conversations/${conv.d}/messages`, 'd', { text: 'Cảm ơn' })).body.code).toBe('CHAT_CLOSED');
  });

  it('hủy giao dịch từ chat → 5 phút sau tin quay lại Chợ, khách khác ra giá lại được', async () => {
    const { t, listingId, offer, respond, feedIds } = await market();
    const deal = (await respond('seller', 'd', (await offer('d', 'd', 200_000)).offerId)).body;
    await post(t, `/transactions/${deal.transactionId}/cancel`, 'd', { reason: 'Không cần nữa' });
    expect(await feedIds('b')).not.toContain(listingId);
    t.clock.advance(5 * 60_000);
    expect(await feedIds('b')).toContain(listingId);
    const again = await offer('b', 'b', 160_000);
    expect((await respond('seller', 'b', again.offerId)).body.transactionId).toBeTruthy();
  });

  it('từ chối giá; lời mới thay lời cũ; 2 người bán bấm chấp nhận cùng lúc 2 khách → chỉ 1 giao dịch', async () => {
    const { t, conv, offer, respond } = await market();
    const first = await offer('b', 'b', 100_000);
    const second = await offer('b', 'b', 120_000);
    expect((await respond('seller', 'b', first.offerId)).body.code).toBe('OFFER_NOT_PENDING'); // đã bị thay
    expect((await respond('seller', 'b', second.offerId, false)).status).toBe(200);
    const msgs = (await t.call('GET', `/conversations/${conv.b}/messages`, { user: 'b' })).body;
    expect(msgs.conversation.pendingOffer).toBeUndefined();
    expect(msgs.items.at(-1)).toMatchObject({ kind: 'SYSTEM', text: 'Đã từ chối giá 120.000đ' });

    const fromC = await offer('c', 'c', 150_000);
    const fromD = await offer('d', 'd', 200_000);
    const results = await Promise.all([respond('seller', 'c', fromC.offerId), respond('seller', 'd', fromD.offerId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await t.call('GET', '/transactions', { user: 'seller' })).body.items).toHaveLength(1);
  });

  it('người bán bị tạm ngừng → chat của tin khóa, không chốt được; mở lại thì bình thường', async () => {
    const { t, offer, respond, conv } = await market();
    const fromD = await offer('d', 'd', 200_000);
    await t.services.partners.setSuspended('admin1', 'seller', true);
    expect((await respond('seller', 'd', fromD.offerId)).body.code).toBe('CHAT_CLOSED');
    expect((await post(t, `/conversations/${conv.b}/messages`, 'b', { text: 'Còn không?' })).body.code).toBe('CHAT_CLOSED');
    await t.services.partners.setSuspended('admin1', 'seller', false);
    expect((await respond('seller', 'd', fromD.offerId)).body.transactionId).toBeTruthy();
  });
});
