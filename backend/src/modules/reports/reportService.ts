import type { Clock } from '../../shared/clock';
import { conflict, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { oneOf, str } from '../../shared/validate';
import { gsi1, keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putVersioned, type Item, type Table } from '../../store/table';
import type { ListingService } from '../listings/listingService';
import type { NotificationService } from '../notifications/notificationService';

export const REPORT_TARGETS = ['LISTING', 'PARTNER', 'REVIEW', 'TRANSACTION'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const REPORT_ACTIONS = ['DISMISS', 'HIDE_LISTING', 'WARN'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export interface Report extends Item {
  reportId: string;
  reporterId: string;
  targetType: ReportTarget;
  targetId: string;
  reason: string;
  status: 'OPEN' | 'RESOLVED';
  resolution?: { action: ReportAction; note?: string; by: string; at: string };
  createdAt: string;
}

/** Báo cáo vi phạm (giaiphap C13) + Admin kiểm duyệt (T14.5). */
export class ReportService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly listings: ListingService,
    private readonly notifications: NotificationService,
  ) {}

  async create(reporterId: string, input: Record<string, unknown>): Promise<Report> {
    const now = this.clock.now().toISOString();
    const reportId = newId();
    const report: Report = {
      ...keys.report(reportId),
      ...gsi1.byStatus('REPORT', 'OPEN', now),
      reportId,
      reporterId,
      targetType: oneOf(input.targetType, REPORT_TARGETS, 'targetType'),
      targetId: str(input.targetId, 'targetId', { max: 80 }),
      reason: str(input.reason, 'reason', { min: 5, max: 1000 }),
      status: 'OPEN',
      createdAt: now,
    };
    await this.table.transact([putVersioned(report, 0)]);
    return { ...report, version: 1 };
  }

  listOpen() {
    return this.table.query<Report>(gsi1.statusPk('REPORT', 'OPEN'), { index: 'gsi1', ascending: false });
  }

  /** Admin xử lý. HIDE_LISTING: hủy tin đang mở (Admin được phép ACTIVE → CANCELLED). */
  async resolve(adminId: string, reportId: string, input: Record<string, unknown>): Promise<Report> {
    const action = oneOf(input.action, REPORT_ACTIONS, 'action');
    const note = str(input.note, 'note', { max: 1000, optional: true });
    const resolved = await withOptimisticRetry(async () => {
      const k = keys.report(reportId);
      const report = await this.table.get<Report>(k.pk, k.sk);
      if (!report) throw notFound('báo cáo');
      if (report.status !== 'OPEN') throw conflict('REPORT_RESOLVED', 'Báo cáo đã được xử lý');
      const now = this.clock.now().toISOString();
      const next: Report = {
        ...report,
        ...gsi1.byStatus('REPORT', 'RESOLVED', report.createdAt),
        status: 'RESOLVED',
        resolution: { action, note, by: adminId, at: now },
      };
      await this.table.transact([putVersioned(next, report.version ?? 1)]);
      return next;
    });
    if (action === 'HIDE_LISTING' && resolved.targetType === 'LISTING') {
      await this.listings.adminHide(resolved.targetId, note);
    }
    await this.notifications.notify(resolved.reporterId, {
      type: 'REPORT_RESOLVED',
      title: 'Báo cáo vi phạm của bạn đã được xử lý',
      body: note,
    });
    return resolved;
  }
}
