import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../src/shared/clock';
import type { Item } from '../src/store/table';
import { approvedPartner, listingBody, post } from './fixtures';
import { makeTestApp } from './helpers';

const types = async (t: ReturnType<typeof makeTestApp>, user: string) =>
  (await t.call('GET', '/notifications', { user })).body.items.map((n: { type: string }) => n.type);

describe('Job nền (Epic 10)', () => {
  it('tin quá 7 ngày → EXPIRED trong DB, báo giá đóng, Owner nhận thông báo; quét lại không sai (T10.2)', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;

    expect((await t.app.sweeper.sweep()).processed).toBe(0); // chưa tới hạn
    t.clock.advance(7 * 24 * HOUR_MS + 1);
    expect((await t.app.sweeper.sweep()).processed).toBe(1);
    expect((await t.app.sweeper.sweep()).processed).toBe(0); // timer đã xóa → chạy trùng không làm gì

    const stored = await t.table.get<Item & { status: string }>(`LISTING#${listingId}`, 'META');
    expect(stored?.status).toBe('EXPIRED');
    const detail = await t.call('GET', `/listings/${listingId}`, { user: 'owner' });
    expect(detail.body.quotes.every((q: { status: string }) => q.status === 'EXPIRED')).toBe(true);
    expect(await types(t, 'owner')).toContain('LISTING_EXPIRED');
  });

  it('tin đã được chọn đối tác thì job hết hạn bỏ qua', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const q = (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0];
    await post(t, `/listings/${listingId}/quotes/${q.quoteId}/request-confirmation`, 'owner');
    await post(t, `/listings/${listingId}/quotes/${q.quoteId}/confirm`, 'near', { price: 400_000 });
    await post(t, '/transactions', 'owner', { listingId, quoteId: q.quoteId });
    t.clock.advance(8 * 24 * HOUR_MS);
    await t.app.sweeper.sweep();
    expect((await t.table.get<Item & { status: string }>(`LISTING#${listingId}`, 'META'))?.status).toBe('MATCHED');
  });

  it('một bên xác nhận → nhắc bên kia ở 24h → tự hoàn tất ở 48h dù không ai mở trang (QĐ-18)', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const q = (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0];
    await post(t, `/listings/${listingId}/quotes/${q.quoteId}/request-confirmation`, 'owner');
    await post(t, `/listings/${listingId}/quotes/${q.quoteId}/confirm`, 'near', { price: 400_000 });
    const tx = (await post(t, '/transactions', 'owner', { listingId, quoteId: q.quoteId })).body;
    await post(t, `/transactions/${tx.transactionId}/confirm-completion`, 'owner');

    t.clock.advance(24 * HOUR_MS + 1);
    await t.app.sweeper.sweep();
    expect(await types(t, 'near')).toContain('TX_REMIND');
    expect((await t.table.get<Item & { status: string }>(`TX#${tx.transactionId}`, 'META'))?.status).toBe('AWAITING_COUNTERPARTY');

    t.clock.advance(24 * HOUR_MS);
    await t.app.sweeper.sweep();
    expect((await t.table.get<Item & { status: string }>(`TX#${tx.transactionId}`, 'META'))?.status).toBe('COMPLETED');
    expect((await t.table.get<Item & { status: string }>(`LISTING#${listingId}`, 'META'))?.status).toBe('COMPLETED');
    expect(await types(t, 'owner')).toContain('TX_AUTO_COMPLETED');
  });
});
