import type { Clock } from '../../shared/clock';
import { badRequest, conflict, notFound } from '../../shared/errors';
import { assertVnd } from '../../shared/money';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putVersioned, type Item, type Table } from '../../store/table';
import { Ledger, REVENUE_OWNER, type PostingPlan } from './ledger';
import { commissionFor, maxPayeeFor, type FeePolicy } from './walletConfig';

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

export class WalletService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly ledger: Ledger,
    private readonly fees: FeePolicy,
  ) {}

  getWallet(userId: string) {
    return this.ledger.getWallet(userId);
  }

  listLedger(userId: string) {
    return this.ledger.listLedger(userId);
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
   * Không đủ số dư → 409 INSUFFICIENT_FUNDS (details.required).
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
