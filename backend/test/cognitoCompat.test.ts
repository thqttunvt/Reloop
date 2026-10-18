import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { CognitoAuthProvider } from '../src/auth/auth';
import { makeTestApp } from './helpers';

describe('Tương thích hạ tầng Cognito dựng sẵn', () => {
  it('nhận hồ sơ do Lambda post-confirmation ghi (role "Owner", chưa có version) và sửa được', async () => {
    const { call, table } = makeTestApp();
    // Đúng item mà reloop-auth-post-confirmation ghi vào reloop-core-table
    await table.transact([
      {
        type: 'put',
        item: {
          pk: 'USER#u1',
          sk: 'PROFILE',
          gsi1pk: 'ROLE#Owner',
          gsi1sk: 'USER#u1',
          email: 'a@x.vn',
          fullName: 'Unknown',
          role: 'Owner',
          status: 'ACTIVE',
          createdAt: '2026-10-11T00:00:00Z',
        },
      },
    ]);

    const me = await call('GET', '/me', { user: 'u1' });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ userId: 'u1', roles: ['OWNER'], email: 'a@x.vn', version: 1 });
    expect(me.body.fullName).toBeUndefined();

    const patched = await call('PATCH', '/me', { user: 'u1', body: { fullName: 'Trần Văn B', phone: '0901234567' } });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ fullName: 'Trần Văn B', version: 2 });

    // Giữ nguyên các trường của Lambda (GSI theo vai trò, status)
    const stored = await table.get('USER#u1', 'PROFILE');
    expect(stored).toMatchObject({ gsi1pk: 'ROLE#Owner', status: 'ACTIVE', role: 'Owner' });
  });

  it('group Cognito "Admins" / "FinanceAdmins" → admin / admin_finance; "Owners" bị bỏ qua', () => {
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: 's1', email: 'e', 'cognito:groups': '[Owners Admins FinanceAdmins]' } } } },
    } as unknown as APIGatewayProxyEventV2;
    expect(new CognitoAuthProvider().authenticate(event)).toEqual({ userId: 's1', email: 'e', groups: ['admin', 'admin_finance'] });
  });
});
