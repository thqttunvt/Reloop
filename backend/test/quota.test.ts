import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../src/shared/clock';
import { approvedPartner, listingBody, post, type T } from './fixtures';
import { makeTestApp } from './helpers';

const DAY = 24 * HOUR_MS;

const postListing = async (t: T, user = 'owner') => post(t, '/listings', user, listingBody());
const quotaOf = async (t: T, user = 'owner') => (await t.call('GET', '/partners/me', { user })).body.quota;

describe('Hạn mức tin đang mở cùng lúc + gói VIP 1 (QĐ-41)', () => {
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

  it('mua VIP 1: 5 tin, 10.000đ vào phí tháng (không tính là giao dịch), mua tiếp thì cộng dồn; hết hạn → về 3', async () => {
    const t = makeTestApp();
    for (let i = 0; i < 3; i++) await postListing(t);
    const bought = (await post(t, '/partners/me/vip', 'owner')).body;
    expect(bought.charged).toBe(10_000);
    const until = bought.partner.vip.until;
    expect(Date.parse(until) - Date.parse('2026-01-01T00:00:00.000Z')).toBe(30 * DAY);
    expect(await quotaOf(t)).toMatchObject({ plan: 'VIP1', limit: 5, open: 3, vipUntil: until, vipPrice: 10_000 });
    expect((await postListing(t)).status).toBe(201);
    expect((await postListing(t)).status).toBe(201);
    expect((await postListing(t)).body.code).toBe('LISTING_QUOTA_REACHED');

    const bill = (await t.call('GET', '/billing/me', { user: 'owner' })).body.currentMonth;
    expect(bill).toMatchObject({ amount: 10_000, transactionCount: 0 });
    expect(bill.lines[0]).toMatchObject({ kind: 'VIP_PLAN', amount: 10_000 });
    expect((await t.call('GET', '/notifications', { user: 'owner' })).body.items.map((n: { type: string }) => n.type)).toContain('VIP_ACTIVATED');

    // Mua tiếp khi còn hạn → cộng dồn 30 ngày, tính thêm 10.000đ
    const renewed = (await post(t, '/partners/me/vip', 'owner')).body.partner.vip.until;
    expect(Date.parse(renewed) - Date.parse(until)).toBe(30 * DAY);
    expect((await t.call('GET', '/billing/me', { user: 'owner' })).body.currentMonth.amount).toBe(20_000);

    // Hết hạn VIP → hạn mức về 3 (tin cũ đã hết hạn 7 ngày nên không còn mở)
    t.clock.advance(61 * DAY);
    expect(await quotaOf(t)).toMatchObject({ plan: 'BASIC', limit: 3, open: 0 });
  });

  it('cấp 2: tối đa 10 tin, không mua VIP 1; lập hóa đơn tháng đếm giao dịch riêng, tiền VIP vẫn tính', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'biz');
    for (let i = 0; i < 10; i++) expect((await postListing(t, 'biz')).status).toBe(201);
    expect((await postListing(t, 'biz')).body).toMatchObject({ code: 'LISTING_QUOTA_REACHED', details: { limit: 10, plan: 'BUSINESS' } });
    expect((await post(t, '/partners/me/vip', 'biz')).body.code).toBe('VIP_NOT_AVAILABLE');
    expect(await quotaOf(t, 'biz')).toMatchObject({ plan: 'BUSINESS', limit: 10, open: 10 });

    // Hóa đơn tháng: chỉ VIP → 0 giao dịch, 10.000đ
    await postListing(t); // "owner" thành đối tác cấp 1 đã duyệt
    expect((await post(t, '/partners/me/vip', 'owner')).body.charged).toBe(10_000);
    t.clock.advance(31 * DAY);
    await t.app.sweeper.sweep();
    expect((await t.call('GET', '/billing/me', { user: 'owner' })).body.invoices[0]).toMatchObject({ month: '2026-01', amount: 10_000, transactionCount: 0 });
  });

  it('chưa là đối tác / bị tạm ngừng thì không mua được VIP', async () => {
    const t = makeTestApp();
    expect((await post(t, '/partners/me/vip', 'nobody')).body.code).toBe('PARTNER_REQUIRED');
    await postListing(t); // "owner" thành đối tác cấp 1 đã duyệt
    await t.services.partners.setSuspended('admin1', 'owner', true);
    expect((await post(t, '/partners/me/vip', 'owner')).body.code).toBe('PARTNER_REQUIRED');
  });
});
