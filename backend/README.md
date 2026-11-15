# Trình Cà Phê — Backend PostgreSQL / Supabase

Backend Node.js, Express, TypeScript cho quản lý tồn kho và hao hụt nguyên vật liệu. Dữ liệu nằm trong PostgreSQL; có thể dùng Supabase hoặc PostgreSQL cục bộ. API, quyền người dùng, phê duyệt, sổ biến động tồn và báo cáo vẫn do backend xử lý. Mã blog gốc và bản SQL Server cũ được giữ trong `template_reference/` để tham khảo.

## Chạy thử cục bộ

```sh
cd ../postgres && docker compose up -d
cd ../trinh-ca-phe-backend
npm ci
# .env hiện có trỏ tới PostgreSQL cục bộ; nếu tạo mới, lấy .env.example rồi thay DATABASE_URL
npm run db:migrate
npm run db:seed
npm run build
npm start
```

API mặc định ở `http://127.0.0.1:4000/api`; `GET /api/health` kiểm tra kết nối. `npm run db:seed` tạo dữ liệu và người dùng demo từ frontend mẫu, tất cả dùng `SEED_PASSWORD`. Chỉ chạy seed cho demo hoặc phát triển. `npm run smoke` thực hiện giao dịch thử nghiệm và ghi dữ liệu vào database, vì vậy không chạy trên dữ liệu thật.

## Dùng Supabase

1. Tạo một dự án Supabase. Trong Dashboard > **Connect**, sao chép chuỗi **Session pooler** (cổng 5432) nếu backend deploy ở môi trường IPv4 như Railway. Thay `[YOUR-PASSWORD]` bằng mật khẩu database; mã hóa các ký tự đặc biệt trong mật khẩu theo URL. Có thể dùng Direct connection nếu host hỗ trợ IPv6. Với thư viện `pg` hiện tại, thêm `?sslmode=require&uselibpqcompat=true` vào URL để bắt buộc mã hóa TLS. Chế độ này chưa xác minh CA; để xác minh cả máy chủ, tải CA từ Supabase Dashboard và dùng `sslmode=verify-full` cùng `sslrootcert`.
2. Đặt `DATABASE_URL` chỉ ở backend/Railway Variables, cùng `JWT_SECRET` ngẫu nhiên dài và `CORS_ORIGIN` bằng URL frontend. Không đặt chuỗi kết nối database trong biến `VITE_` hoặc mã frontend.
3. Chạy `npm run db:migrate` một lần để tạo schema `app` và các bảng. Schema `app` không được thêm vào **Exposed schemas** của Supabase Data API; mọi truy cập dữ liệu đi qua API backend.
4. Để demo, chạy `npm run db:seed` từ máy phát triển với `DATABASE_URL` Supabase và `SEED_PASSWORD` riêng. Không dùng tài khoản demo cho vận hành thật.


## Deploy backend trên Render

- Tạo Git repository riêng từ thư mục backend này và kết nối với Render dưới dạng **Blueprint**. File `render.yaml` tạo Web Service Docker gói Free ở Singapore, đặt `PORT=4000` và kiểm tra `/api/health`.
- Khi Render yêu cầu, điền `DATABASE_URL` trỏ đến **Session pooler** Supabase (cổng 5432, có TLS) và `CORS_ORIGIN` là origin frontend, ví dụ `https://ten-frontend.onrender.com` (không có dấu `/` cuối). `JWT_SECRET` được Render tạo tự động. Không commit `.env`.
- Schema và dữ liệu mẫu Supabase đã được tạo từ máy phát triển. Gói Render Free không hỗ trợ pre-deploy command; khi có migration mới, chạy `npm run db:migrate` từ máy phát triển trước khi deploy phiên bản backend cần migration đó.
- Render Free có thể ngủ khi không có request và lần truy cập đầu sau đó sẽ chậm. Database vẫn nằm ở Supabase, không đặt trên ổ tạm của Render.

## Quy tắc nghiệp vụ

- Bảng nằm trong schema PostgreSQL `app` để tránh lộ qua Supabase Data API. Backend dùng JWT riêng, kiểm tra vai trò và chi nhánh; không dùng Supabase Auth.
- Tồn kho thay đổi qua `stock_movements` trong giao dịch PostgreSQL. Nhận hàng dùng `idempotencyKey`; trạng thái phiếu và phê duyệt được kiểm tra trước khi ghi.
- POS chỉ lưu doanh số và phiên bản công thức để tính tiêu hao lý thuyết; không tự trừ tồn. Kỳ dùng dạng `YYYY-MM` hoặc `YYYY-Q1` đến `YYYY-Q4`. Kỳ tháng và quý chồng lấn cần `overwrite: true`; các dòng thiếu công thức được lưu riêng và không tính tiêu hao.
- `POST /sales-imports/preview` và `POST /sales-imports` nhận `{ "branchId": "...", "period": "2026-11", "items": [{ "recipeId": "MON-001", "quantity": 10 }] }`. `recipeId` nhận ID hoặc mã món; có thể kèm `name` để dò theo tên. Phản hồi chứa `unmatchedItems` và `theoreticalConsumption`.
- Xác nhận phiếu `cap_quay` ghi nhận việc cấp quầy nhưng không giảm tổng tồn chi nhánh, vì quầy vẫn thuộc chi nhánh. Các loại xuất khác chỉ giảm tồn lúc xác nhận. Nếu cần số dư riêng kho/quầy, phải bổ sung bảng tồn theo vị trí và chuyển dữ liệu cũ trước khi dùng báo cáo theo vị trí.
- Tạo kiểm kê với `period` trùng kỳ POS, ví dụ `{ "branchId": "cn-1", "period": "2026-11" }`. Nhân viên xem được tồn hệ thống và chênh lệch, nhập số thực đếm rồi hoàn tất; quản lý dùng `PATCH /stocktakes/:id/handling` để nhập `{ "items": [{ "materialId": "...", "reason": "...", "remedy": "..." }] }` cho từng dòng lệch, sau đó đề xuất điều chỉnh. Phiếu nháp chưa lưu có thể hủy bằng `POST /stocktakes/:id/cancel` (chỉ người tạo); thao tác này xóa phiếu nháp và không đổi tồn.
- Sau khi ghi nhận nhập kho, phiếu chuyển `completed` nếu đủ hàng đạt chuẩn, hoặc `backorder` nếu còn thiếu. Có thể nhận thêm trên phiếu `backorder` cho đến khi hoàn thành. Dữ liệu cũ ở trạng thái `receiving` có lịch sử nhận và còn thiếu được chuyển sang `backorder` bởi migration `003_import_backorder.sql`.
- Bộ dữ liệu phục vụ đặc tả màn hình nằm trong `fixtures/screen-spec-demo.json`. Chạy `npm run db:screen-spec:check` để xem số bản ghi dự kiến. `npm run db:screen-spec:apply` **thay toàn bộ dữ liệu trong schema `app`** bằng bộ này, tạo bản sao lưu JSON trước tại `backups/` (bị loại khỏi Git), và kiểm tra sổ biến động khớp số dư. Ba tài khoản `buiducmanh`, `nguyenthihuong`, `nguyenminhanh` dùng mật khẩu `SEED_PASSWORD` đang cấu hình; các phiên đăng nhập cũ hết hiệu lực sau khi thay dữ liệu.
- Migration `005_ordered_codes.sql` khởi tạo bộ đếm riêng từ mã lớn nhất hiện có. API cấp mã mới theo dạng `NVL-007`, `MON-013`, `PNK-0010`, `PXK-0014`, `PKK-0007`; yêu cầu duyệt và dữ liệu bán hàng cũng có dãy riêng. Mã do database cấp khi lưu, không nhận mã dự đoán từ frontend. Mỗi dãy tăng dần và không trùng; giao dịch lỗi có thể để lại khoảng trống trong dãy. Chạy `npm run db:migrate` trước khi triển khai backend có thay đổi này.
- `GET /reports/loss` (hoặc `/reports/variance`) nhận `branchId`, `period` và `stocktakeId` tùy chọn. API tính tồn lý thuyết bằng tồn hệ thống đã chụp khi mở kiểm kê trừ tiêu hao POS của kỳ, rồi so với số thực đếm. Mức hao hụt cho phép dùng `allowedLossQuantity`, tách khỏi tồn tối thiểu. Nếu thiếu POS hoặc kiểm kê cùng kỳ, API trả 422.

## API chính

| Nhóm             | Đường dẫn                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Phiên, danh mục  | `/auth/login`, `/auth/me`, `/auth/logout`, `/branches`, `/suppliers`, `/materials`, `/thresholds`, `/recipes`           |
| Nhập/xuất kho    | `/imports`, `/imports/:id/receive`, `/exports`, `/exports/:id/confirm`                                                  |
| Kiểm kê và duyệt | `/stocktakes`, `/stocktakes/:id/cancel`, `/stocktakes/:id/complete`, `/stocktakes/:id/propose-adjustment`, `/approvals` |
| POS và báo cáo   | `/sales-imports/preview`, `/sales-imports`, `/dashboard`, `/reports/inventory`, `/reports/loss`, `/stock-movements`     |

Frontend `htquanlykho` hiện vẫn dùng localStorage và lớp REST mẫu gọi `/inventory/snapshot` cùng `/inventory/commands`. Cần thay lớp REST này bằng các API nghiệp vụ ở trên và lưu Bearer token từ `/auth/login`; backend chưa cung cấp hai endpoint tổng hợp đó. Workbook được frontend đọc thành JSON; backend xác thực lại mã món, kỳ và quyền. API chưa nhận tệp XLSX trực tiếp hoặc tạo XLSX trên server.

Migration `002_frontend_workflows.sql` thêm mức hao hụt theo số lượng, xử lý chênh lệch, sự cố xuất kho và kỳ POS. Trên Supabase đang chạy, thực hiện `npm run db:migrate` trước khi deploy mã backend mới lên Render. Script migration lặp lại an toàn.

## Kiểm tra

```sh
npm run check
npm run build
npm run smoke
```
