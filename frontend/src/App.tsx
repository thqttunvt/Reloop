import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { loadSession, saveSession, type DevSession } from './lib/session';
import { AdminPage } from './pages/AdminPage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { WalletPage } from './pages/WalletPage';

export function App() {
  const [session, setSession] = useState<DevSession | null>(loadSession);

  const signIn = (s: DevSession | null) => {
    saveSession(s);
    setSession(s);
  };

  if (!session) return <LoginPage onSignIn={signIn} />;

  const isAdmin = session.groups.includes('admin') || session.groups.includes('admin_finance');
  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">ReLoop</strong>
        <nav>
          <NavLink to="/wallet">Ví</NavLink>
          <NavLink to="/profile">Hồ sơ</NavLink>
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <span className="who">
          {session.userId}
          <button className="link" onClick={() => signIn(null)}>
            Đổi người dùng
          </button>
        </span>
      </header>
      <main>
        <Routes>
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          {isAdmin && <Route path="/admin" element={<AdminPage groups={session.groups} />} />}
          <Route path="*" element={<Navigate to="/wallet" replace />} />
        </Routes>
      </main>
    </div>
  );
}
