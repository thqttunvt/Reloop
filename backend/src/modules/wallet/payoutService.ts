import { withdrawalMachine, type WithdrawalStatus } from '../../domain/stateMachines';
import type { Clock } from '../../shared/clock';
import { badRequest, conflict, notFound } from '../../shared/errors';
import { newId, shortCode } from '../../shared/ids';
import { assertVnd } from '../../shared/money';
import { gsi1, keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putNew, putVersioned, type Item, type Table } from '../../store/table';
import type { UserService } from '../users/userService';
import type { Ledger } from './ledger';
import { normalizeName, vietQrImageUrl, type BankAccountInfo, type WalletLimits } from './walletConfig';

export type BankAccountStatus = 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED';

export interface BankAccount extends Item, BankAccountInfo {
  accountId: string;
  userId: string;
  status: BankAccountStatus;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  note?: string;
}

export interface Withdrawal extends Item {
  withdrawalId: string;
  userId: string;
  code: string;
  amount: number;
  /** Bản sao STK lúc tạo lệnh — đổi STK sau đó không ảnh hưởng lệnh cũ. */
  destination: BankAccountInfo;
  status: WithdrawalStatus;
  createdAt: string;
  processingAt?: string;
  processingBy?: string;
  paidAt?: string;
  failedAt?: string;
  failReason?: string;
  bankTxnId?: string;
}

const ACCOUNT_NO_RE = /^\d{6,20}$/;
const BIN_RE = /^\d{6}$/;

export class PayoutService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly ledger: Ledger,
    private readonly users: UserService,
    private readonly limits: WalletLimits,
  ) {}

  // ------------------------------------------------------------------ Tài khoản ngân hàng nhận tiền

  async addBankAccount(userId: string, input: { bankBin?: unknown; accountNo?: unknown; accountName?: unknown }) {
    const { bankBin, accountNo, accountName } = input;
    if (typeof bankBin !== 'string' || !BIN_RE.test(bankBin)) throw badRequest('INVALID_BANK_BIN', 'Mã BIN ngân hàng gồm 6 chữ số');
    if (typeof accountNo !== 'string' || !ACCOUNT_NO_RE.test(accountNo)) throw badRequest('INVALID_ACCOUNT_NO', 'Số tài khoản không hợp lệ');
    if (typeof accountName !== 'string' || accountName.trim().length < 2) throw badRequest('INVALID_ACCOUNT_NAME', 'Thiếu tên chủ tài khoản');

    const at = this.clock.now().toISOString();
    const accountId = newId();
    const account: BankAccount = {
      ...keys.bankAccount(userId, accountId),
      ...gsi1.byStatus('BANKACC', 'PENDING_VERIFICATION', at),
      accountId,
      userId,
      bankBin,
      accountNo,
      accountName: normalizeName(accountName),
      status: 'PENDING_VERIFICATION',
      createdAt: at,
    };
    await this.table.transact([putVersioned(account, 0)]);
    return { ...account, version: 1 };
  }

  listBankAccounts(userId: string) {
    return this.table.query<BankAccount>(`USER#${userId}`, { skPrefix: 'BANKACC#' });
  }

  /** Hàng đợi Admin, kèm gợi ý tên chủ TK có khớp họ tên hồ sơ không (QĐ-31). */
  async listBankAccountsByStatus(status: BankAccountStatus) {
    const accounts = await this.table.query<BankAccount>(gsi1.statusPk('BANKACC', status), { index: 'gsi1' });
    return Promise.all(
      accounts.map(async (a) => {
        const profile = await this.users.get(a.userId);
        const registeredName = profile?.fullName;
        return {
          ...a,
          registeredName,
          nameMatches: registeredName ? normalizeName(registeredName) === a.accountName : false,
        };
      }),
    );
  }

  reviewBankAccount(adminId: string, userId: string, accountId: string, approve: boolean, note?: string) {
    return withOptimisticRetry(async () => {
      const k = keys.bankAccount(userId, accountId);
      const account = await this.table.get<BankAccount>(k.pk, k.sk);
      if (!account) throw notFound('tài khoản ngân hàng');
      if (account.status !== 'PENDING_VERIFICATION') throw conflict('ALREADY_REVIEWED', 'Tài khoản đã được duyệt trước đó');
      const at = this.clock.now().toISOString();
      const status: BankAccountStatus = approve ? 'VERIFIED' : 'REJECTED';
      const next: BankAccount = {
        ...account,
        ...gsi1.byStatus('BANKACC', status, at),
        status,
        reviewedBy: adminId,
        reviewedAt: at,
        note,
      };
      await this.table.transact([putVersioned(next, account.version ?? 0)]);
      return { ...next, version: (account.version ?? 0) + 1 };
    });
  }

  // ------------------------------------------------------------------ Rút tiền (QĐ-31)

  async requestWithdrawal(userId: string, input: { amount?: unknown; bankAccountId?: unknown }) {
    await this.users.requirePhoneVerified(userId);
    const amount = assertVnd(input.amount);
    if (amount < this.limits.minWithdrawal) {
      throw badRequest('WITHDRAWAL_TOO_SMALL', `Rút tối thiểu ${this.limits.minWithdrawal.toLocaleString('vi-VN')}đ`);
    }
    if (typeof input.bankAccountId !== 'string') throw badRequest('BANK_ACCOUNT_REQUIRED', 'Thiếu tài khoản nhận');
    const k = keys.bankAccount(userId, input.bankAccountId);
    const account = await this.table.get<BankAccount>(k.pk, k.sk);
    if (!account) throw notFound('tài khoản ngân hàng');
    if (account.status !== 'VERIFIED') throw conflict('BANK_ACCOUNT_NOT_VERIFIED', 'Tài khoản ngân hàng chưa được Admin xác minh');

    const withdrawalId = newId();
    const code = `RLR${shortCode(6)}`;
    const at = this.clock.now().toISOString();
    const withdrawal: Withdrawal = {
      ...keys.withdrawal(userId, withdrawalId),
      ...gsi1.byStatus('WD', 'REQUESTED', at),
      withdrawalId,
      userId,
      code,
      amount,
      destination: { bankBin: account.bankBin, accountNo: account.accountNo, accountName: account.accountName },
      status: 'REQUESTED',
      createdAt: at,
    };
    await this.ledger.post(`WDREQ#${withdrawalId}`, async () => ({
      type: 'WITHDRAW_REQUEST',
      lines: [
        { ownerId: userId, bucket: 'available', delta: -amount },
        { ownerId: userId, bucket: 'withdrawing', delta: amount },
      ],
      bankDelta: 0,
      ref: { withdrawalId },
      extraOps: [putVersioned(withdrawal, 0), putNew({ ...keys.withdrawalCode(code), userId, withdrawalId })],
    }));
    return { ...withdrawal, version: 1 };
  }

  listWithdrawals(userId: string) {
    return this.table.query<Withdrawal>(`USER#${userId}`, { skPrefix: 'WD#', ascending: false });
  }

  /** Hàng đợi Admin: kèm QR chuyển tới STK người dùng, nội dung = mã lệnh rút (để webhook tiền ra khớp). */
  async listWithdrawalsByStatus(status: WithdrawalStatus) {
    const items = await this.table.query<Withdrawal>(gsi1.statusPk('WD', status), { index: 'gsi1' });
    return items.map((w) => ({ ...w, transferQrImageUrl: vietQrImageUrl(w.destination, w.amount, w.code) }));
  }

  markProcessing(adminId: string, userId: string, withdrawalId: string) {
    return this.transition(userId, withdrawalId, 'PROCESSING', 'ADMIN', (w, at) => ({
      ...w,
      processingAt: at,
      processingBy: adminId,
    }));
  }

  /** Chuyển khoản lỗi → trả tiền về Khả dụng. */
  async markFailed(userId: string, withdrawalId: string, reason: string) {
    const k = keys.withdrawal(userId, withdrawalId);
    const result = await this.ledger.post(`WDFAIL#${withdrawalId}`, async () => {
      const w = await this.table.get<Withdrawal>(k.pk, k.sk);
      if (!w) throw notFound('lệnh rút');
      withdrawalMachine.assertTransition(w.status, 'FAILED', 'ADMIN');
      const at = this.clock.now().toISOString();
      const failed: Withdrawal = { ...w, ...gsi1.byStatus('WD', 'FAILED', at), status: 'FAILED', failedAt: at, failReason: reason };
      return {
        type: 'WITHDRAW_FAILED',
        lines: [
          { ownerId: userId, bucket: 'withdrawing', delta: -w.amount },
          { ownerId: userId, bucket: 'available', delta: w.amount },
        ],
        bankDelta: 0,
        ref: { withdrawalId },
        extraOps: [putVersioned(failed, w.version ?? 0)],
      };
    });
    return result.journal;
  }

  private transition(
    userId: string,
    withdrawalId: string,
    to: WithdrawalStatus,
    actor: 'ADMIN' | 'SYSTEM',
    change: (w: Withdrawal, at: string) => Withdrawal,
  ) {
    return withOptimisticRetry(async () => {
      const k = keys.withdrawal(userId, withdrawalId);
      const w = await this.table.get<Withdrawal>(k.pk, k.sk);
      if (!w) throw notFound('lệnh rút');
      withdrawalMachine.assertTransition(w.status, to, actor);
      const at = this.clock.now().toISOString();
      const next = { ...change(w, at), ...gsi1.byStatus('WD', to, at), status: to };
      await this.table.transact([putVersioned(next, w.version ?? 0)]);
      return { ...next, version: (w.version ?? 0) + 1 };
    });
  }
}
