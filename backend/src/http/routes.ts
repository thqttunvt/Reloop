import { requireGroup } from '../auth/auth';
import type { BankProvider } from '../bank/bankProvider';
import type { WithdrawalStatus } from '../domain/stateMachines';
import { badRequest } from '../shared/errors';
import type { UserService } from '../modules/users/userService';
import type { BankAccountStatus, PayoutService } from '../modules/wallet/payoutService';
import type { WalletService } from '../modules/wallet/walletService';
import type { Route } from './router';

export interface Services {
  users: UserService;
  wallet: WalletService;
  payouts: PayoutService;
  bankProvider: BankProvider;
}

const WITHDRAWAL_STATUSES: WithdrawalStatus[] = ['REQUESTED', 'PROCESSING', 'PAID', 'FAILED'];
const BANK_ACCOUNT_STATUSES: BankAccountStatus[] = ['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED'];

const oneOf = <T extends string>(value: string | undefined, allowed: T[], fallback: T): T => {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) throw badRequest('INVALID_QUERY', `Giá trị phải thuộc: ${allowed.join(', ')}`);
  return value as T;
};

export function apiRoutes(s: Services): Route[] {
  return [
    // ------------------------------------------------------------ Hồ sơ
    { method: 'GET', path: '/me', auth: 'required', handle: async (c) => ({ body: await s.users.getOrCreate(c.principal) }) },
    {
      method: 'PATCH',
      path: '/me',
      auth: 'required',
      handle: async (c) => ({ body: await s.users.update(c.principal, { fullName: c.body.fullName, phone: c.body.phone }) }),
    },

    // ------------------------------------------------------------ Phí (QĐ-32, QĐ-33)
    {
      method: 'GET',
      path: '/fees',
      auth: 'required',
      handle: async (c) => {
        const price = c.query.price === undefined ? 0 : Number(c.query.price);
        if (!Number.isSafeInteger(price) || price < 0) throw badRequest('INVALID_QUERY', 'price phải là số nguyên VND ≥ 0');
        return { body: s.wallet.feeQuote(price) };
      },
    },

    // ------------------------------------------------------------ Ví
    { method: 'GET', path: '/wallet', auth: 'required', handle: async (c) => ({ body: await s.wallet.getWallet(c.principal.userId) }) },
    {
      method: 'GET',
      path: '/wallet/ledger',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.wallet.listLedger(c.principal.userId) } }),
    },
    {
      method: 'POST',
      path: '/wallet/topups',
      auth: 'required',
      idempotent: true,
      handle: async (c) => ({ status: 201, body: await s.wallet.createTopUp(c.principal.userId, c.body.amount) }),
    },
    {
      method: 'GET',
      path: '/wallet/topups/{id}',
      auth: 'required',
      handle: async (c) => ({ body: await s.wallet.getTopUp(c.principal.userId, c.params.id!) }),
    },
    {
      method: 'POST',
      path: '/wallet/withdrawals',
      auth: 'required',
      idempotent: true,
      handle: async (c) => ({ status: 201, body: await s.payouts.requestWithdrawal(c.principal.userId, c.body) }),
    },
    {
      method: 'GET',
      path: '/wallet/withdrawals',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.payouts.listWithdrawals(c.principal.userId) } }),
    },
    {
      method: 'POST',
      path: '/bank-accounts',
      auth: 'required',
      handle: async (c) => ({ status: 201, body: await s.payouts.addBankAccount(c.principal.userId, c.body) }),
    },
    {
      method: 'GET',
      path: '/bank-accounts',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.payouts.listBankAccounts(c.principal.userId) } }),
    },

    // ------------------------------------------------------------ Webhook ngân hàng (không JWT — xác thực bằng bí mật của nhà cung cấp)
    {
      method: 'POST',
      path: '/webhooks/bank',
      auth: 'public',
      handle: async (c) => {
        const events = s.bankProvider.parseWebhook(c.headers, c.rawBody);
        const results = [];
        for (const e of events) {
          const r = await s.wallet.handleBankEvent(e);
          results.push({ bankTxnId: e.bankTxnId, type: r.journal.type, alreadyProcessed: r.alreadyPosted });
        }
        return { body: { ok: true, results } };
      },
    },

    // ------------------------------------------------------------ Admin
    {
      method: 'GET',
      path: '/admin/bank-accounts',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        const status = oneOf(c.query.status, BANK_ACCOUNT_STATUSES, 'PENDING_VERIFICATION');
        return { body: { items: await s.payouts.listBankAccountsByStatus(status) } };
      },
    },
    {
      method: 'POST',
      path: '/admin/users/{userId}/bank-accounts/{accountId}/review',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        if (typeof c.body.approve !== 'boolean') throw badRequest('INVALID_BODY', 'approve phải là true/false');
        const note = typeof c.body.note === 'string' ? c.body.note : undefined;
        return {
          body: await s.payouts.reviewBankAccount(c.principal.userId, c.params.userId!, c.params.accountId!, c.body.approve, note),
        };
      },
    },
    {
      method: 'GET',
      path: '/admin/withdrawals',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin_finance');
        const status = oneOf(c.query.status, WITHDRAWAL_STATUSES, 'REQUESTED');
        return { body: { items: await s.payouts.listWithdrawalsByStatus(status) } };
      },
    },
    {
      method: 'POST',
      path: '/admin/users/{userId}/withdrawals/{withdrawalId}/processing',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin_finance');
        return { body: await s.payouts.markProcessing(c.principal.userId, c.params.userId!, c.params.withdrawalId!) };
      },
    },
    {
      method: 'POST',
      path: '/admin/users/{userId}/withdrawals/{withdrawalId}/fail',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin_finance');
        const reason = typeof c.body.reason === 'string' && c.body.reason.trim() ? c.body.reason.trim() : undefined;
        if (!reason) throw badRequest('REASON_REQUIRED', 'Cần ghi lý do');
        return { body: await s.payouts.markFailed(c.params.userId!, c.params.withdrawalId!, reason) };
      },
    },
    {
      method: 'GET',
      path: '/admin/reconciliation',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin_finance');
        return {
          body: {
            invariant: await s.wallet.reconcile(),
            revenue: (await s.wallet.getRevenueWallet()).balances.available,
            openItems: await s.wallet.listOpenReconciliation(),
          },
        };
      },
    },
  ];
}

/**
 * CHỈ BẬT KHI STAGE=local. Thay cho các phần chưa có: OTP thật, webhook ngân hàng thật,
 * module giao dịch (giữ / kết thúc tiền).
 */
export function devRoutes(s: Services, webhookSecret: string): Route[] {
  let seq = 0;
  return [
    {
      method: 'POST',
      path: '/dev/verify-phone',
      auth: 'required',
      handle: async (c) => ({ body: await s.users.markPhoneVerified(c.principal.userId) }),
    },
    {
      // Giả lập "vừa có biến động số dư" — đi qua đúng đường webhook thật.
      method: 'POST',
      path: '/dev/bank-events',
      auth: 'required',
      handle: async (c) => {
        const payload = { bankTxnId: `dev-${Date.now()}-${++seq}`, ...c.body };
        const events = s.bankProvider.parseWebhook({ 'x-webhook-secret': webhookSecret }, JSON.stringify(payload));
        const results = [];
        for (const e of events) results.push(await s.wallet.handleBankEvent(e));
        return { body: { results } };
      },
    },
    {
      method: 'POST',
      path: '/dev/transactions/{id}/hold',
      auth: 'required',
      handle: async (c) => ({ body: await s.wallet.holdForTransaction(c.params.id!, c.principal.userId, c.body.amount) }),
    },
    {
      method: 'POST',
      path: '/dev/transactions/{id}/settle',
      auth: 'required',
      handle: async (c) => {
        const payeeId = typeof c.body.payeeId === 'string' ? c.body.payeeId : undefined;
        const payeeAmount = typeof c.body.payeeAmount === 'number' ? c.body.payeeAmount : Number.NaN;
        return { body: await s.wallet.settleTransaction(c.params.id!, payeeId, payeeAmount) };
      },
    },
    {
      // Tạm thay cho module Listing: thu phí đăng bài khi bấm Đăng.
      method: 'POST',
      path: '/dev/listings/{id}/fee',
      auth: 'required',
      handle: async (c) => ({ body: await s.wallet.chargeListingFee(c.params.id!, c.principal.userId) }),
    },
    {
      method: 'POST',
      path: '/dev/listings/{id}/fee-refund',
      auth: 'required',
      handle: async (c) => ({ body: await s.wallet.refundListingFee(c.params.id!) }),
    },
  ];
}
