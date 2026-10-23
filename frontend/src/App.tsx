import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BillingCard } from './components/BillingCard';
import { NotificationBell } from './components/NotificationBell';
import { TermsGate } from './components/TermsGate';
import { CALLBACK_PATH, completeLogin, logoutUrl } from './lib/cognito';
import { ACCOUNT_LOCKED_EVENT, SESSION_EXPIRED_EVENT, api, type BillingSummary, type Partner } from './lib/api';
import { loadSession, saveSession, type Session } from './lib/session';
import { AdminLayout } from './pages/admin/AdminLayout';
import { partnerLabel } from './lib/role';
import { ChatPage, ConversationsPage } from './pages/ChatPage';
import { CreateListingPage } from './pages/CreateListingPage';
import { FeedPage } from './pages/FeedPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ListingDetailPage } from './pages/ListingDetailPage';
import { LoginPage } from './pages/LoginPage';
import { MyListingsPage } from './pages/MyListingsPage';
import { PartnerPage } from './pages/PartnerPage';
import { ProfilePage } from './pages/ProfilePage';
import { TransactionDetailPage } from './pages/TransactionDetailPage';
import { TransactionsPage } from './pages/TransactionsPage';

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [loginError, setLoginError] = useState<string>();
  const location = useLocation();
  const navigate = useNavigate();
  const isCallback = location.pathname === CALLBACK_PATH;
  const [partner, setPartner] = useState<Partner | null>(null);

  // Menu theo vai trò (get.md B2): khách hàng → "Làm đối tác"; đối tác đã duyệt → nút Cấp 1 / Cấp 2 + nhãn PN1 / PN1V / PN2.
  // Hỏi lại khi vào / rời trang Đối tác (vừa được duyệt, vừa mua VIP).
  useEffect(() => {
    if (!session || isCallback) return;
    api<{ partner: Partner | null }>('GET', '/partners/me')
      .then((r) => setPartner(r.partner))
      .catch(() => undefined);
  }, [session, isCallback, location.pathname.startsWith('/partner') ? location.pathname : '']); // eslint-disable-line react-hooks/exhaustive-deps

  // Nợ phí quá hạn > 7 ngày → chỉ còn màn hình thanh toán phí (QĐ-40). Hỏi lại khi đổi trang / khi API báo khóa.
  const [locked, setLocked] = useState(false);
  const checkLock = useCallback(() => {
    if (!session || isCallback) return;
    api<BillingSummary>('GET', '/billing/me')
      .then((b) => setLocked(b.debt.level === 'FULL'))
      .catch(() => undefined);
  }, [session, isCallback]);
  useEffect(checkLock, [checkLock, location.pathname]);
  useEffect(() => {
    window.addEventListener(ACCOUNT_LOCKED_EVENT, checkLock);
    return () => window.removeEventListener(ACCOUNT_LOCKED_EVENT, checkLock);
  }, [checkLock]);

  // Cognito chuyển về /auth/callback?code=... → đổi code lấy token
  useEffect(() => {
    if (!isCallback) return;
    completeLogin(location.search)
      .then(setSession)
      .catch((e: Error) => setLoginError(e.message))
      .finally(() => navigate('/feed', { replace: true }));
  }, [isCallback]); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = (s: Session | null) => {
    saveSession(s);
    setSession(s);
  };

  // Phiên hết hạn hẳn (API trả 401) → về trang đăng nhập thay vì báo lỗi ở từng chỗ
  useEffect(() => {
    const expired = () => {
      saveSession(null);
      setSession(null);
      setLoginError('Phiên đăng nhập đã hết hạn — hãy đăng nhập lại');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, []);

  const signOut = () => {
    const wasCognito = session?.kind === 'cognito';
    signIn(null);
    if (wasCognito) window.location.assign(logoutUrl());
  };

  if (isCallback) return <div className="center">Đang đăng nhập…</div>;
  if (!session) {
    return location.pathname === '/forgot-password' ? <ForgotPasswordPage /> : <LoginPage onSignIn={signIn} error={loginError} />;
  }

  // Mọi API /admin/* cần nhóm Admins; chỉ thuộc FinanceAdmins thì không vào được trang Admin (mục 33 danhgia)
  const isAdmin = session.groups.includes('admin');
  // Trang Admin tách riêng: layout + menu riêng, không có thanh menu người dùng (get.md B3)
  if (isAdmin && location.pathname.startsWith('/admin')) {
    return (
      <TermsGate>
        {/* Route cha /admin/* để các route con relative (overview, users…) khớp — thiếu thì bị đẩy về Chợ */}
        <Routes>
          <Route path="/admin/*" element={<AdminLayout session={session} onSignOut={signOut} />} />
        </Routes>
      </TermsGate>
    );
  }
  const label = partnerLabel(partner);
  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">ReLoop</strong>
        <nav>
          <NavLink to="/feed">Chợ</NavLink>
          <NavLink to="/chat">Tin nhắn</NavLink>
          {label ? (
            <NavLink to="/partner">
              {label === 'PN2' ? 'Cấp 2' : 'Cấp 1'} <span className="badge ok">{label}</span>
            </NavLink>
          ) : (
            <NavLink to="/partner" className={({ isActive }) => `${isActive ? 'active' : ''} nav-cta`}>
              Làm đối tác
            </NavLink>
          )}
        </nav>
        <span className="who">
          <NotificationBell admin={session.groups.includes('admin')} />
          <details className="usermenu" key={location.pathname}>
            <summary>{session.label}</summary>
            <div className="dropdown">
              <Link to="/transactions">Giao dịch</Link>
              <Link to="/profile">Hồ sơ</Link>
              {isAdmin && <Link to="/admin">Trang Admin</Link>}
              <button className="link" onClick={signOut}>
                {session.kind === 'cognito' ? 'Đăng xuất' : 'Đổi người dùng'}
              </button>
            </div>
          </details>
        </span>
      </header>
      <main>
        <TermsGate>
        {locked && !location.pathname.startsWith('/admin') ? (
          <div className="stack">
            <div className="notice bad">
              <strong>Tài khoản tạm khóa do chưa thanh toán phí dịch vụ.</strong> Hóa đơn đã quá hạn trên 7 ngày. Hãy chuyển khoản theo hướng dẫn bên dưới
              — các chức năng khác sẽ hoạt động trở lại ngay khi Admin xác nhận đã nhận tiền.
              {isAdmin && (
                <>
                  {' '}
                  <Link to="/admin">Vào trang Admin</Link>
                </>
              )}
            </div>
            <BillingCard />
          </div>
        ) : (
        <Routes>
          <Route path="/feed" element={<FeedPage userId={session.userId} />} />
          <Route path="/listings" element={<MyListingsPage />} />
          <Route path="/listings/new" element={<CreateListingPage />} />
          <Route path="/listings/:id" element={<ListingDetailPage />} />
          <Route path="/chat" element={<ConversationsPage />} />
          <Route path="/chat/:id" element={<ChatPage userId={session.userId} />} />
          <Route path="/transactions" element={<TransactionsPage userId={session.userId} />} />
          <Route path="/transactions/:id" element={<TransactionDetailPage />} />
          <Route path="/partner/*" element={<PartnerPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
        )}
        </TermsGate>
      </main>
    </div>
  );
}
