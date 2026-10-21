import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AuthProvider, Principal } from '../auth/auth';
import type { Clock } from '../shared/clock';
import { AppError, badRequest, unauthenticated } from '../shared/errors';
import { keys } from '../store/keys';
import { ConditionFailedError, putNew, putVersioned, type Item, type Table } from '../store/table';
import { log } from './log';

export interface RequestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
  rawBody: string;
  principal?: Principal;
}

export interface AuthedContext extends RequestContext {
  principal: Principal;
}

export interface HandlerResult {
  status?: number;
  body: unknown;
}

export type Route =
  | { method: string; path: string; auth: 'public'; handle: (ctx: RequestContext) => Promise<HandlerResult> }
  | {
      method: string;
      path: string;
      auth: 'required';
      /** Bắt buộc header Idempotency-Key; gọi lại cùng key trả về kết quả cũ (TL-04). */
      idempotent?: boolean;
      /** Vẫn dùng được khi tài khoản bị khóa do nợ phí quá hạn (xem hóa đơn, thông báo… — QĐ-40). */
      allowWhenLocked?: boolean;
      handle: (ctx: AuthedContext) => Promise<HandlerResult>;
    };

interface IdempotencyRecord extends Item {
  state: 'IN_PROGRESS' | 'DONE';
  status?: number;
  responseBody?: unknown;
}

const matchPath = (pattern: string, path: string): Record<string, string> | undefined => {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith('{') && seg.endsWith('}')) params[seg.slice(1, -1)] = decodeURIComponent(a[i]!);
    else if (seg !== a[i]) return undefined;
  }
  return params;
};

/** Khóa lưu trữ nội bộ không trả ra API. */
const INTERNAL_FIELDS = new Set(['pk', 'sk', 'gsi1pk', 'gsi1sk']);

const json = (status: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body, (key, value: unknown) => (INTERNAL_FIELDS.has(key) ? undefined : value)),
});

/** Chặn request của người dùng đang bị khóa (ném AppError). Bỏ qua route allowWhenLocked. */
export type AccessGuard = (principal: Principal, route: { method: string; path: string }) => Promise<void>;

export function createApiHandler(deps: { routes: Route[]; auth: AuthProvider; table: Table; clock: Clock; guard?: AccessGuard }) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const started = Date.now();
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let status = 500;
    let principal: Principal | undefined;
    try {
      // Preflight CORS: API Gateway gắn header CORS theo cấu hình, Lambda chỉ cần trả 2xx.
      if (method === 'OPTIONS') {
        status = 204;
        return { statusCode: 204, body: '' };
      }
      let params: Record<string, string> | undefined;
      const route = deps.routes.find((r) => r.method === method && (params = matchPath(r.path, path)));
      if (!route || !params) {
        status = 404;
        return json(404, { code: 'ROUTE_NOT_FOUND', message: `${method} ${path}` });
      }

      const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
      let body: Record<string, unknown> = {};
      if (rawBody && route.auth === 'required') {
        try {
          const parsed: unknown = JSON.parse(rawBody);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
          body = parsed as Record<string, unknown>;
        } catch {
          throw badRequest('INVALID_JSON', 'Body phải là JSON object');
        }
      }
      const ctx: RequestContext = { method, path, params, query: event.queryStringParameters ?? {}, headers, body, rawBody };

      let result: HandlerResult;
      if (route.auth === 'public') {
        result = await route.handle(ctx);
      } else {
        principal = deps.auth.authenticate({ ...event, headers });
        if (!principal) throw unauthenticated();
        if (deps.guard && !route.allowWhenLocked) await deps.guard(principal, route);
        const authed: AuthedContext = { ...ctx, principal };
        result = route.idempotent ? await runIdempotent(deps.table, authed, route.handle) : await route.handle(authed);
      }
      status = result.status ?? 200;
      return json(status, result.body);
    } catch (err) {
      if (err instanceof AppError) {
        status = err.status;
        return json(err.status, { code: err.code, message: err.message, details: err.details });
      }
      status = 500;
      log('error', 'unhandled_error', { method, path, error: err instanceof Error ? err.stack : String(err) });
      return json(500, { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' });
    } finally {
      // Không log header/body: có thể chứa token, STK (T15.5)
      log('info', 'request', { method, path, status, userId: principal?.userId, ms: Date.now() - started });
    }
  };
}

async function runIdempotent(
  table: Table,
  ctx: AuthedContext,
  handle: (ctx: AuthedContext) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const key = ctx.headers['idempotency-key'];
  if (!key || key.length > 100) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Thiếu header Idempotency-Key (≤ 100 ký tự)');
  const k = keys.idempotency(ctx.principal.userId, `${ctx.method} ${ctx.path} ${key}`);

  // Giành khóa TRƯỚC khi chạy: 2 request cùng key song song thì chỉ 1 request được thực thi.
  try {
    await table.transact([putNew({ ...k, state: 'IN_PROGRESS', version: 1 })]);
  } catch (err) {
    if (!(err instanceof ConditionFailedError)) throw err;
    const saved = await table.get<IdempotencyRecord>(k.pk, k.sk);
    if (saved?.state === 'DONE') return { status: saved.status, body: saved.responseBody };
    throw new AppError(409, 'REQUEST_IN_PROGRESS', 'Yêu cầu với Idempotency-Key này đang được xử lý');
  }

  let result: HandlerResult;
  try {
    result = await handle(ctx);
  } catch (err) {
    // Lỗi → nhả khóa để client thử lại cùng key.
    await table.transact([{ type: 'delete', pk: k.pk, sk: k.sk }]);
    throw err;
  }
  await table.transact([
    putVersioned({ ...k, state: 'DONE', status: result.status ?? 200, responseBody: result.body }, 1),
  ]);
  return result;
}
