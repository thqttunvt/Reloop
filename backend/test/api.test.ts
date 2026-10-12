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
    expect(res.body).toMatchObject({ userId: 'u1', roles: ['OWNER'], phoneVerified: false });
  });

  it('đổi số điện thoại thì phải xác minh lại', async () => {
    const t = makeTestApp();
    await t.verifiedUser('u1');
    const res = await t.call('PATCH', '/me', { user: 'u1', body: { phone: '0909999999' } });
    expect(res.body.phoneVerified).toBe(false);
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

  it('API tạo tiền bắt buộc Idempotency-Key', async () => {
    const t = makeTestApp();
    await t.verifiedUser('u1');
    const res = await t.call('POST', '/wallet/topups', { user: 'u1', body: { amount: 100_000 } });
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
