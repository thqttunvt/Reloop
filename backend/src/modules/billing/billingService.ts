import { log } from '../../http/log';
import { HOUR_MS, type Clock } from '../../shared/clock';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors';
import { shortCode } from '../../shared/ids';
import { gsi1, keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { ConditionFailedError, putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';
import type { NotificationService } from '../notifications/notificationService';

/**
 * Phí dịch vụ (QĐ-37, thay hoa hồng QĐ-32 và phí đăng bài QĐ-33):
 *  • 10.000đ cho MỖI giao dịch HOÀN TẤT, NGƯỜI BÁN trả (đối tác cấp 1 hoặc cấp 2 — người đăng tin).
 *  • Gom theo tháng (giờ Việt Nam). Ngày 1 tháng sau hệ thống lập hóa đơn = số giao dịch × 10.000đ.
 *  • Người bán chuyển khoản kèm mã hóa đơn; Admin bấm "Đã thu".
 *  • Quá hạn 7 ngày chưa trả → khóa đăng tin và báo giá cho tới khi trả.
 */
export interface BillingPolicy {
  feePerTransaction: number;
  dueDays: number;
}

export const DEFAULT_BILLING: BillingPolicy = { feePerTransaction: 10_000, dueDays: 7 };

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
  completedAt: string;
}

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

const VN_OFFSET_MS = 7 * HOUR_MS;
/** Tháng theo giờ Việt Nam (UTC+7): giao dịch xong 23h ngày 31 vẫn thuộc tháng đó. */
export const vnMonth = (at: Date | string) => new Date(new Date(at).getTime() + VN_OFFSET_MS).toISOString().slice(0, 7);
const previousMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

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
      const lines = await this.feeLines(userId, month);
      if (lines.length === 0) continue;
      const now = this.clock.now();
      const invoice: Invoice = {
        ...keys.invoice(userId, month),
        ...gsi1.byStatus('INVOICE', 'ISSUED', `${month}#${userId}`),
        userId,
        month,
        paymentCode: `RLF${shortCode(6)}`,
        transactionCount: lines.length,
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
    const [current, invoices] = await Promise.all([this.feeLines(userId, month), this.invoices(userId)]);
    const now = this.clock.now().toISOString();
    return {
      feePerTransaction: this.policy.feePerTransaction,
      dueDays: this.policy.dueDays,
      bank: this.bank,
      currentMonth: {
        month,
        transactionCount: current.length,
        amount: current.reduce((s, l) => s + l.amount, 0),
        lines: current.map(({ transactionId, listingTitle, amount, completedAt }) => ({ transactionId, listingTitle, amount, completedAt })),
      },
      invoices: invoices.map((i) => ({ ...i, overdue: i.status === 'ISSUED' && now > i.dueAt })),
    };
  }

  /** Chặn đăng tin / báo giá khi có hóa đơn quá hạn chưa trả (QĐ-37). */
  async assertNoOverdue(userId: string) {
    const now = this.clock.now().toISOString();
    const overdue = (await this.invoices(userId)).find((i) => i.status === 'ISSUED' && now > i.dueAt);
    if (overdue) {
      throw new AppError(
        403,
        'INVOICE_OVERDUE',
        `Hóa đơn phí tháng ${overdue.month} (${overdue.amount.toLocaleString('vi-VN')}đ) đã quá hạn — hãy thanh toán (nội dung ${overdue.paymentCode}) để tiếp tục đăng tin / báo giá`,
        { month: overdue.month, amount: overdue.amount, paymentCode: overdue.paymentCode },
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
