import { describe, expect, it } from 'vitest';
import type { ImageStore } from '../src/storage/imageStore';
import { classifyModeration, type ImageModerator } from '../src/storage/moderator';
import { ADMIN, approvedPartner, listingBody, post, type T } from './fixtures';
import { makeTestApp } from './helpers';

const report = async (t: T, by: string, targetType: string, targetId: string) =>
  (await post(t, '/reports', by, { targetType, targetId, reason: 'Nghi hàng gian, không giấy tờ' })).body.reportId as string;
const resolve = (t: T, reportId: string, action: string, note?: string) =>
  t.call('POST', `/admin/reports/${reportId}/resolve`, { ...ADMIN, body: { action, note } });
const types = async (t: T, user: string) => (await t.call('GET', '/notifications', { user })).body.items.map((n: { type: string }) => n.type);
const openReports = async (t: T) => (await t.call('GET', '/admin/reports', ADMIN)).body.items;

/** Khách "d" ra giá trong chat, chủ tin chấp nhận → tin đang giao dịch. */
async function inTransaction(t: T, listingId: string) {
  const conv = (await post(t, `/listings/${listingId}/conversations`, 'd')).body.conversationId;
  const offer = (await post(t, `/conversations/${conv}/offers`, 'd', { price: 200_000 })).body;
  return (await post(t, `/conversations/${conv}/offers/${offer.offerId}/accept`, 'owner')).body.transactionId as string;
}

describe('Báo cáo vi phạm xử lý theo mức (QĐ-43, mục 5 danhgia)', () => {
  it('hàng đợi có đường dẫn + người vi phạm + số vi phạm; Cảnh cáo gửi đúng chủ tin và được đếm', async () => {
    const t = makeTestApp();
    const { listingId } = (await post(t, '/listings', 'owner', listingBody({ title: 'iPhone giá rẻ' }))).body;
    const r1 = await report(t, 'b', 'LISTING', listingId);

    expect((await openReports(t))[0]).toMatchObject({
      target: { title: 'iPhone giá rẻ', link: `/listings/${listingId}`, status: 'ACTIVE' },
      violator: { userId: 'owner', name: 'Người bán owner', violations30d: 0 },
    });
    expect((await resolve(t, r1, 'WARN', 'Mô tả không rõ nguồn gốc')).body.status).toBe('RESOLVED');
    expect(await types(t, 'owner')).toContain('VIOLATION_WARNING');
    expect(await types(t, 'b')).toContain('REPORT_RESOLVED');

    const r2 = await report(t, 'c', 'LISTING', listingId);
    expect((await openReports(t)).find((r: { reportId: string }) => r.reportId === r2).violator.violations30d).toBe(1);
  });

  it('Gỡ tin + cảnh cáo: tin đang giao dịch → báo lỗi, báo cáo vẫn mở; tin đang mở → gỡ khỏi Chợ', async () => {
    const t = makeTestApp();
    const busy = (await post(t, '/listings', 'owner', listingBody())).body.listingId;
    await inTransaction(t, busy);
    const r1 = await report(t, 'b', 'LISTING', busy);
    expect((await resolve(t, r1, 'HIDE_AND_WARN', 'Hàng cấm')).body.code).toBe('LISTING_IN_TRANSACTION');
    expect((await openReports(t)).map((r: { reportId: string }) => r.reportId)).toContain(r1);

    const open = (await post(t, '/listings', 'owner', listingBody())).body.listingId;
    const r2 = await report(t, 'b', 'LISTING', open);
    await resolve(t, r2, 'HIDE_AND_WARN', 'Ảnh không phải thiết bị');
    expect((await t.call('GET', `/listings/${open}`, { user: 'owner' })).body.listing.status).toBe('CANCELLED');
    expect((await t.call('GET', '/feed', { user: 'b' })).body.items.map((i: { listing: { listingId: string } }) => i.listing.listingId)).not.toContain(open);
  });

  it('Gỡ tin + tạm ngừng: bắt buộc lý do; gỡ tin + tạm ngừng đối tác; chỉ gỡ được khi báo cáo là tin', async () => {
    const t = makeTestApp();
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const r = await report(t, 'b', 'LISTING', listingId);
    expect((await resolve(t, r, 'HIDE_AND_SUSPEND')).body.code).toBe('NOTE_REQUIRED');
    expect((await resolve(t, r, 'HIDE_AND_SUSPEND', 'ngắn')).body.code).toBe('NOTE_REQUIRED');
    expect((await resolve(t, r, 'HIDE_AND_SUSPEND', 'Đăng bán hàng cấm theo quy định pháp luật')).body.status).toBe('RESOLVED');
    expect((await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.listing.status).toBe('CANCELLED');
    expect((await t.call('GET', '/partners/me', { user: 'owner' })).body.partner.status).toBe('SUSPENDED');
    expect(await types(t, 'owner')).toContain('PARTNER_SUSPENDED');
  });

  it('báo cáo giao dịch: người vi phạm là bên kia; khách không phải đối tác thì chỉ cảnh cáo được', async () => {
    const t = makeTestApp();
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const txId = await inTransaction(t, listingId);

    const byBuyer = await report(t, 'd', 'TRANSACTION', txId);
    expect((await resolve(t, byBuyer, 'HIDE_AND_WARN', 'x')).body.code).toBe('INVALID_ACTION');
    await resolve(t, byBuyer, 'WARN', 'Hẹn rồi không đến');
    expect(await types(t, 'owner')).toContain('VIOLATION_WARNING');

    const byOwner = await report(t, 'owner', 'TRANSACTION', txId);
    expect((await openReports(t))[0].violator).toMatchObject({ userId: 'd' });
    expect((await resolve(t, byOwner, 'SUSPEND', 'Đòi thêm tiền khi gặp')).body.code).toBe('CANNOT_SUSPEND');
    expect((await resolve(t, byOwner, 'WARN', 'Đòi thêm tiền khi gặp')).status).toBe(200);
    expect(await types(t, 'd')).toContain('VIOLATION_WARNING');
  });

  it('5 vi phạm trong 30 ngày → cờ cho Admin', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'shop');
    for (let i = 0; i < 4; i++) await t.services.risk.recordViolation('shop', 'REPORT_WARNING', { type: 'LISTING', id: `l${i}` });
    expect((await t.call('GET', '/admin/risk-flags', ADMIN)).body.items).toHaveLength(0);
    await t.services.risk.recordViolation('shop', 'IMAGE_REJECTED', { type: 'IMAGE', id: 'k' });
    const [flag] = (await t.call('GET', '/admin/risk-flags', ADMIN)).body.items;
    expect(flag).toMatchObject({ userId: 'shop', reasons: [{ code: 'VIOLATIONS', count: 5 }] });
    expect(flag.violations).toHaveLength(5);
  });
});

describe('Ảnh nhạy cảm: chặn ≥ 70%, nghi ngờ 50–70% với nhãn nặng chờ Admin duyệt (QĐ-43)', () => {
  it('phân loại nhãn Rekognition', () => {
    expect(classifyModeration([{ name: 'Explicit Nudity', confidence: 82 }])).toMatchObject({ allowed: false });
    expect(classifyModeration([{ name: 'Explicit Nudity', confidence: 61 }])).toMatchObject({ allowed: true, review: true });
    expect(classifyModeration([{ name: 'Nudity', parent: 'Explicit Nudity', confidence: 55 }])).toMatchObject({ allowed: true, review: true });
    expect(classifyModeration([{ name: 'Suggestive', confidence: 60 }])).toMatchObject({ allowed: true, review: false }); // nhãn nhẹ giữ ngưỡng 70%
    expect(classifyModeration([{ name: 'Suggestive', confidence: 75 }])).toMatchObject({ allowed: false });
    expect(classifyModeration([{ name: 'Alcohol', confidence: 99 }])).toMatchObject({ allowed: true, review: false });
  });

  it('ảnh nghi ngờ → tin chờ Admin duyệt; Admin từ chối và ảnh bị chặn đều tính vi phạm', async () => {
    const images: ImageStore = {
      enabled: true,
      createUpload: async () => ({ key: 'k', url: 'u', fields: {}, expiresInSeconds: 1 }),
      viewUrl: async (k) => `https://img/${k}`,
      markAttached: async () => undefined,
      markModerated: async () => undefined,
      assertModerated: async () => undefined,
      remove: async () => undefined,
      read: async () => ({ mediaType: 'image/jpeg', data: '' }),
    };
    const moderator: ImageModerator = {
      enabled: true,
      check: async (key) =>
        key.includes('nghi')
          ? { allowed: true, review: true, labels: [{ name: 'Explicit Nudity', confidence: 62 }] }
          : key.includes('xau')
            ? { allowed: false, labels: [{ name: 'Explicit Nudity', confidence: 95 }] }
            : { allowed: true, labels: [] },
    };
    const t = makeTestApp({ images, moderator });
    const key = 'listings/owner/nghi.jpg';
    await post(t, '/listings', 'owner', listingBody({ imageKeys: ['listings/owner/ok.jpg'] })); // thành người bán đã duyệt
    expect((await post(t, '/uploads/moderate', 'owner', { key })).body).toMatchObject({ flagged: true });
    const listing = (await post(t, '/listings', 'owner', listingBody({ imageKeys: [key] }))).body;
    expect(listing).toMatchObject({ status: 'PENDING_REVIEW', review: { reason: 'IMAGE_SENSITIVE_SUSPECTED', images: [{ key, kind: 'SENSITIVE' }] } });
    expect(listing.review.images[0].text).toContain('Explicit Nudity 62%');

    await t.call('POST', `/admin/listings/${listing.listingId}/review`, { ...ADMIN, body: { approve: false, note: 'Ảnh không phù hợp' } });
    expect(await t.services.risk.violationCount('owner')).toBe(1);
    expect((await post(t, '/uploads/moderate', 'owner', { key: 'listings/owner/xau.jpg' })).body.code).toBe('IMAGE_REJECTED');
    expect(await t.services.risk.violationCount('owner')).toBe(2);
  });
});
