import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AdminStats } from '../../lib/api';
import { PARTNER_STATUS_LABEL } from '../../lib/catalog';
import { errorText, vnd } from '../../lib/format';

/** Tháng hiện tại theo giờ VN, khớp backend vnMonth. */
const thisMonth = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);

/** Dashboard: hàng đợi (bấm để vào mục) + số liệu kinh doanh tháng (get.md A0, A6). */
export function OverviewPage() {
  const [month, setMonth] = useState(thisMonth);
  const [stats, setStats] = useState<AdminStats>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<AdminStats>('GET', `/admin/stats?month=${month}`)
      .then((s) => (setStats(s), setError('')))
      .catch((e) => setError(errorText(e)));
  }, [month]);

  const queue: [string, string, number | undefined][] = [
    ['Tin chờ duyệt (ảnh bị gắn cờ)', '/admin/listings/review', stats?.pendingListings],
    ['Tranh chấp đang mở', '/admin/disputes', stats?.openDisputes],
    ['Phản ánh chờ xử lý', '/admin/reports', stats?.openReports],
    ['Khiếu nại phí chờ xử lý', '/admin/finance/appeals', stats?.feeAppeals],
    ['Người dùng bị gắn cờ', '/admin/risk-flags', stats?.riskFlags],
  ];

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Việc cần xử lý</h2>
        <div className="tiles">
          {queue.map(([label, to, n]) => (
            <Link key={to} to={to} className="tile">
              <span className="muted">{label}</span>
              <strong>{n ?? '…'}</strong>
            </Link>
          ))}
          {stats &&
            Object.entries(stats.partners).map(([k, v]) => (
              <Link key={k} to={`/admin/partners?status=${k}`} className="tile">
                <span className="muted">Đối tác {PARTNER_STATUS_LABEL[k]?.toLowerCase()}</span>
                <strong>{v}</strong>
              </Link>
            ))}
        </div>
      </section>
      <section className="card">
        <div className="row between">
          <h2>Số liệu tháng</h2>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </div>
        {stats && (
          <div className="tiles">
            <div className="tile">
              <span className="muted">Giao dịch hoàn tất</span>
              <strong>{stats.month.completedTransactions}</strong>
            </div>
            <div className="tile">
              <span className="muted">Người bán có phí</span>
              <strong>{stats.month.sellers}</strong>
            </div>
            <div className="tile">
              <span className="muted">Phí phát sinh</span>
              <strong>{vnd(stats.month.feesAccrued)}</strong>
            </div>
            <div className="tile">
              <span className="muted">Đã lập hóa đơn</span>
              <strong>{vnd(stats.month.feesIssued)}</strong>
            </div>
            <div className="tile">
              <span className="muted">Đã thu</span>
              <strong>{vnd(stats.month.feesPaid)}</strong>
            </div>
          </div>
        )}
        <p className="muted small">Tháng theo giờ Việt Nam. Hóa đơn tháng được lập ngày 1 tháng sau.</p>
      </section>
    </div>
  );
}
