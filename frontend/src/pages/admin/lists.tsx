import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PagedTable, usePagedList, type Page } from '../../components/PagedTable';
import { api, type AuditEntry, type Listing, type Profile, type Report, type Transaction } from '../../lib/api';
import { LISTING_STATUS_LABEL, TX_STATUS_LABEL, statusTone } from '../../lib/catalog';
import { dateTime, errorText, vnd } from '../../lib/format';
import type { Session } from '../../lib/session';
import { adminListingLink } from './listing';

/** Tháng hiện tại: giờ VN cho nhật ký (khớp backend), giờ UTC cho tin (FEED ghi theo UTC — get.md S3). */
const vnMonthNow = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 7);
const utcMonthNow = () => new Date().toISOString().slice(0, 7);

/** Bộ lọc trên URL — F5 không mất. */
function useParam(name: string, fallback: string): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  return [
    params.get(name) ?? fallback,
    (v) => {
      const next = new URLSearchParams(params);
      next.set(name, v);
      setParams(next, { replace: true });
    },
  ];
}

const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1])).toString();

const StatusBadge = ({ s, labels }: { s: string; labels: Record<string, string> }) => <span className={`badge ${statusTone(s)}`}>{labels[s] ?? s}</span>;

const UserLink = ({ id, children }: { id: string; children?: React.ReactNode }) => <Link to={`/admin/users/${encodeURIComponent(id)}`}>{children ?? id}</Link>;

// ---------------------------------------------------------------- Giao dịch theo trạng thái (A3)

export function TransactionsPage() {
  const [status, setStatus] = useParam('status', 'HANDOVER_PENDING');
  const fetchPage = useCallback((cursor?: string) => api<Page<Transaction>>('GET', `/admin/transactions?${qs({ status, cursor })}`), [status]);
  const list = usePagedList(fetchPage);
  return (
    <section className="card">
      <div className="row between">
        <h2>Giao dịch theo trạng thái</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(TX_STATUS_LABEL)
            .filter(([k]) => k !== 'AWAITING_PAYMENT')
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
      </div>
      <p className="muted small">Chỉ có giao dịch tạo hoặc đổi trạng thái từ ngày 22/10/2026. Giao dịch cũ hơn xem ở hồ sơ người dùng.</p>
      <PagedTable
        list={list}
        rowKey={(t) => t.transactionId}
        columns={[
          { header: 'Tin', cell: (t) => <Link to={`/transactions/${t.transactionId}`}>{t.listingTitle}</Link> },
          { header: 'Người bán', cell: (t) => <UserLink id={t.ownerId} /> },
          { header: 'Người mua', cell: (t) => <UserLink id={t.partnerId}>{t.partnerName}</UserLink> },
          { header: 'Giá', className: 'num', cell: (t) => vnd(t.finalPrice ?? t.agreedPrice) },
          { header: 'Nguồn', cell: (t) => (t.source === 'CHAT' ? 'Chat' : 'Báo giá') },
          { header: 'Tạo lúc', cell: (t) => dateTime(t.createdAt) },
          { header: 'Trạng thái', cell: (t) => <StatusBadge s={t.status} labels={TX_STATUS_LABEL} /> },
        ]}
      />
    </section>
  );
}

// ---------------------------------------------------------------- Tin theo tháng (A4)

export function ListingsPage() {
  const [month, setMonth] = useParam('month', utcMonthNow());
  const [status, setStatus] = useParam('status', '');
  const fetchPage = useCallback(
    (cursor?: string) => api<Page<Listing>>('GET', `/admin/listings?${qs({ month, status: status || undefined, cursor })}`),
    [month, status],
  );
  const list = usePagedList(fetchPage);
  return (
    <section className="card">
      <div className="row between">
        <h2>Tất cả tin theo tháng</h2>
        <span className="row">
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Mọi trạng thái</option>
            {Object.entries(LISTING_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </span>
      </div>
      <p className="muted small">Tháng theo giờ UTC (ngày lên Chợ). Bấm tên tin để xem mọi trạng thái (kể cả đã gỡ / hết hạn). Gỡ tin vi phạm vẫn qua luồng phản ánh.</p>
      <PagedTable
        list={list}
        rowKey={(l) => l.listingId}
        columns={[
          { header: 'Tin', cell: (l) => <Link to={`/admin/listings/${l.listingId}`}>{l.title}</Link> },
          { header: 'Người bán', cell: (l) => <UserLink id={l.ownerId} /> },
          { header: 'Khu vực', cell: (l) => l.area },
          { header: 'Đăng lúc', cell: (l) => dateTime(l.createdAt) },
          { header: 'Trạng thái', cell: (l) => <StatusBadge s={l.status} labels={LISTING_STATUS_LABEL} /> },
        ]}
        empty="Không có tin nào khớp bộ lọc trong phần đã đọc — bấm Tải thêm nếu có."
      />
    </section>
  );
}

// ---------------------------------------------------------------- Lịch sử: nhật ký Admin (A5)

const AUDIT_ACTION: Record<string, string> = {
  '/admin/partners/{id}/review': 'Duyệt / từ chối đối tác',
  '/admin/partners/{id}/suspend': 'Tạm ngừng đối tác',
  '/admin/partners/{id}/reactivate': 'Mở lại đối tác',
  '/admin/invoices/{userId}/{month}/paid': 'Xác nhận đã thu phí',
  '/admin/billing/issue': 'Lập hóa đơn tháng',
  '/admin/fee-appeals/{userId}/{month}/{transactionId}/resolve': 'Quyết khiếu nại phí',
  '/admin/risk-flags/{userId}/resolve': 'Xử lý cờ rủi ro',
  '/admin/listings/{id}/review': 'Duyệt / từ chối tin',
  '/admin/reports/{id}/resolve': 'Xử lý phản ánh',
  '/admin/transactions/{id}/resolve': 'Kết luận tranh chấp',
  '/admin/users/{id}': 'Xem hồ sơ người dùng',
  '/admin/listings/{id}/chats': 'Xem chat của tin',
  '/transactions/{id}': 'Xem giao dịch',
};

const describe = (e: AuditEntry) => {
  const f = e.fields;
  const parts = [
    f.approve !== undefined && (f.approve ? 'duyệt' : 'từ chối'),
    typeof f.action === 'string' && f.action,
    typeof f.outcome === 'string' && f.outcome,
    f.waive !== undefined && (f.waive ? 'miễn phí' : 'giữ phí'),
    typeof f.finalPrice === 'number' && vnd(f.finalPrice),
    typeof f.month === 'string' && `tháng ${f.month}`,
  ].filter(Boolean);
  return parts.join(' · ');
};

export function AuditPage() {
  const [month, setMonth] = useParam('month', vnMonthNow());
  const fetchPage = useCallback((cursor?: string) => api<Page<AuditEntry>>('GET', `/admin/audit?${qs({ month, cursor })}`), [month]);
  const list = usePagedList(fetchPage);
  return (
    <section className="card">
      <div className="row between">
        <h2>Nhật ký thao tác Admin</h2>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </div>
      <p className="muted small">Ghi mọi thao tác của Admin và mỗi lần Admin xem dữ liệu cá nhân (hồ sơ, chat, giao dịch của người khác). Giữ lâu dài.</p>
      <PagedTable
        list={list}
        rowKey={(e) => e.auditId ?? `${e.at}${e.adminId}${e.routePath}${JSON.stringify(e.params)}`}
        columns={[
          { header: 'Lúc', cell: (e) => dateTime(e.at) },
          { header: 'Admin', cell: (e) => <UserLink id={e.adminId} /> },
          {
            header: 'Việc',
            cell: (e) => (
              <>
                {AUDIT_ACTION[e.routePath] ?? `${e.method} ${e.routePath}`} {e.kind === 'pii-read' && <span className="badge warn">xem dữ liệu cá nhân</span>}
              </>
            ),
          },
          { header: 'Đối tượng', cell: (e) => Object.values(e.params).join(' / ') },
          { header: 'Quyết định', cell: (e) => describe(e) },
          { header: 'Ghi chú', cell: (e) => (typeof e.fields.note === 'string' ? e.fields.note : '') },
        ]}
        empty="Chưa có thao tác nào trong tháng này."
      />
    </section>
  );
}

// ---------------------------------------------------------------- Lịch sử: phản ánh đã xử lý (A1)

const REPORT_ACTION_LABEL: Record<string, string> = {
  DISMISS: 'Bỏ qua',
  WARN: 'Cảnh cáo',
  HIDE_AND_WARN: 'Gỡ tin + cảnh cáo',
  HIDE_AND_SUSPEND: 'Gỡ tin + tạm ngừng',
  SUSPEND: 'Tạm ngừng',
};

export function ResolvedReportsPage() {
  const fetchPage = useCallback((cursor?: string) => api<Page<Report>>('GET', `/admin/reports?${qs({ status: 'RESOLVED', cursor })}`), []);
  const list = usePagedList(fetchPage);
  return (
    <section className="card">
      <h2>Phản ánh đã xử lý</h2>
      <p className="muted small">Sắp theo ngày gửi phản ánh, mới nhất trước.</p>
      <PagedTable
        list={list}
        rowKey={(r) => r.reportId}
        columns={[
          { header: 'Gửi lúc', cell: (r) => dateTime(r.createdAt) },
          { header: 'Về', cell: (r) => (r.target?.link ? <Link to={adminListingLink(r.target.link)}>{r.target.title}</Link> : (r.target?.title ?? r.targetId)) },
          { header: 'Lý do', cell: (r) => r.reason },
          { header: 'Kết luận', cell: (r) => REPORT_ACTION_LABEL[r.resolution?.action ?? ''] ?? r.resolution?.action },
          { header: 'Người vi phạm', cell: (r) => (r.resolution?.violatorId ? <UserLink id={r.resolution.violatorId} /> : '—') },
          { header: 'Ghi chú', cell: (r) => r.resolution?.note ?? '' },
          { header: 'Xử lý', cell: (r) => r.resolution && <>{dateTime(r.resolution.at)} · <UserLink id={r.resolution.by} /></> },
        ]}
        empty="Chưa có phản ánh nào được xử lý."
      />
    </section>
  );
}

// ---------------------------------------------------------------- Hồ sơ của chính Admin (B3)

export function AdminProfilePage({ session }: { session: Session }) {
  const [me, setMe] = useState<Profile>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<Profile>('GET', '/me').then(setMe).catch((e) => setError(errorText(e)));
  }, []);
  return (
    <section className="card">
      <h2>Hồ sơ của tôi</h2>
      {error && <p className="error">{error}</p>}
      <p>
        <strong>{me?.fullName ?? session.label}</strong>
      </p>
      <p className="muted">Email: {me?.email ?? '—'}</p>
      <p>
        Quyền:{' '}
        {session.groups.map((g) => (
          <span key={g} className="badge ok">
            {g === 'admin_finance' ? 'Admin tài chính' : 'Admin'}
          </span>
        ))}
      </p>
      <p className="muted small">Cấp / gỡ quyền Admin làm bằng scripts/make-admin.sh, không làm trên web.</p>
    </section>
  );
}
