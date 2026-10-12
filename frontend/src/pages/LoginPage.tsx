import { useState } from 'react';
import type { DevSession } from '../lib/session';

const PRESETS: { label: string; session: DevSession }[] = [
  { label: 'Owner (người bán)', session: { userId: 'owner1', groups: [] } },
  { label: 'Partner (đơn vị thu mua)', session: { userId: 'partner1', groups: [] } },
  { label: 'Admin', session: { userId: 'admin1', groups: ['admin', 'admin_finance'] } },
];

/** Đăng nhập giả khi dev local — sẽ thay bằng Cognito Hosted UI khi lên AWS. */
export function LoginPage({ onSignIn }: { onSignIn: (s: DevSession) => void }) {
  const [userId, setUserId] = useState('');

  return (
    <div className="center">
      <div className="card narrow">
        <h1>ReLoop</h1>
        <p className="muted">Chế độ dev local — chọn người dùng để đăng nhập.</p>
        <div className="stack">
          {PRESETS.map((p) => (
            <button key={p.session.userId} onClick={() => onSignIn(p.session)}>
              {p.label} <span className="muted">({p.session.userId})</span>
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (userId.trim()) onSignIn({ userId: userId.trim(), groups: [] });
          }}
        >
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="hoặc nhập userId khác" />
          <button type="submit">Vào</button>
        </form>
      </div>
    </div>
  );
}
