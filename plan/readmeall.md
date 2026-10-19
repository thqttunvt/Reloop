# ReLoop — Bàn giao ngữ cảnh (đọc file này đầu tiên)

> **Mục đích:** lưu toàn bộ ngữ cảnh dự án để khi mở lại máy, Claude (hoặc thành viên mới) đọc là biết đã làm tới đâu.
> **Cập nhật lần cuối:** 2026-10-19
> **Quy tắc:** mỗi khi xong một phần việc hoặc chốt quyết định mới, cập nhật mục 6 (Trạng thái), mục 7 (Việc tiếp theo) và mục 9 (Nhật ký).

---

## 1. Dự án là gì

**ReLoop** là website trung gian kết nối:
- **Owner:** người có đồ điện tử cũ, hỏng, đồ tái chế muốn bán.
- **Partner:** đơn vị thu mua hoặc tái chế. Bắt buộc là doanh nghiệp, có giấy phép kinh doanh.

Tiền đi qua **ví nội bộ**: bên trả nạp tiền vào ví, tiền được giữ đến khi hai bên xác nhận giao dịch xong, rồi tự chuyển sang ví bên nhận.

- **Loại dự án:** thực tập AWS Cloud Engineering. Nhóm 3–4 người, khoảng 12 tuần, bắt đầu 2026-10-10. Ngân sách 20–50 USD/tháng.
- **Kiến trúc:** serverless trên AWS (Lambda, API Gateway, DynamoDB, Cognito, S3/CloudFront, Bedrock, EventBridge).
- **Cách làm đã chốt:** local-first. Viết frontend và backend chạy trên máy trước, lên AWS sau. Code được viết theo dạng Lambda và gọi dịch vụ qua adapter ngay từ đầu, nên khi lên AWS không phải viết lại.
- **Người dùng:** Product Owner, giao tiếp tiếng Việt. Claude đóng vai **tech lead**.

## 2. Bản đồ tài liệu (`plan/`)

| File | Nội dung | Mức ưu tiên |
|---|---|---|
| `readmeall.md` | File này: tổng hợp ngữ cảnh và tiến độ | Đọc đầu tiên |
| `quyetdinh.txt` | **37 quyết định đã chốt** (QĐ-xx, TL-xx). Ghi đè mọi tài liệu khác | **Cao nhất** |
| `devdocx.txt` | Dev doc cho thành viên: cài đặt, quy tắc code / git, phân việc OPS / BE-CORE / BE-AI / FE theo tuần (từ 2026-10-19) | Chia việc |
| `task.txt` | Danh sách task theo 12 tuần, phân vai FE / BE-CORE / BE-PAY / OPS | Kế hoạch làm việc |
| `giaiphap.txt` | Đề xuất giải pháp cho từng điểm bất cập; áp dụng cho những gì quyetdinh.txt chưa nói | Tham khảo |
| `baton.txt` | 58 điểm bất cập của spec gốc | Tham khảo |
| `ReLoop_Specification_v1.0.docx` | Spec gốc (trước đây file mang tên "Theo báo cáo Global E-waste Monitor 2024...") | Gốc, đã bị ghi đè nhiều chỗ |
| `README.md` | Bản tóm tắt task **đầu tiên**, viết trước buổi hỏi đáp | **Đã lỗi thời**: còn giai đoạn 24h, chưa có ví và phí |

Thứ tự tin cậy: **quyetdinh.txt > task.txt > giaiphap.txt > spec gốc > plan/README.md**.

## 3. Các quyết định quan trọng nhất (tóm tắt — chi tiết xem `quyetdinh.txt`)

**Phạm vi**
- **Hai chiều giao dịch (QĐ-29):**
  - *Thu mua:* Partner trả tiền cho Owner. Làm trong MVP.
  - *Bán đồ tái chế:* khách trả tiền cho Partner. Mở rộng sau.
  - Dữ liệu được thiết kế hỗ trợ cả hai chiều ngay từ đầu.
- **Bán kính và Partner:** tối đa 5 km (hai bên gặp mặt để bàn giao). Partner phải là doanh nghiệp (QĐ-10, QĐ-11).
- **Bỏ giai đoạn ưu tiên 24h (QĐ-12):** tin đăng chỉ còn `ACTIVE → MATCHED → COMPLETED`, cùng `EXPIRED` (sau 7 ngày) và `CANCELLED`.
- **AI và matching chạy nền (QĐ-13):** frontend hỏi lại kết quả định kỳ (polling).
- **Bedrock chỉ dùng để phân tích ảnh khi đăng tin, không phải chatbot.** Mình đã gợi ý thêm chatbot FAQ như phần mở rộng; **người dùng chưa trả lời**.
- **Lùi sang "làm nếu còn thời gian" (QĐ-21):** các chỉ số uy tín nâng cao và Amazon Location Service. Thay bằng Leaflet + OpenStreetMap.

**Tiền: ví nội bộ (QĐ-03 → QĐ-09, QĐ-30, QĐ-31)**
- **Nạp:** sinh VietQR tới tài khoản ReLoop, nội dung chuyển khoản là mã `RLNxxxxxx`. Webhook ngân hàng (SePay/payOS/Casso) báo về thì tự cộng tiền vào ví.
- **Ba phần số dư:** Khả dụng / Đang giữ / Đang rút. Hạn mức: nạp tối thiểu 10k, số dư tối đa 20 triệu, rút tối thiểu 50k.
- **Thanh toán:** sau khi Owner chọn offer, bên trả có **12 giờ** để bấm Thanh toán. Tiền chuyển từ Khả dụng sang Đang giữ.
- **Hoàn tất:** khi hai bên cùng xác nhận, hoặc một bên xác nhận và bên kia im lặng quá **48 giờ**, tiền **tự động** chuyển sang ví bên nhận.
- **Hủy hoặc thất bại:** hoàn 100% cho bên trả.
- **Tranh chấp:** đóng băng tiền, Admin quyết trong 7 ngày.
- **Rút:** chỉ về tài khoản ngân hàng có **tên chủ tài khoản trùng tên đã được Admin xác minh**. Admin chuyển tay trong 24 giờ, mã nội dung chuyển khoản là `RLRxxxxxx`.
- **Thông tin liên lạc:** SĐT và địa chỉ chỉ mở cho nhau sau khi tiền đã được giữ.
- **Điều chỉnh giá:** chỉ được giảm, tối đa 2 lần. Hàng bán theo kg thì giữ tiền theo ước tính × 1,2.
- **⚠ Pháp lý:** ví và giữ tiền hộ là dịch vụ trung gian thanh toán, cần giấy phép của Ngân hàng Nhà nước. Demo chỉ dùng tiền và tài khoản của nhóm; báo cáo cuối phải ghi rõ điểm này.

**Doanh thu (QĐ-02, QĐ-32, QĐ-33 — chốt 2026-10-11)**
- **Hoa hồng 10%, tối thiểu 5.000đ:** Partner trả cộng thêm, Owner nhận đủ. Tính trên giá cuối; hủy hoặc thất bại thì không thu.
- **Phí đăng bài 20.000đ/bài:** bài đầu tiên miễn phí. Hoàn phí nếu sau 7 ngày không có báo giá nào được xác nhận. Owner tự hủy tin thì không hoàn.
- Mọi khoản phí vào ví `REVENUE`.

**Đối tác 2 cấp (QĐ-34 — chốt 2026-10-18)**
- Chỉ đối tác đã được Admin duyệt mới đăng tin. Cấp 1 = khách lẻ (tên + email); cấp 2 = doanh nghiệp / hộ kinh doanh (+ loại hình, GPKD; chi nhánh, bảng giá, thu mua).
- Email liên hệ bắt buộc cả 2 cấp; SĐT không bắt buộc (khai ở Hồ sơ). Tên đối tác + email + SĐT hiện công khai trên tin.

**Khác**
- **Đánh giá hai chiều (QĐ-22).**
- **Bắt buộc đồng ý điều khoản khi đăng ký (QĐ-28).**
- **Lưu trữ (QĐ-27):** ảnh tin đăng xóa sau 90 ngày; sổ cái và bằng chứng tranh chấp giữ lâu dài.

## 4. Kiến trúc code hiện tại

Xem cây thư mục chi tiết trong [README.md](../README.md#cấu-trúc). Tóm tắt:
- **backend/** TypeScript, 1 Lambda `reloop-dev-api` phục vụ 3 loại sự kiện: request API Gateway, worker AI (Lambda tự gọi async), job định kỳ (EventBridge 15 phút).
- Adapter theo môi trường: `Table` (MemoryTable ↔ DynamoTable), `AuthProvider` (header dev ↔ Cognito JWT), `ImageStore` (tắt ↔ S3), `Analyzer` (tắt ↔ Bedrock Claude Haiku 4.5).
- **frontend/** React + Vite; Leaflet/OSM; đăng nhập Cognito Hosted UI (OAuth code + PKCE); polling thông báo 30s.
- **infra/** Terraform (state S3 `reloop-tfstate-926583575243`); tài nguyên nhóm dựng tay được đọc qua `data`, không quản lý.
- **scripts/** `smoke-aws.py` (integration test trên AWS), `make-admin.sh`, `loadtest.mjs`.

**Nguyên tắc code (phải giữ):** đổi trạng thái qua `stateMachines.ts`; ghi có điều kiện version; việc nền idempotent; nghiệp vụ không gọi AWS trực tiếp; API tạo dữ liệu quan trọng bắt buộc `Idempotency-Key`; tiền là số nguyên VND qua `Ledger.post()`.

## 5. Môi trường máy

- Windows 11, Node 26, AWS CLI 2.37, Terraform 1.16, Git Bash. Chưa có Docker.
- AWS: profile `reloop` (đăng nhập `aws login --profile reloop`, user IAM `TRUNG`, account `926583575243`, region `ap-southeast-1`). Terraform cần `eval "$(aws configure export-credentials --profile reloop --format env)"` (deploy.sh tự làm).
- Profile mặc định trên máy trỏ account KHÁC (`880207438282`, user `vscode-claude-agent`) — **không dùng** cho ReLoop.
- Git Bash đổi đường dẫn bắt đầu bằng `/` → dùng `MSYS_NO_PATHCONV=1` cho lệnh AWS có tham số dạng `/aws/...`.

## 6. Trạng thái hiện tại (2026-10-16)

**Đã xong, có test, đã deploy lên AWS dev** (89 unit/API test + `scripts/smoke-aws.py` trên AWS thật đều pass)
- EPIC 1: Cognito (pool mới, xác minh email), hồ sơ, điều khoản QĐ-28 (bắt buộc trước khi đăng tin / đăng ký đối tác / chọn offer), landing page, script cấp Admin. **Đã bỏ xác thực SĐT** — SĐT trong hồ sơ không bắt buộc (SĐT doanh nghiệp khi đăng ký đối tác vẫn bắt buộc).
- EPIC 2: địa điểm đã lưu + mặc định, geohash 4 + Haversine, khoảng cách làm tròn 0,5 km, Partner chỉ thấy khu vực trước khi có giao dịch.
- EPIC 3: đăng ký đối tác, chi nhánh (1–5 km, danh mục, tình trạng, bàn giao, bật/tắt), Admin duyệt / từ chối / tạm ngừng / mở lại.
- EPIC 4: đăng tin (theo cái / kg) **bắt buộc đủ thông tin**: mô tả ≥ 10 ký tự + ít nhất 1 ảnh (hãng/model tùy chọn); upload ảnh S3 presigned POST (≤ 5 MB, ≤ 6 ảnh, frontend thu nhỏ ≤ 1600 px); **kiểm duyệt ảnh nhạy cảm bằng Amazon Rekognition** (`POST /uploads/moderate`, ảnh vi phạm bị xóa, ảnh dùng được phải có tag `moderation=passed`); hủy tin.
- EPIC 5: AI phân tích ảnh chạy nền (202 + polling), Claude Haiku 4.5 qua Bedrock, JSON có schema + validate lại, giới hạn 20 lượt/ngày, lỗi → nhập tay. Đã chạy thật trên Bedrock (kiểm tra 2026-10-16).
- EPIC 6–7: matching đồng bộ trong request (≤ 9 query GSI), báo giá dự kiến + Rule Snapshot, yêu cầu xác nhận (24h), xác nhận khác khoảng dự kiến có cảnh báo, từ chối, rút, offer thủ công (72h), Matching Requests của Partner.
- EPIC 9: chọn offer (2 request đồng thời → 1 thành công), mở liên lạc, lịch bàn giao đề xuất–chấp nhận, điều chỉnh giảm giá (≤ 2 lần, cần ảnh), xác nhận 2 bên, 48h tự hoàn tất, hủy / thất bại (mã lý do), tranh chấp khi giá cuối lệch, lịch sử sự kiện. **Thanh toán offline** (không qua ví).
- EPIC 10: timer theo ngăn giờ + EventBridge 15 phút: hết hạn tin 7 ngày, nhắc 24h, tự hoàn tất 48h.
- EPIC 11: thông báo (chuông, polling 30s, đánh dấu đã đọc).
- **Chợ (trang chính, ngoài kế hoạch gốc — người dùng yêu cầu 2026-10-16):** bảng tin kiểu Facebook cho mọi người đã đăng nhập (chỉ khu vực, không giá, không vị trí chính xác), con trỏ `FEED#<tháng>`. Thẻ tin có "💬 Gửi tin nhắn" → cột phải: thông tin người bán (tên, ngày tham gia, uy tín) + chat.
- **Chat người bán ↔ người mua** theo từng tin (`modules/chat`): mọi người mua nhắn được người bán; chủ tin nhắn được đối tác đã match; polling 5s; khóa khi tin kết thúc. Trang "Tin nhắn".
- EPIC 12: đánh giá 2 chiều (14 ngày), nhãn VERIFIED / ADMIN_RESOLVED / FAILED, uy tín (rating khi ≥ 3 review, tỉ lệ hoàn tất / hủy khi ≥ 5 giao dịch).
- EPIC 13–14: tranh chấp + Admin kết luận, báo cáo vi phạm + gỡ tin, thống kê Admin.
- GĐ 3: Terraform, CloudWatch dashboard + 7 alarm + metric từ log (cả ảnh bị chặn), throttle API, IAM tối thiểu, PITR, smoke test trên AWS, script load test.
- Lưu trữ QĐ-27: DynamoDB TTL `ttl` (thông báo 90 ngày); S3 Lifecycle `infra/storage.tf` (ảnh chưa gắn tin 1 ngày, ảnh tin 120 ngày).

**Đã bỏ theo yêu cầu (2026-10-16):** nạp tiền, rút tiền, khai STK, webhook ngân hàng, đối soát ngân hàng. Code sổ cái / giữ tiền / hoa hồng / phí đăng bài vẫn giữ (có test) để nối lại sau.

**Chưa làm / cần người dùng quyết**
- T8.15 thu phí đăng bài, QĐ-32 hoa hồng: chưa thu vì không còn cách nạp tiền vào ví.
- QĐ-13 matching chạy nền: đang chạy đồng bộ trong request (nhanh, < 1s); chuyển sang worker khi cần.
- CI/CD tự deploy (T15.2): cần quyền tạo IAM OIDC provider cho GitHub Actions; hiện deploy bằng `infra/deploy.sh`.
- Môi trường prod (T15.1), WAF (T15.5), load test thật (T15.9 — script có sẵn, cần token), Well-Architected Review, tài liệu cuối kỳ (GĐ 4).
- Sửa / phản hồi đánh giá (T12.2), upload bằng chứng tranh chấp (T13.2), ảnh giấy phép kinh doanh khi đăng ký đối tác, chiều BÁN TÁI CHẾ (M1).

**Đã làm 2026-10-18 (chưa deploy):** QĐ-34 đối tác 2 cấp — backend + frontend + 5 test mới (94 test pass), smoke-aws.py cập nhật.
**Bàn AI 2026-10-18 (tạm gác):** người dùng nói credits AWS không trừ cho Claude trên Bedrock (chưa kiểm tra được Billing). Tạm giữ Claude Haiku. Đã xem xét: Amazon Nova Lite/Pro (model của Amazon, thường trừ credits); tinh chỉnh Nova khi có dữ liệu do người thật gán nhãn; Rekognition Custom Labels; SageMaker (loại vì GPU tính theo giờ). Không tự train Claude được; không dùng output Claude để train model khác (điều khoản Anthropic).
**Máy hiện tại (Windows 10, Node 22) chưa có AWS CLI / Terraform / ~/.aws** → chưa deploy được, chờ người dùng cho cài + `aws login`.
**Chốt 2026-10-18:** GIỮ nguyên form đăng ký Cognito (ô SĐT/địa chỉ là thuộc tính bắt buộc của pool, bỏ thì phải tạo pool mới → người dùng chọn không đổi). SĐT trong app vẫn không bắt buộc.

## 7. Việc tiếp theo

1. **Commit + push code** — toàn bộ việc từ 2026-10-16 CHƯA commit (kiểm tra `git status`).
2. Người dùng: thử trọn luồng trên web (tài khoản `trung02` đã có group Admins + FinanceAdmins).
3. Người dùng / nhóm: báo đồng đội tắt hoặc thêm xác thực cho API `reloop-generate-presigned-url` (đang công khai); thống nhất bỏ pool Cognito cũ.
4. Gợi ý tiếp cho Chợ: lọc theo khoảng cách / loại thiết bị, ô tìm kiếm; chat realtime (WebSocket — M5).
5. Tiếp các mục "Chưa làm" ở trên theo thứ tự ưu tiên của nhóm.

## 8. Rủi ro đang theo dõi

- **Khối lượng việc:** ví và thanh toán là phần nặng nhất; đề xuất 1 người chuyên trách. Timeline 12 tuần khá chặt.
- **Pháp lý** ví điện tử và giữ tiền hộ (xem mục 3).
- **Mức phí có thể cao so với giá trị hàng:** phí tối thiểu 5k cộng phí đăng bài 20k, trong khi món hàng có thể chỉ vài chục nghìn. Cần theo dõi khi demo.
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
