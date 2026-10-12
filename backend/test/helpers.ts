import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { buildApp, loadConfig } from '../src/app';
import { ManualClock } from '../src/shared/clock';
import { MemoryTable } from '../src/store/memoryTable';

process.env.LOG_SILENT = '1';

export const WEBHOOK_SECRET = 'test-secret';

export function makeTestApp() {
  const clock = new ManualClock();
  const table = new MemoryTable();
  const config = { ...loadConfig({ STAGE: 'local', BANK_WEBHOOK_SECRET: WEBHOOK_SECRET }), dataFile: undefined };
  const app = buildApp(config, { table, clock });

  const call = async (
    method: string,
    path: string,
    opts: { user?: string; groups?: string[]; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const [rawPath, qs = ''] = path.split('?');
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.user) headers['x-dev-user'] = opts.user;
    if (opts.groups) headers['x-dev-groups'] = opts.groups.join(',');
    const event = {
      rawPath,
      headers,
      queryStringParameters: Object.fromEntries(new URLSearchParams(qs)),
      body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
      isBase64Encoded: false,
      requestContext: { http: { method } },
    } as unknown as APIGatewayProxyEventV2;
    const res = await app.handler(event);
    return { status: res.statusCode, body: JSON.parse(res.body ?? 'null') };
  };

  /** Người dùng đã khai và xác minh SĐT — đủ điều kiện nạp tiền. */
  const verifiedUser = async (userId: string) => {
    await call('PATCH', '/me', { user: userId, body: { fullName: 'Nguyễn Văn An', phone: '0901234567' } });
    await call('POST', '/dev/verify-phone', { user: userId });
  };

  /** Nạp tiền trọn vòng: tạo lệnh nạp → ngân hàng báo tiền vào đúng mã. */
  const topUp = async (userId: string, amount: number) => {
    const created = await call('POST', '/wallet/topups', {
      user: userId,
      body: { amount },
      headers: { 'idempotency-key': `topup-${userId}-${amount}-${Math.random()}` },
    });
    const content = `CK ${created.body.topUp.code} nap vi`;
    return bankEvent({ direction: 'IN', amount, content, bankTxnId: `in-${created.body.topUp.code}` });
  };

  const bankEvent = (payload: Record<string, unknown>) =>
    call('POST', '/webhooks/bank', { body: payload, headers: { 'x-webhook-secret': WEBHOOK_SECRET } });

  return { app, clock, table, call, verifiedUser, topUp, bankEvent, services: app.services };
}
