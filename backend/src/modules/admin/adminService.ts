import { TRANSACTION_STATUSES, type ListingStatus } from '../../domain/stateMachines';
import { HOUR_MS, MONTH_RE, vnMonth, type Clock } from '../../shared/clock';
import { badRequest, notFound } from '../../shared/errors';
import { gsi1, keys } from '../../store/keys';
import { pageQuery, type Page } from '../../store/paging';
import type { Item, Table } from '../../store/table';
import type { BillingService, FeeLine, Invoice } from '../billing/billingService';
import type { Listing, ListingService } from '../listings/listingService';
import type { PartnerService } from '../partners/partnerService';
import type { RiskFlag } from '../risk/riskService';
import type { Transaction } from '../transactions/transactionService';
import type { UserProfile, UserService } from '../users/userService';

const LISTING_STATUSES: ListingStatus[] = ['PENDING_REVIEW', 'ACTIVE', 'MATCHED', 'COMPLETED', 'EXPIRED', 'CANCELLED'];
const DAY_MS = 24 * HOUR_MS;

const month = (raw: string | undefined, fallback: string) => {
  const m = raw ?? fallback;
  if (!MONTH_RE.test(m)) throw badRequest('INVALID_MONTH', 'Tháng dạng YYYY-MM');
  return m;
};

/** Lấy n + 1 dòng để biết còn nữa không. */
const capped = <T>(rows: T[], n: number) => ({ items: rows.slice(0, n), hasMore: rows.length > n });

/** Truy vấn riêng của trang Admin (get.md A2, A3, A4, A5, A6). Chỉ đọc — thao tác vẫn đi qua service nghiệp vụ. */
export class AdminService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly users: UserService,
    private readonly partners: PartnerService,
    private readonly listings: ListingService,
    private readonly billing: BillingService,
  ) {}

  // ------------------------------------------------------------------ Thành viên (A2)

  /** Thứ tự theo sub (ngẫu nhiên), không phải ngày đăng ký (get.md S5). */
  listUsers(cursor?: string) {
    return pageQuery<UserProfile>(this.table, gsi1.usersPk(), { index: 'gsi1', cursor });
  }

  /** shortcut: đọc hết ROLE#Owner mỗi lần tìm, đổi sang khóa EMAIL#<email> khi vượt vài nghìn người dùng. */
  async searchUsers(email: string) {
    const q = email.trim().toLowerCase();
    if (q.length < 3) throw badRequest('INVALID_QUERY', 'Nhập ít nhất 3 ký tự email');
    const all = await this.table.query<UserProfile>(gsi1.usersPk(), { index: 'gsi1' });
    return { items: all.filter((u) => u.email?.toLowerCase().includes(q)).slice(0, 50) };
  }

  /** Hồ sơ gộp 1 người: mỗi nhóm tối đa vài dòng gần nhất + hasMore. Không có nội dung chat. */
  async userDetail(userId: string) {
    const pk = keys.userPk(userId);
    const recent = (prefix: string, n: number) => this.table.query<Item>(pk, { skPrefix: prefix, ascending: false, limit: n + 1 });
    const since = new Date(this.clock.now().getTime() - 30 * DAY_MS).toISOString();
    const rk = keys.riskFlag(userId);
    const [profile, partner, branches, listings, txRefs, invoices, fees, violations, dealsEnded, suspicions, risk, debt] = await Promise.all([
      this.users.get(userId),
      this.partners.get(userId),
      this.partners.listBranches(userId),
      this.table.query<Listing>(gsi1.ownerListingPk(userId), { index: 'gsi1', ascending: false, limit: 21 }),
      recent('TX#', 20),
      recent('INVOICE#', 12),
      recent('FEE#', 20),
      recent('VIOL#', 50),
      recent('DEALEND#', 20),
      recent('SUSPECT#', 20),
      this.table.get<RiskFlag>(rk.pk, rk.sk),
      this.billing.debtStatus(userId),
    ]);
    if (!profile && !partner) throw notFound('người dùng');
    const tx = capped(txRefs, 20);
    const transactions = await Promise.all(
      tx.items.map((r) => {
        const k = keys.transaction(String(r.transactionId));
        return this.table.get<Transaction>(k.pk, k.sk);
      }),
    );
    const now = this.clock.now();
    return {
      profile: profile ?? null,
      partner: partner ?? null,
      quota: partner ? this.partners.listingQuota(partner, now) : null,
      branches,
      debt,
      listings: (({ items, hasMore }) => ({ items: items.map((l) => ({ ...l, status: this.listings.effectiveListingStatus(l, now) })), hasMore }))(capped(listings, 20)),
      transactions: { items: transactions.filter((t): t is Transaction => !!t), hasMore: tx.hasMore },
      invoices: capped(invoices as Invoice[], 12),
      fees: capped(fees as FeeLine[], 20),
      violations30d: { items: (violations as (Item & { at: string })[]).filter((v) => v.at >= since), hasMore: violations.length > 50 },
      dealsEnded: capped(dealsEnded, 20),
      suspicions: capped(suspicions, 20),
      risk: risk ?? null,
    };
  }

  // ------------------------------------------------------------------ Giao dịch (A3)

  /** Chỉ giao dịch tạo / đổi trạng thái từ khi deploy A3 (PO không bù dữ liệu cũ). */
  listTransactions(status: string | undefined, cursor?: string): Promise<Page<Transaction>> {
    const s = status ?? 'HANDOVER_PENDING';
    if (!(TRANSACTION_STATUSES as readonly string[]).includes(s)) throw badRequest('INVALID_QUERY', `status phải thuộc: ${TRANSACTION_STATUSES.join(', ')}`);
    return pageQuery<Transaction>(this.table, gsi1.txStatusPk(s), { index: 'gsi1', cursor });
  }

  // ------------------------------------------------------------------ Tin theo tháng (A4)

  /**
   * Tin của 1 tháng THEO GIỜ UTC (FEED# ghi theo createdAt UTC — get.md S3), lọc trạng thái hiệu lực.
   * Đọc con trỏ theo lô 50, dừng khi đủ `limit` hoặc đã đọc 500 con trỏ → trang có thể ít hơn limit, vẫn có nextCursor.
   */
  async listListings(rawMonth: string | undefined, status: string | undefined, cursor?: string, limit = 20) {
    const m = month(rawMonth, this.clock.now().toISOString().slice(0, 7));
    if (status && !LISTING_STATUSES.includes(status as ListingStatus)) throw badRequest('INVALID_QUERY', `status phải thuộc: ${LISTING_STATUSES.join(', ')}`);
    const now = this.clock.now();
    const items: Listing[] = [];
    const seen = new Set<string>();
    let next = cursor;
    let scanned = 0;
    do {
      const page = await pageQuery<Item & { listingId: string }>(this.table, keys.feedPk(m), { limit: 50, cursor: next });
      scanned += page.items.length;
      next = page.nextCursor;
      const fresh = page.items.filter((r) => !seen.has(r.listingId) && seen.add(r.listingId));
      const loaded = await Promise.all(
        fresh.map((r) => {
          const k = keys.listing(r.listingId);
          return this.table.get<Listing>(k.pk, k.sk);
        }),
      );
      for (const l of loaded) {
        if (!l) continue;
        const view = { ...l, status: this.listings.effectiveListingStatus(l, now) };
        if (!status || view.status === status) items.push(view);
      }
    } while (next && items.length < limit && scanned < 500);
    return { month: m, timezone: 'UTC', items, nextCursor: next };
  }

  // ------------------------------------------------------------------ Nhật ký Admin (A5)

  listAudit(rawMonth: string | undefined, cursor?: string) {
    return pageQuery<Item>(this.table, keys.auditPk(month(rawMonth, vnMonth(this.clock.now()))), { cursor });
  }

  // ------------------------------------------------------------------ Số liệu tháng (A6)

  /**
   * Đọc khi cần từ FEEMONTH# + dòng phí + hóa đơn của tháng (giờ VN). Khi > ~1.000 người có phí / tháng
   * thì chuyển sang bộ đếm STATS#<tháng> cập nhật trong BillingService (cùng transaction).
   */
  async monthStats(rawMonth: string | undefined) {
    const m = month(rawMonth, vnMonth(this.clock.now()));
    const members = await this.table.query<Item & { userId: string }>(keys.feeMonthPk(m));
    const rows = await Promise.all(
      members.map(async ({ userId }) => {
        const ik = keys.invoice(userId, m);
        const [lines, invoice] = await Promise.all([
          this.table.query<FeeLine>(keys.userPk(userId), { skPrefix: `FEE#${m}#` }),
          this.table.get<Invoice>(ik.pk, ik.sk),
        ]);
        return { lines, invoice };
      }),
    );
    const lines = rows.flatMap((r) => r.lines).filter((l) => l.amount > 0);
    const invoices = rows.flatMap((r) => (r.invoice ? [r.invoice] : []));
    return {
      month: m,
      sellers: members.length,
      completedTransactions: lines.filter((l) => (l.kind ?? 'TRANSACTION') === 'TRANSACTION').length,
      feesAccrued: lines.reduce((s, l) => s + l.amount, 0),
      feesIssued: invoices.reduce((s, i) => s + i.amount, 0),
      feesPaid: invoices.filter((i) => i.status === 'PAID').reduce((s, i) => s + i.amount, 0),
    };
  }
}
