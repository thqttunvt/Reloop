import { describe, expect, it } from 'vitest';
import { keys } from '../src/store/keys';
import { MemoryTable } from '../src/store/memoryTable';
import { pageQuery } from '../src/store/paging';
import { putNew, type Item } from '../src/store/table';
import { HOUR_MS } from '../src/shared/clock';
import { ADMIN, acceptTerms, listingBody, post } from './fixtures';
import { makeTestApp } from './helpers';

const FINANCE = { user: 'fin1', groups: ['admin', 'admin_finance'] };

describe('pageQuery (get.md 2.1)', () => {
  it('không lặp, không mất dòng khi nhiều item cùng sort key; cursor hỏng → 400; trang cuối không có cursor', async () => {
    const table = new MemoryTable();
    const at = (i: number) => `2026-01-01T00:00:0${Math.floor(i / 3)}.000Z`; // 3 item / thời điểm
    for (let i = 0; i < 10; i++) await table.transact([putNew({ pk: 'P', sk: `${at(i)}#${i}`, gsi1pk: 'G', gsi1sk: at(i), n: i })]);
    for (const index of [undefined, 'gsi1'] as const) {
      const got: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await pageQuery<Item & { n: number }>(table, index ? 'G' : 'P', { index, limit: 2, cursor });
        got.push(...page.items.map((x) => x.n));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect([...got].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(pages).toBe(5);
    }
    await expect(pageQuery(table, 'P', { cursor: 'khong-hop-le' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

describe('Nhật ký thao tác Admin (get.md A5)', () => {
  it('POST /admin/* thành công → 1 dòng, chỉ field cho phép; 4xx không ghi; xem hồ sơ người khác = pii-read', async () => {
    const t = makeTestApp();
    await acceptTerms(t, 'seller');
    await t.call('POST', '/partners/apply', {
      user: 'seller',
      body: { tier: 'INDIVIDUAL', businessType: 'PERSONAL', businessName: 'Người bán', licenseNo: '001099012345', contactEmail: 's@mail.vn' },
    });
    const ok = await t.call('POST', '/admin/partners/seller/review', { ...ADMIN, body: { approve: true, note: 'đủ giấy tờ', stk: '0123456789', token: 'bí mật' } });
    expect(ok.status).toBe(200);
    const fail = await t.call('POST', '/admin/partners/seller/review', { ...ADMIN, body: { approve: true } }); // đã duyệt → 409
    expect(fail.status).toBe(409);
    await t.call('GET', '/admin/users/seller', ADMIN);

    const log = (await t.call('GET', '/admin/audit?month=2026-01', ADMIN)).body.items;
    expect(log).toHaveLength(2);
    const write = log.find((x: { kind: string }) => x.kind === 'write');
    expect(write).toMatchObject({ adminId: 'admin1', method: 'POST', routePath: '/admin/partners/{id}/review', params: { id: 'seller' }, fields: { approve: true, note: 'đủ giấy tờ' } });
    expect(JSON.stringify(write)).not.toMatch(/0123456789|bí mật/);
    expect(log.find((x: { kind: string }) => x.kind === 'pii-read')).toMatchObject({ routePath: '/admin/users/{id}', params: { id: 'seller' } });
    expect((await t.call('GET', '/admin/audit', { user: 'seller' })).status).toBe(403);
  });

  it('ghi nhật ký lỗi → thao tác vẫn trả 200', async () => {
    const t = makeTestApp();
    const original = t.table.transact.bind(t.table);
    t.table.transact = async (ops) => {
      if (ops.some((op) => op.type === 'put' && op.item.pk.startsWith('AUDIT#'))) throw new Error('DynamoDB down');
      return original(ops);
    };
    expect((await t.call('POST', '/admin/billing/issue', { ...FINANCE, body: { month: '2025-12' } })).status).toBe(200);
  });
});

describe('Thành viên + hồ sơ gộp (get.md A2)', () => {
  it('getOrCreate ghi ROLE#Owner; liệt kê phân trang; tìm email; hồ sơ gộp có tin + giao dịch + đối tác', async () => {
    const t = makeTestApp();
    for (const u of ['a1', 'b2', 'c3']) await t.call('GET', '/me', { user: u, headers: { 'x-dev-email': `${u}@gmail.com` } });
    const page1 = (await t.call('GET', '/admin/users', ADMIN)).body;
    expect(page1.items.map((x: { userId: string }) => x.userId).sort()).toEqual(['a1', 'b2', 'c3']);
    expect((await t.call('GET', '/admin/users?email=B2@GMAIL', ADMIN)).body.items).toEqual([expect.objectContaining({ userId: 'b2' })]);
    expect((await t.call('GET', '/admin/users?email=x', ADMIN)).status).toBe(400);

    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'buyer')).body.conversationId;
    const offer = (await post(t, `/conversations/${conv}/offers`, 'buyer', { price: 200_000 })).body;
    await post(t, `/conversations/${conv}/offers/${offer.offerId}/accept`, 'owner');

    const detail = (await t.call('GET', '/admin/users/owner', ADMIN)).body;
    expect(detail.partner).toMatchObject({ tier: 'INDIVIDUAL', status: 'APPROVED' });
    expect(detail.quota).toMatchObject({ plan: 'BASIC', limit: 3 });
    expect(detail.listings.items).toEqual([expect.objectContaining({ listingId, status: 'MATCHED' })]);
    expect(detail.transactions.items).toEqual([expect.objectContaining({ listingId, status: 'HANDOVER_PENDING', agreedPrice: 200_000 })]);
    expect(detail.profile).not.toHaveProperty('pk');
    expect((await t.call('GET', '/admin/users/khong-co', ADMIN)).status).toBe(404);
  });
});

describe('Giao dịch theo trạng thái + phản ánh đã xử lý + tin theo tháng + số liệu (get.md A1, A3, A4, A6)', () => {
  it('GSI1 TX#STATUS# đổi theo trạng thái; listDisputed vẫn đúng; tin lọc theo trạng thái; số liệu tháng', async () => {
    const t = makeTestApp();
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const conv = (await post(t, `/listings/${listingId}/conversations`, 'buyer')).body.conversationId;
    const offer = (await post(t, `/conversations/${conv}/offers`, 'buyer', { price: 300_000 })).body;
    const { transactionId } = (await post(t, `/conversations/${conv}/offers/${offer.offerId}/accept`, 'owner')).body;

    const list = async (status: string) => (await t.call('GET', `/admin/transactions?status=${status}`, ADMIN)).body.items.map((x: { transactionId: string }) => x.transactionId);
    expect(await list('HANDOVER_PENDING')).toEqual([transactionId]);
    await post(t, `/transactions/${transactionId}/confirm-completion`, 'owner', { finalPrice: 300_000 });
    expect(await list('HANDOVER_PENDING')).toEqual([]);
    expect(await list('AWAITING_COUNTERPARTY')).toEqual([transactionId]);
    await post(t, `/transactions/${transactionId}/dispute`, 'buyer', { reason: 'Giá cuối sai' });
    expect(await list('DISPUTED')).toEqual([transactionId]);
    expect((await t.call('GET', '/admin/disputes', ADMIN)).body.items).toEqual([expect.objectContaining({ transactionId })]);
    await t.call('POST', `/admin/transactions/${transactionId}/resolve`, { ...ADMIN, body: { outcome: 'COMPLETED', finalPrice: 280_000, note: 'Đã xem chat' } });
    expect(await list('DISPUTED')).toEqual([]);
    expect(await list('COMPLETED')).toEqual([transactionId]);
    expect((await t.call('GET', '/admin/transactions?status=LẠ', ADMIN)).status).toBe(400);

    // Admin xem giao dịch của người khác → pii-read; chính chủ xem → không ghi
    await t.call('GET', `/transactions/${transactionId}`, ADMIN);
    await t.call('GET', `/transactions/${transactionId}`, { user: 'owner' });
    const reads = (await t.call('GET', '/admin/audit?month=2026-01', ADMIN)).body.items.filter((x: { kind: string }) => x.kind === 'pii-read');
    expect(reads).toEqual([expect.objectContaining({ routePath: '/transactions/{id}', adminId: 'admin1' })]);

    // Phản ánh đã xử lý
    const report = (await post(t, '/reports', 'buyer', { targetType: 'LISTING', targetId: listingId, reason: 'Mô tả sai sự thật' })).body;
    expect((await t.call('GET', '/admin/reports?status=RESOLVED', ADMIN)).body.items).toEqual([]);
    await t.call('POST', `/admin/reports/${report.reportId}/resolve`, { ...ADMIN, body: { action: 'WARN', note: 'Nhắc nhở' } });
    expect((await t.call('GET', '/admin/reports?status=RESOLVED', ADMIN)).body.items).toEqual([
      expect.objectContaining({ reportId: report.reportId, resolution: expect.objectContaining({ action: 'WARN', by: 'admin1' }), target: expect.objectContaining({ link: `/listings/${listingId}` }) }),
    ]);

    // Tin theo tháng (UTC)
    await post(t, '/listings', 'owner', listingBody({ title: 'Điện thoại Samsung vỡ' }));
    const listings = (q: string) => t.call('GET', `/admin/listings?month=2026-01${q}`, ADMIN);
    expect((await listings('')).body).toMatchObject({ month: '2026-01', timezone: 'UTC' });
    expect((await listings('')).body.items).toHaveLength(2);
    expect((await listings('&status=COMPLETED')).body.items).toEqual([expect.objectContaining({ listingId })]);
    expect((await listings('&status=ACTIVE')).body.items).toEqual([expect.objectContaining({ title: 'Điện thoại Samsung vỡ' })]);
    t.clock.advance(8 * 24 * HOUR_MS);
    expect((await listings('&status=EXPIRED')).body.items).toHaveLength(1);

    // Số liệu tháng (giờ VN): 1 giao dịch hoàn tất = 10.000đ
    const stats = (await t.call('GET', '/admin/stats?month=2026-01', ADMIN)).body;
    expect(stats.month).toMatchObject({ month: '2026-01', completedTransactions: 1, feesAccrued: 10_000, feesIssued: 0, feesPaid: 0 });
    expect(keys.auditPk('2026-01')).toBe('AUDIT#2026-01');
  });
});
