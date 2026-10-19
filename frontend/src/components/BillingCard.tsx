import { useEffect, useState } from 'react';
import { api, type BillingSummary } from '../lib/api';
import { dateTime, errorText, vnd } from '../lib/format';

/**
 * Phí dịch vụ của người bán (QĐ-37): 10.000đ / giao dịch hoàn tất, gom hóa đơn theo tháng,
 * chuyển khoản kèm mã hóa đơn; quá hạn 7 ngày bị khóa đăng tin và báo giá.
 */
export function BillingCard() {
  const [b, setB] = useState<BillingSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<BillingSummary>('GET', '/billing/me')
      .then(setB)
      .catch((e) => setError(errorText(e)));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!b) return null;
  const unpaid = b.invoices.filter((i) => i.status === 'ISSUED');
  const overdue = unpaid.some((i) => i.overdue);

  return (
    <section className={`card ${overdue ? 'cta' : ''}`}>
      <h2>Phí dịch vụ</h2>
      <p className="muted">
        {vnd(b.feePerTransaction)} cho mỗi giao dịch <strong>hoàn tất</strong> mà bạn là người bán. Hủy / thất bại không tính phí. Ngày 1 hằng tháng
        hệ thống gửi hóa đơn tháng trước; hạn thanh toán {b.dueDays} ngày — quá hạn sẽ tạm khóa đăng tin và báo giá.
      </p>
      {overdue && <div className="notice bad">Bạn có hóa đơn quá hạn — đang bị khóa đăng tin / báo giá cho tới khi thanh toán.</div>}

      <div className="tiles">
        <div className="tile">
          <span className="muted">Tháng {b.currentMonth.month} (tạm tính)</span>
          <strong>{vnd(b.currentMonth.amount)}</strong>
          <span className="muted small">{b.currentMonth.transactionCount} giao dịch hoàn tất</span>
        </div>
        <div className="tile">
          <span className="muted">Chưa thanh toán</span>
          <strong>{vnd(unpaid.reduce((s, i) => s + i.amount, 0))}</strong>
          <span className="muted small">{unpaid.length} hóa đơn</span>
        </div>
      </div>

      {unpaid.length > 0 && (
        <div className="notice warn">
          <strong>Cách thanh toán:</strong> chuyển khoản đúng số tiền, nội dung ghi <strong>mã hóa đơn</strong> bên dưới.{' '}
          {b.bank ? (
            <>
              Ngân hàng <strong>{b.bank.bankName}</strong> · STK <strong>{b.bank.accountNo}</strong> · chủ TK <strong>{b.bank.accountName}</strong>.
            </>
          ) : (
            'Thông tin tài khoản nhận sẽ được Admin gửi qua email liên hệ của bạn.'
          )}{' '}
          Admin xác nhận trong vòng 1 ngày làm việc.
        </div>
      )}

      {b.invoices.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Tháng</th>
              <th className="num">Giao dịch</th>
              <th className="num">Số tiền</th>
              <th>Mã chuyển khoản</th>
              <th>Hạn / trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {b.invoices.map((i) => (
              <tr key={i.month}>
                <td>{i.month}</td>
                <td className="num">{i.transactionCount}</td>
                <td className="num">{vnd(i.amount)}</td>
                <td>
                  <code>{i.paymentCode}</code>
                </td>
                <td>
                  {i.status === 'PAID' ? (
                    <span className="badge ok">Đã thanh toán {i.paidAt && dateTime(i.paidAt)}</span>
                  ) : (
                    <span className={`badge ${i.overdue ? 'bad' : 'warn'}`}>
                      {i.overdue ? 'Quá hạn' : 'Hạn'} {dateTime(i.dueAt)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
