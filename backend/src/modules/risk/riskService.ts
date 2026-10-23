import { log } from '../../http/log';
import { HOUR_MS, vnMonth, type Clock } from '../../shared/clock';
import { AppError, conflict, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { oneOf, str } from '../../shared/validate';
import { gsi1, keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';
import type { NotificationService } from '../notifications/notificationService';
import type { PartnerService } from '../partners/partnerService';

/** Cờ "nghi né phí" (QĐ-39 — hướng B): xét trong 30 ngày, chỉ đếm sự việc sau lần Admin xử lý trước. */
export const RISK_WINDOW_MS = 30 * 24 * HOUR_MS;
/** Số giao dịch hủy / thất bại giữa cùng người bán – người mua để gắn cờ. */
export const REPEAT_PAIR_LIMIT = 2;
/** Số lần "hủy rồi gỡ tin" để gắn cờ. */
export const CANCEL_THEN_REMOVE_LIMIT = 3;
/** Số lần vi phạm trong 30 ngày để gắn cờ (QĐ-43). */
export const VIOLATION_LIMIT = 5;

export type ViolationKind = 'REPORT_WARNING' | 'REPORT_HIDDEN' | 'REPORT_SUSPENDED' | 'IMAGE_REJECTED' | 'LISTING_REJECTED';

export interface Violation extends Item {
  violationId: string;
  userId: string;
  kind: ViolationKind;
  ref: { type: string; id: string; title?: string };
  note?: string;
  at: string;
}

export const RISK_ACTIONS = ['DISMISS', 'WARN', 'SUSPEND'] as const;
export type RiskAction = (typeof RISK_ACTIONS)[number];

export interface DealEnded extends Item {
  transactionId: string;
  sellerId: string;
  buyerId: string;
  buyerName: string;
  listingTitle: string;
  status: 'CANCELLED' | 'FAILED';
  at: string;
}

export interface Suspicion extends Item {
  transactionId: string;
  sellerId: string;
  listingId: string;
  listingTitle: string;
  at: string;
}

export interface RiskReason {
  code: 'REPEAT_PAIR' | 'CANCEL_THEN_REMOVE' | 'VIOLATIONS';
  count: number;
  text: string;
}

export interface RiskFlag extends Item {
  userId: string;
  status: 'OPEN' | 'RESOLVED';
  reasons: RiskReason[];
  openedAt: string;
  updatedAt: string;
  /** Sự việc trước mốc này đã được Admin xem → không đếm lại. */
  resolvedAt?: string;
  resolution?: { action: RiskAction; note?: string; by: string; at: string };
}

export class RiskService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly notifications: NotificationService,
    private readonly partners: PartnerService,
  ) {}

  /** Ghi cùng transaction với việc giao dịch kết thúc (hủy / thất bại do hai bên). */
  dealEndedOp(
    tx: { transactionId: string; ownerId: string; partnerId: string; partnerName: string; listingTitle: string; status: 'CANCELLED' | 'FAILED' },
    at: string,
  ): WriteOp {
    return putNew({
      ...keys.dealEnded(tx.ownerId, at, tx.transactionId),
      transactionId: tx.transactionId,
      sellerId: tx.ownerId,
      buyerId: tx.partnerId,
      buyerName: tx.partnerName,
      listingTitle: tx.listingTitle,
      status: tx.status,
      at,
    } satisfies DealEnded);
  }

  /** Ghi cùng transaction với việc người bán gỡ tin bị tính phí nghi vấn. */
  suspicionOp(sellerId: string, listing: { listingId: string; title: string }, transactionId: string, at: string): WriteOp {
    return putNew({
      ...keys.suspicion(sellerId, at, transactionId),
      transactionId,
      sellerId,
      listingId: listing.listingId,
      listingTitle: listing.title,
      at,
    } satisfies Suspicion);
  }

  /** Ghi 1 lần vi phạm rồi xét lại cờ (QĐ-43). Lỗi xét cờ chỉ ghi log, không làm hỏng thao tác chính. */
  async recordViolation(userId: string, kind: ViolationKind, ref: Violation['ref'], note?: string) {
    const at = this.clock.now().toISOString();
    const violationId = newId();
    await this.table.transact([putNew({ ...keys.violation(userId, at, violationId), violationId, userId, kind, ref, note, at } satisfies Violation)]);
    log('warn', 'violation_recorded', { userId, kind, ref: ref.type });
    await this.evaluate(userId).catch((err) => log('error', 'risk_evaluate_failed', { userId, error: err instanceof Error ? err.message : String(err) }));
  }

  /** Số vi phạm trong 30 ngày gần nhất (hiện cạnh nút tạm ngừng để Admin không xử quá tay). */
  async violationCount(userId: string) {
    const since = new Date(this.clock.now().getTime() - RISK_WINDOW_MS).toISOString();
    return (await this.table.query<Violation>(keys.userPk(userId), { skPrefix: 'VIOL#', ascending: false, limit: 200 })).filter((v) => v.at >= since).length;
  }

  private flag(userId: string) {
    const k = keys.riskFlag(userId);
    return this.table.get<RiskFlag>(k.pk, k.sk);
  }

  /** Sự việc của người bán từ `since` (after: chỉ lấy sau hẳn mốc đó), mới nhất trước. */
  private async events(userId: string, since: string, after = false) {
    const [ends, suspects, violations] = await Promise.all([
      this.table.query<DealEnded>(keys.userPk(userId), { skPrefix: 'DEALEND#', ascending: false, limit: 200 }),
      this.table.query<Suspicion>(keys.userPk(userId), { skPrefix: 'SUSPECT#', ascending: false, limit: 200 }),
      this.table.query<Violation>(keys.userPk(userId), { skPrefix: 'VIOL#', ascending: false, limit: 200 }),
    ]);
    const keep = (at: string) => (after ? at > since : at >= since);
    return { ends: ends.filter((e) => keep(e.at)), suspects: suspects.filter((s) => keep(s.at)), violations: violations.filter((v) => keep(v.at)) };
  }

  /** Xét lại cờ sau mỗi sự việc mới. Đủ ngưỡng → mở (hoặc cập nhật) cờ cho Admin. */
  async evaluate(userId: string): Promise<RiskFlag | undefined> {
    return withOptimisticRetry(async () => {
      const current = await this.flag(userId);
      const now = this.clock.now().toISOString();
      const windowStart = new Date(this.clock.now().getTime() - RISK_WINDOW_MS).toISOString();
      // Sự việc tới lúc Admin xử lý cờ lần trước đã được xem → không đếm lại
      const afterResolved = !!current?.resolvedAt && current.resolvedAt >= windowStart;
      const { ends, suspects, violations } = await this.events(userId, afterResolved ? current!.resolvedAt! : windowStart, afterResolved);

      const reasons: RiskReason[] = [];
      const byBuyer = new Map<string, DealEnded[]>();
      for (const e of ends) byBuyer.set(e.buyerId, [...(byBuyer.get(e.buyerId) ?? []), e]);
      for (const list of byBuyer.values()) {
        if (list.length >= REPEAT_PAIR_LIMIT) {
          reasons.push({ code: 'REPEAT_PAIR', count: list.length, text: `${list.length} giao dịch hủy / thất bại với cùng người mua "${list[0]!.buyerName}"` });
        }
      }
      if (suspects.length >= CANCEL_THEN_REMOVE_LIMIT) {
        reasons.push({ code: 'CANCEL_THEN_REMOVE', count: suspects.length, text: `${suspects.length} lần hủy giao dịch rồi gỡ tin trong 72 giờ` });
      }
      if (violations.length >= VIOLATION_LIMIT) {
        reasons.push({ code: 'VIOLATIONS', count: violations.length, text: `${violations.length} lần vi phạm trong 30 ngày (cảnh cáo, gỡ tin, ảnh nhạy cảm bị chặn…)` });
      }
      if (reasons.length === 0) return current;

      const openedAt = current?.status === 'OPEN' ? current.openedAt : now;
      const next: RiskFlag = {
        ...keys.riskFlag(userId),
        ...gsi1.byStatus('RISK', 'OPEN', openedAt),
        userId,
        status: 'OPEN',
        reasons,
        openedAt,
        updatedAt: now,
        resolvedAt: current?.resolvedAt,
        resolution: current?.resolution,
      };
      await this.table.transact([putVersioned(next, current?.version ?? 0)]);
      if (current?.status !== 'OPEN') log('warn', 'risk_flag_opened', { userId, reasons: reasons.map((r) => r.code) });
      return { ...next, version: (current?.version ?? 0) + 1 };
    });
  }

  /**
   * Lịch sử giao dịch 30 ngày của người bán, hiện công khai trên tin (QĐ-39 hướng A): số giao dịch hoàn tất
   * (dòng phí giao dịch — QĐ-37) và số giao dịch bị hủy / thất bại do hai bên. Không nói ai hủy: chỉ là dữ kiện để người mua cân nhắc.
   */
  async sellerHistory(userId: string) {
    const now = this.clock.now();
    const since = new Date(now.getTime() - RISK_WINDOW_MS).toISOString();
    const months = [...new Set([vnMonth(now), vnMonth(since)])];
    const [ends, ...feeMonths] = await Promise.all([
      this.table.query<DealEnded>(keys.userPk(userId), { skPrefix: 'DEALEND#', ascending: false, limit: 200 }),
      ...months.map((m) => this.table.query<Item & { kind?: string; completedAt: string }>(keys.userPk(userId), { skPrefix: `FEE#${m}#` })),
    ]);
    return {
      days: RISK_WINDOW_MS / (24 * HOUR_MS),
      completed: feeMonths.flat().filter((l) => (l.kind ?? 'TRANSACTION') === 'TRANSACTION' && l.completedAt >= since).length,
      cancelled: ends.filter((e) => e.at >= since).length,
    };
  }

  /** Chỉ đếm cờ đang mở (badge Admin) — không đọc lịch sử sự việc. */
  async openCount() {
    return (await this.table.query<RiskFlag>(gsi1.statusPk('RISK', 'OPEN'), { index: 'gsi1' })).filter((f) => f.status === 'OPEN').length;
  }

  /** Hàng đợi Admin: cờ đang mở, cũ nhất trước, kèm lịch sử sự việc. */
  async listOpen() {
    const flags = await this.table.query<RiskFlag>(gsi1.statusPk('RISK', 'OPEN'), { index: 'gsi1' });
    return Promise.all(
      flags
        .filter((f) => f.status === 'OPEN')
        .map(async (f) => {
          const since = new Date(this.clock.now().getTime() - RISK_WINDOW_MS).toISOString();
          const [partner, { ends, suspects, violations }] = await Promise.all([this.partners.get(f.userId), this.events(f.userId, since)]);
          return {
            ...f,
            sellerName: partner?.businessName,
            dealsEnded: ends.slice(0, 20).map(({ transactionId, buyerName, listingTitle, status, at }) => ({ transactionId, buyerName, listingTitle, status, at })),
            cancelThenRemove: suspects.slice(0, 20).map(({ transactionId, listingId, listingTitle, at }) => ({ transactionId, listingId, listingTitle, at })),
            violations: violations.slice(0, 20).map(({ violationId, kind, ref, note, at }) => ({ violationId, kind, ref, note, at })),
          };
        }),
    );
  }

  /** Admin xử lý cờ: bỏ qua / cảnh cáo (thông báo) / tạm ngừng đối tác. */
  async resolve(adminId: string, userId: string, input: Record<string, unknown>): Promise<RiskFlag> {
    const action = oneOf(input.action, RISK_ACTIONS, 'action');
    const note = str(input.note, 'note', { max: 1000, optional: true });
    const resolved = await withOptimisticRetry(async () => {
      const current = await this.flag(userId);
      if (!current) throw notFound('cờ nghi né phí');
      if (current.status !== 'OPEN') throw conflict('RISK_FLAG_RESOLVED', 'Cờ đã được xử lý');
      const now = this.clock.now().toISOString();
      const next: RiskFlag = {
        ...current,
        ...gsi1.byStatus('RISK', 'RESOLVED', current.openedAt),
        status: 'RESOLVED',
        resolvedAt: now,
        resolution: { action, note, by: adminId, at: now },
        updatedAt: now,
      };
      await this.table.transact([putVersioned(next, current.version ?? 0)]);
      return { ...next, version: (current.version ?? 0) + 1 };
    });
    if (action === 'SUSPEND') {
      try {
        await this.partners.setSuspended(adminId, userId, true, note ?? 'Nghi né phí dịch vụ (QĐ-39)');
      } catch (err) {
        // Đã tạm ngừng / không phải đối tác (vd khách bị đếm vi phạm ảnh) → bỏ qua, cờ vẫn được đóng
        if (!(err instanceof AppError) || (err.code !== 'PARTNER_INVALID_STATUS' && err.code !== 'NOT_FOUND')) throw err;
      }
    }
    if (action === 'WARN' || action === 'SUSPEND') {
      await this.notifications.notify(userId, {
        type: 'RISK_WARNING',
        title: 'Cảnh cáo: nhiều giao dịch bị hủy bất thường',
        body: note ?? 'Hãy hoàn tất giao dịch trên ReLoop. Hủy rồi giao dịch bên ngoài để né phí có thể bị tạm ngừng tài khoản.',
        link: '/partner',
      });
    }
    log('info', 'risk_flag_resolved', { userId, action, by: adminId });
    return resolved;
  }
}
