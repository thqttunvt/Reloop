# ReLoop — Plan trang Admin mới (bản senior, đã đối chiếu code)

> Viết 2026-10-22 trên nhánh `feature/doi-tac-2-cap` (HEAD `4b1fdd1`). Plan gốc: `plan/docx/letd.md`. File này **giữ nguyên hướng của letd.md** và bổ sung những điểm phát hiện khi đọc code thật. Nếu file này khác letd.md thì **làm theo file này**.
> Đọc trước khi làm: `plan/docx/let.md` (hiện trạng + 7 nguyên tắc code), `plan/docx/readmeall.md`. Thứ tự tin cậy: code > `plan/quyetdinh.txt` > tài liệu.
> Tiến độ thực hiện ghi ở `plan/docx/readmeall.md` mục 9.

---

## 0. Bảy điểm sửa so với letd.md (đã kiểm tra trong code)

| # | Plan cũ nói | Code thật | Cách xử lý trong plan này |
|---|---|---|---|
| S1 | Phân trang bằng "cursor = sort key dòng cuối + `skRange`" | `Table.query` chỉ trả mảng, không trả `LastEvaluatedKey`. `skRange` **gồm cả 2 đầu**. Sort key không duy nhất làm cursor sẽ lặp hoặc mất dòng. | **1 helper dùng chung** `pageQuery` (mục 2.1); mọi sort key mới **duy nhất** (`<thời điểm>#<id>`). |
| S2 | K1: `gsi1sk = <createdAt>` | Giao dịch được tạo ở **2 chỗ**: `select` và `chatDealOps`. `mutate` xoá GSI1 ở mọi trạng thái ≠ DISPUTED. | GSI1 ở **cả 2 chỗ tạo** và trong `mutate`, `gsi1sk = <createdAt>#<transactionId>`. Tranh chấp: "đã chờ X ngày" từ `tx.dispute.at`, sắp xếp ở client. |
| S3 | Tin theo tháng dùng `FEED#<tháng>` | `FEED#` ghi theo **tháng UTC**; item FEED chỉ có `listingId`; store không có `batchGet`. | Giữ cách ghi FEED. API ghi rõ "tháng UTC". Đọc từng listing theo lô rồi lọc; đọc tiếp tới khi đủ hoặc chạm trần. |
| S4 | Báo cáo đã xử lý: chỉ thêm tham số API | `REPORT#STATUS#RESOLVED` có `gsi1sk = report.createdAt` → sắp theo **ngày tạo**. | UI hiện thêm cột `resolution.at`. |
| S5 | Liệt kê user qua GSI1 `ROLE#Owner` | Thứ tự **theo sub (ngẫu nhiên)**. `getOrCreate` tạo hồ sơ không có GSI1. | K3. UI không hứa "mới nhất trước". Tìm email = đọc hết partition rồi lọc, có trần. |
| S6 | K2: ghi 1 chỗ trong router | Router có chính sách **không log body**. | Audit **theo cờ trên route**, chỉ field trong danh sách cho phép, không ghi body thô. |
| S7 | Thứ tự A0 → A6 | A2 là trang xem dữ liệu cá nhân (NĐ 13/2023), cần log lượt xem. | **A5 trước A2.** Thứ tự: A0 → A1 → A5 → A2 → A3 → A4 → A6. |

## 1. Nguyên tắc riêng (cộng 7 nguyên tắc ở let.md)

1. **Không chép code giữa các trang Admin.** Mọi danh sách mới dùng chung `pageQuery` (backend) + `usePagedList` / `<PagedTable>` (frontend).
2. Mỗi bước deploy độc lập, không làm hỏng trang Admin cũ.
3. Không GSI2, không Scan, không đổi luật nghiệp vụ trong QĐ.
4. Tháng dùng `vnMonth` cho mọi thứ mới (audit, số liệu). Ngoại lệ: FEED (tháng UTC).

## 2. Hai mảnh dùng chung

### 2.1 `pageQuery` — `backend/src/store/paging.ts` (viết ở A1)
- `pageQuery<T>(table, pk, { index?, limit = 20, cursor?, idOf, skOf }) → { items, nextCursor? }`; cursor = base64url(JSON `{ sk, id }`), opaque.
- Giảm dần: `skRange: { to: cursor.sk }`, `limit + 1`, bỏ dòng trùng cursor, `nextCursor` từ dòng cuối khi còn.
- Cursor hỏng → `400 INVALID_CURSOR`. Test trên MemoryTable: không lặp / mất dòng khi trùng thời điểm, cursor hỏng, trang cuối.

### 2.2 Audit (viết ở A5)
- `Route.audit?: 'write' | 'pii-read'`. Mọi `POST /admin/*` → `write`. `GET /admin/users/{id}`, `GET /admin/listings/{id}/chats` → `pii-read`. `GET /transactions/{id}`: handler trả `result.audit = 'pii-read'` khi Admin không thuộc 2 bên.
- Router ghi `putNew` sau khi thành công (`status < 400`): `pk = AUDIT#<vnMonth>`, `sk = <ISO>#<id>`, `{ adminId, groups, method, routePath, params, query, fields, status, at, kind }`; `fields` chỉ gồm `approve, note, action, outcome, finalPrice, waive, month, status`. **Không ghi body thô. Không TTL.**
- Ghi audit lỗi → không đổi response; `log('error', 'audit_write_failed')` + metric `AuditWriteFailed` + alarm SNS.
- Khoá trong `store/keys.ts` (`audit`, `auditPk`).

## 3. Các bước (mỗi bước: code + vitest + typecheck + deploy dev + smoke + cập nhật readmeall)

- **A0** — Layout `/admin/*` riêng (`AdminLayout`, `<Outlet>`), 8 khối cũ chuyển sang `pages/admin/` không đổi logic, badge từ 1 lần gọi `/admin/stats`, `?status=` trên URL (partners, invoices). Xoá `AdminPage.tsx`.
- **A1** — `pageQuery` + `GET /admin/reports?status=OPEN|RESOLVED&cursor=`; `usePagedList` + `<PagedTable>`; tab "Đã xử lý" có kết luận, `resolution.by`, `resolution.at`.
- **A5** — Audit (2.2) + `GET /admin/audit?month=&cursor=` + trang `/admin/audit`. Test: POST thành công có 1 dòng, 4xx không có, body nhạy cảm không bị ghi, lỗi ghi audit vẫn 200.
- **A2** — K3 (`getOrCreate` ghi `ROLE#Owner`). `GET /admin/users?cursor=` (pageQuery), `GET /admin/users?email=` (đọc hết, lọc includes, tối đa 50, comment shortcut), `GET /admin/users/{id}` (`pii-read`; gộp `USER#<id>`, `PARTNER#<id>`, GSI1 `OWNER#<id>`, `RISK#<id>`; mỗi nhóm có giới hạn + `hasMore`; không trả chat). Frontend `/admin/users`, `/admin/users/:id`; tên người ở các trang Admin thành link.
- **A3** — `txStatusIndex(tx)` trong `keys.ts`, gọi ở `select`, `chatDealOps`, `mutate`. `GET /admin/transactions?status=&cursor=`. Không bù dữ liệu cũ. Trang `/admin/transactions`.
- **A4** — `GET /admin/listings?month=&status=&cursor=` trên `FEED#<month>` (tháng UTC), lô 50, bỏ trùng, trần 500 con trỏ / request. Trang `/admin/listings`.
- **A6** — `GET /admin/stats?month=` thêm `completedTransactions`, `feesIssued`, `feesPaid` (đọc `FEEMONTH#` + `FEE#` + hoá đơn PAID). Ghi chú: > ~1.000 người có phí / tháng thì chuyển bộ đếm `STATS#<month>`.

## 4. Ngoài phạm vi
Cấp / gỡ quyền Admin trên web; bằng chứng tranh chấp (B3 cũ); xuất CSV; tìm theo tên; `EMAIL#` / OpenSearch; bộ đếm `STATS#`.

## 5. Quyết định PO (ĐÃ CHỐT 2026-10-22)
1. **Không** chạy script bù GSI1 giao dịch cũ; không Scan, không ngoại lệ.
2. Nhật ký Admin **giữ lâu dài, không TTL**; QĐ-27 thêm dòng này.
3. Cấp / gỡ quyền Admin trên web: ngoài plan (`scripts/make-admin.sh`).
4. Bằng chứng tranh chấp, CSV, tìm theo tên: để sau.
5. Tab "đã xử lý" giữ thứ tự ngày tạo, hiện thêm ngày xử lý.
6. Tin theo tháng chấp nhận tháng UTC, UI ghi chú.

## 5b. Định hướng sản phẩm (PO, 2026-10-22)

**B1. Nhãn vai trò** (suy ra, không lưu DB) — 1 hàm `roleLabel(partner, groups, now)` ở `frontend/src/lib/`:
Admin (group `admin` / `admin_finance`) · **PN1** (đối tác `APPROVED`, tier `INDIVIDUAL`, 3 tin) · **PN1V** (PN1 có VIP 1 còn hạn, 5 tin) · **PN2** (`BUSINESS`, 10 tin, không VIP) · Khách hàng (không nhãn). Hồ sơ cũ không có `tier` = cấp 2.

**B2. Menu người dùng theo vai trò** (chỉ frontend):
Khách hàng: `Chợ` · `Tin nhắn` · `Làm đối tác`. PN1 / PN2: `Chợ` · `Tin nhắn` · nút `Cấp 1` / `Cấp 2` (hiện PN1 / PN1V / PN2) → `/partner` (trong đó có Đăng tin, Tin của tôi, chi nhánh, bảng giá, phí / VIP). `Giao dịch`, `Hồ sơ`, `Đăng xuất` vào menu thả xuống dưới tên người dùng; khách vẫn vào được Giao dịch. Không xoá route nào.

**B3. Trang Admin tách riêng**: `/admin/*` layout riêng, không thanh menu người dùng, có link "Về trang người dùng". Cùng app, cùng domain. Menu:
Dashboard (A0, A6) · Hồ sơ (của chính Admin: `GET /me` + session) · Đối tác (+ tab Cờ rủi ro) · Giao dịch (+ tab Tranh chấp; A3) · Lịch sử (nhật ký Admin + phản ánh đã xử lý; A5, A1) · Thành viên (A2) · Ngân hàng (hoá đơn + khiếu nại phí) · Bài viết (tin chờ duyệt, tin theo tháng A4, phản ánh đang mở).
**Đổi chữ "Báo cáo" thành "Phản ánh"** ở `ReportButton.tsx` và trang Admin (chỉ nhãn; không đổi API / entity `REPORT`).

**B4. Đăng nhập Google — TẠM HOÃN.** Khi làm: `aws_cognito_identity_provider` Google, `supported_identity_providers = ["COGNITO", "Google"]` ở 2 client, secret qua `TF_VAR_...`; kiểm tra post_confirmation chạy với Google (nếu không: `getOrCreate` + K3 vẫn an toàn → làm A2 trước); trùng email → trigger `pre_sign_up` + `AdminLinkProviderForUser`, không làm thì không bật trên dữ liệu thật.

**B5. Logo mới** — chờ PO gửi file SVG; thay `<strong className="brand">` + favicon.

**B6. Test lại sau khi kết thúc giao dịch** (sau A3): hoàn tất → `FEE#`, `FEEMONTH#`, hoá đơn lập tay, thông báo, đánh giá; nhánh huỷ, thất bại, tranh chấp → Admin kết luận (GSI1 `TX#STATUS#` đổi đúng). Đưa nhánh hoàn tất + tranh chấp vào `smoke-aws.py`.

**Thứ tự gộp:** A0 (+ B3) → A1 → A5 → A2 → B1 + B2 → A3 → B6 → A4 → A6 → B5 (khi có logo). B4 để sau.

PO chốt thêm: Hồ sơ (Admin) = hồ sơ chính Admin; Admin đăng tin: quyết sau, đợt này không thêm; đăng nhập: chỉ thủ công đợt này; nhãn PN1 / PN1V / PN2 như trên.

## 6. Định nghĩa "xong"
- Các route Admin hoạt động, mỗi route có URL riêng, danh sách mới phân trang bằng `pageQuery` / `<PagedTable>`, không danh sách mới nào tải toàn bộ.
- Mọi `POST /admin/*` và mọi lượt xem dữ liệu cá nhân có dòng audit; có test chứng minh body nhạy cảm không bị ghi.
- Không Scan mới. `listDisputed` + test cũ pass, `smoke-aws.py` ALL PASS.
- `readmeall.md` cập nhật từng bước; `let.md` cập nhật bảng API Admin ở bước cuối.
