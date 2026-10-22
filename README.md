# ReLoop

Chợ đồ điện tử cũ, hỏng. Người bán (đối tác đã được Admin duyệt: **cấp 1** khách lẻ, **cấp 2** doanh nghiệp / hộ kinh doanh) đăng tin kèm ảnh (AI gợi ý thông tin) → tin lên **Chợ** và được ghép với đơn vị thu mua cấp 2 trong bán kính 1–5 km → chốt bằng **báo giá** của đơn vị thu mua hoặc **ra giá trong chat** với bất kỳ khách nào → giao dịch, bàn giao (thanh toán trực tiếp), đánh giá hai chiều.

- Web (dev): https://d1cjl1tvcp0r6q.cloudfront.net
- Tài liệu kế hoạch: [plan/](plan/). Thứ tự ưu tiên khi các file mâu thuẫn: **code** → [plan/quyetdinh.txt](plan/quyetdinh.txt) → [plan/devdocx.txt](plan/devdocx.txt) → task.txt → giaiphap.txt → spec gốc. Trạng thái mới nhất: [plan/docx/readmeall.md](plan/docx/readmeall.md). Tra cứu kỹ thuật (API, khóa DynamoDB, Terraform): `plan/devdocx.txt` mục 9.
- **Phí dịch vụ (QĐ-37, 39, 41):** đăng tin miễn phí; người bán trả 10.000đ / giao dịch hoàn tất (+ 10.000đ nếu hủy giao dịch rồi gỡ tin trong 72 giờ; + 10.000đ / 30 ngày gói VIP 1). Hóa đơn gộp theo tháng, chuyển khoản, Admin tài chính xác nhận. Nợ quá hạn > 3 ngày: không đăng tin mới; > 7 ngày: khóa mọi chức năng (QĐ-40).
- **Hạn mức tin đang mở (QĐ-41):** cấp 1 = 3 tin, cấp 1 + VIP 1 = 5, cấp 2 = 10.
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
    storage/            ImageStore: S3 presigned POST/GET (≤ 5 MB, JPEG/PNG/WebP, prefix theo user) · kiểm duyệt ảnh nhạy cảm bằng Amazon Rekognition · đọc chữ trong ảnh + Guardrail để gắn cờ (tin chờ Admin duyệt)
    ai/                 Analyzer: Amazon Nova Pro trên Bedrock (Converse API + toolChoice → JSON có cấu trúc, Guardrail)
    domain/             state machine Listing / Quote / Transaction · danh mục, tình trạng, bàn giao
    modules/users       hồ sơ (SĐT không bắt buộc), điều khoản (QĐ-28, phiên bản 2026-10-21)
    modules/locations   địa điểm đã lưu, mặc định
    modules/partners    đối tác 2 cấp, Admin duyệt / tạm ngừng, chi nhánh (1–5 km), bảng giá, hạn mức tin + VIP 1
    modules/listings    đăng tin (hạn mức, ảnh chờ duyệt), bảng tin "Chợ" (phân trang 7 ngày), matching geohash + Haversine, báo giá dự kiến, xác nhận / từ chối / rút, offer thủ công, Admin gỡ tin
    modules/ai          AI phân tích ảnh chạy nền + giới hạn 20 lượt/ngày; tin đăng lưu nhãn "AI gợi ý ↔ người đăng chốt" (AILABEL#<tháng>)
    modules/transactions chọn báo giá / chốt từ chat, bàn giao, điều chỉnh giá, hoàn tất 2 bước (xác nhận giá → chấp nhận, 48h tự hoàn tất), hủy sau 5 phút, thất bại, khiếu nại / tranh chấp, đánh giá
    modules/reputation  điểm uy tín (rating, tỉ lệ hoàn tất / hủy)
    modules/notifications thông báo (polling) + hộp thư chung Admin
    modules/chat        chat người bán ↔ người mua theo từng tin (polling 5s), ra giá / chấp nhận giá, Admin xem chat
    modules/reports     báo cáo vi phạm, Admin xử lý theo mức (cảnh cáo / gỡ tin / tạm ngừng)
    modules/billing     phí 10.000đ / giao dịch, phí nghi bán ngoài, VIP 1, hóa đơn tháng, khiếu nại phí, khóa khi nợ
    modules/risk        đếm vi phạm, cờ "nghi né phí / vi phạm nhiều lần" cho Admin
    modules/jobs        hẹn giờ việc nền theo "ngăn giờ" (không Scan)
    modules/wallet      sổ cái, giữ tiền, hoa hồng, phí đăng bài (chưa nối vào luồng)
  test/                 vitest — 140 test
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

0. **Chợ** (trang chính): bảng tin kiểu Facebook — mọi người đã đăng nhập lướt tin đang mở; bấm "💬 Gửi tin nhắn" → cột phải hiện thông tin người bán + khung chat. Trong chat có ô **Ra giá**; bên kia bấm **Chấp nhận** là tạo giao dịch.

1. **Người bán:** đồng ý điều khoản → Đối tác → gửi yêu cầu (cấp 1 / cấp 2) → Admin duyệt → Đăng tin (bắt buộc đủ thông tin + ít nhất 1 ảnh đã qua kiểm duyệt; ✨ AI gợi ý; ghim vị trí) → xem báo giá dự kiến → "Yêu cầu xác nhận giá".
2. **Partner:** Đối tác → đăng ký → thêm chi nhánh (bán kính 1–5 km) + bảng giá → Admin duyệt → "Tin phù hợp" → 💬 nhắn tin hỏi người bán → xác nhận giá hoặc gửi báo giá thủ công.
3. **Người bán:** "Chọn đối tác này" (hoặc chấp nhận giá trong chat) → Giao dịch: hẹn lịch bàn giao, (bên mua) đề nghị giảm giá, một bên "Xác nhận đã bàn giao xong" + giá cuối → bên kia "Chấp nhận" (hoặc Khiếu nại) → đánh giá nhau. Hủy giao dịch = tự hủy sau 5 phút.
4. **Admin:** duyệt / tạm ngừng đối tác, duyệt tin bị gắn cờ, tranh chấp (xem chat), báo cáo vi phạm, người dùng bị gắn cờ, hóa đơn / khiếu nại phí (Admin tài chính), thống kê.

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
| S3 `reloop-device-images` | ảnh; backend chỉ dùng prefix `listings/<userId>/`. Lifecycle (Terraform `infra/storage.tf`): ảnh chưa gắn tin (tag `state=pending`) xóa sau 1 ngày, ảnh xóa 90 ngày sau khi upload |
| Lambda `reloop-auth-post-confirmation` | tạo hồ sơ khi xác nhận đăng ký; backend tự chuẩn hóa ở lần gọi `/me` đầu tiên |
| Cognito `ReLoop-user-pool` | pool cũ, **không dùng** cho app (xác minh qua SMS không gửi được) |
| Lambda + API `reloop-generate-presigned-url` | của nhóm, **không có xác thực** — nên tắt; app dùng `POST /uploads/presign` |

**Terraform quản lý** ([infra/](infra/)):

| Tài nguyên | Ghi chú |
|---|---|
| Cognito `reloop-dev-user-pool` (`ap-southeast-1_HttIDqEll`) | chỉ xác minh email; domain `reloop-dev-auth`; web client `3fgdovrar5bgm7bm6ddpl6pkn0`; group `Admins`, `FinanceAdmins`, `Partners`, `Owners` |
| Lambda `reloop-dev-api` (Node 22, arm64) + IAM role | quyền tối thiểu: bảng core, prefix ảnh, Bedrock Nova Pro + Guardrail, Rekognition kiểm duyệt ảnh, tự gọi async, log |
| API Gateway HTTP API `2tslnzyaga` | JWT Cognito cho mọi route; `OPTIONS` không JWT (CORS); throttle 20 req/s |
| EventBridge `reloop-dev-sweep` | 15 phút/lần: hết hạn tin, nhắc 24h, tự hoàn tất 48h, tự hủy sau 5 phút, lập hóa đơn tháng |
| S3 + CloudFront | web tĩnh, bucket private (OAC) |
| CloudWatch + SNS | log 7 ngày, dashboard `reloop-dev-overview`, 9 alarm (Lambda lỗi / throttle, API 5xx, p95 > 2s, lỗi job nền / AI / hệ thống, ảnh có chữ bất thường tăng đột biến, có khiếu nại mới) → SNS `reloop-dev-alarms`; email Admin đăng ký bằng `scripts/make-admin.sh` (thêm email khác qua biến `alarm_email`) |
| Bedrock Guardrail | `reloop-dev-ai-guardrail` (tier Standard) cho AI và kiểm tra chữ trong ảnh |

## Nguyên tắc khi code

- **Không gọi dịch vụ AWS trực tiếp trong nghiệp vụ.** Đi qua interface (`Table`, `AuthProvider`, `ImageStore`, `Analyzer`…) để local và AWS dùng chung code.
- **Đổi trạng thái** phải qua `stateMachines.ts` (`assertTransition`); ghi có điều kiện version (optimistic locking).
- **Việc nền** idempotent: kiểm tra lại trạng thái trước khi ghi; chạy trễ / trùng không sai.
- **API tạo dữ liệu quan trọng** (đăng tin, gửi offer, chọn báo giá, chấp nhận giá trong chat, mua VIP 1) bắt buộc header `Idempotency-Key`.
- **Tiền** là số nguyên VND; phí ghi qua `BillingService` trong cùng transaction với việc đổi trạng thái (ví / `Ledger.post()` chỉ còn giữ cho thanh toán qua ví sau này).
- **Không Scan.** Khóa mới khai báo ở `backend/src/store/keys.ts`.
- **Không commit bí mật.** `.env` nằm trong `.gitignore`.
