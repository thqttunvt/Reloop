import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers';

describe('HTTP API', () => {
  it('chưa đăng nhập → 401', async () => {
    const t = makeTestApp();
    expect((await t.call('GET', '/me')).status).toBe(401);
  });

  it('GET /me tạo hồ sơ mặc định OWNER (§4.1)', async () => {
    const t = makeTestApp();
    const res = await t.call('GET', '/me', { user: 'u1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: 'u1', roles: ['OWNER'] });
  });

  it('SĐT không bắt buộc: khai được, xóa được (chuỗi rỗng), không còn xác minh', async () => {
    const t = makeTestApp();
    expect((await t.call('PATCH', '/me', { user: 'u1', body: { phone: '0909999999' } })).body.phone).toBe('0909999999');
    const cleared = await t.call('PATCH', '/me', { user: 'u1', body: { phone: '' } });
    expect(cleared.body.phone).toBeUndefined();
    expect(cleared.body.phoneVerified).toBeUndefined();
    expect((await t.call('POST', '/dev/verify-phone', { user: 'u1' })).status).toBe(404);
  });

  it('dữ liệu sai → 400 kèm mã lỗi', async () => {
    const t = makeTestApp();
    expect((await t.call('PATCH', '/me', { user: 'u1', body: { phone: 'abc' } })).body.code).toBe('INVALID_PHONE');
    expect((await t.call('PATCH', '/me', { user: 'u1', body: '{hỏng' })).body.code).toBe('INVALID_JSON');
  });

  it('route không tồn tại → 404', async () => {
    const t = makeTestApp();
    expect((await t.call('GET', '/khong-co', { user: 'u1' })).status).toBe(404);
  });

  it('API tạo dữ liệu (đăng tin) bắt buộc Idempotency-Key', async () => {
    const t = makeTestApp();
    const res = await t.call('POST', '/listings', { user: 'u1', body: {} });
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('Preflight CORS', () => {
  it('OPTIONS trả 204, không cần đăng nhập', async () => {
    const { app } = makeTestApp();
    const res = await app.handler({
      rawPath: '/wallet/topups',
      headers: {},
      requestContext: { http: { method: 'OPTIONS' } },
    } as unknown as Parameters<typeof app.handler>[0]);
    expect(res.statusCode).toBe(204);
  });
});
