import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../src/shared/clock';
import { geohashCellsAround, geohashEncode, haversineKm, roundDistanceKm } from '../src/shared/geo';
import { makeTestApp } from './helpers';

import { ADMIN, FAR, NEAR, OWNER_AT, approvedPartner, branchBody, businessApply, listingBody, post } from './fixtures';

describe('Vị trí (TL-01)', () => {
  it('9 ô geohash quanh điểm luôn chứa chi nhánh trong 5 km, kể cả sát mép ô', () => {
    const center = geohashEncode(OWNER_AT.lat, OWNER_AT.lng);
    const cells = geohashCellsAround(OWNER_AT.lat, OWNER_AT.lng);
    expect(cells).toHaveLength(9);
    expect(cells).toContain(center);
    // điểm cách 4,9 km theo 4 hướng
    const d = 4.9 / 111;
    for (const [la, lo] of [[d, 0], [-d, 0], [0, d], [0, -d]] as const) {
      expect(cells).toContain(geohashEncode(OWNER_AT.lat + la, OWNER_AT.lng + lo));
    }
  });

  it('Haversine + làm tròn 0,5 km (giaiphap E4)', () => {
    expect(haversineKm(OWNER_AT.lat, OWNER_AT.lng, NEAR.lat, NEAR.lng)).toBeCloseTo(1.34, 1);
    expect(roundDistanceKm(1.34)).toBe(1.5);
    expect(roundDistanceKm(0.1)).toBe(0.5);
  });
});

describe('Đối tác (T3.1, T14.1)', () => {
  it('đăng ký → thêm chi nhánh → Admin duyệt → có vai trò PARTNER', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'p1');
    const me = await t.call('GET', '/partners/me', { user: 'p1' });
    expect(me.body.partner.status).toBe('APPROVED');
    expect(me.body.branches).toHaveLength(1);
    expect(me.body.rules).toHaveLength(1);
    expect((await t.call('GET', '/me', { user: 'p1' })).body.roles).toEqual(['OWNER', 'PARTNER']);
  });

  it('không phải Admin thì không duyệt được; chưa có chi nhánh thì không được duyệt', async () => {
    const t = makeTestApp();
    await post(t, '/partners/apply', 'p1', businessApply('p1'));
    expect((await t.call('POST', '/admin/partners/p1/review', { user: 'p1', body: { approve: true } })).status).toBe(403);
    const res = await t.call('POST', '/admin/partners/p1/review', { ...ADMIN, body: { approve: true } });
    expect(res.body.code).toBe('PARTNER_NO_BRANCH');
    const pending = await t.call('GET', '/admin/partners?status=PENDING', ADMIN);
    expect(pending.body.items.map((p: { partnerId: string }) => p.partnerId)).toEqual(['p1']);
  });

  it('bán kính tối đa 5 km (QĐ-11)', async () => {
    const t = makeTestApp();
    await post(t, '/partners/apply', 'p1', businessApply('p1'));
    const res = await post(t, '/partners/me/branches', 'p1', branchBody(NEAR, { radiusKm: 6 }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RADIUS_KM');
  });
});

describe('Đăng tin + matching + báo giá dự kiến (T4.2, T6.1, T7.2)', () => {
  it('chỉ match chi nhánh đã duyệt, trong bán kính, đúng danh mục; có rule mới có giá dự kiến', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near'); // khớp, có rule
    await approvedPartner(t, 'norule', { rule: false }); // khớp, không rule → không có giá
    await approvedPartner(t, 'far', { location: FAR }); // ngoài 5 km
    await approvedPartner(t, 'pending', { approve: false }); // chưa duyệt

    const res = await post(t, '/listings', 'owner', listingBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'ACTIVE', matchingStatus: 'DONE', matchCount: 2, quoteCount: 1 });

    const detail = await t.call('GET', `/listings/${res.body.listingId}`, { user: 'owner' });
    expect(detail.body.matches.map((m: { partnerId: string }) => m.partnerId).sort()).toEqual(['near', 'norule']);
    expect(detail.body.quotes).toHaveLength(1);
    expect(detail.body.quotes[0]).toMatchObject({
      partnerId: 'near',
      status: 'ESTIMATED',
      distanceKm: 1.5,
      estimate: { unitMin: 300_000, unitMax: 500_000, quantity: 2, totalMin: 600_000, totalMax: 1_000_000 },
    });
  });

  it('không có Partner phù hợp → không tạo giá giả (T6.3)', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const res = await post(t, '/listings', 'owner', listingBody({ category: 'BATTERY' }));
    expect(res.body).toMatchObject({ matchCount: 0, quoteCount: 0, matchingStatus: 'DONE' });
  });

  it('hàng theo kg bắt buộc khối lượng; dữ liệu sai → 400', async () => {
    const t = makeTestApp();
    expect((await post(t, '/listings', 'owner', listingBody({ unit: 'PER_KG' }))).body.code).toBe('INVALID_WEIGHT_KG');
    expect((await post(t, '/listings', 'owner', listingBody({ condition: 'TOT' }))).body.code).toBe('INVALID_CONDITION');
  });

  it('Partner được match / người xem chỉ thấy khu vực, không thấy tọa độ (QĐ-20)', async () => {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;

    const asPartner = await t.call('GET', `/listings/${listingId}`, { user: 'near' });
    expect(asPartner.body.role).toBe('PARTNER');
    expect(asPartner.body.listing.location).toBeUndefined();
    expect(asPartner.body.listing.area).toBe('Phường Linh Trung, TP Thủ Đức');
    // Người khác (bảng tin kiểu chợ) xem dạng công khai: không vị trí chính xác, không báo giá
    const asViewer = await t.call('GET', `/listings/${listingId}`, { user: 'stranger' });
    expect(asViewer.body).toMatchObject({ role: 'VIEWER', quotes: [], matches: [] });
    expect(asViewer.body.listing.location).toBeUndefined();

    const reqs = await t.call('GET', '/partners/me/requests', { user: 'near' });
    expect(reqs.body.items).toHaveLength(1);
    expect(reqs.body.items[0]).toMatchObject({ listingId, distanceKm: 1.5, listingStatus: 'ACTIVE' });
  });
});

describe('Xác nhận giá & offer (T7.3, T7.4)', () => {
  async function setup() {
    const t = makeTestApp();
    await approvedPartner(t, 'near');
    const { listingId } = (await post(t, '/listings', 'owner', listingBody())).body;
    const quoteId = (await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0].quoteId;
    return { t, listingId, quoteId };
  }

  it('Owner yêu cầu xác nhận → Partner xác nhận giá khác dự kiến → có cờ cảnh báo (QĐ-16)', async () => {
    const { t, listingId, quoteId } = await setup();
    const q = `/listings/${listingId}/quotes/${quoteId}`;
    // Partner không xác nhận được khi Owner chưa yêu cầu
    expect((await post(t, `${q}/confirm`, 'near', { price: 700_000 })).body.code).toBe('INVALID_STATE_TRANSITION');
    // chỉ Owner của tin mới yêu cầu được
    expect((await post(t, `${q}/request-confirmation`, 'near')).status).toBe(404);

    expect((await post(t, `${q}/request-confirmation`, 'owner')).body.status).toBe('CONFIRMATION_REQUESTED');
    const confirmed = await post(t, `${q}/confirm`, 'near', { price: 450_000, note: 'Còn RAM' });
    expect(confirmed.body).toMatchObject({ status: 'CONFIRMED_OFFER', offer: { price: 450_000, differsFromEstimate: true } });

    expect((await post(t, `${q}/withdraw`, 'near')).body.status).toBe('WITHDRAWN');
  });

  it('Partner không trả lời trong 24h → báo giá hết hạn, không xác nhận được nữa', async () => {
    const { t, listingId, quoteId } = await setup();
    const q = `/listings/${listingId}/quotes/${quoteId}`;
    await post(t, `${q}/request-confirmation`, 'owner');
    t.clock.advance(25 * HOUR_MS);
    expect((await t.call('GET', `/listings/${listingId}`, { user: 'owner' })).body.quotes[0].status).toBe('EXPIRED');
    expect((await post(t, `${q}/confirm`, 'near', { price: 600_000 })).body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('Manual offer: chỉ chi nhánh được match, tối đa 1 offer đang mở / chi nhánh', async () => {
    const { t, listingId } = await setup();
    const me = await t.call('GET', '/partners/me', { user: 'near' });
    const branchId = me.body.branches[0].branchId;
    const first = await post(t, `/listings/${listingId}/offers`, 'near', { branchId, price: 800_000 });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ kind: 'MANUAL', status: 'CONFIRMED_OFFER' });
    expect((await post(t, `/listings/${listingId}/offers`, 'near', { branchId, price: 900_000 })).body.code).toBe('OFFER_ALREADY_OPEN');

    await approvedPartner(t, 'other', { location: FAR });
    const otherBranch = (await t.call('GET', '/partners/me', { user: 'other' })).body.branches[0].branchId;
    expect((await post(t, `/listings/${listingId}/offers`, 'other', { branchId: otherBranch, price: 1 })).status).toBe(404);
  });

  it('Owner hủy tin → báo giá đang mở hết hạn, Partner không thao tác được nữa (giaiphap B7)', async () => {
    const { t, listingId, quoteId } = await setup();
    expect((await post(t, `/listings/${listingId}/cancel`, 'owner')).body.status).toBe('CANCELLED');
    const detail = await t.call('GET', `/listings/${listingId}`, { user: 'owner' });
    expect(detail.body.quotes[0].status).toBe('EXPIRED');
    expect((await post(t, `/listings/${listingId}/quotes/${quoteId}/request-confirmation`, 'owner')).body.code).toBe('LISTING_NOT_ACTIVE');
  });

  it('tin quá 7 ngày hiển thị EXPIRED (QĐ-12)', async () => {
    const { t } = await setup();
    t.clock.advance(7 * 24 * HOUR_MS + 1);
    expect((await t.call('GET', '/listings/mine', { user: 'owner' })).body.items[0].status).toBe('EXPIRED');
  });
});
