import { useEffect, useState } from 'react';
import { api, type Profile } from '../lib/api';
import { errorText } from '../lib/format';

/** Bắt buộc đồng ý Điều khoản sử dụng + Chính sách quyền riêng tư trước khi dùng (QĐ-28). */
export function TermsGate({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<(Profile & { currentTermsVersion: string; terms?: { version: string } }) | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<typeof me>('GET', '/me')
      .then(setMe)
      .catch((e) => setError(errorText(e)));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!me) return <p className="muted">Đang tải…</p>;
  if (me.terms?.version === me.currentTermsVersion) return <>{children}</>;

  const accept = async () => {
    try {
      setMe({ ...(await api<NonNullable<typeof me>>('POST', '/me/accept-terms', { body: { version: me.currentTermsVersion } })), currentTermsVersion: me.currentTermsVersion });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card terms">
      <h2>Điều khoản sử dụng & Chính sách quyền riêng tư</h2>
      <p className="muted">Phiên bản {me.currentTermsVersion}. ReLoop là dự án thực tập AWS Cloud Engineering, chưa phải dịch vụ thương mại.</p>
      <h3>1. ReLoop làm gì</h3>
      <p>
        ReLoop kết nối người có thiết bị điện tử cũ, hỏng (chủ tin) với doanh nghiệp thu mua, sửa chữa, tái chế (đối tác) trong bán kính 5 km.
        ReLoop không mua bán, vận chuyển, kiểm định thiết bị hay cam kết giá cuối. Giá dự kiến do bảng giá của đối tác tạo ra và chỉ mang tính tham khảo;
        giá cuối do hai bên thống nhất khi bàn giao. Hiện hai bên thanh toán trực tiếp khi gặp nhau. Chỉ đối tác đã được Admin duyệt mới đăng tin:
        khách lẻ là đối tác cấp 1, doanh nghiệp / hộ kinh doanh là đối tác cấp 2.
      </p>
      <h3>Phí dịch vụ</h3>
      <p>
        Đăng tin miễn phí. Người bán trả 10.000đ cho mỗi giao dịch hoàn tất (hủy / thất bại không tính phí). Phí được gộp theo tháng: ngày 1 hằng
        tháng ReLoop gửi hóa đơn tháng trước, thanh toán bằng chuyển khoản trong 7 ngày. Quá hạn trên 3 ngày: không đăng tin mới (tin đang có vẫn
        bình thường); quá hạn trên 7 ngày: tạm khóa mọi chức năng, chỉ còn xem và thanh toán phí, cho tới khi ReLoop xác nhận đã nhận tiền.
      </p>
      <p>
        Hạn mức tin đang mở cùng lúc: đối tác cấp 1 được 3 tin, gói VIP 1 (10.000đ / 30 ngày, cộng vào phí tháng) được 5 tin, đối tác cấp 2 được 10 tin.
        Chống né phí: nếu giao dịch bị hủy / báo thất bại rồi người bán gỡ tin trong vòng 72 giờ sau đó, ReLoop coi như đã bán bên ngoài và tính
        10.000đ vào phí tháng (người bán được khiếu nại, Admin miễn nếu hợp lý). Người bán có nhiều giao dịch bị hủy bất thường có thể bị cảnh cáo
        hoặc tạm ngừng tài khoản đối tác.
      </p>
      <h3>2. AI phân tích ảnh</h3>
      <p>AI chỉ gợi ý thông tin dựa trên những gì thấy được trong ảnh, không khẳng định thiết bị còn hoạt động. Bạn chịu trách nhiệm kiểm tra lại trước khi đăng.</p>
      <h3>3. Dữ liệu cá nhân</h3>
      <p>
        Chúng tôi thu thập: email, họ tên, số điện thoại, địa chỉ và vị trí bạn ghim, ảnh thiết bị. Trước khi bạn chọn đối tác, đối tác chỉ thấy khu vực (phường/quận)
        và khoảng cách làm tròn; địa chỉ chi tiết chỉ mở cho hai bên sau khi giao dịch được tạo. Khi bạn là đối tác, tên đối tác, email liên hệ và số
        điện thoại (nếu bạn khai trong hồ sơ) được hiện công khai trên tin đăng để khách liên lạc. Ảnh tin đăng được xóa 90 ngày sau khi tải lên;
        lịch sử giao dịch được lưu để giải quyết tranh chấp. Bạn có thể yêu cầu xóa tài khoản; dữ liệu giao dịch sẽ được ẩn danh (theo Nghị định 13/2023/NĐ-CP).
      </p>
      <h3>4. Ứng xử</h3>
      <p>Không đăng thông tin sai sự thật, ảnh không phù hợp hay hàng cấm. Admin có quyền gỡ tin, tạm ngừng tài khoản vi phạm và quyết định khi có tranh chấp.</p>
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        Tôi đã đọc và đồng ý Điều khoản sử dụng và Chính sách quyền riêng tư
      </label>
      <div className="row">
        <button onClick={() => void accept()} disabled={!checked}>
          Đồng ý và tiếp tục
        </button>
      </div>
    </section>
  );
}
