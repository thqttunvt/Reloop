import { loadSession } from './session';

const BASE = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const session = loadSession();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session) {
    headers['x-dev-user'] = session.userId;
    if (session.groups.length) headers['x-dev-groups'] = session.groups.join(',');
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'HTTP_ERROR', data?.message ?? res.statusText);
  return data as T;
}

/** Mỗi lần người dùng bấm nút tạo 1 key mới; bấm lại do mạng lỗi thì dùng lại key cũ. */
export const newIdempotencyKey = () => crypto.randomUUID();

// ---- Kiểu dữ liệu trả về (khớp backend) ----
export type Bucket = 'available' | 'held' | 'withdrawing' | 'unallocated';

export interface Profile {
  userId: string;
  email?: string;
  fullName?: string;
  phone?: string;
  phoneVerified: boolean;
  roles: string[];
}

export interface Wallet {
  ownerId: string;
  balances: Record<Bucket, number>;
}

export interface TopUp {
  topUpId: string;
  code: string;
  amount: number;
  status: 'CREATED' | 'CREDITED' | 'EXPIRED';
  expiresAt: string;
  creditedAmount?: number;
}

export interface PaymentInstruction {
  bankBin: string;
  accountNo: string;
  accountName: string;
  amount: number;
  content: string;
  qrImageUrl: string;
}

export interface LedgerLine {
  journalId: string;
  type: string;
  delta: Record<Bucket, number>;
  balancesAfter: Record<Bucket, number>;
  at: string;
}

export interface BankAccount {
  accountId: string;
  userId: string;
  bankBin: string;
  accountNo: string;
  accountName: string;
  status: 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED';
  registeredName?: string;
  nameMatches?: boolean;
}

export interface Withdrawal {
  withdrawalId: string;
  userId: string;
  code: string;
  amount: number;
  status: 'REQUESTED' | 'PROCESSING' | 'PAID' | 'FAILED';
  destination: { bankBin: string; accountNo: string; accountName: string };
  createdAt: string;
  failReason?: string;
  transferQrImageUrl?: string;
}
