import type { BankEvent } from '../../bank/bankProvider';
import { topUpMachine, withdrawalMachine, type TopUpStatus } from '../../domain/stateMachines';
import type { Clock } from '../../shared/clock';
import { badRequest, conflict, notFound } from '../../shared/errors';
import { newId, shortCode } from '../../shared/ids';
import { assertVnd } from '../../shared/money';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';
import type { UserService } from '../users/userService';
import { BUCKETS, Ledger, REVENUE_OWNER, SYSTEM_OWNER, type PostingPlan, type Wallet } from './ledger';
import {
  commissionFor,
  maxPayeeFor,
  vietQrImageUrl,
  type BankAccountInfo,
  type FeePolicy,
  type WalletLimits,
} from './walletConfig';
import type { Withdrawal } from './payoutService';

export interface TopUp extends Item {
  topUpId: string;
  userId: string;
  code: string;
  amount: number;
  status: TopUpStatus;
  createdAt: string;
  expiresAt: string;
  creditedAmount?: number;
  bankTxnId?: string;
  creditedAt?: string;
}

export type HoldStatus = 'HELD' | 'FROZEN' | 'SETTLED';

export interface Hold extends Item {
  transactionId: string;
  payerId: string;
  amount: number;
  status: HoldStatus;
  settlement?: { payeeId?: string; payeeAmount: number; commission: number; refundAmount: number; at: string };
}

export interface ListingFee extends Item {
  listingId: string;
  ownerId: string;
  amount: number;
  /** WAIVED = bài miễn phí (bài đầu tiên) */
  status: 'CHARGED' | 'WAIVED' | 'REFUNDED';
  chargedAt: string;
  refundedAt?: string;
}

export interface ReconciliationItem extends Item {
  reconId: string;
  status: 'OPEN' | 'RESOLVED';
  reason: string;
  bankTxnId: string;
  direction: 'IN' | 'OUT';
  amount: number;
  content: string;
  at: string;
}

// Mã nạp RLN + 6 ký tự, mã rút RLR + 6 ký tự (bảng chữ cái của shortCode)
const TOPUP_CODE_RE = /RLN[A-HJKMNP-Z2-9]{6}/;
const WITHDRAWAL_CODE_RE = /RLR[A-HJKMNP-Z2-9]{6}/;
/** Ngân hàng hay chèn/bỏ khoảng trắng, dấu gạch trong nội dung CK → so khớp trên chuỗi chỉ còn chữ-số. */
const compact = (content: string) => content.toUpperCase().replace(/[^A-Z0-9]/g, '');

const walletTotal = (w: Wallet) => BUCKETS.reduce((s, b) => s + w.balances[b], 0);

export class WalletService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly ledger: Ledger,
    private readonly users: UserService,
    private readonly receivingAccount: BankAccountInfo,
    private readonly limits: WalletLimits,
    private readonly fees: FeePolicy,
  ) {}

  getWallet(userId: string) {
    return this.ledger.getWallet(userId);
  }

  listLedger(userId: string) {
    return this.ledger.listLedger(userId);
  }

  // ------------------------------------------------------------------ Nạp tiền (QĐ-04)

  async createTopUp(userId: string, rawAmount: unknown) {
    await this.users.requirePhoneVerified(userId);
    const amount = assertVnd(rawAmount);
    if (amount < this.limits.minTopUp) {
      throw badRequest('TOPUP_TOO_SMALL', `Nạp tối thiểu ${this.limits.minTopUp.toLocaleString('vi-VN')}đ`);
    }
    const wallet = await this.ledger.getWallet(userId);
    if (walletTotal(wallet) + amount > this.limits.maxBalance) {
      throw conflict('BALANCE_LIMIT_EXCEEDED', `Số dư ví tối đa ${this.limits.maxBalance.toLocaleString('vi-VN')}đ`);
    }

    const now = this.clock.now();
    const topUpId = newId();
    const code = `RLN${shortCode(6)}`;
    const topUp: TopUp = {
      ...keys.topUp(userId, topUpId),
      topUpId,
      userId,
      code,
      amount,
      status: 'CREATED',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.limits.topUpTtlMs).toISOString(),
    };
    await this.table.transact([putVersioned(topUp, 0), putNew({ ...keys.topUpCode(code), userId, topUpId })]);
    return { topUp: { ...topUp, version: 1 }, payment: this.paymentInstruction(amount, code) };
  }

  async getTopUp(userId: string, topUpId: string) {
    const k = keys.topUp(userId, topUpId);
    const topUp = await this.table.get<TopUp>(k.pk, k.sk);
    if (!topUp) throw notFound('lệnh nạp');
    return { topUp, payment: this.paymentInstruction(topUp.amount, topUp.code) };
  }

  private paymentInstruction(amount: number, content: string) {
    return { ...this.receivingAccount, amount, content, qrImageUrl: vietQrImageUrl(this.receivingAccount, amount, content) };
  }

  // ------------------------------------------------------------------ Webhook ngân hàng (TL-03)

  /** Idempotent theo bankTxnId: webhook gửi lại bao nhiêu lần cũng chỉ ghi sổ 1 lần. */
  handleBankEvent(event: BankEvent) {
    return event.direction === 'IN' ? this.handleIncoming(event) : this.handleOutgoing(event);
  }

  private handleIncoming(event: BankEvent) {
    return this.ledger.post(`BANKIN#${event.bankTxnId}`, async () => {
      const raw = this.rawBankTxnOp(event);
      const code = compact(event.content).match(TOPUP_CODE_RE)?.[0];
      const ref = await (code ? this.table.get<Item & { userId: string; topUpId: string }>(keys.topUpCode(code).pk, 'META') : undefined);
      const topUpKey = ref ? keys.topUp(ref.userId, ref.topUpId) : undefined;
      const topUp = topUpKey ? await this.table.get<TopUp>(topUpKey.pk, topUpKey.sk) : undefined;

      if (!topUp) return this.unallocated(event, code ? 'Không tìm thấy lệnh nạp với mã này' : 'Nội dung CK không có mã nạp', raw);
      if (!topUpMachine.canTransition(topUp.status, 'CREDITED', 'SYSTEM')) {
        return this.unallocated(event, `Lệnh nạp ${topUp.code} đã được cộng tiền trước đó`, raw);
      }
      const wallet = await this.ledger.getWallet(topUp.userId);
      if (walletTotal(wallet) + event.amount > this.limits.maxBalance) {
        return this.unallocated(event, `Vượt số dư tối đa của ví ${topUp.userId}`, raw);
      }

      // Cộng ĐÚNG số tiền thực nhận (người dùng có thể chuyển khác số đã khai).
      const credited: TopUp = {
        ...topUp,
        status: 'CREDITED',
        creditedAmount: event.amount,
        bankTxnId: event.bankTxnId,
        creditedAt: this.clock.now().toISOString(),
      };
      const plan: PostingPlan = {
        type: 'TOPUP',
        lines: [{ ownerId: topUp.userId, bucket: 'available', delta: event.amount }],
        bankDelta: event.amount,
        ref: { topUpId: topUp.topUpId, bankTxnId: event.bankTxnId },
        extraOps: [raw, putVersioned(credited, topUp.version ?? 0)],
      };
      return plan;
    });
  }

  private handleOutgoing(event: BankEvent) {
    return this.ledger.post(`BANKOUT#${event.bankTxnId}`, async () => {
      const raw = this.rawBankTxnOp(event);
      const code = compact(event.content).match(WITHDRAWAL_CODE_RE)?.[0];
      const ref = code ? await this.table.get<Item & { userId: string; withdrawalId: string }>(keys.withdrawalCode(code).pk, 'META') : undefined;
      const wdKey = ref ? keys.withdrawal(ref.userId, ref.withdrawalId) : undefined;
      const wd = wdKey ? await this.table.get<Withdrawal>(wdKey.pk, wdKey.sk) : undefined;

      if (!wd) return this.unallocated(event, 'Tiền ra không khớp lệnh rút nào', raw);
      if (!withdrawalMachine.canTransition(wd.status, 'PAID', 'SYSTEM')) {
        return this.unallocated(event, `Lệnh rút ${wd.code} đang ở trạng thái ${wd.status}`, raw);
      }
      if (event.amount !== wd.amount) {
        return this.unallocated(event, `Số tiền ra ${event.amount} khác lệnh rút ${wd.code} (${wd.amount})`, raw);
      }

      const at = this.clock.now().toISOString();
      const paid: Withdrawal = { ...wd, status: 'PAID', paidAt: at, bankTxnId: event.bankTxnId, gsi1pk: 'WD#STATUS#PAID', gsi1sk: at };
      const plan: PostingPlan = {
        type: 'WITHDRAW_PAID',
        lines: [{ ownerId: wd.userId, bucket: 'withdrawing', delta: -wd.amount }],
        bankDelta: -wd.amount,
        ref: { withdrawalId: wd.withdrawalId, bankTxnId: event.bankTxnId },
        extraOps: [raw, putVersioned(paid, wd.version ?? 0)],
      };
      return plan;
    });
  }

  /** Tiền vào/ra không gắn được cho ai → ví SYSTEM.unallocated + hàng đợi đối soát của Admin. */
  private unallocated(event: BankEvent, reason: string, raw: WriteOp): PostingPlan {
    const delta = event.direction === 'IN' ? event.amount : -event.amount;
    const at = this.clock.now().toISOString();
    const reconId = newId();
    const recon: ReconciliationItem = {
      ...keys.reconciliation(at, reconId),
      reconId,
      status: 'OPEN',
      reason,
      bankTxnId: event.bankTxnId,
      direction: event.direction,
      amount: event.amount,
      content: event.content,
      at,
      gsi1pk: 'RECON#STATUS#OPEN',
      gsi1sk: at,
    };
    return {
      type: event.direction === 'IN' ? 'UNALLOCATED_IN' : 'UNALLOCATED_OUT',
      lines: [{ ownerId: SYSTEM_OWNER, bucket: 'unallocated', delta }],
      bankDelta: delta,
      ref: { bankTxnId: event.bankTxnId, reconId },
      extraOps: [raw, putNew(recon)],
    };
  }

  /** Lưu nguyên payload để đối soát (TL-03). */
  private rawBankTxnOp(event: BankEvent): WriteOp {
    return putNew({ ...keys.bankTxn(event.bankTxnId), ...event, receivedAt: this.clock.now().toISOString() });
  }

  listOpenReconciliation() {
    return this.table.query<ReconciliationItem>('RECON#STATUS#OPEN', { index: 'gsi1', ascending: false });
  }

  reconcile() {
    return this.ledger.reconcile();
  }

  // ------------------------------------------------------------------ Giữ tiền cho giao dịch (QĐ-05 → QĐ-08)

  async getHold(transactionId: string): Promise<Hold | undefined> {
    const k = keys.hold(transactionId);
    return this.table.get<Hold>(k.pk, k.sk);
  }

  /**
   * Trừ Khả dụng → Đang giữ. seq > 1 dùng khi phải giữ thêm (hàng theo kg vượt ước tính, QĐ-26).
   * Gọi lại cùng (transactionId, seq) không trừ lần 2.
   */
  holdForTransaction(transactionId: string, payerId: string, rawAmount: unknown, seq = 1) {
    const amount = assertVnd(rawAmount);
    return this.ledger.post(`HOLD#${transactionId}#${seq}`, async () => {
      const hold = await this.getHold(transactionId);
      if (hold && hold.payerId !== payerId) throw conflict('HOLD_PAYER_MISMATCH', 'Giao dịch đã được thanh toán bởi người khác');
      if (hold && hold.status !== 'HELD') throw conflict('HOLD_NOT_ACTIVE', `Khoản giữ đang ở trạng thái ${hold.status}`);

      const next: Hold = hold
        ? { ...hold, amount: hold.amount + amount }
        : { ...keys.hold(transactionId), transactionId, payerId, amount, status: 'HELD' };
      return {
        type: 'HOLD',
        lines: [
          { ownerId: payerId, bucket: 'available', delta: -amount },
          { ownerId: payerId, bucket: 'held', delta: amount },
        ],
        bankDelta: 0,
        ref: { transactionId },
        extraOps: [putVersioned(next, hold?.version ?? 0)],
      };
    });
  }

  /** Bảng giá cho frontend: bên trả phải có bao nhiêu để thanh toán một mức giá (QĐ-32). */
  feeQuote(price: number) {
    const commission = commissionFor(price, this.fees);
    return { price, commission, payerTotal: price + commission, policy: this.fees };
  }

  /**
   * Kết thúc khoản giữ: payeeAmount (giá cuối) sang Khả dụng của bên nhận, hoa hồng tính trên giá cuối
   * sang ví REVENUE, phần còn lại trả về bên trả (QĐ-06, QĐ-07, QĐ-32).
   * Hủy/thất bại → payeeAmount = 0 → không thu phí, hoàn toàn bộ.
   * Khoản đang FROZEN (tranh chấp) chỉ Admin được kết thúc (QĐ-08).
   */
  settleTransaction(transactionId: string, payeeId: string | undefined, rawPayeeAmount: number, opts: { byAdmin?: boolean } = {}) {
    if (!Number.isSafeInteger(rawPayeeAmount) || rawPayeeAmount < 0) {
      throw badRequest('INVALID_AMOUNT', 'payeeAmount phải là số nguyên ≥ 0');
    }
    if (rawPayeeAmount > 0 && !payeeId) throw badRequest('PAYEE_REQUIRED', 'Thiếu bên nhận tiền');

    return this.ledger.post(`SETTLE#${transactionId}`, async () => {
      const hold = await this.getHold(transactionId);
      if (!hold) throw notFound('khoản giữ tiền của giao dịch');
      if (hold.status === 'SETTLED') throw conflict('HOLD_ALREADY_SETTLED', 'Khoản giữ đã được kết thúc');
      if (hold.status === 'FROZEN' && !opts.byAdmin) throw conflict('HOLD_FROZEN', 'Tiền đang bị đóng băng do tranh chấp');
      const commission = commissionFor(rawPayeeAmount, this.fees);
      if (rawPayeeAmount + commission > hold.amount) {
        throw conflict('PAYEE_AMOUNT_EXCEEDS_HOLD', 'Giá cuối cộng hoa hồng vượt số đang giữ', {
          held: hold.amount,
          maxPayeeAmount: maxPayeeFor(hold.amount, this.fees),
        });
      }

      const refundAmount = hold.amount - rawPayeeAmount - commission;
      const lines: PostingPlan['lines'] = [{ ownerId: hold.payerId, bucket: 'held', delta: -hold.amount }];
      if (rawPayeeAmount > 0) lines.push({ ownerId: payeeId!, bucket: 'available', delta: rawPayeeAmount });
      if (commission > 0) lines.push({ ownerId: REVENUE_OWNER, bucket: 'available', delta: commission });
      if (refundAmount > 0) lines.push({ ownerId: hold.payerId, bucket: 'available', delta: refundAmount });

      const settled: Hold = {
        ...hold,
        status: 'SETTLED',
        settlement: { payeeId, payeeAmount: rawPayeeAmount, commission, refundAmount, at: this.clock.now().toISOString() },
      };
      return {
        type: 'SETTLE',
        lines,
        bankDelta: 0,
        ref: { transactionId },
        extraOps: [putVersioned(settled, hold.version ?? 0)],
      };
    });
  }

  // ------------------------------------------------------------------ Phí đăng bài (QĐ-33)

  async getListingFee(listingId: string): Promise<ListingFee | undefined> {
    const k = keys.listingFee(listingId);
    return this.table.get<ListingFee>(k.pk, k.sk);
  }

  /**
   * Thu phí khi Owner bấm Đăng. Bài đầu tiên của mỗi tài khoản miễn phí.
   * Không đủ số dư → 409 INSUFFICIENT_FUNDS (details.required) để frontend hiện QR nạp phần thiếu.
   * Gọi lại cùng listingId không thu lần 2.
   */
  async chargeListingFee(listingId: string, ownerId: string) {
    await this.ledger.post(`LISTINGFEE#${listingId}`, async () => {
      const ck = keys.listingFeeCounter(ownerId);
      const counter = await this.table.get<Item & { count: number }>(ck.pk, ck.sk);
      const used = counter?.count ?? 0;
      const amount = used < this.fees.freeListings ? 0 : this.fees.listingFee;
      const fee: ListingFee = {
        ...keys.listingFee(listingId),
        listingId,
        ownerId,
        amount,
        status: amount === 0 ? 'WAIVED' : 'CHARGED',
        chargedAt: this.clock.now().toISOString(),
      };
      return {
        type: 'LISTING_FEE',
        lines:
          amount === 0
            ? []
            : [
                { ownerId, bucket: 'available', delta: -amount },
                { ownerId: REVENUE_OWNER, bucket: 'available', delta: amount },
              ],
        bankDelta: 0,
        ref: { listingId },
        extraOps: [putVersioned(fee, 0), putVersioned({ ...ck, count: used + 1 }, counter?.version ?? 0)],
      };
    });
    return (await this.getListingFee(listingId))!;
  }

  /** Hoàn phí khi tin hết hạn 7 ngày mà không có báo giá được xác nhận (quyết định do module Listing). */
  async refundListingFee(listingId: string) {
    await this.ledger.post(`LISTINGFEEREFUND#${listingId}`, async () => {
      const fee = await this.getListingFee(listingId);
      if (!fee) throw notFound('phí đăng bài');
      if (fee.status !== 'CHARGED') throw conflict('LISTING_FEE_NOT_REFUNDABLE', `Phí đang ở trạng thái ${fee.status}`);
      return {
        type: 'LISTING_FEE_REFUND',
        lines: [
          { ownerId: REVENUE_OWNER, bucket: 'available', delta: -fee.amount },
          { ownerId: fee.ownerId, bucket: 'available', delta: fee.amount },
        ],
        bankDelta: 0,
        ref: { listingId },
        extraOps: [putVersioned({ ...fee, status: 'REFUNDED', refundedAt: this.clock.now().toISOString() }, fee.version ?? 0)],
      };
    });
    return (await this.getListingFee(listingId))!;
  }

  getRevenueWallet() {
    return this.ledger.getWallet(REVENUE_OWNER);
  }

  freezeHold(transactionId: string) {
    return this.setHoldStatus(transactionId, 'HELD', 'FROZEN');
  }

  unfreezeHold(transactionId: string) {
    return this.setHoldStatus(transactionId, 'FROZEN', 'HELD');
  }

  private setHoldStatus(transactionId: string, from: HoldStatus, to: HoldStatus) {
    return withOptimisticRetry(async () => {
      const hold = await this.getHold(transactionId);
      if (!hold) throw notFound('khoản giữ tiền của giao dịch');
      if (hold.status === to) return hold;
      if (hold.status !== from) throw conflict('HOLD_INVALID_STATUS', `Khoản giữ đang ${hold.status}, không thể chuyển sang ${to}`);
      const next = { ...hold, status: to };
      await this.table.transact([putVersioned(next, hold.version ?? 0)]);
      return { ...next, version: (hold.version ?? 0) + 1 };
    });
  }
}
