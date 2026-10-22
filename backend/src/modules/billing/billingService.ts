import { log } from '../../http/log';
import { HOUR_MS, MONTH_RE, vnMonth, type Clock } from '../../shared/clock';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors';
import { shortCode } from '../../shared/ids';
import { str } from '../../shared/validate';
import { gsi1, keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { ConditionFailedError, putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';
import type { NotificationService } from '../notifications/notificationService';

/**
 * Phí dịch vụ (QĐ-37, thay hoa hồng QĐ-32 và phí đăng bài QĐ-33):
 *  • 10.000đ cho MỖI giao dịch HOÀN TẤT, NGƯỜI BÁN trả (đối tác cấp 1 hoặc cấp 2 — người đăng tin).
 *  • Gom theo tháng (giờ Việt Nam). Ngày 1 tháng sau hệ thống lập hóa đơn = số giao dịch × 10.000đ.
 *  • Người bán chuyển khoản kèm mã hóa đơn; Admin bấm "Đã thu".
 *  • Nợ quá hạn (QĐ-40, thay khóa đăng tin + báo giá của QĐ-37): quá hạn > 3 ngày → không đăng tin mới
 *    (tin đang có vẫn bình thường); quá hạn > 7 ngày → khóa mọi chức năng, chỉ còn xem / thanh toán phí.
 */
export interface BillingPolicy {
  feePerTransaction: number;
  dueDays: number;
  /** Quá hạn hơn số ngày này → không đăng tin mới (QĐ-40). */
  postingLockDays: number;
  /** Quá hạn hơn số ngày này → khóa mọi chức năng (QĐ-40). */
  fullLockDays: number;
  /** Gói VIP 1 cho đối tác cấp 1 (QĐ-41). */
  vipPrice: number;
  vipDays: number;
}

export const DEFAULT_BILLING: BillingPolicy = { feePerTransaction: 10_000, dueDays: 7, postingLockDays: 3, fullLockDays: 7, vipPrice: 10_000, vipDays: 30 };

/** NONE: không nợ quá hạn · WARNING: quá hạn, chưa khóa · NO_POSTING: không đăng tin mới · FULL: khóa mọi chức năng. */
export type DebtLevel = 'NONE' | 'WARNING' | 'NO_POSTING' | 'FULL';

export interface DebtStatus {
  level: DebtLevel;
  /** Hóa đơn quá hạn lâu nhất */
  invoice?: { month: string; amount: number; paymentCode: string; dueAt: string };
  /** Tổng tiền các hóa đơn quá hạn */
  overdueAmount: number;
  daysOverdue: number;
  postingLockAt?: string;
  fullLockAt?: string;
}

const DAY_MS = 24 * HOUR_MS;

/** Thông tin tài khoản nhận tiền phí (cấu hình, không cứng trong code). */
export interface BillingBank {
  bankName: string;
  accountNo: string;
  accountName: string;
}

export type InvoiceStatus = 'ISSUED' | 'PAID';

export interface FeeLine extends Item {
  userId: string;
  month: string;
  transactionId: string;
  listingTitle: string;
  amount: number;
  /** Thời điểm tính phí: giao dịch hoàn tất, hoặc lúc gỡ tin bị nghi bán ngoài. */
  completedAt: string;
  /** TRANSACTION (mặc định): giao dịch hoàn tất. SUSPECTED_OFFLINE: hủy rồi gỡ tin trong 72 giờ (QĐ-39). VIP_PLAN: gói VIP 1 (QĐ-41). */
  kind?: 'TRANSACTION' | 'SUSPECTED_OFFLINE' | 'VIP_PLAN';
  /** Khiếu nại phí nghi vấn; WAIVED → amount = 0. */
  appeal?: { reason: string; at: string; status: 'OPEN' | 'WAIVED' | 'KEPT'; note?: string; by?: string; resolvedAt?: string };
}

/** Dòng phí còn tính tiền (đã miễn → 0đ, không đếm). */
const charged = (l: FeeLine) => l.amount > 0;
/** Dòng phí theo giao dịch (không tính gói VIP) — để đếm "số giao dịch" trên hóa đơn. */
const perDeal = (l: FeeLine) => charged(l) && l.kind !== 'VIP_PLAN';

export interface Invoice extends Item {
  userId: string;
  month: string;
  /** Mã ghi vào nội dung chuyển khoản, vd RLF8K3M2Q */
  paymentCode: string;
  transactionCount: number;
  feePerTransaction: number;
  amount: number;
  status: InvoiceStatus;
  issuedAt: string;
  dueAt: string;
  paidAt?: string;
  paidBy?: string;
  paidNote?: string;
}

export { vnMonth };
const previousMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

export class BillingService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly notifications: NotificationService,
    private readonly policy: BillingPolicy = DEFAULT_BILLING,
    private readonly bank?: BillingBank,
  ) {}

  get feePerTransaction() {
    return this.policy.feePerTransaction;
  }

  /**
   * Ghi phí khi giao dịch vừa HOÀN TẤT — gọi trong CÙNG transaction với việc đổi trạng thái,
   * nên mỗi giao dịch chỉ bị tính đúng 1 lần (putNew theo transactionId).
   */
  feeOps(tx: { transactionId: string; ownerId: string; listingTitle: string }, completedAt: string): WriteOp[] {
    const month = vnMonth(completedAt);
    const line: FeeLine = {
      ...keys.feeLine(tx.ownerId, month, tx.transactionId),
      userId: tx.ownerId,
      month,
      transactionId: tx.transactionId,
      listingTitle: tx.listingTitle,
      amount: this.policy.feePerTransaction,
      completedAt,
    };
    // Danh sách người có phí trong tháng (để lập hóa đơn không cần Scan); ghi đè cũng không sao.
    return [putNew(line), { type: 'put', item: { ...keys.feeMonthMember(month, tx.ownerId), userId: tx.ownerId } }];
  }

  get vipPlan() {
    return { price: this.policy.vipPrice, days: this.policy.vipDays };
  }

  /** Phí gói VIP 1 (QĐ-41) — ghi cùng transaction với việc bật / gia hạn gói. */
  vipFeeOps(userId: string, purchaseId: string, until: string, at: string): WriteOp[] {
    const month = vnMonth(at);
    const line: FeeLine = {
      ...keys.feeLine(userId, month, `VIP${purchaseId}`),
      userId,
      month,
      transactionId: `VIP${purchaseId}`,
      listingTitle: `Gói VIP 1 — hiệu lực đến ${new Date(new Date(until).getTime() + 7 * HOUR_MS).toISOString().slice(0, 10)}`,
      amount: this.policy.vipPrice,
      completedAt: at,
      kind: 'VIP_PLAN',
    };
    return [putNew(line), { type: 'put', item: { ...keys.feeMonthMember(month, userId), userId } }];
  }

  /**
   * Phí nghi bán ngoài ReLoop (QĐ-39): người bán gỡ tin trong 72 giờ sau khi giao dịch bị hủy / thất bại.
   * Khóa theo transactionId (giao dịch đó không hoàn tất nên không trùng phí thường). Có version để khiếu nại được.
   */
  suspectedFeeOps(sellerId: string, listing: { listingId: string; title: string }, transactionId: string, at: string): WriteOp[] {
    const month = vnMonth(at);
    const line: FeeLine = {
      ...keys.feeLine(sellerId, month, transactionId),
      userId: sellerId,
      month,
      transactionId,
      listingTitle: listing.title,
      amount: this.policy.feePerTransaction,
      completedAt: at,
      kind: 'SUSPECTED_OFFLINE',
    };
    return [putVersioned(line, 0), { type: 'put', item: { ...keys.feeMonthMember(month, sellerId), userId: sellerId } }];
  }

  private feeLines(userId: string, month: string) {
    return this.table.query<FeeLine>(keys.userPk(userId), { skPrefix: `FEE#${month}#` });
  }

  private async getInvoice(userId: string, month: string) {
    const k = keys.invoice(userId, month);
    return this.table.get<Invoice>(k.pk, k.sk);
  }

  private invoices(userId: string) {
    return this.table.query<Invoice>(keys.userPk(userId), { skPrefix: 'INVOICE#', ascending: false });
  }

  // ------------------------------------------------------------------ Lập hóa đơn tháng

  /**
   * Lập hóa đơn cho một tháng ĐÃ KẾT THÚC. Idempotent: người đã có hóa đơn tháng đó thì bỏ qua.
   * Gọi từ job nền (ngày 1 hằng tháng) hoặc Admin bấm tay.
   */
  async issueMonth(month: string): Promise<{ month: string; issued: number }> {
    if (!MONTH_RE.test(month)) throw badRequest('INVALID_MONTH', 'Tháng dạng YYYY-MM');
    if (month >= vnMonth(this.clock.now())) throw conflict('MONTH_NOT_ENDED', 'Chỉ lập hóa đơn cho tháng đã kết thúc');
    const members = await this.table.query<Item & { userId: string }>(keys.feeMonthPk(month));
    let issued = 0;
    for (const { userId } of members) {
      if (await this.getInvoice(userId, month)) continue;
      const lines = (await this.feeLines(userId, month)).filter(charged);
      if (lines.length === 0) continue;
      const dealCount = lines.filter(perDeal).length;
      const now = this.clock.now();
      const invoice: Invoice = {
        ...keys.invoice(userId, month),
        ...gsi1.byStatus('INVOICE', 'ISSUED', `${month}#${userId}`),
        userId,
        month,
        paymentCode: `RLF${shortCode(6)}`,
        transactionCount: dealCount,
        feePerTransaction: this.policy.feePerTransaction,
        amount: lines.reduce((s, l) => s + l.amount, 0),
        status: 'ISSUED',
        issuedAt: now.toISOString(),
        dueAt: new Date(now.getTime() + this.policy.dueDays * 24 * HOUR_MS).toISOString(),
      };
      try {
        await this.table.transact([putVersioned(invoice, 0)]);
      } catch (err) {
        if (err instanceof ConditionFailedError) continue; // lượt chạy khác vừa lập
        throw err;
      }
      issued++;
      await this.notifications.notify(userId, {
        type: 'INVOICE_ISSUED',
        title: `Hóa đơn phí dịch vụ tháng ${month}: ${invoice.amount.toLocaleString('vi-VN')}đ`,
        body: `${invoice.transactionCount} giao dịch hoàn tất × ${invoice.feePerTransaction.toLocaleString('vi-VN')}đ — hạn trả ${new Date(invoice.dueAt).toLocaleDateString('vi-VN')}, nội dung chuyển khoản ${invoice.paymentCode}`,
        link: '/partner',
      });
    }
    log('info', 'invoices_issued', { month, issued });
    return { month, issued };
  }

  /** Job nền: từ ngày 1 hằng tháng, lập hóa đơn tháng trước (chỉ chạy thật 1 lần nhờ cờ đã chạy). */
  async issuePreviousMonthIfDue() {
    const month = previousMonth(vnMonth(this.clock.now()));
    const k = keys.billingRun(month);
    if (await this.table.get(k.pk, k.sk)) return;
    await this.issueMonth(month);
    await this.table.transact([{ type: 'put', item: { ...k, month, at: this.clock.now().toISOString() } }]);
  }

  // ------------------------------------------------------------------ Người bán

  async summaryFor(userId: string) {
    const month = vnMonth(this.clock.now());
    const lastMonth = previousMonth(month);
    const [current, previous, invoices, debt] = await Promise.all([
      this.feeLines(userId, month),
      this.feeLines(userId, lastMonth),
      this.invoices(userId),
      this.debtStatus(userId),
    ]);
    const now = this.clock.now().toISOString();
    const view = ({ month: m, transactionId, listingTitle, amount, completedAt, kind, appeal }: FeeLine) => ({
      month: m,
      transactionId,
      listingTitle,
      amount,
      completedAt,
      kind: kind ?? 'TRANSACTION',
      appeal,
    });
    return {
      feePerTransaction: this.policy.feePerTransaction,
      dueDays: this.policy.dueDays,
      postingLockDays: this.policy.postingLockDays,
      fullLockDays: this.policy.fullLockDays,
      bank: this.bank,
      debt,
      currentMonth: {
        month,
        transactionCount: current.filter(perDeal).length,
        amount: current.reduce((s, l) => s + l.amount, 0),
        lines: current.map(view),
      },
      /** Phí nghi bán ngoài tháng này + tháng trước — để người bán khiếu nại (QĐ-39). */
      suspected: [...current, ...previous].filter((l) => l.kind === 'SUSPECTED_OFFLINE').map(view),
      invoices: invoices.map((i) => ({ ...i, overdue: i.status === 'ISSUED' && now > i.dueAt })),
    };
  }

  // ------------------------------------------------------------------ Khiếu nại phí nghi bán ngoài (QĐ-39)

  /** Người bán khiếu nại 1 lần cho mỗi dòng phí nghi vấn. */
  async appeal(userId: string, month: string, transactionId: string, rawReason: unknown): Promise<FeeLine> {
    const reason = str(rawReason, 'reason', { min: 10, max: 1000 });
    const k = keys.feeLine(userId, month, transactionId);
    return withOptimisticRetry(async () => {
      const line = await this.table.get<FeeLine>(k.pk, k.sk);
      if (!line) throw notFound('dòng phí');
      if (line.kind !== 'SUSPECTED_OFFLINE') throw conflict('FEE_NOT_APPEALABLE', 'Chỉ khiếu nại được phí nghi bán ngoài ReLoop');
      if (line.appeal) throw conflict('APPEAL_EXISTS', 'Dòng phí này đã được khiếu nại');
      const at = this.clock.now().toISOString();
      const next: FeeLine = { ...line, ...gsi1.byStatus('FEEAPPEAL', 'OPEN', at), appeal: { reason, at, status: 'OPEN' } };
      await this.table.transact([putVersioned(next, line.version ?? 0)]);
      log('info', 'fee_appealed', { userId, month, transactionId });
      return { ...next, version: (line.version ?? 0) + 1 };
    });
  }

  /** Khiếu nại đang chờ, cũ nhất trước. */
  async listAppeals() {
    const items = await this.table.query<FeeLine>(gsi1.statusPk('FEEAPPEAL', 'OPEN'), { index: 'gsi1' });
    return items.filter((l) => l.appeal?.status === 'OPEN');
  }

  /**
   * Admin tài chính quyết: MIỄN → dòng phí về 0đ; hóa đơn tháng đó chưa thu thì tính lại (về 0đ thì coi như đã xong).
   * Hóa đơn đã thu → trả về refundDue để hoàn tay.
   */
  async resolveAppeal(adminId: string, userId: string, month: string, transactionId: string, waive: boolean, note?: string) {
    const k = keys.feeLine(userId, month, transactionId);
    const result = await withOptimisticRetry(async () => {
      const line = await this.table.get<FeeLine>(k.pk, k.sk);
      if (!line) throw notFound('dòng phí');
      if (line.appeal?.status !== 'OPEN') throw conflict('APPEAL_NOT_OPEN', 'Không có khiếu nại đang chờ');
      const now = this.clock.now().toISOString();
      const next: FeeLine = {
        ...line,
        ...gsi1.byStatus('FEEAPPEAL', 'RESOLVED', line.appeal.at),
        amount: waive ? 0 : line.amount,
        appeal: { ...line.appeal, status: waive ? 'WAIVED' : 'KEPT', note, by: adminId, resolvedAt: now },
      };
      const ops: WriteOp[] = [putVersioned(next, line.version ?? 0)];
      let refundDue = 0;
      const invoice = waive ? await this.getInvoice(userId, month) : undefined;
      if (invoice?.status === 'PAID') refundDue = line.amount;
      if (invoice?.status === 'ISSUED') {
        const lines = (await this.feeLines(userId, month)).map((l) => (l.transactionId === transactionId ? next : l)).filter(charged);
        const amount = lines.reduce((s, l) => s + l.amount, 0);
        const recalculated: Invoice =
          amount > 0
            ? { ...invoice, amount, transactionCount: lines.filter(perDeal).length }
            : { ...invoice, ...gsi1.byStatus('INVOICE', 'PAID', `${month}#${userId}`), amount: 0, transactionCount: 0, status: 'PAID', paidAt: now, paidBy: adminId, paidNote: 'Miễn toàn bộ sau khiếu nại' };
        ops.push(putVersioned(recalculated, invoice.version ?? 1));
      }
      await this.table.transact(ops);
      return { line: { ...next, version: (line.version ?? 0) + 1 }, refundDue };
    });
    log('info', 'fee_appeal_resolved', { userId, month, transactionId, waive, by: adminId });
    await this.notifications.notify(userId, {
      type: waive ? 'FEE_WAIVED' : 'FEE_KEPT',
      title: waive ? 'Khiếu nại được chấp nhận — đã miễn phí 10.000đ' : 'Khiếu nại không được chấp nhận — giữ phí 10.000đ',
      body: note ?? result.line.listingTitle,
      link: '/partner',
    });
    return result;
  }

  /** Mức khóa do nợ phí quá hạn (QĐ-40), tính theo hóa đơn quá hạn lâu nhất. */
  async debtStatus(userId: string): Promise<DebtStatus> {
    const now = this.clock.now();
    const overdue = (await this.invoices(userId))
      .filter((i) => i.status === 'ISSUED' && now.toISOString() > i.dueAt)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    const oldest = overdue[0];
    if (!oldest) return { level: 'NONE', overdueAmount: 0, daysOverdue: 0 };
    const days = (now.getTime() - Date.parse(oldest.dueAt)) / DAY_MS;
    const level: DebtLevel = days > this.policy.fullLockDays ? 'FULL' : days > this.policy.postingLockDays ? 'NO_POSTING' : 'WARNING';
    const due = Date.parse(oldest.dueAt);
    return {
      level,
      invoice: { month: oldest.month, amount: oldest.amount, paymentCode: oldest.paymentCode, dueAt: oldest.dueAt },
      overdueAmount: overdue.reduce((s, i) => s + i.amount, 0),
      daysOverdue: Math.floor(days),
      postingLockAt: new Date(due + this.policy.postingLockDays * DAY_MS).toISOString(),
      fullLockAt: new Date(due + this.policy.fullLockDays * DAY_MS).toISOString(),
    };
  }

  private debtDetails(d: DebtStatus) {
    return { level: d.level, month: d.invoice?.month, amount: d.overdueAmount, paymentCode: d.invoice?.paymentCode };
  }

  /** Quá hạn > 3 ngày → không đăng tin mới; tin đang có vẫn bình thường (QĐ-40). */
  async assertCanPost(userId: string) {
    const d = await this.debtStatus(userId);
    if (d.level === 'NO_POSTING' || d.level === 'FULL') {
      throw new AppError(
        403,
        'INVOICE_OVERDUE',
        `Hóa đơn phí tháng ${d.invoice!.month} đã quá hạn ${d.daysOverdue} ngày — hãy thanh toán ${d.overdueAmount.toLocaleString('vi-VN')}đ (nội dung ${d.invoice!.paymentCode}) để đăng tin mới`,
        this.debtDetails(d),
      );
    }
  }

  /** Quá hạn > 7 ngày → khóa mọi chức năng, chỉ còn xem / thanh toán phí (QĐ-40). */
  async assertNotLocked(userId: string) {
    const d = await this.debtStatus(userId);
    if (d.level === 'FULL') {
      throw new AppError(
        403,
        'ACCOUNT_LOCKED_UNPAID',
        `Tài khoản tạm khóa: hóa đơn phí tháng ${d.invoice!.month} quá hạn ${d.daysOverdue} ngày. Cần thanh toán ${d.overdueAmount.toLocaleString('vi-VN')}đ (nội dung ${d.invoice!.paymentCode}) trước khi các chức năng khác hoạt động trở lại`,
        this.debtDetails(d),
      );
    }
  }

  // ------------------------------------------------------------------ Admin

  async listByStatus(status: InvoiceStatus) {
    const items = await this.table.query<Invoice>(gsi1.statusPk('INVOICE', status), { index: 'gsi1' });
    const now = this.clock.now().toISOString();
    return items.filter((i) => i.status === status).map((i) => ({ ...i, overdue: i.status === 'ISSUED' && now > i.dueAt }));
  }

  /** Admin xác nhận đã nhận chuyển khoản (đối chiếu mã nội dung + số tiền). Mở khóa ngay. */
  async markPaid(adminId: string, userId: string, month: string, note?: string): Promise<Invoice> {
    const paid = await withOptimisticRetry(async () => {
      const invoice = await this.getInvoice(userId, month);
      if (!invoice) throw notFound('hóa đơn');
      if (invoice.status === 'PAID') throw conflict('INVOICE_ALREADY_PAID', 'Hóa đơn đã thu');
      const next: Invoice = {
        ...invoice,
        ...gsi1.byStatus('INVOICE', 'PAID', `${month}#${userId}`),
        status: 'PAID',
        paidAt: this.clock.now().toISOString(),
        paidBy: adminId,
        paidNote: note,
      };
      await this.table.transact([putVersioned(next, invoice.version ?? 1)]);
      return { ...next, version: (invoice.version ?? 1) + 1 };
    });
    log('info', 'invoice_paid', { userId, month, amount: paid.amount, by: adminId });
    await this.notifications.notify(userId, {
      type: 'INVOICE_PAID',
      title: `Đã nhận thanh toán phí tháng ${month}`,
      body: `${paid.amount.toLocaleString('vi-VN')}đ — cảm ơn bạn`,
      link: '/partner',
    });
    return paid;
  }
}
