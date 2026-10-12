# ReLoop — AI-Assisted Electronics Reuse & Recycling Marketplace

> Nền tảng kết nối **Owner** (người có thiết bị điện tử cũ/hỏng) với **Partner** (cửa hàng sửa chữa, thu mua, tái chế) — hỗ trợ đăng tin bằng AI, matching theo vị trí, báo giá tự động theo quy tắc, quản lý giao dịch và đánh giá uy tín.
>
> **Loại dự án:** AWS Cloud Engineering Internship · **Nền tảng:** Responsive Web App · **Kiến trúc:** Serverless, Event-Driven trên AWS
>
> Tài liệu gốc: `Theo báo cáo Global E-waste Monitor 2024 ... .docx` (ReLoop — Complete Business Workflow & System Specification v1.0). Các mục `§x.y` bên dưới tham chiếu tới section trong tài liệu đó.

---

## 1. Nguyên tắc cốt lõi (§28)

- **AI hỗ trợ nhận diện** thiết bị — không khẳng định những gì không thấy được trên ảnh.
- **Partner quyết định giá** — Estimated Quote không phải cam kết.
- **Owner quyết định chọn đối tác** — chỉ chọn được Confirmed Offer còn hiệu lực.
- **Backend đảm bảo tính nhất quán** — state machine, conditional writes, idempotency.
- **ReLoop KHÔNG** thu mua, vận chuyển, thanh toán, cam kết giá cuối, kiểm định phần cứng hay cấp chứng nhận tái chế (§1.3).

## 2. Tech stack (§3, §19)

| Lớp | Công nghệ |
|---|---|
| Frontend | React + TypeScript (responsive) |
| Hosting | S3 + CloudFront (+ Route 53 nếu có domain, WAF tùy chọn) |
| Auth | Amazon Cognito (email + mật khẩu, JWT) |
| API | API Gateway (JWT authorizer) + AWS Lambda |
| Database | Amazon DynamoDB |
| Ảnh | S3 private bucket + Presigned URL |
| AI | Amazon Bedrock (phân tích ảnh → JSON có cấu trúc) |
| Lịch | EventBridge Scheduler → Lifecycle Lambda |
| Thông báo | DynamoDB + polling (SNS/email tùy chọn; WebSocket để sau) |
| Vị trí | Amazon Location Service (geocode) + Haversine (matching) |
| Giám sát | CloudWatch (logs, metrics, alarms, custom business metrics), CloudTrail |
| Bảo mật | IAM least privilege, WAF |
| IaC | Terraform (hoặc 1 công cụ IaC thống nhất) |

## 3. Vai trò (§2)

| Vai trò | Tóm tắt |
|---|---|
| **Owner** | Mặc định khi đăng ký. Quản lý địa điểm, đăng tin, xem/so sánh báo giá, chọn Partner, theo dõi giao dịch, đánh giá, báo cáo vi phạm. |
| **Partner** | Phải nộp đơn và được Admin duyệt. Quản lý chi nhánh, quy tắc giá, nhận yêu cầu, gửi báo giá, xử lý giao dịch, phản hồi đánh giá. |
| **Admin** | Duyệt Partner, kiểm duyệt tin/đánh giá, theo dõi giao dịch, xử lý báo cáo và giá bất thường, tạm ngừng Partner/Rule, thống kê. |

Một tài khoản có thể có nhiều vai trò. **Không bao giờ tin role/userId do frontend gửi lên** (§4.2, §22.2).

---

## 4. Danh sách task

Các task được nhóm theo **4 phase phát triển trong §27**. Phase 0 là phần chuẩn bị nền tảng mình đề xuất thêm (tài liệu không ghi riêng, nhưng mọi phase sau đều cần nó).

Ký hiệu: `[FE]` frontend · `[BE]` backend/Lambda · `[INFRA]` hạ tầng AWS · `[QA]` kiểm thử · `[DOC]` tài liệu

### Phase 0 — Nền tảng dự án (đề xuất)

- [ ] **T0.1 Khởi tạo repo** — cấu trúc monorepo (`frontend/`, `backend/`, `infra/`, `docs/`), lint, format, quy ước commit.
- [ ] **T0.2 Khung IaC tối thiểu** `[INFRA]` — Terraform state backend, môi trường `dev`, các tài nguyên ban đầu: Cognito User Pool, API Gateway, DynamoDB, S3 bucket ảnh, S3 + CloudFront cho frontend.
- [ ] **T0.3 Thiết kế DynamoDB vật lý** `[BE]` — liệt kê **access patterns** trước, rồi thiết kế bảng/GSI (không bắt buộc 1 bảng/entity, §20). Gồm 19 entity logic: Users, Partners, PartnerBranches, PartnerCapabilities, SavedLocations, Listings, ListingImages, ListingLocationSnapshots, Matches, PricingRules, Quotes, Transactions, TransactionEvents, Reviews, ReviewResponses, ReputationMetrics, Notifications, Reports.
- [ ] **T0.4 Chốt API Contract** `[BE][DOC]` — request/response schema, mã lỗi, pagination, idempotency, quyền truy cập cho từng endpoint (§21 mới là bản sơ bộ).
- [ ] **T0.5 Khung backend** `[BE]` — 1 codebase, nhiều Lambda handler theo module (§18, không bắt buộc microservices); middleware dùng chung: đọc claims từ JWT, kiểm tra role, kiểm tra sở hữu tài nguyên, validate input, structured logging (không log token).
- [ ] **T0.6 Khung frontend** `[FE]` — React + TS, routing theo 3 vùng Owner/Partner/Admin, layout responsive, API client gắn Access Token.

### Phase 1 — Functional MVP (§27)

#### Epic 1: Authentication & Profile (§4, §18.1)
- [ ] **T1.1** `[INFRA]` Cognito: đăng ký email/mật khẩu, xác minh tài khoản (nếu cấu hình), quên & khôi phục mật khẩu.
- [ ] **T1.2** `[BE]` Sau khi xác thực, tạo/cập nhật hồ sơ user trong DynamoDB, mặc định role **Owner**. API `GET /me`, `PATCH /me`.
- [ ] **T1.3** `[BE]` API Gateway JWT authorizer + kiểm tra role & quyền sở hữu tài nguyên trong Lambda.
- [ ] **T1.4** `[FE]` Trang Đăng ký, Đăng nhập, Xác minh, Quên/Khôi phục mật khẩu, Profile Settings.
- [ ] **T1.5** `[FE]` Landing Page: giới thiệu, quy trình, danh mục thiết bị, lợi ích Owner/Partner, nút "Đăng thiết bị" và "Đăng ký đối tác" (§3.1).

**Xong khi:** user đăng ký → đăng nhập → gọi API có bảo vệ; sửa role ở browser không có tác dụng.

#### Epic 2: Location Management (§5, §18.2) — *chức năng cốt lõi cho matching*
- [ ] **T2.1** `[BE]` CRUD Saved Locations: `GET/POST /locations`, `PATCH/DELETE /locations/{id}`. Trường: id, tên, địa chỉ hiển thị, địa chỉ chuẩn hóa, lat/lng, trạng thái xác nhận tọa độ, cờ mặc định, createdAt/updatedAt. Chỉ có **1 địa điểm mặc định**.
- [ ] **T2.2** `[BE][INFRA]` Location Verification qua Amazon Location Service: nhập địa chỉ/chọn trên bản đồ → trả tọa độ → user xác nhận → backend validate → lưu.
- [ ] **T2.3** `[BE]` Hàm Haversine `distanceKm` + điều kiện `distanceKm <= serviceRadiusKm`. Hiển thị là **khoảng cách đường chim bay**, không phải quãng đường/thời gian di chuyển.
- [ ] **T2.4** `[BE]` Location Snapshot: mỗi Listing lưu bản sao vị trí lúc đăng; đổi địa điểm mặc định **không** ảnh hưởng Listing cũ.
- [ ] **T2.5** `[BE]` Đổi vị trí Listing đang mở (chưa có giao dịch): lưu vị trí mới → tăng version Listing → chạy lại matching → vô hiệu hóa Estimated Quote không còn hợp lệ → cập nhật Partner/báo giá liên quan. Đã có giao dịch thì chỉ đổi khi **cả hai bên đồng ý**.
- [ ] **T2.6** `[BE]` Location Privacy: trước khi chọn Partner chỉ trả về khu vực tương đối + khoảng cách ước tính; địa chỉ chi tiết chỉ mở cho các bên trong giao dịch.
- [ ] **T2.7** `[FE]` Trang Saved Locations (thêm/sửa/xóa/đặt mặc định, chọn trên bản đồ).

#### Epic 3: Listing & Image Upload (§6, §18.3)
- [ ] **T3.1** `[BE][INFRA]` `POST /uploads/presign`: cấp S3 Presigned URL sau khi kiểm tra quyền; bucket private, Block Public Access; chỉ chấp nhận object trong phạm vi đã cấp, kiểm tra metadata.
- [ ] **T3.2** `[FE]` Upload ảnh: kiểm tra định dạng, dung lượng, số lượng, trạng thái upload; upload trực tiếp lên S3.
- [ ] **T3.3** `[BE]` `POST /listings`: xác thực → validate → xác minh địa điểm → tạo ID → lưu snapshot vị trí → lưu Listing → set `createdAt`, `priorityUntil = +24h`, `expiresAt = +7 ngày` → trạng thái `ACTIVE_PRIORITY` → kích hoạt matching.
- [ ] **T3.4** `[BE]` `GET /listings`, `GET /listings/{id}`, `PATCH /listings/{id}`, `POST /listings/{id}/cancel` (chỉ hủy khi chưa có giao dịch, §14.4).
- [ ] **T3.5** `[FE]` Luồng Create Listing: upload → AI → xác nhận thông tin (loại, hãng/model, tình trạng `Working/Partially Working/Not Working/Unknown`, số lượng, khối lượng, mô tả lỗi, địa điểm — mặc định chọn sẵn, hình thức bàn giao) → Preview → Đăng.
- [ ] **T3.6** `[FE]` Owner Dashboard (tổng tin, đang hoạt động, có báo giá, giao dịch đang làm/hoàn thành, tin hết hạn) + trang My Listings.

#### Epic 4: AI Analysis (§6.3, §18.4)
- [ ] **T4.1** `[BE]` `POST /ai/analyze`: gọi Bedrock với ảnh, nhận JSON gồm Device Category, Brand, Model, Visible Damage, Cosmetic Condition, Suggested Description, Possible Reuse Category.
- [ ] **T4.2** `[BE]` Prompt + validate schema output: chỉ nhận xét điều thấy được trên ảnh; **không** khẳng định máy chạy được/bo mạch tốt/pin còn dùng; giá trị không xác định → `Unknown`.
- [ ] **T4.3** `[BE][FE]` Xử lý lỗi Bedrock → cho Owner nhập thủ công (§23.1).

#### Epic 5: Matching Engine (§7, §18.5)
- [ ] **T5.1** `[BE]` Lọc Partner/chi nhánh: đã duyệt, tài khoản active, chi nhánh active, nhận loại thiết bị, nhận tình trạng, trong bán kính, hỗ trợ hình thức bàn giao, đạt số lượng/khối lượng tối thiểu.
- [ ] **T5.2** `[BE]` Mỗi chi nhánh được đánh giá riêng; lưu kết quả vào Matches; `GET /listings/{id}/matches`.
- [ ] **T5.3** `[BE]` Xếp hạng đơn giản (có thể dùng reputation để sắp xếp). Partner mới hiển thị **"Chưa đủ dữ liệu"**, không bị loại.
- [ ] **T5.4** `[BE]` Sau matching: kích hoạt Auto-Quote + tạo thông báo cho Partner.
- [ ] **T5.5** `[BE][FE]` Không có Partner phù hợp → thông báo cho Owner, **không tạo giá giả** (§23.2).

#### Epic 6: Partner Onboarding & Pricing Rules (§2.2, §5.3, §8, §16)
- [ ] **T6.1** `[BE]` `POST /partners/apply`, `GET /partners/me`: khai báo cơ sở kinh doanh, ≥1 chi nhánh để được duyệt.
- [ ] **T6.2** `[BE]` `POST /partners/branches`, `PATCH /partners/branches/{id}`: địa chỉ, tọa độ, bán kính phục vụ, loại thiết bị, hình thức bàn giao, trạng thái hoạt động/xác minh.
- [ ] **T6.3** `[BE]` `POST /pricing-rules`, `PATCH /pricing-rules/{id}`: Branch, Category, Brand/nhóm, Condition, Price Unit, khoảng giá, Min Quantity, Min Weight, Max Distance, Handover Method, Effective Period, Status. Bật/tắt rule.
- [ ] **T6.4** `[FE]` Partner Registration, Branch & Service Settings, Pricing Rules.
- [ ] **T6.5** `[FE]` Partner Dashboard overview: yêu cầu mới, yêu cầu xác nhận giá, báo giá đang hoạt động, giao dịch đang xử lý/hoàn thành, điểm đánh giá.

#### Epic 7: Auto-Quote Engine (§8, §18.6)
- [ ] **T7.1** `[BE]` Với mỗi Partner match: lấy rule phù hợp → kiểm tra điều kiện → tạo Estimated Quote (`ESTIMATED`) + lưu **Rule Snapshot**. Không có rule → không tạo giá, chuyển sang báo giá thủ công (§23.3).
- [ ] **T7.2** `[BE]` Sửa rule **không** làm đổi các quote đã tạo (giữ snapshot).
- [ ] **T7.3** `[FE]` Hiển thị rõ nhãn **"Giá dự kiến — Chưa được Partner xác nhận"**.

#### Epic 8: Offers & Quote Confirmation (§8.5, §9, §11, §18.7)
- [ ] **T8.1** `[BE]` `POST /quotes/{id}/request-confirmation` → `CONFIRMATION_REQUESTED`.
- [ ] **T8.2** `[BE]` Partner `POST /quotes/{id}/confirm` (giá cụ thể → `CONFIRMED_OFFER`), đề xuất giá khác, hoặc `POST /quotes/{id}/reject` → `REJECTED`.
- [ ] **T8.3** `[BE]` `POST /offers`: Partner gửi Manual Offer (giá, đơn vị, điều kiện, bàn giao, thời hạn, ghi chú) → validate → `CONFIRMED_OFFER`.
- [ ] **T8.4** `[BE]` Partner xem báo giá đã gửi, rút báo giá chưa được chọn (`WITHDRAWN`), báo giá hết hạn (`EXPIRED`). Báo giá đã `SELECTED` thì **không được sửa đơn phương**.
- [ ] **T8.5** `[FE]` Partner: trang Matching Requests (ảnh, loại, tình trạng, số lượng, khu vực, khoảng cách, bàn giao, thời hạn) + trang Offers.
- [ ] **T8.6** `[FE]` Owner: trang Listing Details & Offers — bảng so sánh (Partner, xác minh, khoảng cách, rating, số giao dịch hoàn thành, giá dự kiến/xác nhận, điều kiện, bàn giao, thời hạn). Chỉ nút "Chọn" trên Confirmed Offer còn hiệu lực.

#### Epic 9: Transaction Management (§12, §18.8)
- [ ] **T9.1** `[BE]` `POST /transactions` (chọn Partner): kiểm tra Owner sở hữu Listing, Listing hợp lệ, Offer thuộc Listing, đã xác nhận, chưa hết hạn, chưa có giao dịch active → dùng **DynamoDB TransactWriteItems / Conditional Writes** → tạo Transaction (`HANDOVER_PENDING`), quote → `SELECTED`, Listing → `MATCHED`. Hai request đồng thời: chỉ một thành công.
- [ ] **T9.2** `[BE]` Thỏa thuận bàn giao: hình thức (mang đến cửa hàng / Partner đến nhận / tự thỏa thuận), địa điểm, thời gian, liên hệ; mở địa chỉ chi tiết cho các bên có quyền.
- [ ] **T9.3** `[BE]` `POST /transactions/{id}/price-adjustment`: Partner đề nghị giá mới + lý do → `PRICE_ADJUSTMENT_PENDING` → Owner đồng ý/từ chối. **Không đổi giá cuối khi Owner chưa đồng ý.**
- [ ] **T9.4** `[BE]` `POST /transactions/{id}/confirm-handover` + `POST /transactions/{id}/complete`: cần **xác nhận từ cả 2 bên** → lưu giá cuối → Transaction & Listing → `COMPLETED` → mở quyền đánh giá.
- [ ] **T9.5** `[BE]` `POST /transactions/{id}/cancel` + ghi nhận thất bại (bên báo, lý do, thời gian, giá, trạng thái). Hai bên không thống nhất → `DISPUTED` để Admin xem. Listing còn hạn → mở lại cho Owner tìm Partner khác; quá hạn → không tự mở lại.
- [ ] **T9.6** `[BE]` Ghi TransactionEvents (lịch sử trạng thái & lịch sử thay đổi giá).
- [ ] **T9.7** `[FE]` Trang Transactions cho Owner và Partner.

#### Epic 10: Listing Lifecycle & Scheduling (§14, §15)
- [ ] **T10.1** `[INFRA][BE]` EventBridge Scheduler → Lifecycle Lambda: `ACTIVE_PRIORITY → ACTIVE_PUBLIC` sau 24h, `→ EXPIRED` sau 7 ngày nếu chưa chọn Partner.
- [ ] **T10.2** `[BE]` Lambda **kiểm tra trạng thái và thời hạn hiện tại trước khi cập nhật** — chạy trễ/chạy trùng không gây chuyển sai (§23.7).
- [ ] **T10.3** `[BE]` Giai đoạn Public mở rộng nhóm Partner nhưng **không vượt** giới hạn phục vụ Partner đã cấu hình.

#### Epic 11: Notification System (§10, §18.10)
- [ ] **T11.1** `[BE]` Lưu notification trong DynamoDB cho các sự kiện của Owner / Partner / Admin (danh sách ở §10.2).
- [ ] **T11.2** `[BE]` Xử lý sự kiện trùng, retry an toàn; thông báo **không** phải nguồn quyết định trạng thái.
- [ ] **T11.3** `[FE]` Polling theo chu kỳ hợp lý + UI thông báo.
- [ ] **T11.4** `[INFRA]` (Tùy chọn) Email/SNS cho sự kiện quan trọng.

### Phase 2 — Trust & Administration (§27)

#### Epic 12: Review & Reputation (§13, §18.9)
- [ ] **T12.1** `[BE]` `POST /transactions/{id}/reviews`: chỉ Owner của Transaction đã kết thúc; mỗi Transaction 1 review hiệu lực; không review từ Estimated Quote. Nhãn `VERIFIED_TRANSACTION` chỉ khi hoàn thành có xác nhận 2 bên; tách bạch review từ giao dịch thất bại.
- [ ] **T12.2** `[BE]` Form: rating 1–5, nhận xét, thái độ, đúng hẹn, giá cuối có khớp không, lý do không hài lòng.
- [ ] **T12.3** `[BE]` `POST /reviews/{id}/reply` (Partner phản hồi, không sửa được review), `POST /reviews/{id}/report`, `GET /partners/{id}/reviews`.
- [ ] **T12.4** `[BE]` Tính Reputation Metrics với **quy tắc tính rõ ràng**: Average Rating, Completion Rate, Cancellation Rate, Quote Accuracy, Price Reduction Rate, Verified Review Count. Không tính giao dịch đang diễn ra như thất bại.
- [ ] **T12.5** `[BE]` Suspicious Pricing: lưu giá ban đầu/xác nhận/cuối/lý do/kết quả; **đánh dấu** để Admin xem (vd. nhiều lần xác nhận cao rồi giảm mạnh) — không tự kết luận gian lận.
- [ ] **T12.6** `[FE]` Trang Reviews (Owner), Reviews & Reputation (Partner), hiển thị uy tín Partner ("Chưa đủ dữ liệu đánh giá" cho Partner mới).

#### Epic 13: Admin (§17, §18.11)
- [ ] **T13.1** `[BE]` `GET /admin/partners/pending`, `POST /admin/partners/{id}/approve|reject`, tạm ngừng Partner và Pricing Rule. API Admin được bảo vệ riêng.
- [ ] **T13.2** `[BE]` Kiểm duyệt tin (bị báo cáo, spam, nội dung không phù hợp) và đánh giá (vi phạm, giả, khiếu nại 2 phía).
- [ ] **T13.3** `[BE]` `GET /admin/reports`: giao dịch hoàn thành/thất bại/tranh chấp, điều chỉnh giá bất thường.
- [ ] **T13.4** `[BE]` `GET /admin/statistics`: tổng user/Partner/Listing, số Estimated Quote/Confirmed Offer, tỷ lệ tin có báo giá, thời gian đến báo giá đầu tiên, số giao dịch hoàn thành, tỷ lệ thất bại, rating trung bình.
- [ ] **T13.5** `[FE]` Admin Dashboard, Partner Approvals, Listings Management, Transactions & Reports, Reviews Moderation.
- [ ] **T13.6** `[BE][FE]` Owner báo cáo hành vi không phù hợp (entity Reports).

### Phase 3 — Cloud Engineering (§27)

- [ ] **T14.1 IaC hoàn chỉnh** `[INFRA]` — toàn bộ tài nguyên chính trong Terraform, tái triển khai được.
- [ ] **T14.2 CI/CD Pipeline** `[INFRA]` — build, test, deploy frontend + backend + infra.
- [ ] **T14.3 Monitoring** `[INFRA]` — CloudWatch logs, Lambda/API metrics, error monitoring, alarms, **custom business metrics**, dashboard; CloudTrail.
- [ ] **T14.4 Security** `[INFRA][BE]` (§22) — HTTPS, S3 Block Public Access, Presigned URL có hạn, IAM least privilege, WAF trên CloudFront, không log token, chính sách lưu trữ/xóa dữ liệu, giới hạn request nhạy cảm (throttling).
- [ ] **T14.5 Reliability** `[BE]` (§23) — idempotency key cho thao tác quan trọng, chống chọn báo giá đồng thời, chống review trùng, chống chuyển trạng thái không hợp lệ.
- [ ] **T14.6 Integration Tests** `[QA]` — luồng end-to-end §25 + kiểm tra phân quyền.
- [ ] **T14.7 Load Testing** `[QA]`.
- [ ] **T14.8 Cost Analysis & Optimization** `[INFRA]`.
- [ ] **T14.9 AWS Well-Architected Review** `[DOC]`.

### Phase 4 — Documentation & Workshop (§26, §27)

- [ ] **T15.1** Business Workflow Specification (đã có bản v1.0)
- [ ] **T15.2** AWS Architecture Diagram
- [ ] **T15.3** Data Model (DynamoDB vật lý + access patterns)
- [ ] **T15.4** API Contract (bản chốt)
- [ ] **T15.5** State Machine diagram
- [ ] **T15.6** Security Configuration, Monitoring Dashboard
- [ ] **T15.7** Bằng chứng: Integration Test Results, Load Test Results, Failure Handling Demonstration
- [ ] **T15.8** Cost Analysis, Well-Architected Review
- [ ] **T15.9** Deployment Workshop
- [ ] **T15.10** Final Project Report + chuẩn bị Demo (kịch bản §25)

---

## 5. State machines (§15)

**Listing:** `ACTIVE_PRIORITY → ACTIVE_PUBLIC` · `ACTIVE_* → MATCHED | EXPIRED | CANCELLED` · `MATCHED → COMPLETED` · (giao dịch thất bại + còn hạn → có thể mở lại)

**Quote:** `ESTIMATED`, `CONFIRMATION_REQUESTED`, `CONFIRMED_OFFER`, `REJECTED`, `WITHDRAWN`, `EXPIRED`, `SELECTED`

**Transaction:** `HANDOVER_PENDING`, `PRICE_ADJUSTMENT_PENDING`, `COMPLETED`, `FAILED`, `CANCELLED`, `DISPUTED`

Backend phải kiểm tra **cả** tính hợp lệ của chuyển trạng thái **và** quyền của người thực hiện.

## 6. Kịch bản demo (§25) — dùng làm acceptance test tổng

1. **Registration & Location** — Owner đăng nhập, thêm địa điểm Thủ Đức, xác nhận tọa độ, đặt mặc định.
2. **Listing & AI** — upload ảnh laptop Dell hỏng → Bedrock phân tích → Owner xác nhận "Not Working" → đăng tin.
3. **Matching & Auto-Quote** — tìm Partner, tính khoảng cách, Auto-Quote → Owner thấy giá dự kiến, Partner nhận thông báo.
4. **Offer Confirmation** — Owner yêu cầu Partner A xác nhận; Partner B gửi Manual Offer; so sánh.
5. **Transaction** — chọn Partner B (conditional write) → thống nhất bàn giao → kiểm tra → chốt giá → 2 bên xác nhận → hoàn tất.
6. **Review & Reputation** — Owner đánh giá, metrics cập nhật, Partner thấy review.
7. **Cloud Engineering** — Admin dashboard, CloudWatch, demo kiểm tra quyền, request trùng, 2 request chọn báo giá đồng thời, Listing tự hết hạn, load test, đánh giá chi phí & độ tin cậy.

## 7. Ngoài phạm vi MVP (§24)

WebSocket real-time · AI dự đoán giá · AI phát hiện gian lận · tối ưu tuyến đường · thanh toán trong app · tích hợp vận chuyển · hệ thống tranh chấp nâng cao · phân tích giá thị trường · app mobile native.

## 8. Điểm tài liệu chưa rõ — cần chốt trước khi code

Trong lúc đọc mình thấy một số chỗ spec chưa định nghĩa, nên thống nhất sớm:

1. **API còn thiếu trong §21** dù nghiệp vụ có nhắc đến:
   - Thông báo: `GET /notifications`, đánh dấu đã đọc.
   - Partner xem danh sách Listing phù hợp (Matching Requests), xem/rút báo giá đã gửi.
   - Owner đồng ý/từ chối điều chỉnh giá; báo giao dịch thất bại; cập nhật thỏa thuận bàn giao; danh sách giao dịch (`GET /transactions`).
   - Geocode địa chỉ (proxy tới Amazon Location Service).
   - Admin: tạm ngừng Partner/Rule, kiểm duyệt Listing/Review, Owner báo cáo vi phạm.
2. **Partner "đề xuất mức giá khác"** (§8.5) — chuyển sang trạng thái quote nào? Owner có cần chấp nhận lại không?
3. **Hoàn tất giao dịch**: `confirm-handover` và `complete` khác nhau thế nào; nếu một bên không bao giờ xác nhận thì có timeout không?
4. **Điều kiện mở lại Listing** sau giao dịch thất bại (§15.1) — trạng thái quay về `ACTIVE_PRIORITY` hay `ACTIVE_PUBLIC`? Các quote cũ xử lý ra sao?
5. **Giai đoạn `ACTIVE_PUBLIC`** "nhóm Partner rộng hơn" cụ thể là gì, khi vẫn phải tôn trọng bán kính phục vụ?
6. **Thời hạn của Estimated Quote / Offer** mặc định là bao lâu?
7. **Partner có đánh giá Owner không?** — spec chỉ mô tả chiều Owner → Partner.
8. **Công thức chính xác** của các Reputation Metrics (mẫu số, cửa sổ thời gian).
9. **Xác minh Partner**: Admin dựa vào giấy tờ gì? Có upload tài liệu không?
10. Giới hạn ảnh cụ thể (định dạng, dung lượng, số lượng), chu kỳ polling, model Bedrock dùng.
