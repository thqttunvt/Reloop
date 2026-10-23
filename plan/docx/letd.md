# ReLoop — Plan trang quản trị (Admin) mới: việc cần làm

> Viết 2026-10-22, nhánh `feature/doi-tac-2-cap`. Đây là file GIAO VIỆC: đọc xong thì làm theo mục 4 (thứ tự A0 → A6).
> **Đọc trước:** `plan/docx/let.md` (hiện trạng: kiến trúc, quyền Admin, 8 khối trang Admin cũ, toàn bộ API Admin, khóa DynamoDB, 7 nguyên tắc code bắt buộc), rồi `plan/docx/readmeall.md` (tiến độ). Thứ tự tin cậy: code > `plan/quyetdinh.txt` > tài liệu.
> **Trước khi làm:** hỏi Product Owner 4 điểm ở mục 5. Mỗi bước xong: cập nhật `plan/docx/readmeall.md` mục 6 / 7 / 9.


Nguyên tắc của plan: **dùng lại khóa đã có trước, chỉ thêm khóa khi không còn cách**; không Scan; không đổi luật nghiệp vụ trong QĐ; mỗi bước tự deploy được, không làm hỏng trang Admin cũ.

## 1. Những gì đã kiểm tra trên dữ liệu thật (2026-10-22)

- **Hồ sơ người dùng do Lambda đăng ký của nhóm tạo đã có sẵn GSI1:** `GSI1PK = ROLE#Owner`, `GSI1SK = USER#<sub>` (đọc 1 hồ sơ thật trên `reloop-core-table`). → Liệt kê **mọi người dùng** = Query GSI1 `ROLE#Owner`, **không cần khóa mới, không cần chạy bù**. Hồ sơ tạo bằng `UserService.getOrCreate` (dev local / smoke test) chưa có GSI1 này → sửa 1 chỗ cho đồng nhất (bước A2, mục 4).
- **`FEED#<tháng>`** có con trỏ của mọi tin từng lên Chợ (ghi khi đăng tin không bị gắn cờ và khi Admin duyệt tin). → Duyệt **tất cả tin theo tháng** dùng lại khóa này. Chỉ thiếu tin bị từ chối ngay khi đang chờ duyệt (không quan trọng cho Admin, đã có trong vi phạm `VIOL#`).
- **Transaction** chỉ có GSI1 khi DISPUTED (`TransactionService.mutate` xóa `gsi1pk` ở mọi trạng thái khác) → muốn lọc giao dịch theo trạng thái thì phải đổi (bước A3, mục 4).
- **Report** đã có GSI1 `REPORT#STATUS#RESOLVED` khi xử lý xong → lịch sử báo cáo chỉ cần thêm tham số API.
- **Không có nhật ký thao tác Admin** đọc được trên web (chỉ log CloudWatch) → cần 1 khóa mới (bước A5, mục 4). TL-04 cũng yêu cầu audit log cho thao tác tiền của Admin.

## 2. Khóa / GSI cần thêm

| # | Khóa | Ở đâu | Vì sao không dùng cái có sẵn | Chạy bù dữ liệu cũ? |
|---|---|---|---|---|
| K1 | **Transaction GSI1 luôn có**: `gsi1pk = TX#STATUS#<status>`, `gsi1sk = <createdAt>` | `TransactionService.select`, `chatDealOps`, `mutate` (thay đoạn "chỉ DISPUTED mới có gsi1") | Giao dịch chỉ tra được theo từng người (`USER#<id>` / `TX#`) | Tùy chọn: script 1 lần cho giao dịch cũ (dữ liệu dev là dữ liệu test) — **cần PO đồng ý** vì phải đọc toàn bảng 1 lần |
| K2 | **`AUDIT#<YYYY-MM>`**, sk `<at>#<id>`, gồm `{ adminId, method, path, params, note?, status }` | Ghi 1 chỗ trong router sau mỗi request `/admin/*` thành công (POST) + các GET xem dữ liệu cá nhân (xem chat, hồ sơ người dùng — NĐ 13/2023) | Chưa có gì tương tự | Không |
| K3 | (Đồng nhất) hồ sơ tạo bằng `getOrCreate` ghi thêm `gsi1pk = ROLE#Owner`, `gsi1sk = USER#<id>` | `UserService.getOrCreate` | Cho giống hồ sơ do Lambda đăng ký tạo | Không |

`listDisputed()` vẫn chạy y như cũ sau K1 (cùng `TX#STATUS#DISPUTED`). **Không thêm GSI2** — bảng do nhóm dựng tay trên Console, Terraform chỉ đọc (`data`).

Phân trang: `Table.query` không trả `LastEvaluatedKey` → dùng **cursor = sort key của dòng cuối** + `skRange` (giống `ListingService.feed`). Trên GSI, sort key là `gsi1sk`.

## 3. Route con (frontend) + API

Trang `/admin` thành **layout có menu bên trái** (badge số đếm lấy từ `GET /admin/stats`), mỗi mục là 1 route con, file riêng trong `frontend/src/pages/admin/`. Các khối cũ của `AdminPage.tsx` **chuyển nguyên** sang file riêng, không đổi logic.

| Route | Nội dung | API (★ = mới) | Quyền |
|---|---|---|---|
| `/admin` | → chuyển tới `/admin/overview` | | admin |
| `/admin/overview` | Ô số đếm hàng đợi (bấm vào → mục tương ứng) + số liệu tháng: giao dịch hoàn tất, phí đã lập, phí đã thu | `GET /admin/stats` ★ thêm `?month=` | admin |
| `/admin/listings/review` | Tin chờ duyệt (khối cũ) | có sẵn | admin |
| `/admin/reports` | Báo cáo chờ xử lý (khối cũ) + tab **Đã xử lý** | ★ `GET /admin/reports?status=RESOLVED&cursor=` | admin |
| `/admin/disputes` | Tranh chấp (khối cũ) + số ngày đã chờ (QĐ-08: 7 ngày) | có sẵn | admin |
| `/admin/risk-flags` | Người bị gắn cờ (khối cũ) | có sẵn | admin |
| `/admin/partners` | Duyệt / tạm ngừng đối tác (khối cũ), giữ `?status=` trên URL | có sẵn | admin |
| `/admin/finance/invoices` | Hóa đơn (khối cũ), `?status=` | có sẵn | xem: admin · thao tác: admin_finance |
| `/admin/finance/appeals` | Khiếu nại phí (khối cũ) | có sẵn | xem: admin · thao tác: admin_finance |
| `/admin/users` | Danh sách người dùng + ô tìm theo email | ★ `GET /admin/users?email=&cursor=` (Query GSI1 `ROLE#Owner`, lọc email khi đọc) | admin |
| `/admin/users/:id` | **Hồ sơ gộp 1 người**: hồ sơ, đối tác (cấp, trạng thái, VIP), tin, giao dịch, hóa đơn + dòng phí, vi phạm 30 ngày, cờ rủi ro; nút Tạm ngừng / Mở lại dùng API có sẵn | ★ `GET /admin/users/{id}` (gộp từ `USER#<id>`, `PARTNER#<id>`, GSI1 `OWNER#<id>`, `RISK#<id>` — không khóa mới) | admin; ghi K2 |
| `/admin/transactions` | Giao dịch theo trạng thái | ★ `GET /admin/transactions?status=&cursor=` (K1) | admin |
| `/admin/listings` | Tin theo tháng + lọc trạng thái | ★ `GET /admin/listings?month=&status=&cursor=` (`FEED#<tháng>`) | admin |
| `/admin/audit` | Nhật ký thao tác Admin theo tháng | ★ `GET /admin/audit?month=&cursor=` (K2) | admin |

Giữ nguyên: link `/transactions/:id` (Admin đã xem được mọi giao dịch + thẻ chat), chuông hộp thư chung Admin.

Giới hạn cố ý: tìm người dùng **theo email đúng / chứa chuỗi** bằng cách lọc khi đọc GSI1 — đủ cho vài nghìn người dùng. Tìm theo tên / vượt quy mô đó → cần thêm khóa `EMAIL#<email>` hoặc OpenSearch (để sau).

## 4. Thứ tự làm

Mỗi bước: code + test vitest + `npm run typecheck` + deploy dev + `smoke-aws.py` pass + cập nhật `plan/docx/readmeall.md` mục 6/7/9.

| Bước | Việc | Backend | Frontend | Xong khi |
|---|---|---|---|---|
| **A0** | Tách trang thành layout + route con, chuyển 8 khối cũ sang file riêng, badge số đếm | — | `pages/admin/*`, `App.tsx` route `/admin/*` | Mọi chức năng cũ chạy y như trước, mỗi mục có URL riêng |
| **A1** | Lịch sử báo cáo đã xử lý | `GET /admin/reports?status=` (GSI có sẵn) | tab Đã xử lý | Thấy báo cáo cũ kèm kết luận, người xử lý |
| **A2** | Người dùng + hồ sơ gộp | K3; `GET /admin/users`, `GET /admin/users/{id}` | `/admin/users`, `/admin/users/:id`; link tên người ở các mục khác → hồ sơ gộp | Tìm được người theo email, xem đủ lịch sử 1 người |
| **A3** | Giao dịch theo trạng thái | K1; `GET /admin/transactions`; test `listDisputed` vẫn đúng | `/admin/transactions` | Lọc được giao dịch mới theo trạng thái (cũ: tùy script bù) |
| **A4** | Tin theo tháng | `GET /admin/listings` (`FEED#`) | `/admin/listings` | Xem mọi tin của 1 tháng, lọc trạng thái, gỡ tin vi phạm bằng luồng có sẵn |
| **A5** | Nhật ký Admin | K2: ghi trong `createApiHandler` (1 chỗ); `GET /admin/audit` | `/admin/audit` | Mọi thao tác Admin + lần xem chat / hồ sơ người dùng đều có dòng nhật ký |
| **A6** | Số liệu kinh doanh tháng | `/admin/stats?month=`: đếm từ `FEEMONTH#<tháng>` + dòng phí + hóa đơn PAID (đọc khi cần, không bộ đếm mới) | ô số liệu ở Tổng quan | Thấy số giao dịch hoàn tất, phí lập / thu của tháng |

A0 làm trước vì chỉ đụng frontend và mở chỗ cho các bước sau; A1 nhỏ nhất; A2 giá trị cao nhất cho Admin; A5 nên làm trước khi có thêm người làm Admin.

## 5. Cần Product Owner quyết trước khi làm

1. **Script bù GSI1 cho giao dịch cũ (K1)**: chạy 1 lần, đọc toàn bảng → ngoại lệ của luật "không Scan". Hay chỉ hiện giao dịch từ lúc deploy A3?
2. **Nhật ký Admin giữ bao lâu** (QĐ-27 chưa có mục này) — đề xuất giữ lâu dài như hóa đơn.
3. **Cấp / gỡ quyền Admin từ web**: hiện chỉ qua `scripts/make-admin.sh`. Làm trên web cần cho Lambda quyền `cognito-idp:AdminAddUserToGroup` — rủi ro bảo mật; đề xuất **để ngoài plan này**.
4. Upload bằng chứng tranh chấp (task B3 cũ), xuất CSV, tìm theo tên: **để sau**, không nằm trong A0–A6.
