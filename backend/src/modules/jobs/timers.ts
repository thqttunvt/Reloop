import { HOUR_MS, type Clock } from '../../shared/clock';
import { log } from '../../http/log';
import { keys } from '../../store/keys';
import { putNew, type Item, type Table, type WriteOp } from '../../store/table';

/**
 * Hẹn giờ cho việc nền (Epic 10, giaiphap E3) mà không cần Scan:
 * mỗi mốc là 1 item trong "ngăn" theo giờ: PK = TIMER#<YYYY-MM-DDTHH>, SK = <kind>#<id>.
 * Job quét định kỳ đọc các ngăn từ 72 giờ trước tới hiện tại, xử lý mốc đã tới hạn rồi xóa.
 * Mọi xử lý đều kiểm tra lại trạng thái hiện tại → chạy trễ / chạy trùng không gây sai (T10.2).
 */
export type TimerKind = 'LISTING_EXPIRE' | 'TX_REMIND' | 'TX_AUTO_COMPLETE' | 'TX_CANCEL';

export interface Timer extends Item {
  kind: TimerKind;
  targetId: string;
  dueAt: string;
}

const bucketOf = (iso: string) => iso.slice(0, 13); // YYYY-MM-DDTHH
const LOOKBACK_HOURS = 72;

/** overwrite: mốc có thể đặt lại nhiều lần cho cùng đối tượng (vd yêu cầu hủy → rút → yêu cầu lại). */
export function timerOp(kind: TimerKind, targetId: string, dueAt: string, overwrite = false): WriteOp {
  const item = { ...keys.timer(bucketOf(dueAt), kind, targetId), kind, targetId, dueAt } satisfies Timer;
  return overwrite ? { type: 'put', item } : putNew(item);
}

export type TimerHandler = (timer: Timer) => Promise<void>;

export class TimerSweeper {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly handlers: Record<TimerKind, TimerHandler>,
    /** Việc định kỳ chạy sau mỗi lượt quét (vd lập hóa đơn tháng — QĐ-37). Phải idempotent. */
    private readonly periodic: (() => Promise<void>)[] = [],
  ) {}

  async sweep(): Promise<{ processed: number; failed: number }> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    let processed = 0;
    let failed = 0;
    for (let h = LOOKBACK_HOURS; h >= 0; h--) {
      const bucket = bucketOf(new Date(now.getTime() - h * HOUR_MS).toISOString());
      const timers = await this.table.query<Timer>(keys.timerPk(bucket));
      for (const t of timers) {
        if (t.dueAt > nowIso) continue;
        try {
          await this.handlers[t.kind](t);
          await this.table.transact([{ type: 'delete', pk: t.pk, sk: t.sk }]);
          processed++;
        } catch (err) {
          failed++; // giữ lại timer để lần quét sau thử lại
          log('error', 'timer_failed', { kind: t.kind, targetId: t.targetId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    for (const job of this.periodic) {
      try {
        await job();
      } catch (err) {
        failed++;
        log('error', 'timer_failed', { kind: 'PERIODIC', error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (processed || failed) log('info', 'timer_sweep', { processed, failed });
    return { processed, failed };
  }
}
