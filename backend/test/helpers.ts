import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { buildApp, loadConfig } from '../src/app';
import { ManualClock } from '../src/shared/clock';
import { keys } from '../src/store/keys';
import { MemoryTable } from '../src/store/memoryTable';
import { putVersioned } from '../src/store/table';

process.env.LOG_SILENT = '1';

export function makeTestApp(overrides: Omit<NonNullable<Parameters<typeof buildApp>[1]>, 'table' | 'clock'> = {}) {
  const clock = new ManualClock();
  const table = new MemoryTable();
  const config = { ...loadConfig({ STAGE: 'local' }), dataFile: undefined };
  const app = buildApp(config, { table, clock, ...overrides });

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

  /**
   * Nạp tiền đã tạm bỏ khỏi sản phẩm → test giữ tiền nạp số dư thẳng vào bảng
   * (mô phỏng tiền vào TK ngân hàng: cộng cả ví lẫn số dư ngân hàng để bất biến đối soát vẫn đúng).
   */
  const fund = async (userId: string, amount: number) => {
    const wk = keys.wallet(userId);
    const bk = keys.bankBalance();
    const wallet = await table.get<any>(wk.pk, wk.sk);
    const bank = await table.get<any>(bk.pk, bk.sk);
    const balances = wallet?.balances ?? { available: 0, held: 0 };
    await table.transact([
      putVersioned({ ...wk, ownerId: userId, balances: { ...balances, available: balances.available + amount }, gsi1pk: 'WALLETS', gsi1sk: userId }, wallet?.version ?? 0),
      putVersioned({ ...bk, balance: (bank?.balance ?? 0) + amount }, bank?.version ?? 0),
    ]);
  };

  return { app, clock, table, call, fund, services: app.services };
}
