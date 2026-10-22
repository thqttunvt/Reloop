import { useState } from 'react';
import { Link } from 'react-router-dom';
import { confirmReset, sendResetCode, startLogin } from '../lib/cognito';

/** Quên mật khẩu: nhập email → "Lấy mã" → nhập mã + mật khẩu mới (có nút hiện mật khẩu). */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = (fn: () => Promise<void>) => async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="center">
        <div className="card narrow stack">
          <h2>Đã đổi mật khẩu</h2>
          <p className="muted">Hãy đăng nhập lại bằng mật khẩu mới.</p>
          <button onClick={() => void startLogin()}>Đăng nhập</button>
        </div>
      </div>
    );
  }

  return (
    <div className="center">
      <div className="card narrow stack">
        <h2>Quên mật khẩu</h2>
        <form className="stack" onSubmit={run(async () => (await sendResetCode(email.trim()), setSent(true)))}>
          <label>
            Email đã đăng ký
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ban@gmail.com" />
          </label>
          <button type="submit" disabled={busy}>
            {sent ? 'Gửi lại mã' : 'Lấy mã'}
          </button>
        </form>
        {sent && (
          <form className="stack" onSubmit={run(async () => (await confirmReset(email.trim(), code.trim(), password), setDone(true)))}>
            <p className="muted">Nếu email đã đăng ký, mã xác minh đã được gửi tới hộp thư (xem cả mục Spam).</p>
            <label>
              Mã xác minh
              <input required inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <label>
              Mật khẩu mới
              <span className="row">
                <input type={show ? 'text' : 'password'} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="link" onClick={() => setShow(!show)}>
                  {show ? 'Ẩn' : 'Hiện'}
                </button>
              </span>
            </label>
            <button type="submit" disabled={busy}>
              Đổi mật khẩu
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
        <Link to="/">← Quay lại</Link>
      </div>
    </div>
  );
}
