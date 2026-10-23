import type { Clock } from '../../shared/clock';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { oneOf, str } from '../../shared/validate';
import { gsi1, keys } from '../../store/keys';
import { pageQuery } from '../../store/paging';
import { withOptimisticRetry } from '../../store/retry';
import { putVersioned, type Item, type Table } from '../../store/table';
import type { Listing, ListingService } from '../listings/listingService';
import type { NotificationService } from '../notifications/notificationService';
import type { PartnerService } from '../partners/partnerService';
import type { RiskService, ViolationKind } from '../risk/riskService';
import type { Transaction } from '../transactions/transactionService';
import type { UserService } from '../users/userService';

/** REVIEW đã bỏ: không xác định được người vi phạm nên Admin chỉ "Bỏ qua" được, web cũng không có nút phản ánh đánh giá. */
export const REPORT_TARGETS = ['LISTING', 'PARTNER', 'TRANSACTION'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

/**
 * Xử lý báo cáo theo mức (QĐ-43):
 *  DISMISS          — bỏ qua
 *  WARN             — cảnh cáo người vi phạm
 *  HIDE_AND_WARN    — gỡ tin + cảnh cáo (chỉ báo cáo tin)
 *  HIDE_AND_SUSPEND — gỡ tin + tạm ngừng tài khoản đối tác (chỉ báo cáo tin)
 *  SUSPEND          — tạm ngừng (báo cáo giao dịch / đối tác)
 */
export const REPORT_ACTIONS = ['DISMISS', 'WARN', 'HIDE_AND_WARN', 'HIDE_AND_SUSPEND', 'SUSPEND'] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];
const HIDES: ReportAction[] = ['HIDE_AND_WARN', 'HIDE_AND_SUSPEND'];
const SUSPENDS: ReportAction[] = ['HIDE_AND_SUSPEND', 'SUSPEND'];
const VIOLATION_OF: Record<Exclude<ReportAction, 'DISMISS'>, ViolationKind> = {
  WARN: 'REPORT_WARNING',
  HIDE_AND_WARN: 'REPORT_HIDDEN',
  HIDE_AND_SUSPEND: 'REPORT_SUSPENDED',
  SUSPEND: 'REPORT_SUSPENDED',
};
const ACTION_LABEL: Record<ReportAction, string> = {
  DISMISS: 'không phát hiện vi phạm',
  WARN: 'đã cảnh cáo người vi phạm',
  HIDE_AND_WARN: 'đã gỡ tin và cảnh cáo người vi phạm',
  HIDE_AND_SUSPEND: 'đã gỡ tin và tạm ngừng tài khoản người vi phạm',
  SUSPEND: 'đã tạm ngừng tài khoản người vi phạm',
};

export interface Report extends Item {
  reportId: string;
  reporterId: string;
  targetType: ReportTarget;
  targetId: string;
  reason: string;
  status: 'OPEN' | 'RESOLVED';
  resolution?: { action: ReportAction; note?: string; by: string; at: string; violatorId?: string };
  createdAt: string;
}

/** Báo cáo vi phạm (giaiphap C13) + Admin kiểm duyệt (T14.5, QĐ-43). */
export class ReportService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly listings: ListingService,
    private readonly notifications: NotificationService,
    private readonly partners: PartnerService,
    private readonly users: UserService,
    private readonly risk: RiskService,
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

  /** Hàng đợi Admin: kèm thứ bị báo cáo (tên, đường dẫn) + người vi phạm và số vi phạm 30 ngày (chặn bấm nhầm). */
  async listOpenDetailed() {
    return Promise.all(
      (await this.listOpen()).map(async (r) => {
        const target = await this.targetOf(r);
        const violatorId = target?.violatorId;
        const [violator, violations30d] = violatorId
          ? await Promise.all([this.describeUser(violatorId), this.risk.violationCount(violatorId)])
          : [undefined, 0];
        return { ...r, target: target && { title: target.title, status: target.status, link: target.link }, violator: violator && { ...violator, violations30d } };
      }),
    );
  }

  /** Báo cáo đã xử lý, phân trang — sắp theo NGÀY TẠO báo cáo (GSI có sẵn, get.md S4), kèm thứ bị báo cáo. */
  async listResolved(cursor?: string) {
    const page = await pageQuery<Report>(this.table, gsi1.statusPk('REPORT', 'RESOLVED'), { index: 'gsi1', cursor });
    const items = await Promise.all(
      page.items.map(async (r) => {
        const target = await this.targetOf(r);
        return { ...r, target: target && { title: target.title, status: target.status, link: target.link } };
      }),
    );
    return { items, nextCursor: page.nextCursor };
  }

  /** Admin xử lý. Gỡ tin / tạm ngừng chạy TRƯỚC khi đóng báo cáo: lỗi → báo cáo vẫn mở để xử lý lại. */
  async resolve(adminId: string, reportId: string, input: Record<string, unknown>): Promise<Report> {
    const action = oneOf(input.action, REPORT_ACTIONS, 'action');
    const note = str(input.note, 'note', { max: 1000, optional: true });
    if (SUSPENDS.includes(action) && (!note || note.trim().length < 5)) {
      throw badRequest('NOTE_REQUIRED', 'Tạm ngừng cần ghi lý do (ít nhất 5 ký tự) — lý do được gửi cho người bị tạm ngừng');
    }
    const report = await this.load(reportId);
    if (report.status !== 'OPEN') throw conflict('REPORT_RESOLVED', 'Báo cáo đã được xử lý');
    if (HIDES.includes(action) && report.targetType !== 'LISTING') throw badRequest('INVALID_ACTION', 'Chỉ gỡ được tin khi báo cáo là tin đăng');

    const target = action === 'DISMISS' ? undefined : await this.targetOf(report);
    const violatorId = target?.violatorId;
    if (action !== 'DISMISS' && !violatorId) throw conflict('NO_VIOLATOR', 'Không xác định được người vi phạm cho báo cáo này');
    if (SUSPENDS.includes(action)) {
      const partner = await this.partners.get(violatorId!);
      if (!partner || (partner.status !== 'APPROVED' && partner.status !== 'SUSPENDED')) {
        throw conflict('CANNOT_SUSPEND', 'Người này không phải đối tác đã duyệt — chỉ cảnh cáo được');
      }
    }

    // 1. Gỡ tin — tin đang giao dịch ném LISTING_IN_TRANSACTION, báo cáo vẫn mở
    if (HIDES.includes(action)) await this.listings.adminHide(report.targetId, note, { notify: false });
    // 2. Tạm ngừng (đã ngừng sẵn thì bỏ qua) — setSuspended tự báo lý do cho người bị ngừng
    if (SUSPENDS.includes(action)) {
      try {
        await this.partners.setSuspended(adminId, violatorId!, true, note);
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'PARTNER_INVALID_STATUS') throw err;
      }
    }
    // 3. Đóng báo cáo
    const resolved = await withOptimisticRetry(async () => {
      const current = await this.load(reportId);
      if (current.status !== 'OPEN') throw conflict('REPORT_RESOLVED', 'Báo cáo đã được xử lý');
      const now = this.clock.now().toISOString();
      const next: Report = {
        ...current,
        ...gsi1.byStatus('REPORT', 'RESOLVED', current.createdAt),
        status: 'RESOLVED',
        resolution: { action, note, by: adminId, at: now, violatorId },
      };
      await this.table.transact([putVersioned(next, current.version ?? 1)]);
      return next;
    });
    // 4. Người vi phạm: thông báo + đếm vi phạm (≥ 5 / 30 ngày → cờ cho Admin)
    if (action !== 'DISMISS') {
      if (action === 'WARN' || action === 'HIDE_AND_WARN') {
        await this.notifications.notify(violatorId!, {
          type: action === 'WARN' ? 'VIOLATION_WARNING' : 'LISTING_HIDDEN',
          title: action === 'WARN' ? 'Bạn bị cảnh cáo vi phạm' : `Tin "${target!.title}" bị gỡ và bạn bị cảnh cáo vi phạm`,
          body: note ?? `Admin đã xem báo cáo về ${target!.title}`,
          link: target!.link,
        });
      }
      await this.risk.recordViolation(violatorId!, VIOLATION_OF[action], { type: report.targetType, id: report.targetId, title: target!.title }, note);
    }
    // 5. Người báo cáo
    await this.notifications.notify(resolved.reporterId, {
      type: 'REPORT_RESOLVED',
      title: `Báo cáo vi phạm của bạn đã được xử lý: ${ACTION_LABEL[action]}`,
      body: note,
    });
    return resolved;
  }

  private async load(reportId: string) {
    const k = keys.report(reportId);
    const report = await this.table.get<Report>(k.pk, k.sk);
    if (!report) throw notFound('báo cáo');
    return report;
  }

  /** Thứ bị báo cáo + người vi phạm: tin → chủ tin; giao dịch → bên kia (không phải người báo cáo); đối tác → chính đối tác. */
  private async targetOf(r: Report): Promise<{ title: string; status?: string; link?: string; violatorId?: string } | undefined> {
    if (r.targetType === 'LISTING') {
      const k = keys.listing(r.targetId);
      const l = await this.table.get<Listing>(k.pk, k.sk);
      return l && { title: l.title, status: this.listings.effectiveListingStatus(l), link: `/listings/${l.listingId}`, violatorId: l.ownerId };
    }
    if (r.targetType === 'TRANSACTION') {
      const k = keys.transaction(r.targetId);
      const tx = await this.table.get<Transaction>(k.pk, k.sk);
      if (!tx) return undefined;
      const violatorId = tx.ownerId === r.reporterId ? tx.partnerId : tx.partnerId === r.reporterId ? tx.ownerId : undefined;
      return { title: tx.listingTitle, status: tx.status, link: `/transactions/${tx.transactionId}`, violatorId };
    }
    if (r.targetType === 'PARTNER') {
      const p = await this.partners.get(r.targetId);
      return p && { title: p.businessName, status: p.status, violatorId: p.partnerId };
    }
    return undefined;
  }

  private async describeUser(userId: string) {
    const [partner, profile] = await Promise.all([this.partners.get(userId), this.users.get(userId)]);
    return {
      userId,
      name: partner?.businessName ?? profile?.fullName ?? (profile?.email ? profile.email.split('@')[0]! : userId),
      partnerStatus: partner?.status,
    };
  }
}
