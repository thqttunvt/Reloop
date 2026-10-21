import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BillingCard } from './components/BillingCard';
import { NotificationBell } from './components/NotificationBell';
import { TermsGate } from './components/TermsGate';
import { CALLBACK_PATH, completeLogin, logoutUrl } from './lib/cognito';
import { ACCOUNT_LOCKED_EVENT, api, type BillingSummary, type Partner } from './lib/api';
import { loadSession, saveSession, type Session } from './lib/session';
import { AdminPage } from './pages/AdminPage';
import { ChatPage, ConversationsPage } from './pages/ChatPage';
import { CreateListingPage } from './pages/CreateListingPage';
import { FeedPage } from './pages/FeedPage';
import { ListingDetailPage } from './pages/ListingDetailPage';
import { LoginPage } from './pages/LoginPage';
import { MyListingsPage } from './pages/MyListingsPage';
import { PartnerPage } from './pages/PartnerPage';
import { ProfilePage } from './pages/ProfilePage';
import { TransactionDetailPage } from './pages/TransactionDetailPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { WalletPage } from './pages/WalletPage';

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [loginError, setLoginError] = useState<string>();
  const location = useLocation();
  const navigate = useNavigate();
  const isCallback = location.pathname === CALLBACK_PATH;
  const [partnerApproved, setPartnerApproved] = useState(true);

  // Chưa là đối tác đã duyệt → làm nổi bật "Đối tác" trên thanh menu (QĐ-34). Hỏi lại khi đổi trang cho tới khi được duyệt.
  useEffect(() => {
    if (!session || isCallback) return;
    api<{ partner: Partner | null }>('GET', '/partners/me')
      .then((r) => setPartnerApproved(r.partner?.status === 'APPROVED'))
      .catch(() => undefined);
  }, [session, isCallback, location.pathname === '/partner']); // eslint-disable-line react-hooks/exhaustive-deps

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

  const signOut = () => {
    const wasCognito = session?.kind === 'cognito';
    signIn(null);
    if (wasCognito) window.location.assign(logoutUrl());
  };

  if (isCallback) return <div className="center">Đang đăng nhập…</div>;
  if (!session) return <LoginPage onSignIn={signIn} error={loginError} />;

  const isAdmin = session.groups.includes('admin') || session.groups.includes('admin_finance');
  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">ReLoop</strong>
        <nav>
          <NavLink to="/feed">Chợ</NavLink>
          <NavLink to="/listings" end>
            Tin của tôi
          </NavLink>
          <NavLink to="/listings/new">Đăng tin</NavLink>
          <NavLink to="/chat">Tin nhắn</NavLink>
          <NavLink to="/transactions">Giao dịch</NavLink>
          <NavLink to="/partner" className={({ isActive }) => `${isActive ? 'active' : ''} ${partnerApproved ? '' : 'nav-cta'}`}>
            {partnerApproved ? 'Đối tác' : 'Làm đối tác'}
          </NavLink>
          <NavLink to="/wallet">Ví (đang fix)</NavLink>
          <NavLink to="/profile">Hồ sơ</NavLink>
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <span className="who">
          <NotificationBell admin={session.groups.includes('admin')} />
          {session.label}
          <button className="link" onClick={signOut}>
            {session.kind === 'cognito' ? 'Đăng xuất' : 'Đổi người dùng'}
          </button>
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
          <Route path="/partner" element={<PartnerPage />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          {isAdmin && <Route path="/admin" element={<AdminPage />} />}
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
        )}
        </TermsGate>
      </main>
    </div>
  );
}
