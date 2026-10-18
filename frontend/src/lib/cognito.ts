import { saveSession, type Session } from './session';

/**
 * Đăng nhập qua Cognito managed login (user pool ReLoop-user-pool, domain reloop-auth),
 * OAuth 2.0 authorization code + PKCE — app client reloop-web-client không có client secret.
 */
const DOMAIN = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;

export const cognitoEnabled = Boolean(DOMAIN && CLIENT_ID);

export const CALLBACK_PATH = '/auth/callback';
const redirectUri = () => `${window.location.origin}${CALLBACK_PATH}`;
const PKCE_KEY = 'reloop.pkce';

/** Group Cognito → nhóm quyền trong code (khớp backend/src/auth/auth.ts). */
const GROUP_MAP: Record<string, string> = { Admins: 'admin', FinanceAdmins: 'admin_finance' };

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomString = (len = 32) => base64url(crypto.getRandomValues(new Uint8Array(len)));

export async function startLogin(): Promise<void> {
  const verifier = randomString(48);
  const state = randomString(16);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID!,
    redirect_uri: redirectUri(),
    scope: 'openid email phone',
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  window.location.assign(`${DOMAIN}/oauth2/authorize?${params}`);
}

export function logoutUrl(): string {
  const params = new URLSearchParams({ client_id: CLIENT_ID!, logout_uri: `${window.location.origin}/` });
  return `${DOMAIN}/logout?${params}`;
}

interface TokenResponse {
  id_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID!, ...body }),
  });
  if (!res.ok) throw new Error(`Cognito token: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

const decodeJwt = (jwt: string): Record<string, unknown> => {
  const payload = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
  const json = decodeURIComponent(
    Array.from(atob(payload), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
  );
  return JSON.parse(json) as Record<string, unknown>;
};

const toSession = (t: TokenResponse, refreshToken: string | undefined): Session => {
  const claims = decodeJwt(t.id_token);
  const groups = Array.isArray(claims['cognito:groups']) ? (claims['cognito:groups'] as string[]) : [];
  return {
    kind: 'cognito',
    userId: String(claims.sub),
    label: String(claims.email ?? claims['cognito:username'] ?? claims.sub),
    groups: groups.flatMap((g) => (GROUP_MAP[g] ? [GROUP_MAP[g]!] : [])),
    idToken: t.id_token,
    refreshToken: t.refresh_token ?? refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
};

/** Gọi khi trình duyệt quay về /auth/callback?code=...&state=... */
export async function completeLogin(search: string): Promise<Session> {
  const params = new URLSearchParams(search);
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as { verifier: string; state: string } | null;
  sessionStorage.removeItem(PKCE_KEY);
  const error = params.get('error_description') ?? params.get('error');
  if (error) throw new Error(error);
  const code = params.get('code');
  if (!code || !saved || params.get('state') !== saved.state) throw new Error('Phiên đăng nhập không hợp lệ, vui lòng thử lại');
  const session = toSession(
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: saved.verifier }),
    undefined,
  );
  saveSession(session);
  return session;
}

/** Trả về idToken còn hạn; tự làm mới bằng refresh token khi sắp hết hạn. */
export async function freshIdToken(session: Session): Promise<string | undefined> {
  if (!session.idToken) return undefined;
  if (!session.expiresAt || session.expiresAt - Date.now() > 60_000) return session.idToken;
  if (!session.refreshToken) return session.idToken;
  try {
    const next = toSession(await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken }), session.refreshToken);
    saveSession(next);
    return next.idToken;
  } catch {
    saveSession(null);
    window.location.assign('/');
    return undefined;
  }
}
