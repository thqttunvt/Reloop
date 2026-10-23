# ReLoop — tóm tắt để lên plan trang quản trị (Admin)

> Cập nhật 2026-10-22, đối chiếu với code nhánh `feature/doi-tac-2-cap` (commit `6202d98`, đã deploy dev).
> Plan trang Admin mới (route con, khóa cần thêm, thứ tự làm): `plan/docx/letd.md`.
> Nguồn chi tiết: `plan/docx/readmeall.md` (tiến độ), `plan/quyetdinh.txt` (43 quyết định), `plan/devdocx.txt` mục 9 (tra cứu kỹ thuật).
> Thứ tự tin cậy: **code > quyetdinh.txt > devdocx.txt > tài liệu khác**.

## 1. Dự án

ReLoop là chợ trung gian đồ điện tử cũ / hỏng. Người bán là **đối tác đã được Admin duyệt**: cấp 1 (khách lẻ) hoặc cấp 2 (doanh nghiệp / hộ kinh doanh, có chi nhánh + bảng giá, nhận tin phù hợp để báo giá). Người mua: đối tác cấp 2 (báo giá) hoặc bất kỳ ai đã đăng nhập (ra giá trong chat).

- Tiền **không qua ReLoop**: hai bên trả trực tiếp khi bàn giao. ReLoop thu **10.000đ / giao dịch hoàn tất** từ người bán, gom **hóa đơn tháng** (ngày 1, hạn 7 ngày, mã chuyển khoản `RLFxxxxxx`), Admin tài chính bấm "Đã thu".
- Ví nội bộ / giữ tiền / nạp rút: **tạm ngưng** — code backend còn, website đã bỏ trang Ví (2026-10-22). Không đưa vào trang Admin.
- Thực tập AWS Cloud Engineering, ~12 tuần từ 2026-10-10, ngân sách 20–50 USD/tháng.

## 2. Kiến trúc

| Phần | Công nghệ |
|---|---|
| Backend | TypeScript, **1 Lambda** `reloop-dev-api` sau API Gateway HTTP API (JWT Cognito). Cùng Lambda chạy worker AI (tự gọi async) và job định kỳ EventBridge 15 phút |
| Dữ liệu | DynamoDB single-table `reloop-core-table` (PK/SK + GSI1), khóa tập trung ở `backend/src/store/keys.ts` |
| Frontend | React + Vite, S3 + CloudFront (`https://d1cjl1tvcp0r6q.cloudfront.net`), polling (thông báo 30s, chat 5s) |
| Đăng nhập | Cognito `reloop-dev-user-pool`, Managed Login v2 (username + mật khẩu cùng 1 trang, có nút hiện mật khẩu); trang `/forgot-password` riêng theo email |
| AI / kiểm duyệt | Bedrock Amazon Nova Pro (+ Gemini dự phòng, chưa có key), Rekognition (ảnh nhạy cảm, đọc chữ), Bedrock Guardrail |
| Hạ tầng | Terraform `infra/`, deploy `AWS_PROFILE=reloop bash infra/deploy.sh` (hoặc `... deploy.sh frontend`) |
| Giám sát | CloudWatch dashboard `reloop-dev-overview`, alarm → SNS `reloop-dev-alarms` (email Admin đăng ký qua `scripts/make-admin.sh`) |

Adapter theo môi trường (chạy local không cần AWS): `Table`, `AuthProvider`, `ImageStore`, `ImageModerator`, `TextScreener`, `Analyzer`. Local đăng nhập giả bằng header `x-dev-user` / `x-dev-groups` (có sẵn preset "Admin").

### Nguyên tắc code bắt buộc (trang Admin cũng phải theo)

1. Đổi trạng thái qua `backend/src/domain/stateMachines.ts` (Listing, Quote, Transaction) — Admin là actor `ADMIN`.
2. Ghi có điều kiện `version` + `withOptimisticRetry`.
3. **Không Scan DynamoDB.** Muốn liệt kê → phải có khóa / GSI1 cho truy vấn đó (xem mục 5).
4. Việc nền idempotent. Nghiệp vụ không gọi AWS SDK trực tiếp (qua adapter).
5. API tạo dữ liệu quan trọng / tính tiền bắt buộc header `Idempotency-Key`.
6. Tiền là số nguyên VND; phí ghi qua `BillingService` cùng transaction với đổi trạng thái.
7. Không trả `pk/sk/gsi1pk/gsi1sk` ra API (router tự lọc).

## 3. Phân quyền Admin

- Cognito group **`Admins`** → quyền `admin` (xem + xử lý vận hành).
- Cognito group **`FinanceAdmins`** → quyền `admin_finance` (thao tác tiền: Đã thu, Lập hóa đơn, Miễn / Giữ phí).
- Backend kiểm bằng `requireGroup(principal, 'admin' | 'admin_finance')` trong `backend/src/http/routes.ts`.
- Cấp quyền: `AWS_PROFILE=reloop bash scripts/make-admin.sh <email> [--finance]` (người được cấp đăng xuất / đăng nhập lại). Không có API cấp quyền Admin.
- Route `/admin/*` **không** bị khóa bởi nợ phí (QĐ-40).
- Frontend: menu "Admin" hiện khi session có `admin` hoặc `admin_finance`; nút tiền chỉ bấm được khi có `admin_finance`, người khác thấy ghi chú.

## 4. Trang Admin hiện tại

**Một trang dài duy nhất** `frontend/src/pages/AdminPage.tsx` (~32 KB), route `/admin`, xếp dọc 8 khối, không tab / không route con / không phân trang:

| Thứ tự | Khối | Làm được gì |
|---|---|---|
| 1 | Tổng quan | Số đối tác theo trạng thái, tranh chấp mở, báo cáo mở, tin chờ duyệt, cờ rủi ro, khiếu nại phí |
| 2 | Tin chờ duyệt (ảnh bị gắn cờ) | Xem ảnh + chữ đọc được + người đăng; Duyệt / Từ chối (bắt buộc lý do, có lý do soạn sẵn) |
| 3 | Hóa đơn phí dịch vụ | Lọc ISSUED / PAID, đánh dấu quá hạn; "Đã thu" (finance); lập hóa đơn tay theo tháng (finance) |
| 4 | Khiếu nại phí nghi bán ngoài | Xem lý do; Miễn / Giữ phí (finance), trả `refundDue` nếu hóa đơn đã thu |
| 5 | Người dùng bị gắn cờ | Lý do (cùng người mua hủy ≥ 2, hủy rồi gỡ tin ≥ 3, vi phạm ≥ 5 / 30 ngày) + lịch sử; Bỏ qua / Cảnh cáo / Tạm ngừng |
| 6 | Duyệt đối tác | Lọc PENDING / APPROVED / REJECTED / SUSPENDED; Duyệt / Từ chối (cấp 2 cần ≥ 1 chi nhánh); Tạm ngừng / Mở lại |
| 7 | Tranh chấp | Kết luận Hoàn tất (nhập giá cuối) / Thất bại, bắt buộc ghi chú; link sang giao dịch (trang giao dịch có thẻ Admin xem chat) |
| 8 | Báo cáo vi phạm | Kèm thứ bị báo cáo + người vi phạm + số vi phạm 30 ngày; Bỏ qua / Cảnh cáo / Gỡ tin + cảnh cáo / Gỡ tin + tạm ngừng / Tạm ngừng; lý do soạn sẵn; tạm ngừng bắt buộc lý do + hỏi lại |

Ngoài trang: **chuông thông báo** có hộp thư chung Admin (`ADMINS`, một người đọc = cả nhóm đã đọc) — hiện báo tranh chấp mới; email qua CloudWatch alarm `reloop-dev-dispute-opened`.

## 5. API Admin đang có (`backend/src/http/routes.ts`)

| Method | Path | Quyền | Ghi chú |
|---|---|---|---|
| GET | `/admin/stats` | admin | Đếm theo các hàng đợi (không Scan) |
| GET | `/admin/partners?status=` | admin | PENDING (mặc định) / APPROVED / REJECTED / SUSPENDED, kèm người đăng ký + chi nhánh |
| POST | `/admin/partners/{id}/review` | admin | `{ approve, note? }` |
| POST | `/admin/partners/{id}/suspend` | admin | `{ note }` bắt buộc ≥ 5 ký tự (2026-10-24) |
| POST | `/admin/partners/{id}/reactivate` | admin | |
| GET | `/admin/invoices?status=` | admin | ISSUED (mặc định) / PAID, kèm tên đối tác |
| POST | `/admin/invoices/{userId}/{month}/paid` | **admin_finance** | `{ note? }` |
| POST | `/admin/billing/issue` | **admin_finance** | `{ month: 'YYYY-MM' }` tháng đã kết thúc, idempotent |
| GET | `/admin/notifications` · `/unread-count` | admin | Hộp thư chung Admin |
| POST | `/admin/notifications/read-all` · `/{id}/read` | admin | |
| GET | `/admin/listings/{id}/chats` | admin | Đọc mọi chat của 1 tin (chỉ đọc, ghi log `admin_chat_viewed`) |
| GET | `/admin/fee-appeals` | admin | Khiếu nại phí đang mở |
| POST | `/admin/fee-appeals/{userId}/{month}/{transactionId}/resolve` | **admin_finance** | `{ waive, note? }` |
| GET | `/admin/risk-flags` | admin | Cờ đang mở + lịch sử 30 ngày |
| POST | `/admin/risk-flags/{userId}/resolve` | admin | `{ action: DISMISS/WARN/SUSPEND, note? }` |
| GET | `/admin/listings/review` | admin | Tin PENDING_REVIEW (tối đa 100) |
| POST | `/admin/listings/{id}/review` | admin | `{ approve, note }` — từ chối bắt buộc note |
| GET | `/admin/reports` | admin | Báo cáo mở kèm chi tiết |
| POST | `/admin/reports/{id}/resolve` | admin | `{ action, note? }` (5 mức, xem mục 4) |
| GET | `/admin/disputes` | admin | Giao dịch DISPUTED |
| POST | `/admin/transactions/{id}/resolve` | admin | `{ outcome: COMPLETED/FAILED, finalPrice?, note }` |
| GET | `/transactions/{id}` | admin xem được mọi giao dịch | `role: 'ADMIN'` khi không phải 1 trong 2 bên |
| GET | `/admin/reports?status=OPEN|RESOLVED&cursor=` | admin | RESOLVED: lịch sử phân trang (2026-10-22) |
| GET | `/admin/audit?month=&cursor=` | admin | Nhật ký thao tác Admin (tháng giờ VN) |
| GET | `/admin/users?cursor=` · `?email=` | admin | Thành viên (GSI1 `ROLE#Owner`) / tìm email |
| GET | `/admin/users/{id}` | admin, ghi nhật ký `pii-read` | Hồ sơ gộp 1 người |
| GET | `/admin/transactions?status=&cursor=` | admin | Giao dịch theo trạng thái (GSI1 `TX#STATUS#`) |
| GET | `/admin/listings?month=&status=&cursor=` | admin | Tin theo tháng UTC (`FEED#`) |
| GET | `/admin/stats?month=` | admin | Không có `month` → chỉ đếm badge (2026-10-24). Có `month`: giao dịch hoàn tất, phí phát sinh / lập / thu, VIP 1 đã thu |
| GET | `/admin/listings/{id}` | admin, ghi nhật ký `pii-read` | Xem 1 tin mọi trạng thái, có vị trí chính xác (2026-10-24) |
| GET | `/admin/vip-requests?status=` | admin | Yêu cầu VIP 1 (QĐ-44) |
| POST | `/admin/vip-requests/{userId}/{id}/invoice` · `/approve` · `/reject` | **admin_finance** | Gửi hóa đơn RLV… / xác nhận đã thu → bật gói / từ chối (`note` ≥ 5 ký tự) |

### Hàng đợi / truy vấn có sẵn (không Scan)

- GSI1 theo trạng thái `<ENTITY>#STATUS#<status>`: `PARTNER`, `INVOICE`, `REPORT`, `RISK`, `FEEAPPEAL`, `TX#STATUS#DISPUTED`.
- `REVIEWQ#LISTING` (tin chờ duyệt), `FEEMONTH#<tháng>` (người có phí trong tháng), `FEED#<tháng>` (con trỏ bảng tin), `AILABEL#<tháng>` (bộ dữ liệu nhãn AI), `TIMER#<giờ>` (job nền).
- Theo người: `USER#<id>` chứa hồ sơ, giao dịch (`TX#`), hóa đơn (`INVOICE#`), dòng phí (`FEE#`), vi phạm (`VIOL#`), hủy giao dịch (`DEALEND#`), nghi vấn (`SUSPECT#`), thông báo (`NOTIF#`), chat (`CONV#`).
- GSI1 `OWNER#<id>` → tin của một người bán.

**Chưa có khóa để liệt kê** (muốn làm trên trang Admin thì phải thêm khóa / GSI, không Scan): danh sách **tất cả người dùng**, tìm người dùng theo email / tên, **tất cả tin** theo trạng thái (ngoài chờ duyệt / bảng tin 7 ngày), **tất cả giao dịch** theo trạng thái (ngoài DISPUTED), báo cáo đã xử lý theo thời gian (có GSI `REPORT#STATUS#RESOLVED` nhưng chưa có API), nhật ký thao tác Admin (hiện chỉ có log CloudWatch).

## 6. Hạn chế đang thấy ở trang Admin (đầu vào cho plan)

- Mọi thứ trên 1 trang, tải 8 khối cùng lúc; không tab, không link trực tiếp tới từng khối.
- Không phân trang; vài API giới hạn cứng (tin chờ duyệt 100, thông báo 50).
- Không tra cứu người dùng / tin / giao dịch bất kỳ; Admin chỉ thấy những gì đang nằm trong hàng đợi.
- Không có trang hồ sơ một người dùng gộp: đối tác, tin, giao dịch, hóa đơn, vi phạm, cờ.
- Không có lịch sử quyết định của Admin để xem lại (ai duyệt / gỡ / tạm ngừng lúc nào) ngoài trường `reviewedBy`, `resolution.by` lưu trên từng bản ghi.
- Tổng quan chỉ là số đếm hàng đợi; chưa có số liệu kinh doanh (giao dịch hoàn tất, phí đã thu theo tháng…).
- Tranh chấp chưa có upload bằng chứng (B3).
- Không cấp / gỡ quyền Admin từ web (chỉ qua script).

## 7. Việc mới làm trong phiên 2026-10-22 (đã deploy dev)

- AI tiếng Việt: prompt có bảng từ vựng + 2 trường suy luận (`observedTextAndLabels`, `identifiedComponents`), tự sửa chữ sai đã biết; Gemini `gemini-2.5-flash` dùng trước, lỗi / 429 → Nova Pro (log `ai_fallback`, metric `AiFallbacks`). **Chưa có Gemini key** → đang chỉ dùng Nova Pro. Chưa thử trên ảnh thật.
- Kiểm tra chữ trong ảnh: bắt câu lệnh tiếng Việt bị mất dấu trước khi gọi Guardrail.
- Bỏ trang Ví khỏi website.
- Đăng nhập: Managed Login v2, username + mật khẩu 1 trang, nút hiện mật khẩu; sai username hay mật khẩu đều báo chung (không lộ tài khoản); trang `/forgot-password` nhập email → Lấy mã → đổi mật khẩu.
- Chat ra giá: nhập theo nghìn đồng (50 → 50.000đ), dòng xem trước, nút giá gợi ý.
- 151 test backend pass; smoke-aws.py ALL PASS.

## 8. Còn mở / rủi ro liên quan

- Lỗi 12 (`danhgia.txt`): lượt AI tính theo ngày UTC, hóa đơn theo giờ VN.
- Chưa làm: matching chạy nền, upload bằng chứng tranh chấp, sửa / phản hồi đánh giá, ảnh giấy tờ đối tác, lọc / tìm kiếm Chợ, AWS Budgets, CI/CD tự deploy, prod, WAF.
- Email Cognito mặc định tối đa ~50 / ngày.
- Nếu bật Gemini: ảnh người dùng gửi sang Google (gói free có thể dùng dữ liệu) → cần cập nhật điều khoản.
- Pháp lý: nối lại ví cần giấy phép NHNN; dữ liệu cá nhân theo NĐ 13/2023 — trang Admin xem chat / thông tin liên hệ cần ghi log ai xem.

## 9. File cần đọc khi làm trang Admin

- `frontend/src/pages/AdminPage.tsx`, `frontend/src/lib/api.ts`, `frontend/src/lib/catalog.ts`, `frontend/src/App.tsx`
- `backend/src/http/routes.ts` (khối Admin cuối file), `backend/src/store/keys.ts`, `backend/src/domain/stateMachines.ts`
- Service theo khối: `modules/partners`, `modules/billing`, `modules/reports`, `modules/risk`, `modules/listings` (duyệt tin, gỡ tin), `modules/transactions` (tranh chấp), `modules/chat` (Admin xem chat), `modules/notifications` (hộp thư Admin)
- Test mẫu: `backend/test/violations.test.ts`, `billing.test.ts`, `feeEvasion.test.ts`, `adminChat.test.ts`

