import { HOUR_MS, type Clock } from '../../shared/clock';
import { keys } from '../../store/keys';
import type { Item, Table } from '../../store/table';
import type { Transaction } from '../transactions/transactionService';

const WINDOW_MS = 180 * 24 * HOUR_MS; // cửa sổ 180 ngày (giaiphap D15)
const MIN_REVIEWS = 3;
const MIN_ENDED = 5;

interface ReceivedRating extends Item {
  transactionId: string;
  rating: number;
  label: string;
  comment?: string;
  createdAt: string;
}

export interface Reputation {
  /** null = "Chưa đủ dữ liệu" */
  averageRating: number | null;
  reviewCount: number;
  completedCount: number;
  completionRate: number | null;
  cancellationRate: number | null;
  recentReviews: { rating: number; comment?: string; createdAt: string; label: string }[];
}

/**
 * Chỉ số uy tín cơ bản (QĐ-21, T12.3) — tính khi đọc từ các bản ghi đã có.
 *  - Average Rating: chỉ review từ giao dịch hoàn tất (VERIFIED / ADMIN_RESOLVED), hiện khi ≥ 3 review.
 *  - Completion Rate = COMPLETED / (COMPLETED + FAILED + CANCELLED bởi chính người này), hiện khi ≥ 5 giao dịch kết thúc.
 *  - Cancellation Rate = CANCELLED bởi chính người này / tổng giao dịch đã kết thúc.
 */
export class ReputationService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
  ) {}

  async of(userId: string, as: 'OWNER' | 'PARTNER'): Promise<Reputation> {
    const since = new Date(this.clock.now().getTime() - WINDOW_MS).toISOString();
    const [ratings, refs] = await Promise.all([
      this.table.query<ReceivedRating>(keys.userPk(userId), { skPrefix: 'RATING#', ascending: false, limit: 200 }),
      this.table.query<Item & { transactionId: string; role: string }>(keys.userPk(userId), { skPrefix: 'TX#', ascending: false, limit: 100 }),
    ]);

    const counted = ratings.filter((r) => r.createdAt >= since && r.label !== 'FAILED_TRANSACTION');
    const txs = (
      await Promise.all(
        refs
          .filter((r) => r.role === as)
          .map((r) => {
            const k = keys.transaction(r.transactionId);
            return this.table.get<Transaction>(k.pk, k.sk);
          }),
      )
    ).filter((t): t is Transaction => !!t && !!t.closedAt && t.closedAt >= since);

    const completed = txs.filter((t) => t.status === 'COMPLETED').length;
    const failed = txs.filter((t) => t.status === 'FAILED').length;
    const cancelledByMe = txs.filter((t) => t.status === 'CANCELLED' && t.cancel?.by === as).length;
    const ended = txs.length;

    return {
      averageRating: counted.length >= MIN_REVIEWS ? Math.round((counted.reduce((s, r) => s + r.rating, 0) / counted.length) * 10) / 10 : null,
      reviewCount: counted.length,
      completedCount: completed,
      completionRate: ended >= MIN_ENDED ? completed / (completed + failed + cancelledByMe || 1) : null,
      cancellationRate: ended >= MIN_ENDED ? cancelledByMe / ended : null,
      recentReviews: ratings.slice(0, 10).map(({ rating, comment, createdAt, label }) => ({ rating, comment, createdAt, label })),
    };
  }
}
