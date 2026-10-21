import { useEffect, useState } from 'react';
import { api, type BillingSummary, type FeeLine } from '../lib/api';
import { dateTime, errorText, vnd } from '../lib/format';

const APPEAL_LABEL: Record<string, string> = { OPEN: 'Đang chờ Admin xem', WAIVED: 'Đã được miễn', KEPT: 'Giữ phí' };
const APPEAL_TONE: Record<string, string> = { OPEN: 'warn', WAIVED: 'ok', KEPT: 'bad' };

/**
 * Phí dịch vụ của người bán (QĐ-37): 10.000đ / giao dịch hoàn tất, gom hóa đơn theo tháng,
 * chuyển khoản kèm mã hóa đơn; quá hạn 7 ngày bị khóa đăng tin và báo giá.
 */
export function BillingCard() {
  const [b, setB] = useState<BillingSummary | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    api<BillingSummary>('GET', '/billing/me')
      .then(setB)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  /** Khiếu nại phí nghi bán ngoài (QĐ-39) — mỗi dòng 1 lần. */
  const appeal = async (l: FeeLine) => {
    const reason = prompt('Vì sao bạn gỡ tin? (ít nhất 10 ký tự — Admin sẽ xem lại và miễn phí nếu hợp lý)');
    if (!reason) return;
    try {
      await api('POST', `/billing/fees/${l.month}/${l.transactionId}/appeal`, { body: { reason } });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!b) return null;
  const unpaid = b.invoices.filter((i) => i.status === 'ISSUED');
  const debt = b.debt;
  const overdue = debt.level !== 'NONE';

  return (
    <section className={`card ${overdue ? 'cta' : ''}`}>
      <h2>Phí dịch vụ</h2>
      <p className="muted">
        {vnd(b.feePerTransaction)} cho mỗi giao dịch <strong>hoàn tất</strong> mà bạn là người bán. Hủy / thất bại không tính phí (trừ khi gỡ tin
        ngay sau đó — xem bên dưới). Ngày 1 hằng tháng
        hệ thống gửi hóa đơn tháng trước; hạn thanh toán {b.dueDays} ngày. Quá hạn trên {b.postingLockDays} ngày: không đăng tin mới; quá hạn trên{' '}
        {b.fullLockDays} ngày: tạm khóa mọi chức năng cho tới khi thanh toán.
      </p>
      {overdue && debt.invoice && (
        <div className={`notice ${debt.level === 'WARNING' ? 'warn' : 'bad'}`}>
          Hóa đơn tháng {debt.invoice.month} quá hạn {debt.daysOverdue} ngày ({vnd(debt.overdueAmount)}).{' '}
          {debt.level === 'WARNING' && `Thanh toán trước ${dateTime(debt.postingLockAt!)} để không bị dừng đăng tin mới.`}
          {debt.level === 'NO_POSTING' && `Đang dừng đăng tin mới. Thanh toán trước ${dateTime(debt.fullLockAt!)} để không bị khóa mọi chức năng.`}
          {debt.level === 'FULL' && 'Tài khoản đang tạm khóa mọi chức năng cho tới khi Admin xác nhận đã nhận tiền.'}
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <span className="muted">Tháng {b.currentMonth.month} (tạm tính)</span>
          <strong>{vnd(b.currentMonth.amount)}</strong>
          <span className="muted small">
            {b.currentMonth.transactionCount} giao dịch
            {b.currentMonth.lines.some((l) => l.kind === 'VIP_PLAN') &&
              ` · gói VIP ${vnd(b.currentMonth.lines.filter((l) => l.kind === 'VIP_PLAN').reduce((s, l) => s + l.amount, 0))}`}
          </span>
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

      {b.suspected.length > 0 && (
        <>
          <h3>Phí nghi bán ngoài ReLoop</h3>
          <p className="muted small">
            Gỡ tin trong 72 giờ sau khi giao dịch bị hủy / thất bại được coi như đã bán bên ngoài và tính {vnd(b.feePerTransaction)}. Nếu không phải
            vậy, hãy khiếu nại — Admin tài chính xem lại và miễn phí nếu hợp lý.
          </p>
          <table>
            <thead>
              <tr>
                <th>Tin</th>
                <th>Lúc gỡ</th>
                <th className="num">Phí</th>
                <th>Khiếu nại</th>
              </tr>
            </thead>
            <tbody>
              {b.suspected.map((l) => (
                <tr key={`${l.month}-${l.transactionId}`}>
                  <td>{l.listingTitle}</td>
                  <td>{dateTime(l.completedAt)}</td>
                  <td className="num">{vnd(l.amount)}</td>
                  <td>
                    {!l.appeal ? (
                      <button className="secondary" onClick={() => void appeal(l)}>
                        Khiếu nại
                      </button>
                    ) : (
                      <span className={`badge ${APPEAL_TONE[l.appeal.status]}`} title={l.appeal.note ?? l.appeal.reason}>
                        {APPEAL_LABEL[l.appeal.status]}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
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
