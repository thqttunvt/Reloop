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
    await app.services.partners.apply({ userId: 'owner', groups: [] }, { tier: 'INDIVIDUAL', businessName: 'Người bán', contactEmail: 'owner@mail.vn' });
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
