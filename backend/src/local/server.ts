import { createServer, type IncomingMessage } from 'node:http';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { buildApp, loadConfig } from '../app';

/**
 * Server dev local: chuyển request HTTP thường thành event API Gateway v2
 * rồi gọi ĐÚNG handler sẽ chạy trên Lambda — local và AWS dùng chung code.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // không có .env → dùng giá trị mặc định cho dev
}
const config = loadConfig();
if (config.stage !== 'local') throw new Error('server local chỉ chạy với STAGE=local');
const { handler } = buildApp(config);
const port = Number(process.env.PORT ?? 3001);

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
  ) as Record<string, string | undefined>;
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: await readBody(req),
    isBase64Encoded: false,
    requestContext: { http: { method: req.method ?? 'GET', path: url.pathname } },
  } as unknown as APIGatewayProxyEventV2;

  const result = await handler(event);
  res.writeHead(result.statusCode ?? 200, result.headers as Record<string, string>);
  res.end(result.body ?? '');
}).listen(port, () => {
  console.log(`ReLoop API (local) chạy tại http://localhost:${port} — dữ liệu lưu ở ${config.dataFile}`);
});
