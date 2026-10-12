# ReLoop

Nền tảng trung gian kết nối người có đồ điện tử cũ / tái chế (Owner) với đơn vị thu mua (Partner), có ví nội bộ giữ tiền đến khi hai bên xác nhận giao dịch.

- Tài liệu kế hoạch: [plan/](plan/). Thứ tự ưu tiên khi các file mâu thuẫn: [plan/quyetdinh.txt](plan/quyetdinh.txt), rồi spec gốc, rồi giaiphap.txt.
- Danh sách task: [plan/task.txt](plan/task.txt).

## Cấu trúc

```
backend/    API serverless (TypeScript) — chạy local bằng Node, lên AWS bằng Lambda
  src/
    app.ts            lắp adapter theo môi trường (local / aws)
    lambda.ts         entry point Lambda
    local/server.ts   server dev local, gọi CÙNG handler với Lambda
    http/             router, idempotency, route
    auth/             LocalAuthProvider (dev) · CognitoAuthProvider (AWS)
    bank/             BankProvider: FakeBankProvider (dev) · adapter ngân hàng thật thêm sau
    store/            interface Table (single-table DynamoDB) · MemoryTable (dev/test)
    domain/           state machine Listing / Quote / Transaction / TopUp / Withdrawal
    modules/users     hồ sơ, xác minh SĐT
    modules/wallet    sổ cái, nạp, giữ tiền, kết thúc giao dịch, rút, đối soát
  test/
frontend/   React + TypeScript + Vite
plan/       tài liệu kế hoạch
```

## Chạy local

Yêu cầu Node.js 22+. Không cần Docker hay tài khoản AWS.

```bash
npm install
cp backend/.env.example backend/.env   # lần đầu
npm run dev:be    # API tại http://localhost:3001 (dữ liệu lưu ở backend/.data/db.json)
npm run dev:fe    # Web tại http://localhost:5173
npm test          # test backend
```

Đăng nhập dev: chọn sẵn Owner, Partner hoặc Admin trên màn hình đầu tiên. Danh tính được gửi qua header `x-dev-user` và `x-dev-groups`, chỉ hoạt động khi `AUTH_MODE=local`.

### Thử luồng tiền trên giao diện

1. **Hồ sơ:** nhập họ tên và SĐT → "Xác minh SĐT (dev)".
2. **Ví → Nạp tiền:** tạo mã QR → "Giả lập ngân hàng báo tiền vào (dev)" → số dư tự cập nhật.
3. **Ví → Rút tiền:** thêm STK (tên chủ TK trùng họ tên hồ sơ) → đăng nhập Admin → duyệt STK → quay lại tạo lệnh rút.
4. **Admin:** "Đang chuyển" → "Giả lập ngân hàng báo tiền ra (dev)" → lệnh rút thành PAID; phần Đối soát hiện KHỚP.

Giữ tiền, kết thúc giao dịch và phí đăng bài tạm thời gọi qua API dev, cho đến khi có module giao dịch và tin đăng. Ví dụ giá chốt 150.000đ, hoa hồng 10% do Partner trả thêm, nên Partner cần nạp ít nhất 165.000đ trước:

```bash
H='-H content-type:application/json'
curl -X POST localhost:3001/dev/transactions/TX1/hold   -H "x-dev-user: partner1" $H -d '{"amount":165000}'
curl -X POST localhost:3001/dev/transactions/TX1/settle -H "x-dev-user: partner1" $H -d '{"payeeId":"owner1","payeeAmount":150000}'
# → owner1 nhận 150.000đ, ví doanh thu ReLoop nhận 15.000đ
curl -X POST localhost:3001/dev/listings/L1/fee -H "x-dev-user: owner1"   # bài đầu miễn phí, từ bài 2 thu 20.000đ
curl "localhost:3001/fees?price=150000" -H "x-dev-user: owner1"            # xem trước phí
```

Các route `/dev/*` chỉ được bật khi `STAGE=local`.

## Nguyên tắc khi code

- **Tiền** là số nguyên VND. Mọi thay đổi số dư phải đi qua `Ledger.post()`: sổ cái chỉ ghi thêm, bút toán kép, id bút toán cố định để chống ghi trùng.
- **Không gọi dịch vụ AWS trực tiếp trong nghiệp vụ.** Đi qua interface (`Table`, `AuthProvider`, `BankProvider`…) để local và AWS dùng chung code.
- **Đổi trạng thái** phải qua `stateMachines.ts` (`assertTransition`).
- **API tạo tiền** (nạp, rút) bắt buộc header `Idempotency-Key`.
- **Không commit bí mật.** `.env` đã nằm trong `.gitignore`; khi lên AWS dùng Secrets Manager.
