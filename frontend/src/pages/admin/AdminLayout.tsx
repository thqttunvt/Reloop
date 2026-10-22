import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { NotificationBell } from '../../components/NotificationBell';
import { api, type AdminStats } from '../../lib/api';
import type { Session } from '../../lib/session';
import { AdminProfilePage, AuditPage, ListingsPage, ResolvedReportsPage, TransactionsPage } from './lists';
import { MemberDetailPage, MembersPage } from './members';
import { OverviewPage } from './OverviewPage';
import { DisputesAdmin, FeeAppealsAdmin, InvoicesAdmin, ListingReviewAdmin, PartnersAdmin, ReportsAdmin, RiskFlagsAdmin } from './sections';

type Badge = (s: AdminStats) => number;

/** Menu Admin theo nhóm (get.md B3). URL giữ như get.md mục 3. */
const MENU: { group: string; items: { to: string; label: string; badge?: Badge }[] }[] = [
  { group: 'Dashboard', items: [{ to: 'overview', label: 'Tổng quan' }] },
  { group: 'Hồ sơ', items: [{ to: 'profile', label: 'Hồ sơ của tôi' }] },
  {
    group: 'Đối tác',
    items: [
      { to: 'partners', label: 'Duyệt / tạm ngừng', badge: (s) => s.partners.PENDING ?? 0 },
      { to: 'risk-flags', label: 'Cờ rủi ro', badge: (s) => s.riskFlags },
    ],
  },
  {
    group: 'Giao dịch',
    items: [
      { to: 'transactions', label: 'Theo trạng thái' },
      { to: 'disputes', label: 'Tranh chấp', badge: (s) => s.openDisputes },
    ],
  },
  {
    group: 'Lịch sử',
    items: [
      { to: 'audit', label: 'Nhật ký thao tác' },
      { to: 'reports/resolved', label: 'Phản ánh đã xử lý' },
    ],
  },
  { group: 'Thành viên', items: [{ to: 'users', label: 'Danh sách / tìm email' }] },
  {
    group: 'Ngân hàng',
    items: [
      { to: 'finance/invoices', label: 'Hóa đơn phí dịch vụ' },
      { to: 'finance/appeals', label: 'Khiếu nại phí', badge: (s) => s.feeAppeals },
    ],
  },
  {
    group: 'Bài viết',
    items: [
      { to: 'listings/review', label: 'Tin chờ duyệt', badge: (s) => s.pendingListings },
      { to: 'listings', label: 'Tất cả tin theo tháng' },
      { to: 'reports', label: 'Phản ánh đang mở', badge: (s) => s.openReports },
    ],
  },
];

/** Trang Admin tách riêng (get.md B3): không có thanh menu người dùng, cùng app / cùng domain. */
export function AdminLayout({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const location = useLocation();
  const [stats, setStats] = useState<AdminStats>();
  // 1 lần gọi /admin/stats mỗi khi đổi trang → badge luôn mới sau thao tác
  useEffect(() => {
    api<AdminStats>('GET', '/admin/stats').then(setStats).catch(() => undefined);
  }, [location.pathname]);

  return (
    <div className="admin-shell">
      <aside className="admin-nav">
        <strong className="brand">ReLoop Admin</strong>
        {MENU.map((g) => (
          <div key={g.group} className="admin-group">
            <span className="muted small">{g.group}</span>
            {g.items.map((it) => {
              const n = stats && it.badge ? it.badge(stats) : 0;
              return (
                <NavLink key={it.to} to={`/admin/${it.to}`} end>
                  {it.label} {n > 0 && <span className="badge warn">{n}</span>}
                </NavLink>
              );
            })}
          </div>
        ))}
        <Link to="/feed" className="small">
          ← Về trang người dùng
        </Link>
      </aside>
      <div className="admin-main">
        <header className="row between">
          <span className="muted">{session.label}</span>
          <span className="who">
            <NotificationBell admin={session.groups.includes('admin')} />
            <button className="link" onClick={onSignOut}>
              Đăng xuất
            </button>
          </span>
        </header>
        <Routes>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="profile" element={<AdminProfilePage session={session} />} />
          <Route path="partners" element={<PartnersAdmin />} />
          <Route path="risk-flags" element={<RiskFlagsAdmin />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="disputes" element={<DisputesAdmin />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="reports/resolved" element={<ResolvedReportsPage />} />
          <Route path="users" element={<MembersPage />} />
          <Route path="users/:id" element={<MemberDetailPage />} />
          <Route path="finance/invoices" element={<InvoicesAdmin />} />
          <Route path="finance/appeals" element={<FeeAppealsAdmin />} />
          <Route path="listings/review" element={<ListingReviewAdmin />} />
          <Route path="listings" element={<ListingsPage />} />
          <Route path="reports" element={<ReportsAdmin />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Routes>
      </div>
    </div>
  );
}
