# ReLoop — Bàn giao ngữ cảnh (đọc file này đầu tiên)

> **Mục đích:** lưu toàn bộ ngữ cảnh dự án để khi mở lại máy, Claude (hoặc thành viên mới) đọc là biết đã làm tới đâu.
> **Cập nhật lần cuối:** 2026-10-22 (đối chiếu toàn bộ với code)
> **Quy tắc:** mỗi khi xong một phần việc hoặc chốt quyết định mới, cập nhật mục 6 (Trạng thái), mục 7 (Việc tiếp theo) và mục 9 (Nhật ký).

---

## 1. Dự án là gì

**ReLoop** là website trung gian (chợ) đồ điện tử cũ, hỏng:
- **Người bán:** đối tác đã được Admin duyệt — **cấp 1** (khách lẻ) hoặc **cấp 2** (doanh nghiệp / hộ kinh doanh, có chi nhánh, bảng giá, thu mua).
- **Người mua:** đơn vị thu mua cấp 2 (báo giá từ bảng giá) hoặc **bất kỳ ai đã đăng nhập** (ra giá trong chat).

Tiền **không qua ReLoop**: hai bên thanh toán trực tiếp khi bàn giao. ReLoop thu **phí dịch vụ theo hóa đơn tháng** (người bán chuyển khoản, Admin tài chính xác nhận).

- **Loại dự án:** thực tập AWS Cloud Engineering. Bắt đầu 2026-10-10, khoảng 12 tuần. Ngân sách 20–50 USD/tháng.
- **Kiến trúc:** serverless trên AWS (Lambda, API Gateway, DynamoDB, Cognito, S3/CloudFront, Bedrock, Rekognition, EventBridge, CloudWatch + SNS).
- **Cách làm đã chốt:** local-first. Code viết dạng Lambda, gọi dịch vụ qua adapter, nên chạy local và AWS cùng một code.
- **Người dùng:** Product Owner, giao tiếp tiếng Việt. Claude đóng vai **tech lead**.

## 2. Bản đồ tài liệu (`plan/`, file .md nằm trong `plan/docx/`)

| File | Nội dung | Mức ưu tiên |
|---|---|---|
| `docx/readmeall.md` | File này: tổng hợp ngữ cảnh và tiến độ | Đọc đầu tiên |
| `docx/let.md` | Tóm tắt toàn dự án để lên plan trang quản trị (Admin): quyền, API Admin, hàng đợi, hạn chế | Giao việc trang Admin |
| `docx/letd.md` | Plan trang Admin mới (giao việc): khóa cần thêm, route con, thứ tự A0 → A6, điểm cần PO quyết | Giao việc trang Admin |
| `docx/get.md` | **Plan trang Admin bản chốt** (đã đối chiếu code + quyết định PO 2026-10-22) — khác letd.md thì theo file này | Đang làm |
| `quyetdinh.txt` | **43 quyết định** (QĐ-01 → QĐ-43, TL-xx), đã đối chiếu với code 2026-10-22; QĐ ví / giữ tiền đánh dấu TẠM NGƯNG | **Cao nhất** (sau code) |
| `devdocx.txt` | Dev doc cho nhóm: cài đặt, quy tắc, phân việc, nhật ký tiến độ cho giảng viên, **mục 9 tra cứu kỹ thuật** (Terraform, env, khóa DynamoDB, chữ ký hàm, 88 API) | Làm việc hằng ngày |
| `danhgia.txt` | Danh sách lỗi / mâu thuẫn đã rà soát + đề xuất + trạng thái sửa | Theo dõi lỗi |
| `task.txt` | Danh sách task 12 tuần ban đầu | Lịch sử / kế hoạch |
| `giaiphap.txt` | Đề xuất giải pháp cho từng điểm bất cập | Tham khảo (lịch sử) |
| `baton.txt` | 58 điểm bất cập của spec gốc | Tham khảo (lịch sử) |
| `ReLoop_Specification_v1.0.docx` | Spec gốc | Gốc, đã bị ghi đè nhiều chỗ |
| `docx/README.md` | Bản tóm tắt task **đầu tiên**, viết trước buổi hỏi đáp | **Đã lỗi thời** |

Thứ tự tin cậy: **code > quyetdinh.txt > devdocx.txt > task.txt > giaiphap.txt > spec gốc > plan/docx/README.md**.

## 3. Hệ thống đang làm gì (theo code 2026-10-22)

**Đối tác & tin đăng**
- Chỉ đối tác đã duyệt mới đăng tin (QĐ-34). Cả 2 cấp khai loại hình, tên, số giấy tờ, email liên hệ; SĐT không bắt buộc (ở Hồ sơ). Tên + email + SĐT của người bán hiện công khai trên tin.
- **Hạn mức tin đang mở cùng lúc (QĐ-41):** cấp 1 = 3, cấp 1 + **VIP 1** = 5 (10.000đ / 30 ngày, tự mua, cộng dồn, cộng vào hóa đơn), cấp 2 = 10.
- Đăng tin bắt buộc mô tả ≥ 10 ký tự + ≥ 1 ảnh; ảnh qua Rekognition: **≥ 70% nhạy cảm → chặn + tính vi phạm**; **50–70% nhãn nặng → tin chờ Admin duyệt** (QĐ-43); **chữ bất thường trong ảnh → chờ duyệt** (QĐ-36).
- AI Amazon Nova Pro gợi ý thông tin từ ảnh (chạy nền, 20 lượt/ngày), lưu bộ dữ liệu nhãn (QĐ-35).
- Tin mở 7 ngày; matching geohash + Haversine trong bán kính chi nhánh (1–5 km), **chạy ngay trong request** (QĐ-13 phần matching nền chưa làm).
- **Chợ:** mọi người đã đăng nhập xem tin đang mở (chỉ khu vực), phân trang thật trong 7 ngày gần nhất; tin của người bán bị tạm ngừng / khóa do nợ bị ẩn.

**Chốt giao dịch — 2 đường**
- *Báo giá (đối tác cấp 2):* giá dự kiến từ bảng giá → chủ tin yêu cầu xác nhận (24h) → đối tác xác nhận giá → chủ tin chọn. Đối tác không được chọn thấy "đang giao dịch với người khác" và được báo.
- *Ra giá trong chat (QĐ-38):* hai bên ra giá qua lại, bên kia bấm **Chấp nhận** → giao dịch; tin rời Chợ, khách khác được báo, chat của họ khóa.

**Giao dịch (thanh toán offline)**
- Liên hệ + địa chỉ mở cho hai bên ngay khi tạo giao dịch. Hẹn lịch bàn giao; đang chờ bàn giao vẫn ra giá mới trong chat; bên mua đề nghị giảm giá (≤ 2 lần, có ảnh).
- **Hoàn tất 2 bước (QĐ-42):** bên trước nhập giá cuối → bên kia **Chấp nhận** (hoàn tất) hoặc **Khiếu nại** (tranh chấp); im lặng 48h → tự hoàn tất, nhắc ở 24h.
- **Hủy (QĐ-38):** yêu cầu hủy → tự hủy sau 5 phút (rút lại / đồng ý hủy ngay được) → tin quay lại Chợ.
- Tranh chấp: Admin được báo qua chuông + email, xem chat, kết luận hoàn tất (nhập giá) / thất bại. Chưa có upload bằng chứng.
- Đánh giá 2 chiều trong 14 ngày; uy tín 180 ngày.

**Phí & chống né phí**
- 10.000đ / giao dịch hoàn tất, người bán trả, hóa đơn ngày 1 hằng tháng, hạn 7 ngày, mã chuyển khoản RLFxxxxxx (QĐ-37).
- **Nợ quá hạn (QĐ-40):** > 3 ngày không đăng tin mới; > 7 ngày khóa mọi chức năng (chỉ còn màn hình thanh toán phí).
- **Chống né phí (QĐ-39):** hủy / thất bại rồi gỡ tin trong 72h → tính 10.000đ "nghi bán ngoài" (khiếu nại được); cờ cho Admin khi ≥ 2 lần hủy với cùng người mua hoặc ≥ 3 lần hủy rồi gỡ tin trong 30 ngày.

**Kiểm duyệt (QĐ-43)**
- Báo cáo vi phạm (tin / giao dịch): Admin chọn Cảnh cáo · Gỡ tin + cảnh cáo · Gỡ tin + tạm ngừng / Tạm ngừng · Bỏ qua; lý do soạn sẵn; tạm ngừng bắt buộc lý do + hỏi lại; người vi phạm được báo.
- Đếm vi phạm (cảnh cáo, gỡ tin, tạm ngừng, ảnh bị chặn, tin bị từ chối) ≥ 5 / 30 ngày → cờ cho Admin.
- Người bán bị tạm ngừng: tin ẩn khỏi Chợ, không chốt / báo giá / chat mới, không sửa chi nhánh / bảng giá.

**Đã tạm ngưng (code backend còn giữ, không dùng; website đã bỏ trang Ví 2026-10-22):** ví nội bộ, giữ tiền, hoa hồng 10%, phí đăng bài 20k, nạp / rút, STK, webhook ngân hàng. ⚠ Pháp lý: nếu nối lại ví thì cần giấy phép trung gian thanh toán của NHNN.

## 4. Kiến trúc code hiện tại

Cây thư mục chi tiết: [README.md](../../README.md#cấu-trúc). Tham chiếu kỹ thuật đầy đủ: `devdocx.txt` mục 9.
- **backend/** TypeScript, 1 Lambda `reloop-dev-api` phục vụ 3 loại sự kiện: request API Gateway, worker AI (Lambda tự gọi async), job định kỳ (EventBridge 15 phút: hết hạn tin, nhắc 24h, tự hoàn tất 48h, tự hủy sau 5 phút, lập hóa đơn tháng). Local: job mỗi 60 giây.
- Adapter theo môi trường: `Table` (MemoryTable ↔ DynamoTable), `AuthProvider` (header dev ↔ Cognito JWT), `ImageStore` (tắt ↔ S3), `ImageModerator` / `TextScreener` (tắt ↔ Rekognition + Guardrail), `Analyzer` (tắt ↔ Bedrock **Amazon Nova Pro**).
- **frontend/** React + Vite; Leaflet/OSM; đăng nhập Cognito (OAuth code + PKCE); polling: thông báo 30s, chat 5s.
- **infra/** Terraform (state S3 `reloop-tfstate-926583575243`); tài nguyên nhóm dựng tay được đọc qua `data`. CloudWatch 9 alarm → SNS `reloop-dev-alarms` (email Admin đăng ký qua `make-admin.sh`).
- **scripts/** `smoke-aws.py`, `make-admin.sh` (cấp quyền Admin + đăng ký email cảnh báo), `loadtest.mjs`.
- **Test:** 140 test vitest (backend).

**Nguyên tắc code (phải giữ):** đổi trạng thái qua `stateMachines.ts`; ghi có điều kiện version + `withOptimisticRetry`; không Scan; việc nền idempotent; nghiệp vụ không gọi AWS trực tiếp; API tạo dữ liệu quan trọng bắt buộc `Idempotency-Key`; tiền là số nguyên VND, phí ghi qua `BillingService` cùng transaction đổi trạng thái.

## 5. Môi trường máy

- Máy hiện tại: Windows 10, Node 22, AWS CLI 2.38.1, Terraform 1.16.6, Git Bash. Chưa có Docker.
- AWS: profile `reloop` (đăng nhập `aws login --profile reloop`, user IAM `TRUNG`, account `926583575243`, region `ap-southeast-1`). Terraform cần `eval "$(aws configure export-credentials --profile reloop --format env)"` (deploy.sh tự làm).
- Profile mặc định trên máy trỏ account KHÁC — **không dùng** cho ReLoop.
- Git Bash đổi đường dẫn bắt đầu bằng `/` → dùng `MSYS_NO_PATHCONV=1` cho lệnh AWS có tham số dạng `/aws/...`.

## 6. Trạng thái hiện tại (2026-10-22)

**Đã deploy lên AWS dev (2026-10-22, commit `d4e2784` + `ae5f016`, nhánh `feature/doi-tac-2-cap`):** toàn bộ dưới đây; smoke-aws.py RUN e07cce ALL PASS (25 bước). Dữ liệu test được GIỮ trên web theo yêu cầu (dùng để test / fix bug) — không xóa tin nào.

**Gồm (2026-10-20 → 2026-10-22, 140 test pass):**
- QĐ-38 ra giá trong chat + hủy sau 5 phút · QĐ-39 chống né phí · QĐ-40 khóa 2 mức khi nợ phí · QĐ-41 hạn mức tin + VIP 1 · QĐ-42 hoàn tất 2 bước · QĐ-43 xử lý vi phạm theo mức, đếm vi phạm, ảnh nghi nhạy cảm chờ duyệt.
- Sửa lỗi theo `danhgia.txt`: 1, 1b, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20 (Admin xem chat, hộp thư chung Admin + email khi có khiếu nại, Chợ phân trang thật…).
- Terraform đã apply: SNS `reloop-dev-alarms`, alarm `dispute-opened`, metric mới, S3 ảnh 90 ngày.

**Chưa làm / còn lỗi** (chi tiết `danhgia.txt`, `devdocx.txt` mục 5)
- Lỗi code còn mở: 12 (lượt AI theo ngày UTC).
- **Trang Admin mới (get.md) đã deploy 2026-10-22:** A0–A6 + B1, B2, B3, B6 xong (layout riêng /admin/*, menu theo nhóm, Thành viên + hồ sơ gộp, giao dịch theo trạng thái, tin theo tháng, nhật ký Admin, số liệu tháng, nhãn PN1/PN1V/PN2, menu người dùng theo vai trò, "Phản ánh"). Còn: B4 (Google, hoãn), B5 (chờ file logo).
- **Đã deploy 2026-10-22:** sửa chất lượng AI tiếng Việt + Gemini dự phòng (chưa có key → tắt) + bắt câu lệnh mất dấu + bỏ trang Ví. Chưa thử AI trên ảnh thật.
- Matching chạy nền (B7), upload bằng chứng tranh chấp (B3), sửa / phản hồi đánh giá (B4), ảnh giấy tờ đối tác (B2), lọc / tìm kiếm Chợ (B5), nút xóa ảnh khi đăng tin (F2), "thu cũ đổi mới" của cấp 2, hướng A chống né phí (hiện chỉ số hủy trên hồ sơ).
- Hạ tầng: AWS Budgets, CI/CD tự deploy, môi trường prod, WAF, load test thật, Well-Architected Review, tài liệu cuối kỳ.

## 7. Việc tiếp theo

1. Chạy lại `make-admin.sh` cho các Admin hiện có để đăng ký email cảnh báo, mỗi người bấm Confirm trong email AWS.
2. Gộp `feature/doi-tac-2-cap` vào `main` (Pull Request) khi nhóm đã test xong.
3. Người dùng thử trên web dev, báo lỗi; sửa tiếp các mục còn mở trong `danhgia.txt`.
4. Báo đồng đội tắt / thêm xác thực API `reloop-generate-presigned-url` (đang công khai); bỏ pool Cognito cũ.
6. Logo mới (get.md B5): chờ PO gửi file SVG. Đăng nhập Google (B4): hoãn.
5. Thử AI trên ảnh thật: `aws login --profile reloop` rồi `AWS_PROFILE=reloop [GEMINI_API_KEY=...] npx -w backend tsx ../scripts/ai-compare.mts <ảnh>` (ảnh ESP32 + chuột Logitech M650). Quyết định có bật Gemini không (xem rủi ro mục 8) → deploy với `TF_VAR_gemini_api_key`.

## 8. Rủi ro đang theo dõi

- **Né phí** khi thanh toán offline: chỉ phát hiện theo dấu hiệu (QĐ-39), không chặn tuyệt đối.
- **Bắt nhầm ảnh** ở vùng 50–70%: theo dõi metric `ImagesSensitiveSuspected` sau khi chạy thật để chỉnh ngưỡng.
- **Rekognition đọc sai dấu tiếng Việt** → câu lệnh tiếng Việt in trong ảnh có thể không bị gắn cờ.
- **Email cảnh báo** chỉ tới Admin đã bấm Confirm subscription; `COGNITO_DEFAULT` gửi tối đa ~50 email/ngày.
- **Pháp lý:** nếu nối lại ví / giữ tiền cần giấy phép NHNN; dữ liệu cá nhân theo NĐ 13/2023.
- **Gemini miễn phí (nếu bật):** ảnh người dùng gửi sang Google; gói free của AI Studio có thể dùng dữ liệu để cải thiện sản phẩm → cần ghi vào điều khoản / cân nhắc NĐ 13/2023, hoặc dùng gói trả phí. Key nằm trong biến môi trường Lambda + Terraform state (chưa dùng SSM / Secrets Manager).
- **`npm audit`** có cảnh báo ở các gói chỉ dùng khi dev (vite, vitest); chưa nâng phiên bản.

## 9. Nhật ký phiên làm việc

| Ngày | Việc đã làm |
|---|---|
| 2026-10-10 | Đọc spec .docx → tóm tắt task (plan/README.md) → baton.txt (58 bất cập) → giaiphap.txt → hỏi đáp tech lead 6 vòng → quyetdinh.txt (escrow, sau đó chuyển sang ví nội bộ, hai chiều giao dịch) → task.txt. Chốt local-first. Chuyển tài liệu vào `plan/`. Dựng monorepo, lõi ví, frontend; 36 test. |
| 2026-10-11 | Người dùng yêu cầu có doanh thu → chốt hoa hồng 10% (min 5k, Partner trả) + phí đăng bài 20k (bài đầu miễn phí) → code + 7 test mới (43 tổng) → cập nhật quyetdinh/task/README. |
| 2026-10-12 | Trình bày các bước triển khai AWS (mục 7). Tạo file `readmeall.md` này. |
| 2026-10-12 | (phiên 2) Người dùng chọn đưa lên GitHub kèm CI. Thêm .github/workflows/ci.yml và .gitattributes, kiểm tra lại (typecheck, 43 test, build đều pass), commit đầu 3da3ba7. Chờ người dùng tạo repo và push. |
| 2026-10-12 | (phiên 2) Người dùng đã push lên 	hqttunvt/Reloop. Repo đang Public template; đã khuyên chuyển sang Private. |
| 2026-10-12 | (phiên 2) Cài gh CLI. Tạo label, milestone GĐ 0 và 13 issue từ task.txt (T0.1–T0.13); đóng #13. CI lần đầu pass. |
| 2026-10-16 | Viết `DynamoTable` (backend/src/store/dynamoTable.ts) + nối vào app.ts khi STAGE=aws (bắt buộc TABLE_NAME). 9 test mới (52 tổng), typecheck sạch. Máy đã có AWS CLI 2.37 + Terraform 1.16. |
| 2026-10-16 | Lên AWS account 926583575243 (ap-southeast-1, profile `reloop` qua `aws login`, user TRUNG). Theo hạ tầng nhóm dựng sẵn: DynamoTable đổi khóa sang PK/SK/GSI1, UserService nhận hồ sơ do Lambda post-confirmation tạo, group Cognito Admins/FinanceAdmins. Chạy test hợp đồng trên bảng thật (pass). Terraform (infra/, data source cho tài nguyên có sẵn): đã tạo S3 web + CloudFront d1cjl1tvcp0r6q.cloudfront.net, API Gateway 2tslnzyaga + JWT authorizer, log group. Tạo group FinanceAdmins, bật PITR. Web đã upload. **Kẹt:** IAM role cho Lambda (TRUNG thiếu iam:TagRole) và callback URL Cognito chưa cập nhật — chờ người dùng. |
| 2026-10-16 | Admin cấp thêm quyền IAM/Lambda (policy ReLoopDeployExtra) cho TRUNG. Terraform tạo nốt IAM role + Lambda `reloop-dev-api` + route API. Sửa CORS preflight (route OPTIONS không JWT, Lambda trả 204). Kiểm tra: Lambda đọc DynamoDB thật OK, JWT chặn đúng, CORS đúng origin. 56 test pass. **Còn chờ:** thêm callback/logout URL `https://d1cjl1tvcp0r6q.cloudfront.net/auth/callback` (và localhost) vào reloop-web-client. |
| 2026-10-16 | Pool Cognito cũ xác minh qua SMS (account trong SMS sandbox → không nhận được mã) và TRUNG không có quyền UpdateUserPool. Tạo pool mới bằng Terraform `reloop-dev-user-pool` (ap-southeast-1_HttIDqEll), sao theo pool cũ nhưng chỉ xác minh email, domain `reloop-dev-auth`, client web `3fgdovrar5bgm7bm6ddpl6pkn0`, 4 group, vẫn dùng Lambda post-confirmation. API Gateway + frontend chuyển sang pool mới. User cũ (trung01, madlyham) phải đăng ký lại. |
| 2026-10-16 | Bỏ nạp/rút tiền theo yêu cầu. Làm EPIC 1–7, 9–14 + giám sát: đối tác, chi nhánh, bảng giá, đăng tin + ảnh S3, AI Bedrock (chạy nền), matching geohash, báo giá, giao dịch offline, job nền EventBridge, thông báo, đánh giá + uy tín, tranh chấp, báo cáo vi phạm, điều khoản, địa điểm đã lưu, landing, CloudWatch dashboard + alarm. 78 test + smoke test AWS pass. AI Bedrock đã chạy thật. |
| 2026-10-16 | Lưu trữ QĐ-27 (người dùng đồng ý sửa cấu hình của nhóm): bật DynamoDB TTL `ttl` trên reloop-core-table (thông báo 90 ngày); S3 Lifecycle `infra/storage.tf` cho prefix `listings/` — ảnh tag `state=pending` xóa sau 1 ngày, ảnh đã gắn tin xóa sau 120 ngày. Kiểm tra trên AWS: upload → pending, đăng tin → attached. |
| 2026-10-16 | Kiểm duyệt ảnh nhạy cảm (M6) bằng Amazon Rekognition `DetectModerationLabels`: frontend gọi `POST /uploads/moderate` ngay sau upload; ảnh vi phạm (khỏa thân, bạo lực, ghê rợn, biểu tượng thù địch, ma túy…, độ tin cậy ≥ 70%) bị xóa + trả 422; ảnh sạch gắn tag `moderation=passed`. Đăng tin / AI / đề nghị giảm giá bắt buộc ảnh có tag này. Metric `ImagesRejected` trên dashboard. Đã kiểm tra trên AWS. |
| 2026-10-16 | Theo yêu cầu: (1) đăng tin bắt buộc đủ thông tin — mô tả ≥ 10 ký tự + ít nhất 1 ảnh (khi có S3); (2) bỏ xác thực SĐT, SĐT trong hồ sơ không bắt buộc (bỏ /dev/verify-phone, bỏ biến enable_dev_routes); (3) chat người bán ↔ đơn vị thu mua theo từng tin (`modules/chat`, chỉ đối tác được match; thông báo ở tin đầu chưa đọc; khóa khi tin kết thúc; thứ tự theo version cuộc trò chuyện). 86 test + smoke test AWS (có chat) pass. |
| 2026-10-16 | Trang "Chợ" kiểu Facebook (mặc định sau đăng nhập): mọi người đã đăng nhập xem tin đang mở (chỉ khu vực, không giá, không vị trí chính xác); thẻ tin có "💬 Gửi tin nhắn" → cột phải hiện thông tin người bán (tên, ngày tham gia, uy tín) + chat. Chat mở cho mọi người mua (không cần là đối tác); báo giá / chọn đối tác vẫn chỉ cho đối tác đã duyệt. Bảng tin dùng con trỏ `FEED#<tháng>` (không Scan). Trang chi tiết tin có chế độ VIEWER. 89 test + smoke AWS pass. |
| 2026-10-18 | Đọc lại toàn bộ code (89 test pass). QĐ-34: chia đối tác cấp 1 (khách lẻ) / cấp 2 (doanh nghiệp, hộ KD); chỉ đối tác đã duyệt mới đăng tin; email liên hệ bắt buộc, SĐT không bắt buộc ở Hồ sơ; liên hệ đối tác hiện công khai trên tin; trang Đăng tin + menu làm nổi bật yêu cầu làm đối tác; PATCH /partners/me/contact cho hồ sơ cũ thiếu email; điều khoản 2026-10-18. 94 test pass, build web OK. Chưa deploy. |
| 2026-10-19 | QĐ-35: AI đổi sang Amazon Nova Pro (apac.amazon.nova-pro-v1:0) qua Bedrock Converse API (toolChoice → JSON), bỏ SDK Anthropic; Bedrock Guardrail (Terraform infra/ai.tf, bật mặc định); lưu bộ dữ liệu nhãn AI gợi ý ↔ người đăng chốt (AILABEL#<tháng>). Cấp 1 cũng khai loại hình (thêm Cá nhân) + số giấy tờ. 97 test pass. Chưa deploy, chưa chạy terraform validate (máy chưa có Terraform). |
| 2026-10-19 | QĐ-36: gắn cờ ảnh có chữ bất thường (Rekognition DetectText → Bedrock ApplyGuardrail) khi upload; tin có ảnh bị gắn cờ → PENDING_REVIEW chờ Admin duyệt 1–3 ngày (hàng đợi REVIEWQ#LISTING, trang Admin "Tin chờ duyệt"); metric + alarm. 101 test pass, build web OK. Chưa deploy. |
| 2026-10-19 | QĐ-37 phí dịch vụ 10.000đ / giao dịch hoàn tất, người bán trả, gộp hóa đơn theo tháng (giờ VN), thay hoa hồng + phí đăng bài; hóa đơn ngày 1 hằng tháng (job nền), Admin tài chính xác nhận đã thu, quá hạn 7 ngày khóa đăng tin / báo giá (modules/billing). Điều khoản 2026-10-19. 107 test pass. Chưa deploy. |
| 2026-10-19 | Cài AWS CLI 2.38.1 + Terraform 1.16.6 trên máy mới (Windows 10). DEPLOY nhánh feature/doi-tac-2-cap lên dev (Terraform 0 xóa; Guardrail tier STANDARD + cross-region APAC, MISCONDUCT chỉ lọc chữ). smoke-aws.py ALL PASS. Kiểm tra thật: Nova Pro đọc đúng tem Dell Latitude 5490 (JSON, confidence high); Guardrail Standard bắt câu lệnh tiếng Anh + tiếng Việt có dấu, không bắt nhầm tem nhãn. HẠN CHẾ: Rekognition DetectText đọc sai dấu tiếng Việt → câu lệnh tiếng Việt in trong ảnh KHÔNG bị gắn cờ (tiếng Anh vẫn bị). DynamoDB on-demand; account có budget 2 USD. |
| 2026-10-20 | Rà soát toàn website → `plan/danhgia.txt` (19 lỗi / mâu thuẫn). Sửa khối người bán ở trang tin, siết chỉ dẫn AI viết tiếng Việt. QĐ-38: ra giá trong chat (Chấp nhận → giao dịch, tin rời Chợ, báo khách khác), hủy giao dịch sau 5 phút. 112 test. Chưa commit / deploy. |
| 2026-10-21 | QĐ-39 chống né phí (phí nghi bán ngoài + khiếu nại + cờ Admin). QĐ-40 khóa 2 mức khi nợ phí; người bán bị tạm ngừng bị ẩn. Sửa lỗi 1b, 2, 3, 6, 8, 9, 10, 11 (Chợ phân trang thật, `skRange`), 20 (Admin xem chat). QĐ-41 hạn mức tin 3 / 5 / 10 + VIP 1. QĐ-42 hoàn tất 2 bước. 132 test. Chưa commit / deploy. |
| 2026-10-22 | Mục 7: hộp thư chung Admin + CloudWatch alarm `dispute-opened` → SNS email (make-admin.sh tự đăng ký email Admin). QĐ-43: báo cáo vi phạm theo mức, lý do soạn sẵn, chặn tạm ngừng nhầm, đếm vi phạm ≥ 5 / 30 ngày, ảnh nghi nhạy cảm 50–70% chờ duyệt. 140 test, terraform validate OK. Đối chiếu toàn bộ tài liệu với code (chỉ sửa tài liệu). Chưa commit / deploy. |
| 2026-10-22 | S3 Lifecycle: ảnh xóa 90 ngày sau khi upload (thay 120 ngày, tiết kiệm); điều khoản sửa "90 ngày sau khi tải lên"; menu "Ví (đang fix)". Chưa commit / deploy (cần `terraform apply`). |
| 2026-10-22 | Push GitHub (commit d4e2784, ae5f016) + DEPLOY dev: terraform apply 5 thêm / 10 sửa / 0 xóa, Lambda + web mới. smoke-aws.py sửa theo luật mới (hủy 5 phút, ra giá trong chat, khách đồng ý điều khoản), mặc định giữ dữ liệu test (người dùng yêu cầu không xóa tin nào); RUN e07cce ALL PASS. 2 tài khoản test smoke-*-cd6a26 đang bị tạm ngừng (tin ẩn, chưa xóa). |
| 2026-10-22 | (phiên sau) Đọc lại toàn bộ code trên nhánh `feature/doi-tac-2-cap` (HEAD 0e1ff1f): 140 test pass, typecheck backend + frontend sạch. Code khớp mục 3–6; không sửa code. `scripts/make-admin.sh` hiện "M" trong git nhưng diff nội dung rỗng (chỉ khác kết thúc dòng). |
| 2026-10-22 | Sửa AI theo lỗi chạy thật (Nova Pro viết "Chuốt", "Bổ tâng Arduino", "màu máu"): schema thêm 2 trường suy luận đứng đầu (`observedTextAndLabels`, `identifiedComponents`), prompt có bảng từ vựng tiếng Việt + cấm chữ sai + mẫu tiêu đề / mô tả, `sanitizeVietnamese` trong `validateResult` (cụm vô nghĩa bị xóa, không thay bằng màu / tình trạng bịa). Thêm `GeminiAnalyzer` (fetch, `gemini-2.5-flash`) + `FallbackAnalyzer` (lỗi / 429 → Nova Pro, log `ai_fallback` + metric `AiFallbacks`); env `GEMINI_API_KEY` / `GEMINI_MODEL_ID`, Terraform `gemini_api_key` (sensitive). TextScreener: so khớp câu lệnh không dấu trước Guardrail. Sửa danhgia 19. Script `scripts/ai-compare.mts`. 151 test, typecheck, terraform validate OK. Commit b61882f; chưa deploy / chạy thật. |
| 2026-10-22 | Bỏ ví khỏi website theo yêu cầu PO: xóa menu "Ví (đang fix)", route `/wallet`, `WalletPage.tsx` và kiểu Wallet / LedgerLine / Bucket ở frontend (danhgia 18). Backend ví giữ nguyên. Build web OK. Chưa deploy. |
| 2026-10-22 | DEPLOY dev (commit 85529c8): terraform apply 1 thêm (metric AiFallbacks) / 1 sửa (Lambda + env GEMINI_*, key còn rỗng → AI chỉ dùng Nova Pro prompt mới) / 0 xóa; web mới (bỏ menu Ví). smoke-aws.py RUN f9f4bc ALL PASS (25 bước, giữ dữ liệu test). Chưa thử AI trên ảnh thật, chưa có Gemini key. |
| 2026-10-22 | Đăng nhập: Cognito domain chuyển Managed Login v2 + branding mặc định (Terraform 2 thêm / 1 sửa / 0 xóa) → có nút hiện mật khẩu. Trang quên mật khẩu của Cognito vẫn ghi "Username" (pool dùng alias_attributes, đổi phải tạo lại pool = mất user) → thêm trang `/forgot-password` trong web: nhập email → Lấy mã → mã + mật khẩu mới (nút Hiện / Ẩn), gọi thẳng API ForgotPassword / ConfirmForgotPassword. Link "Quên mật khẩu?" ở trang chủ. Đã deploy dev. |
| 2026-10-22 | Chat ra giá: ô nhập theo nghìn đồng (50 → 50.000đ, 1000 → 1.000.000đ) + dòng xem trước "= …đ"; nút giá gợi ý 50.000 / 100.000 / 200.000 / 1.000.000 / 2.000.000 (không có đ, bấm để điền). Bong bóng chat vẫn hiện có đ. Đã deploy dev. |
| 2026-10-22 | Đăng nhập 1 trang: bỏ `ALLOW_USER_AUTH` ở 2 app client (Terraform 0 thêm / 2 sửa / 0 xóa) → managed login hiện Username + Password cùng trang thay vì hỏi từng bước. Sai mật khẩu / sai username đều báo chung "Incorrect username or password" (prevent_user_existence_errors — không lộ tài khoản). |
| 2026-10-22 | Viết `plan/docx/let.md` (tóm tắt để lên plan trang Admin). Gom các file .md của `plan/` vào `plan/docx/` (readmeall.md, README.md, let.md); sửa đường dẫn trong README gốc, devdocx.txt. README.md gốc giữ ở thư mục gốc (GitHub). |
| 2026-10-22 | Trang Admin mới theo `plan/docx/get.md` (đã lưu plan + quyết định PO): backend `pageQuery` (store/paging.ts), nhật ký Admin `AUDIT#<tháng>` ghi trong router (mọi POST /admin/* + xem dữ liệu cá nhân, chỉ field cho phép, lỗi ghi → log `audit_write_failed` + alarm), K1 GSI1 `TX#STATUS#` cho giao dịch, K3 `ROLE#Owner` khi getOrCreate, `AdminService` (thành viên, hồ sơ gộp, giao dịch, tin theo tháng UTC, số liệu tháng). Frontend: `/admin/*` layout riêng + 8 nhóm menu + badge, `usePagedList` / `<PagedTable>`, nhãn PN1/PN1V/PN2, menu người dùng theo vai trò (Giao dịch / Hồ sơ / Đăng xuất vào menu thả xuống), "Báo cáo" → "Phản ánh". smoke-aws.py thêm nhánh hoàn tất + tranh chấp + API Admin. 156 test. Deploy dev (Terraform 2 thêm / 1 sửa / 0 xóa). Sửa nhãn trạng thái bị kéo dài ở danh sách giao dịch. QĐ-27 thêm dòng nhật ký Admin. |
