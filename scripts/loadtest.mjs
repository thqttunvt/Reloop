// Load test (T15.9, giaiphap F1): N người dùng ảo gọi các API đọc phổ biến trong D giây.
// Mục tiêu: lỗi < 1%, p95 đọc < 500 ms.
//
// Dùng (cần ID token Cognito của một tài khoản test — lấy từ localStorage "reloop.session" sau khi đăng nhập web):
//   API=https://<api>.execute-api.ap-southeast-1.amazonaws.com TOKEN=<idToken> \
//   USERS=50 RPS=20 DURATION=600 node scripts/loadtest.mjs
// Lưu ý chi phí: 20 req/s × 10 phút ≈ 12.000 request Lambda + DynamoDB — vài cent; chỉ chạy trên dev.
const API = process.env.API;
const TOKEN = process.env.TOKEN;
const USERS = Number(process.env.USERS ?? 50);
const RPS = Number(process.env.RPS ?? 20);
const DURATION = Number(process.env.DURATION ?? 60);
if (!API || !TOKEN) {
  console.error('Thiếu API hoặc TOKEN');
  process.exit(1);
}

const PATHS = ['/me', '/listings/mine', '/notifications/unread-count', '/transactions', '/partners/me', '/wallet'];
const latencies = [];
let ok = 0;
let failed = 0;
const statuses = {};

async function hit() {
  const path = PATHS[Math.floor(Math.random() * PATHS.length)];
  const t0 = performance.now();
  try {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    await res.arrayBuffer();
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    if (res.status >= 500 || res.status === 429) failed++;
    else ok++;
  } catch {
    failed++;
  }
  latencies.push(performance.now() - t0);
}

const end = Date.now() + DURATION * 1000;
const perUserDelay = (USERS / RPS) * 1000; // mỗi user gửi 1 request mỗi perUserDelay ms → tổng ≈ RPS
await Promise.all(
  Array.from({ length: USERS }, async (_, i) => {
    await new Promise((r) => setTimeout(r, (i * perUserDelay) / USERS));
    while (Date.now() < end) {
      const started = Date.now();
      await hit();
      await new Promise((r) => setTimeout(r, Math.max(0, perUserDelay - (Date.now() - started))));
    }
  }),
);

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]?.toFixed(0);
const total = ok + failed;
console.log(JSON.stringify({ total, ok, failed, errorRate: `${((failed / total) * 100).toFixed(2)}%`, p50: pct(50), p95: pct(95), p99: pct(99), statuses }, null, 2));
console.log(failed / total < 0.01 && Number(pct(95)) < 500 ? 'ĐẠT mục tiêu F1' : 'CHƯA ĐẠT mục tiêu F1');
