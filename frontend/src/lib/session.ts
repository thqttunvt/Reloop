/**
 * Phiên đăng nhập DEV: chỉ dùng khi backend chạy AUTH_MODE=local.
 * Khi lên AWS sẽ thay bằng token Cognito.
 */
export interface DevSession {
  userId: string;
  groups: string[];
}

const KEY = 'reloop.devSession';

export function loadSession(): DevSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DevSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: DevSession | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    // trình duyệt chặn storage → phiên chỉ sống trong bộ nhớ
  }
}
