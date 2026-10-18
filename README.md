# ReLoop

Nền tảng kết nối người có đồ điện tử cũ, hỏng (**Owner**) với doanh nghiệp thu mua, sửa chữa, tái chế (**Partner**) trong bán kính 5 km: đăng tin kèm ảnh (AI gợi ý thông tin) → matching theo vị trí → báo giá dự kiến từ bảng giá của đối tác → xác nhận giá → giao dịch, bàn giao, đánh giá hai chiều.

- Web (dev): https://d1cjl1tvcp0r6q.cloudfront.net
- Tài liệu kế hoạch: [plan/](plan/). Thứ tự ưu tiên khi các file mâu thuẫn: [plan/quyetdinh.txt](plan/quyetdinh.txt) → [plan/task.txt](plan/task.txt) → giaiphap.txt → spec gốc. Trạng thái mới nhất: [plan/readmeall.md](plan/readmeall.md).
- **Nạp / rút tiền qua ngân hàng đã bỏ (2026-10-16).** Hai bên thanh toán trực tiếp khi bàn giao. Sổ cái ví, giữ tiền, hoa hồng, phí đăng bài vẫn giữ trong code để nối lại khi có kết nối ngân hàng cho đối tác chuyển tiền.

## Cấu trúc

```
backend/    API serverless (TypeScript) — chạy local bằng Node, lên AWS bằng 1 Lambda
  src/
    app.ts              lắp adapter theo môi trường (local / aws)
    lambda.ts           entry point Lambda: API Gateway + worker AI (tự gọi async) + job định kỳ (EventBridge)
    local/server.ts     server dev local, gọi CÙNG handler với Lambda; chạy job nền mỗi phút
    http/               router (xác thực, Idempotency-Key, CORS preflight), routes
    auth/               LocalAuthProvider (dev) · CognitoAuthProvider (JWT claims, group Admins/FinanceAdmins)
    store/              interface Table · MemoryTable (dev/test) · DynamoTable (AWS, khóa PK/SK/GSI1)
    storage/            ImageStore: S3 presigned POST/GET (≤ 5 MB, JPEG/PNG/WebP, prefix theo user) · kiểm duyệt ảnh nhạy cảm bằng Amazon Rekognition
    ai/                 Analyzer: Claude Haiku 4.5 trên Amazon Bedrock (tool use → JSON có cấu trúc)
    domain/             state machine Listing / Quote / Transaction · danh mục, tình trạng, bàn giao
    modules/users       hồ sơ (SĐT không bắt buộc), điều khoản (QĐ-28)
    modules/locations   địa điểm đã lưu, mặc định
    modules/partners    đăng ký đối tác, Admin duyệt / tạm ngừng, chi nhánh (1–5 km), bảng giá
    modules/listings    đăng tin, bảng tin "Chợ" (mọi người đã đăng nhập), matching geohash + Haversine, báo giá dự kiến, xác nhận / từ chối / rút, offer thủ công
    modules/ai          AI phân tích ảnh chạy nền + giới hạn 20 lượt/ngày
    modules/transactions chọn offer, bàn giao, điều chỉnh giá, xác nhận 2 bên (48h tự hoàn tất), hủy / thất bại / tranh chấp, đánh giá
    modules/reputation  điểm uy tín (rating, tỉ lệ hoàn tất / hủy)
    modules/notifications thông báo (polling)
    modules/chat        chat người bán ↔ người mua theo từng tin (polling 5s)
    modules/reports     báo cáo vi phạm, Admin gỡ tin
    modules/jobs        hẹn giờ việc nền theo "ngăn giờ" (không Scan)
    modules/wallet      sổ cái, giữ tiền, hoa hồng, phí đăng bài (chưa nối vào luồng)
  test/                 vitest — 78 test
frontend/   React + TypeScript + Vite; Leaflet + OpenStreetMap; đăng nhập Cognito (OAuth code + PKCE)
infra/      Terraform môi trường dev (state trên S3) + bootstrap.sh + deploy.sh
scripts/    smoke-aws.py (integration test trên AWS) · make-admin.sh · loadtest.mjs
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

Đăng nhập dev: chọn sẵn Owner, Partner hoặc Admin trên màn hình đầu tiên (header `x-dev-user`, `x-dev-groups`; chỉ khi `AUTH_MODE=local`). Local không có S3 / Bedrock thì upload ảnh và AI tự tắt, các luồng khác chạy đủ.

Muốn web chạy local nhưng đăng nhập thật và gọi API trên AWS: tạo `frontend/.env.local`

```
VITE_API_BASE=https://2tslnzyaga.execute-api.ap-southeast-1.amazonaws.com
VITE_COGNITO_DOMAIN=https://reloop-dev-auth.auth.ap-southeast-1.amazoncognito.com
VITE_COGNITO_CLIENT_ID=3fgdovrar5bgm7bm6ddpl6pkn0
```

### Thử luồng chính

0. **Chợ** (trang chính): bảng tin kiểu Facebook — mọi người đã đăng nhập lướt tin đang mở; bấm "💬 Gửi tin nhắn" → cột phải hiện thông tin người bán + khung chat.

1. **Owner:** đồng ý điều khoản → Đăng tin (bắt buộc đủ thông tin + ít nhất 1 ảnh đã qua kiểm duyệt; ✨ AI gợi ý; ghim vị trí) → xem báo giá dự kiến → "Yêu cầu xác nhận giá".
2. **Partner:** Đối tác → đăng ký → thêm chi nhánh (bán kính 1–5 km) + bảng giá → Admin duyệt → "Tin phù hợp" → 💬 nhắn tin hỏi người bán → xác nhận giá hoặc gửi báo giá thủ công.
3. **Owner:** "Chọn đối tác này" → Giao dịch: hẹn lịch bàn giao, (đối tác) đề nghị giảm giá, hai bên "Xác nhận đã bàn giao xong" → đánh giá nhau.
4. **Admin:** duyệt / tạm ngừng đối tác, xử lý tranh chấp, báo cáo vi phạm, thống kê.

## Triển khai lên AWS (môi trường dev)

Account `926583575243`, region `ap-southeast-1`. Yêu cầu AWS CLI ≥ 2.32, Terraform ≥ 1.10.

```bash
aws login --profile reloop --region ap-southeast-1   # đăng nhập (phiên tạm thời, tối đa 12 giờ)
AWS_PROFILE=reloop bash infra/bootstrap.sh            # CHỈ lần đầu: bucket lưu Terraform state
AWS_PROFILE=reloop bash infra/deploy.sh               # build backend → terraform apply → build + upload web
AWS_PROFILE=reloop bash infra/deploy.sh frontend      # chỉ cập nhật web
AWS_PROFILE=reloop AWS_REGION=ap-southeast-1 python scripts/smoke-aws.py   # kiểm tra trọn luồng trên AWS
AWS_PROFILE=reloop bash scripts/make-admin.sh <email> --finance            # cấp quyền Admin
```

**Hạ tầng dựng sẵn trên Console** (Terraform chỉ đọc, không sửa / xóa):

| Tài nguyên | Ghi chú |
|---|---|
| DynamoDB `reloop-core-table` | khóa `PK`/`SK`, GSI `GSI1` (`GSI1PK`/`GSI1SK`). `DynamoTable` đổi tên sang `pk`/`sk` của code. Đã bật PITR và TTL (thuộc tính `ttl`: thông báo tự xóa sau 90 ngày) |
| S3 `reloop-device-images` | ảnh; backend chỉ dùng prefix `listings/<userId>/`. Lifecycle (Terraform `infra/storage.tf`): ảnh chưa gắn tin (tag `state=pending`) xóa sau 1 ngày, ảnh đã gắn xóa sau 120 ngày |
| Lambda `reloop-auth-post-confirmation` | tạo hồ sơ khi xác nhận đăng ký; backend tự chuẩn hóa ở lần gọi `/me` đầu tiên |
| Cognito `ReLoop-user-pool` | pool cũ, **không dùng** cho app (xác minh qua SMS không gửi được) |
| Lambda + API `reloop-generate-presigned-url` | của nhóm, **không có xác thực** — nên tắt; app dùng `POST /uploads/presign` |

**Terraform quản lý** ([infra/](infra/)):

| Tài nguyên | Ghi chú |
|---|---|
| Cognito `reloop-dev-user-pool` (`ap-southeast-1_HttIDqEll`) | chỉ xác minh email; domain `reloop-dev-auth`; web client `3fgdovrar5bgm7bm6ddpl6pkn0`; group `Admins`, `FinanceAdmins`, `Partners`, `Owners` |
| Lambda `reloop-dev-api` (Node 22, arm64) + IAM role | quyền tối thiểu: bảng core, prefix ảnh, Bedrock Haiku, Rekognition kiểm duyệt ảnh, tự gọi async, log |
| API Gateway HTTP API `2tslnzyaga` | JWT Cognito cho mọi route; `OPTIONS` không JWT (CORS); throttle 20 req/s |
| EventBridge `reloop-dev-sweep` | 15 phút/lần: hết hạn tin, nhắc 24h, tự hoàn tất 48h |
| S3 + CloudFront | web tĩnh, bucket private (OAC) |
| CloudWatch | log 7 ngày, dashboard `reloop-dev-overview`, 7 alarm (Lambda lỗi / throttle, API 5xx, p95 > 2s, lỗi job nền / AI / hệ thống); email cảnh báo qua biến `alarm_email` |

## Nguyên tắc khi code

- **Không gọi dịch vụ AWS trực tiếp trong nghiệp vụ.** Đi qua interface (`Table`, `AuthProvider`, `ImageStore`, `Analyzer`…) để local và AWS dùng chung code.
- **Đổi trạng thái** phải qua `stateMachines.ts` (`assertTransition`); ghi có điều kiện version (optimistic locking).
- **Việc nền** idempotent: kiểm tra lại trạng thái trước khi ghi; chạy trễ / trùng không sai.
- **API tạo dữ liệu quan trọng** (đăng tin, chọn offer, gửi offer) bắt buộc header `Idempotency-Key`.
- **Tiền** là số nguyên VND; mọi thay đổi số dư qua `Ledger.post()`.
- **Không commit bí mật.** `.env` nằm trong `.gitignore`.
