# ReLoop — Bàn giao ngữ cảnh (đọc file này đầu tiên)

> **Mục đích:** lưu toàn bộ ngữ cảnh dự án để khi mở lại máy, Claude (hoặc thành viên mới) đọc là biết đã làm tới đâu.
> **Cập nhật lần cuối:** 2026-10-12 (phiên 2)
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
| `quyetdinh.txt` | **33 quyết định đã chốt** (QĐ-xx, TL-xx). Ghi đè mọi tài liệu khác | **Cao nhất** |
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

**Khác**
- **Đánh giá hai chiều (QĐ-22).**
- **Bắt buộc đồng ý điều khoản khi đăng ký (QĐ-28).**
- **Lưu trữ (QĐ-27):** ảnh tin đăng xóa sau 90 ngày; sổ cái và bằng chứng tranh chấp giữ lâu dài.

## 4. Kiến trúc code hiện tại

```
projecmeo/
  README.md                 hướng dẫn chạy code
  package.json              npm workspaces: backend, frontend
  plan/                     tài liệu kế hoạch (xem mục 2)
  backend/                  TypeScript, viết theo dạng Lambda handler
    src/app.ts              lắp adapter theo STAGE (local/aws) + loadConfig()
    src/lambda.ts           entry point Lambda
    src/local/server.ts     server dev (cổng 3001), gọi CÙNG handler với Lambda, đọc backend/.env
    src/http/router.ts      router, xác thực, Idempotency-Key (giành khóa trước khi chạy), lọc pk/sk khỏi response
    src/http/routes.ts      toàn bộ route (API + /dev/* chỉ bật khi STAGE=local)
    src/auth/auth.ts        LocalAuthProvider (header x-dev-user / x-dev-groups) · CognitoAuthProvider
    src/bank/bankProvider.ts  interface BankProvider + FakeBankProvider (header x-webhook-secret)
    src/store/table.ts      interface Table kiểu DynamoDB (get/query/transact, notExists/versionEquals)
    src/store/memoryTable.ts  bản giả lập trong bộ nhớ, lưu ra backend/.data/db.json
    src/store/keys.ts       mọi khóa single-table + GSI1
    src/domain/stateMachines.ts  Listing / Quote / Transaction / TopUp / Withdrawal
    src/modules/users/      hồ sơ, xác minh SĐT
    src/modules/wallet/
      ledger.ts             sổ cái bút toán kép, id bút toán = khóa chống trùng, reconcile()
      walletService.ts      nạp, webhook vào/ra, giữ tiền, kết thúc (có hoa hồng), phí đăng bài
      payoutService.ts      tài khoản ngân hàng, lệnh rút, Admin xử lý
      walletConfig.ts       hạn mức ví + DEFAULT_FEES (mức phí) + VietQR + chuẩn hóa tên
    test/                   vitest: 43 test (state machine, MemoryTable, ví, phí, API)
  frontend/                 React 18 + TS + Vite 5.4.21, proxy /api → :3001
    src/pages/              LoginPage (đăng nhập dev), ProfilePage, WalletPage, AdminPage
    src/lib/                api.ts, session.ts, format.ts
```

**Nguyên tắc code (phải giữ):**
- Tiền là số nguyên VND. Mọi thay đổi số dư phải qua `Ledger.post(journalId, plan)`.
- Bất biến luôn đúng: **tổng mọi ví (kể cả SYSTEM và REVENUE) = số dư tài khoản ngân hàng ReLoop**.
- Ví đặc biệt:
  - `SYSTEM.unallocated`: tiền vào/ra không khớp được với lệnh nào, chờ Admin đối soát. Được phép âm.
  - `REVENUE`: doanh thu của ReLoop.
- Đổi trạng thái phải qua `stateMachines.ts`.
- Nghiệp vụ không gọi dịch vụ AWS trực tiếp, chỉ đi qua adapter.
- API tạo tiền (nạp, rút) bắt buộc header `Idempotency-Key`.

## 5. Môi trường máy

- Windows 10, Node 22.12, npm 10.9, Git 2.47.
- **Chưa có:** Docker, Java (nên không chạy được DynamoDB Local), AWS CLI, Terraform, thư mục `~/.aws`.
- **Đã là git repo** (nhánh `main`, commit đầu `3da3ba7`). Remote: `https://github.com/thqttunvt/Reloop` (đã push). `.gitattributes` ép xuống dòng LF.
- **Chạy local:**
  - `npm install`
  - `cp backend/.env.example backend/.env` (file `.env` đã có sẵn)
  - `npm run dev:be` và `npm run dev:fe`
  - `npm test`

## 6. Trạng thái hiện tại (2026-10-12)

**Đã xong và đã kiểm tra**
- Tài liệu kế hoạch: baton, giaiphap, quyetdinh (33 QĐ), task.
- Khung monorepo, backend và frontend.
- **Toàn bộ lõi ví:** nạp, webhook vào/ra, giữ tiền, kết thúc giao dịch kèm hoa hồng, đóng băng, phí đăng bài và hoàn phí, tài khoản ngân hàng, rút tiền, đối soát.
- API Admin: duyệt tài khoản ngân hàng (có gợi ý tên khớp), hàng đợi lệnh rút kèm QR, đối soát kèm doanh thu.
- Frontend: đăng nhập dev, hồ sơ, ví (nạp QR tự cập nhật, lịch sử, rút), trang Admin.
- **GitHub Issues:** 13 issue cho GĐ 0 (#1–#13, milestone "GĐ 0 — Nền tảng (tuần 1–2)", label FE/BE-CORE/BE-PAY/OPS/P0/P1/không-code); #13 đã đóng. Chưa gán người làm. Máy đã có `gh` 2.102.0, đăng nhập `thqttunvt`.
- **Git + CI:** đã commit đầu tiên; .github/workflows/ci.yml chạy typecheck, test, build frontend khi push lên main hoặc mở PR.
- **Kết quả kiểm tra:** 43/43 test pass, typecheck sạch cả hai bên, frontend build được. Đã chạy thật ở local bằng curl (nạp → giữ → kết thúc → đối soát khớp) và gọi qua proxy frontend.

**Đang tạm dùng bản dev (chưa có bản thật)**
- OTP: thay bằng `/dev/verify-phone`.
- Đăng nhập: header dev thay cho Cognito.
- Webhook ngân hàng: `FakeBankProvider` và `/dev/bank-events`.
- Giữ / kết thúc tiền: `/dev/transactions/{id}/hold|settle`, vì chưa có module giao dịch.
- Phí đăng bài: `/dev/listings/{id}/fee|fee-refund`, vì chưa có module tin đăng.

**Chưa làm**
- Module địa điểm, tin đăng, ảnh, AI, matching, báo giá, giao dịch, lịch tác vụ, thông báo, đánh giá, tranh chấp đầy đủ, Partner onboarding.
- `DynamoTable`, Terraform, CD (tự deploy lên AWS), đóng gói Lambda, đăng nhập Cognito ở frontend.

## 7. Việc tiếp theo

**Đang chờ người dùng:** repo vẫn **Public** (đã bỏ Template), cân nhắc chuyển sang Private; CI lần đầu đã pass. Gán người làm cho issue #1–#12 khi thành viên đã nhận lời mời. Bật branch protection cho `main` (bắt buộc CI pass). Vẫn còn treo câu hỏi: "Bắt đầu viết `DynamoTable` không?"

**Claude làm được ngay (không cần AWS)**
1. `DynamoTable`: dùng AWS SDK v3, `TransactWriteItems` + `ConditionExpression`, **đọc số dư bằng `ConsistentRead: true`**.
2. Terraform: bảng DynamoDB (bật PITR), Cognito (nhóm `admin` và `admin_finance`), Lambda, API Gateway HTTP API có JWT authorizer (riêng `/webhooks/bank` để công khai, có throttle), SSM Parameter Store, S3 + CloudFront, log 30 ngày, Budgets.
3. Đóng gói Lambda bằng esbuild.
4. Đăng nhập Cognito ở frontend.
5. Các module nghiệp vụ theo `task.txt`: địa điểm → tin đăng (gắn thu phí, T8.15) → AI → matching → báo giá → **giao dịch (Epic 9, nối vào holdForTransaction/settleTransaction)**.

**Người dùng phải tự làm**
- Tạo tài khoản AWS: bật MFA cho root, tạo người dùng qua IAM Identity Center, chọn region (đề xuất `ap-southeast-1`), bật Budgets.
- **Xin quyền dùng model Bedrock** (Claude Haiku).
- Cài AWS CLI v2 và Terraform, chạy `aws configure sso`. Lệnh `terraform apply` do người dùng chạy.
- Chọn tài khoản ngân hàng làm tài khoản ReLoop; đăng ký dịch vụ webhook (SePay/payOS/Casso).
- **Gửi tài liệu API MB Bank** (người dùng đã hứa gửi). Lưu ý:
  - Nếu đó là thư viện không chính thức (đăng nhập internet banking bằng mật khẩu) thì phải cảnh báo, vì vi phạm điều khoản ngân hàng.
  - Không bao giờ nhận key hay mật khẩu qua chat.
- Chuyển repo GitHub sang Private, thêm thành viên nhóm, bật branch protection.
- Trả lời có thêm chatbot FAQ (Bedrock) vào phần mở rộng không.

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
