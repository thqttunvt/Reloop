import type { Clock } from '../../shared/clock';
import { conflict } from '../../shared/errors';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { MAX_TRANSACT_OPS, putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';

/**
 * Sổ cái ví (QĐ-30, TL-02).
 *  available   — khả dụng: thanh toán hoặc rút
 *  held        — đang giữ cho giao dịch
 *  withdrawing — đã tạo lệnh rút, chờ chuyển
 *  unallocated — chỉ ví SYSTEM: tiền vào/ra TK ngân hàng chưa gắn được cho ai (chờ đối soát)
 *
 * Bất biến: tổng mọi bucket của mọi ví = số dư TK ngân hàng ReLoop (bankBalance).
 * Mỗi bút toán thỏa: tổng delta các dòng = bankDelta.
 */
export type Bucket = 'available' | 'held' | 'withdrawing' | 'unallocated';
export const BUCKETS: Bucket[] = ['available', 'held', 'withdrawing', 'unallocated'];
export const SYSTEM_OWNER = 'SYSTEM';
/** Ví doanh thu của ReLoop (hoa hồng + phí đăng bài, QĐ-02). */
export const REVENUE_OWNER = 'REVENUE';

export type JournalType =
  | 'TOPUP'
  | 'UNALLOCATED_IN'
  | 'UNALLOCATED_OUT'
  | 'HOLD'
  | 'SETTLE'
  | 'LISTING_FEE'
  | 'LISTING_FEE_REFUND'
  | 'WITHDRAW_REQUEST'
  | 'WITHDRAW_PAID'
  | 'WITHDRAW_FAILED';

export interface JournalLine {
  ownerId: string;
  bucket: Bucket;
  delta: number;
}

export interface Wallet extends Item {
  ownerId: string;
  balances: Record<Bucket, number>;
  updatedAt?: string;
}

export interface Journal extends Item {
  journalId: string;
  type: JournalType;
  lines: JournalLine[];
  bankDelta: number;
  ref: Record<string, string>;
  at: string;
}

export interface PostingPlan {
  type: JournalType;
  lines: JournalLine[];
  bankDelta: number;
  ref?: Record<string, string>;
  /** Ghi kèm trong CÙNG transaction (vd đổi trạng thái lệnh nạp). Phải có điều kiện version. */
  extraOps?: WriteOp[];
}

export interface PostResult {
  journal: Journal;
  alreadyPosted: boolean;
}

const emptyBalances = (): Record<Bucket, number> => ({ available: 0, held: 0, withdrawing: 0, unallocated: 0 });

/** Bucket duy nhất được phép âm: chênh lệch tiền ra không rõ nguồn, chờ Admin đối soát. */
const mayGoNegative = (ownerId: string, bucket: Bucket) => ownerId === SYSTEM_OWNER && bucket === 'unallocated';

export class Ledger {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
  ) {}

  async getWallet(ownerId: string): Promise<Wallet> {
    const k = keys.wallet(ownerId);
    return (await this.table.get<Wallet>(k.pk, k.sk)) ?? { ...k, ownerId, balances: emptyBalances(), version: 0 };
  }

  async getJournal(journalId: string): Promise<Journal | undefined> {
    const k = keys.journal(journalId);
    return this.table.get<Journal>(k.pk, k.sk);
  }

  async getBankBalance(): Promise<{ balance: number; version: number }> {
    const k = keys.bankBalance();
    const item = await this.table.get<Item & { balance: number }>(k.pk, k.sk);
    return { balance: item?.balance ?? 0, version: item?.version ?? 0 };
  }

  /**
   * Ghi một bút toán. journalId là khóa idempotency: id đã ghi → trả về bút toán cũ, không ghi lại.
   * plan() được gọi lại ở mỗi lần thử (đọc dữ liệu mới); lỗi nghiệp vụ trong plan() được ném thẳng ra.
   */
  post(journalId: string, plan: () => Promise<PostingPlan>): Promise<PostResult> {
    return withOptimisticRetry(async () => {
      const existing = await this.getJournal(journalId);
      if (existing) return { journal: existing, alreadyPosted: true };

      const p = await plan();
      validatePlan(journalId, p);

      const at = this.clock.now().toISOString();
      const deltasByOwner = new Map<string, Record<Bucket, number>>();
      for (const line of p.lines) {
        const d = deltasByOwner.get(line.ownerId) ?? emptyBalances();
        d[line.bucket] += line.delta;
        deltasByOwner.set(line.ownerId, d);
      }

      const ops: WriteOp[] = [];
      for (const [ownerId, delta] of deltasByOwner) {
        const wallet = await this.getWallet(ownerId);
        const balances = { ...wallet.balances };
        for (const bucket of BUCKETS) {
          balances[bucket] += delta[bucket];
          if (balances[bucket] < 0 && !mayGoNegative(ownerId, bucket)) {
            throw conflict('INSUFFICIENT_FUNDS', 'Số dư không đủ', {
              ownerId,
              bucket,
              current: wallet.balances[bucket],
              required: -delta[bucket],
            });
          }
        }
        ops.push(
          putVersioned(
            { ...keys.wallet(ownerId), ownerId, balances, updatedAt: at, gsi1pk: 'WALLETS', gsi1sk: ownerId },
            wallet.version ?? 0,
          ),
          putNew({
            ...keys.walletLedgerLine(ownerId, at, journalId),
            journalId,
            type: p.type,
            delta,
            balancesAfter: balances,
            ref: p.ref ?? {},
            at,
          }),
        );
      }

      if (p.bankDelta !== 0) {
        const bank = await this.getBankBalance();
        ops.push(putVersioned({ ...keys.bankBalance(), balance: bank.balance + p.bankDelta, updatedAt: at }, bank.version));
      }

      const journal: Journal = {
        ...keys.journal(journalId),
        journalId,
        type: p.type,
        lines: p.lines,
        bankDelta: p.bankDelta,
        ref: p.ref ?? {},
        at,
      };
      ops.push(putNew(journal), ...(p.extraOps ?? []));
      if (ops.length > MAX_TRANSACT_OPS) throw new Error(`Bút toán ${journalId} vượt ${MAX_TRANSACT_OPS} thao tác`);

      await this.table.transact(ops);
      return { journal, alreadyPosted: false };
    });
  }

  async listLedger(ownerId: string, limit = 50) {
    return this.table.query<Item>(keys.walletLedgerPk(ownerId), { skPrefix: 'LEDGER#', ascending: false, limit });
  }

  /** Kiểm tra bất biến tiền (job đối soát hằng ngày, T15.4). */
  async reconcile() {
    const wallets = await this.table.query<Wallet>('WALLETS', { index: 'gsi1' });
    const totals = emptyBalances();
    const negative: { ownerId: string; bucket: Bucket; balance: number }[] = [];
    for (const w of wallets) {
      for (const bucket of BUCKETS) {
        totals[bucket] += w.balances[bucket];
        if (w.balances[bucket] < 0 && !mayGoNegative(w.ownerId, bucket)) {
          negative.push({ ownerId: w.ownerId, bucket, balance: w.balances[bucket] });
        }
      }
    }
    const walletTotal = BUCKETS.reduce((s, b) => s + totals[b], 0);
    const { balance: bankBalance } = await this.getBankBalance();
    return { ok: walletTotal === bankBalance && negative.length === 0, walletTotal, bankBalance, totals, negative };
  }
}

function validatePlan(journalId: string, p: PostingPlan): void {
  for (const line of p.lines) {
    if (!Number.isSafeInteger(line.delta) || line.delta === 0) {
      throw new Error(`Bút toán ${journalId}: delta phải là số nguyên khác 0`);
    }
  }
  const sum = p.lines.reduce((s, l) => s + l.delta, 0);
  if (sum !== p.bankDelta) throw new Error(`Bút toán ${journalId} lệch: tổng dòng ${sum} ≠ bankDelta ${p.bankDelta}`);
}
