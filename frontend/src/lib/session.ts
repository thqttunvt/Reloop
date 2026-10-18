/**
 * Phiên đăng nhập.
 *  - dev:     backend AUTH_MODE=local, danh tính gửi qua header x-dev-user / x-dev-groups.
 *  - cognito: token từ Cognito (managed login), gửi qua Authorization: Bearer <idToken>.
 */
export interface Session {
  kind: 'dev' | 'cognito';
  userId: string;
  /** Tên hiển thị trên thanh trên cùng. */
  label: string;
  /** Nhóm quyền trong code: admin / admin_finance. */
  groups: string[];
  idToken?: string;
  refreshToken?: string;
  /** epoch ms khi idToken hết hạn */
  expiresAt?: number;
}

const KEY = 'reloop.session';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    // trình duyệt chặn storage → phiên chỉ sống trong bộ nhớ
  }
}
