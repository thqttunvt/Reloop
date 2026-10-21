import { describe, expect, it } from 'vitest';
import { keys } from '../src/store/keys';
import { putVersioned, type Item, type WriteOp } from '../src/store/table';
import { ADMIN, approvedPartner, listingBody, post } from './fixtures';
import { makeTestApp } from './helpers';

describe('Admin xem chat của một tin (mục 20 danhgia)', () => {
  it('Admin thấy mọi cuộc trò chuyện về tin (kể cả lời ra giá); người khác bị 403', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const withNear = (await post(t, `/listings/${listingId}/conversations`, 'near')).body.conversationId;
    const withBuyer = (await post(t, `/listings/${listingId}/conversations`, 'buyer')).body.conversationId;
    await post(t, `/conversations/${withNear}/messages`, 'near', { text: 'Máy còn sạc không?' });
    await post(t, `/conversations/${withBuyer}/offers`, 'buyer', { price: 150_000 });

    expect((await t.call('GET', `/admin/listings/${listingId}/chats`, { user: 'owner' })).status).toBe(403);
    const res = (await t.call('GET', `/admin/listings/${listingId}/chats`, ADMIN)).body;
    expect(res.listing).toMatchObject({ listingId, ownerId: 'owner' });
    const byBuyer = Object.fromEntries(res.conversations.map((c: { conversation: { partnerId: string }; messages: unknown[] }) => [c.conversation.partnerId, c.messages]));
    expect(byBuyer.near).toEqual([expect.objectContaining({ text: 'Máy còn sạc không?' })]);
    expect(byBuyer.buyer).toEqual([expect.objectContaining({ kind: 'OFFER', price: 150_000 })]);
  });
});

describe('Ghép đối tác khi tin vừa bị đổi (mục 10 danhgia)', () => {
  it('chủ tin hủy tin đúng lúc đang ghép → không lỗi 500, tin vẫn là đã hủy', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    // Ngay trước lần ghi "đã ghép xong" đầu tiên: chen một lần ghi khác vào tin (mô phỏng chủ tin vừa bấm Hủy)
    const original = t.table.transact.bind(t.table);
    let raced = false;
    t.table.transact = async (ops: WriteOp[]) => {
      const done = ops.find((op) => op.type === 'put' && (op.item as Item).matchingStatus === 'DONE');
      if (done && !raced && done.type === 'put') {
        raced = true;
        const k = keys.listing(String(done.item.listingId));
        const current = (await t.table.get<Item>(k.pk, k.sk))!;
        await original([putVersioned({ ...current, status: 'CANCELLED' }, current.version ?? 1)]);
      }
      return original(ops);
    };

    const res = await post(t, '/listings', 'owner', listingBody());
    expect(raced).toBe(true);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'CANCELLED', matchingStatus: 'DONE', matchCount: 1 });
  });
});
