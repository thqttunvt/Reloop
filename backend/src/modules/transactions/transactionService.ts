import { HANDOVER_METHODS, type HandoverMethod } from '../../domain/catalog';
import { quoteMachine, transactionMachine, type Actor, type ListingStatus, type TransactionStatus } from '../../domain/stateMachines';
import { HOUR_MS, type Clock } from '../../shared/clock';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { int, oneOf, str } from '../../shared/validate';
import { assertOwnImageKeys, type ImageStore } from '../../storage/imageStore';
import { gsi1, keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';
import { timerOp } from '../jobs/timers';
import type { BillingService } from '../billing/billingService';
import type { RiskService } from '../risk/riskService';
import { log } from '../../http/log';
import type { Listing, ListingService, Quote } from '../listings/listingService';
import type { NotificationService } from '../notifications/notificationService';
import type { Branch, PartnerService } from '../partners/partnerService';
import type { UserService } from '../users/userService';

/** Một bên xác nhận hoàn tất, bên kia im lặng quá 48h → tự hoàn tất (QĐ-18). */
export const COUNTERPARTY_TTL_MS = 48 * HOUR_MS;
/** Tối đa 2 lần đề nghị giảm giá (QĐ-15). */
export const MAX_PRICE_ADJUSTMENTS = 2;
/** Đánh giá trong 14 ngày sau khi giao dịch kết thúc (giaiphap D13). */
export const REVIEW_WINDOW_MS = 14 * 24 * HOUR_MS;
/** Một bên yêu cầu hủy → 5 phút sau tự hủy (QĐ-38). */
export const CANCEL_DELAY_MS = 5 * 60 * 1000;
/** Thao tác vẫn làm được khi đang có yêu cầu hủy. */
const CANCEL_EVENTS = ['CANCEL_WITHDRAWN', 'CANCELLED'];

export const FAILURE_REASONS = ['NO_SHOW_OWNER', 'NO_SHOW_PARTNER', 'DEVICE_MISMATCH', 'PRICE_DISAGREEMENT', 'OTHER'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

type Party = 'OWNER' | 'PARTNER';
const other = (p: Party): Party => (p === 'OWNER' ? 'PARTNER' : 'OWNER');

export interface Transaction extends Item {
  transactionId: string;
  listingId: string;
  /** QUOTE: chủ tin chọn báo giá của đối tác cấp 2. CHAT: hai bên chốt lời ra giá trong chat (QĐ-38). Bản ghi cũ không có → QUOTE. */
  source?: 'QUOTE' | 'CHAT';
  quoteId?: string;
  conversationId?: string;
  ownerId: string;
  /** Bên mua: đối tác cấp 2 (QUOTE) hoặc khách bất kỳ (CHAT). */
  partnerId: string;
  branchId?: string;
  /** Chiều thu mua: Partner trả, Owner nhận (QĐ-29). */
  direction: 'BUYBACK';
  payerId: string;
  payeeId: string;
  /** Nạp/rút qua ví đã tạm bỏ → hai bên thanh toán trực tiếp khi gặp. */
  paymentMode: 'OFFLINE';
  status: TransactionStatus;
  listingTitle: string;
  partnerName: string;
  branchName?: string;
  originalPrice: number;
  agreedPrice: number;
  finalPrice?: number;
  priceAdjustments: { price: number; reason: string; imageKeys: string[]; at: string; outcome?: 'ACCEPTED' | 'REJECTED' }[];
  handoverPlan?: {
    method: HandoverMethod;
    time: string;
    place: string;
    note?: string;
    proposedBy: Party;
    status: 'PROPOSED' | 'AGREED';
    at: string;
  };
  completion: Partial<Record<Party, { at: string; finalPrice: number }>>;
  counterpartyDeadline?: string;
  cancel?: { by: Party; reason: string; at: string };
  /** Đang chờ hủy: tới effectiveAt thì tự hủy (QĐ-38). */
  cancelRequest?: { by: Party; reason: string; at: string; effectiveAt: string };
  failure?: { by: Party; reason: FailureReason; note?: string; at: string };
  dispute?: { by: Party; reason: string; at: string; resolution?: { outcome: 'COMPLETED' | 'FAILED'; finalPrice?: number; note: string; by: string; at: string } };
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Review extends Item {
  transactionId: string;
  by: Party;
  reviewerId: string;
  revieweeId: string;
  rating: number;
  comment?: string;
  /** VERIFIED_TRANSACTION: hoàn tất với xác nhận của cả 2 bên; ADMIN_RESOLVED: Admin kết luận hoàn tất (D14). */
  label: 'VERIFIED_TRANSACTION' | 'ADMIN_RESOLVED' | 'FAILED_TRANSACTION';
  createdAt: string;
}

const TERMINAL: TransactionStatus[] = ['COMPLETED', 'CANCELLED', 'FAILED'];

export class TransactionService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly users: UserService,
    private readonly partners: PartnerService,
    private readonly listings: ListingService,
    private readonly notifications: NotificationService,
    private readonly images: ImageStore,
    private readonly billing: BillingService,
    private readonly risk: RiskService,
  ) {}

  // ------------------------------------------------------------------ Tạo giao dịch (T9.1)

  /** Owner chọn một offer đã xác nhận. 2 request đồng thời → chỉ 1 thành công (điều kiện version của Listing). */
  async select(ownerId: string, input: Record<string, unknown>): Promise<Transaction> {
    await this.users.requireTerms({ userId: ownerId, groups: [] });
    await this.partners.requireSeller(ownerId); // người bán bị tạm ngừng không chốt giao dịch mới
    const listingId = str(input.listingId, 'listingId', { max: 64 });
    const quoteId = str(input.quoteId, 'quoteId', { max: 80 });
    const tx = await withOptimisticRetry(async () => {
      const listing = await this.loadListing(listingId);
      if (listing.ownerId !== ownerId) throw notFound('tin đăng');
      if (this.listings.effectiveListingStatus(listing) !== 'ACTIVE') {
        throw conflict('LISTING_NOT_ACTIVE', 'Tin không còn mở để chọn đối tác');
      }
      const qk = keys.quote(listingId, quoteId);
      const quote = await this.table.get<Quote>(qk.pk, qk.sk);
      if (!quote) throw notFound('báo giá');
      const qs = this.listings.effectiveQuoteStatus(quote, listing);
      if (qs !== 'CONFIRMED_OFFER') throw conflict('OFFER_NOT_SELECTABLE', 'Chỉ chọn được báo giá đã xác nhận còn hiệu lực');
      quoteMachine.assertTransition('CONFIRMED_OFFER', 'SELECTED', 'OWNER');
      await this.partners.requireApproved(quote.partnerId);
      // Đơn vị thu mua bị khóa do nợ phí > 7 ngày không làm được gì trong giao dịch (QĐ-40)
      if (!(await this.partners.isAvailable(quote.partnerId))) throw conflict('PARTNER_UNAVAILABLE', 'Đơn vị thu mua đang tạm khóa — hãy chọn báo giá khác');

      const now = this.clock.now().toISOString();
      const transactionId = newId();
      const price = quote.offer!.price;
      const tx: Transaction = {
        ...keys.transaction(transactionId),
        transactionId,
        listingId,
        source: 'QUOTE',
        quoteId,
        ownerId,
        partnerId: quote.partnerId,
        branchId: quote.branchId,
        direction: 'BUYBACK',
        payerId: quote.partnerId,
        payeeId: ownerId,
        paymentMode: 'OFFLINE',
        status: 'HANDOVER_PENDING',
        listingTitle: listing.title,
        partnerName: quote.partnerName,
        branchName: quote.branchName,
        originalPrice: price,
        agreedPrice: price,
        priceAdjustments: [],
        completion: {},
        createdAt: now,
        updatedAt: now,
      };
      Object.assign(tx, gsi1.txStatus(tx));
      await this.table.transact([
        putVersioned({ ...listing, status: 'MATCHED', activeTransactionId: transactionId, lastEndedDeal: undefined, updatedAt: now }, listing.version ?? 1),
        putVersioned({ ...quote, status: 'SELECTED', updatedAt: now }, quote.version ?? 1),
        putVersioned(tx, 0),
        putNew({ ...keys.userTransaction(ownerId, now, transactionId), transactionId, role: 'OWNER' }),
        putNew({ ...keys.userTransaction(quote.partnerId, now, transactionId), transactionId, role: 'PARTNER' }),
        this.eventOp(tx, 0, 'OWNER', 'CREATED', { price }),
      ]);
      return { ...tx, version: 1 };
    });
    await this.notifications.notify(tx.partnerId, {
      type: 'TX_CREATED',
      title: 'Bạn được chọn để thu mua',
      body: `${tx.listingTitle} — ${tx.agreedPrice.toLocaleString('vi-VN')}đ`,
      link: `/transactions/${tx.transactionId}`,
    });
    // Đơn vị thu mua khác + khách đang hỏi biết tin đã có người chốt (mục 1b danhgia)
    await this.listings.notifyTaken(tx.listingId, tx.listingTitle, [tx.ownerId, tx.partnerId]);
    return tx;
  }

  /**
   * Chốt lời ra giá trong chat khi tin đang mở (QĐ-38). Trả về các thao tác ghi để ChatService ghi CÙNG
   * transaction với việc đóng lời ra giá → 2 người chốt cùng lúc thì chỉ 1 người thành công (version của Listing).
   */
  chatDealOps(listing: Listing, buyer: { userId: string; name: string; conversationId: string }, price: number, acceptedBy: Party) {
    const now = this.clock.now().toISOString();
    const transactionId = newId();
    const tx: Transaction = {
      ...keys.transaction(transactionId),
      transactionId,
      listingId: listing.listingId,
      source: 'CHAT',
      conversationId: buyer.conversationId,
      ownerId: listing.ownerId,
      partnerId: buyer.userId,
      direction: 'BUYBACK',
      payerId: buyer.userId,
      payeeId: listing.ownerId,
      paymentMode: 'OFFLINE',
      status: 'HANDOVER_PENDING',
      listingTitle: listing.title,
      partnerName: buyer.name,
      originalPrice: price,
      agreedPrice: price,
      priceAdjustments: [],
      completion: {},
      createdAt: now,
      updatedAt: now,
    };
    Object.assign(tx, gsi1.txStatus(tx));
    const ops: WriteOp[] = [
      putVersioned({ ...listing, status: 'MATCHED', activeTransactionId: transactionId, lastEndedDeal: undefined, updatedAt: now }, listing.version ?? 1),
      putVersioned(tx, 0),
      putNew({ ...keys.userTransaction(listing.ownerId, now, transactionId), transactionId, role: 'OWNER' }),
      putNew({ ...keys.userTransaction(buyer.userId, now, transactionId), transactionId, role: 'PARTNER' }),
      this.eventOp(tx, 0, acceptedBy, 'CREATED', { price, source: 'CHAT' }),
    ];
    return { tx: { ...tx, version: 1 }, ops };
  }

  /** Hai bên chốt giá mới trong chat khi đang chờ bàn giao (QĐ-38). */
  agreeChatPrice(userId: string, transactionId: string, price: number) {
    return this.change(userId, transactionId, 'PRICE_AGREED', (tx) => {
      if (tx.status !== 'HANDOVER_PENDING') throw conflict('INVALID_STATE', 'Chỉ đổi giá khi đang chờ bàn giao');
      return { ...tx, agreedPrice: price };
    }, { price });
  }

  // ------------------------------------------------------------------ Đọc

  async list(userId: string) {
    const refs = await this.table.query<Item & { transactionId: string }>(keys.userPk(userId), { skPrefix: 'TX#', ascending: false, limit: 50 });
    const txs = await Promise.all(refs.map((r) => this.loadAndSettle(r.transactionId)));
    return txs.filter((t): t is Transaction => !!t);
  }

  /** Chi tiết + thông tin liên lạc của bên kia (mở ngay khi chọn offer — QĐ-20, thanh toán offline). */
  async get(userId: string, transactionId: string, isAdmin = false) {
    const tx = await this.loadAndSettle(transactionId);
    if (!tx) throw notFound('giao dịch');
    const party = this.partyOf(tx, userId);
    if (!party && !isAdmin) throw notFound('giao dịch');

    const [listing, owner, ownerPartner, partner, buyer, branch, events, reviews] = await Promise.all([
      this.loadListing(tx.listingId),
      this.users.get(tx.ownerId),
      this.partners.get(tx.ownerId),
      this.partners.get(tx.partnerId),
      this.users.get(tx.partnerId),
      tx.branchId ? this.partners.getBranch(tx.partnerId, tx.branchId) : undefined,
      this.table.query<Item>(keys.transactionPk(transactionId), { skPrefix: 'EVENT#' }),
      this.table.query<Review>(keys.transactionPk(transactionId), { skPrefix: 'REVIEW#' }),
    ]);
    // Người mua qua chat có thể không phải đối tác → liên hệ lấy từ hồ sơ người dùng
    const partnerContact = partner ? await this.partners.contactOf(partner) : { email: buyer?.email, phone: buyer?.phone };
    const contacts = {
      owner: {
        fullName: ownerPartner?.businessName ?? owner?.fullName,
        email: ownerPartner?.contactEmail,
        phone: owner?.phone,
        address: listing.location.address,
        location: listing.location,
      },
      partner: {
        businessName: partner?.businessName ?? tx.partnerName,
        email: partnerContact?.email,
        phone: partnerContact?.phone,
        branchName: (branch as Branch | undefined)?.name,
        address: (branch as Branch | undefined)?.location.address,
        location: (branch as Branch | undefined)?.location,
      },
    };
    const images = this.images.enabled
      ? await Promise.all(tx.priceAdjustments.flatMap((a) => a.imageKeys).map((k) => this.images.viewUrl(k)))
      : [];
    return { role: party ?? 'ADMIN', transaction: tx, contacts, events, reviews, adjustmentImages: images, canReview: party ? this.canReview(tx, party, reviews) : false };
  }

  // ------------------------------------------------------------------ Bàn giao (T9.4)

  proposeHandover(userId: string, transactionId: string, input: Record<string, unknown>) {
    const method = oneOf<HandoverMethod>(input.method, HANDOVER_METHODS, 'method');
    const time = str(input.time, 'time', { max: 40 });
    if (Number.isNaN(Date.parse(time))) throw badRequest('INVALID_TIME', 'Thời gian không hợp lệ');
    const place = str(input.place, 'place', { max: 300 });
    const note = str(input.note, 'note', { max: 500, optional: true });
    return this.change(userId, transactionId, 'HANDOVER_PROPOSED', (tx, party, now) => {
      if (tx.status !== 'HANDOVER_PENDING') throw conflict('INVALID_STATE', 'Chỉ thỏa thuận bàn giao khi đang chờ bàn giao');
      return { ...tx, handoverPlan: { method, time, place, note, proposedBy: party, status: 'PROPOSED', at: now } };
    });
  }

  acceptHandover(userId: string, transactionId: string) {
    return this.change(userId, transactionId, 'HANDOVER_AGREED', (tx, party, now) => {
      if (!tx.handoverPlan || tx.handoverPlan.status !== 'PROPOSED') throw conflict('NO_PROPOSAL', 'Chưa có đề xuất bàn giao');
      if (tx.handoverPlan.proposedBy === party) throw conflict('OWN_PROPOSAL', 'Bên kia phải chấp nhận đề xuất của bạn');
      return { ...tx, handoverPlan: { ...tx.handoverPlan, status: 'AGREED', at: now } };
    });
  }

  // ------------------------------------------------------------------ Điều chỉnh giá (T9.5, QĐ-15)

  async proposePriceAdjustment(userId: string, transactionId: string, input: Record<string, unknown>) {
    const price = int(input.price, 'price', { min: 0, max: 1_000_000_000 });
    const reason = str(input.reason, 'reason', { min: 5, max: 500 });
    const imageKeys = assertOwnImageKeys(userId, input.imageKeys);
    if (this.images.enabled && imageKeys.length === 0) throw badRequest('IMAGE_REQUIRED', 'Cần ít nhất 1 ảnh chứng minh');
    await this.images.assertModerated(imageKeys);
    await this.images.markAttached(imageKeys);
    return this.change(userId, transactionId, 'PRICE_ADJUSTMENT_PROPOSED', (tx, party, now) => {
      if (party !== 'PARTNER') throw forbidden('Chỉ đối tác đề nghị điều chỉnh giá');
      transactionMachine.assertTransition(tx.status, 'PRICE_ADJUSTMENT_PENDING', 'PARTNER');
      if (tx.priceAdjustments.length >= MAX_PRICE_ADJUSTMENTS) throw conflict('ADJUSTMENT_LIMIT', `Tối đa ${MAX_PRICE_ADJUSTMENTS} lần điều chỉnh giá`);
      if (price >= tx.agreedPrice) throw badRequest('PRICE_NOT_LOWER', 'Chỉ được điều chỉnh giảm giá');
      return { ...tx, status: 'PRICE_ADJUSTMENT_PENDING', priceAdjustments: [...tx.priceAdjustments, { price, reason, imageKeys, at: now }] };
    }, { price });
  }

  respondPriceAdjustment(userId: string, transactionId: string, accept: boolean) {
    return this.change(userId, transactionId, accept ? 'PRICE_ADJUSTMENT_ACCEPTED' : 'PRICE_ADJUSTMENT_REJECTED', (tx, party) => {
      if (party !== 'OWNER') throw forbidden('Chỉ chủ tin đồng ý / từ chối điều chỉnh giá');
      transactionMachine.assertTransition(tx.status, 'HANDOVER_PENDING', 'OWNER');
      const adjustments = [...tx.priceAdjustments];
      const last = { ...adjustments[adjustments.length - 1]!, outcome: accept ? ('ACCEPTED' as const) : ('REJECTED' as const) };
      adjustments[adjustments.length - 1] = last;
      return { ...tx, status: 'HANDOVER_PENDING', priceAdjustments: adjustments, agreedPrice: accept ? last.price : tx.agreedPrice };
    });
  }

  // ------------------------------------------------------------------ Hoàn tất (T9.6, QĐ-18, giaiphap C7)

  /**
   * Hoàn tất 2 bước (mục 7 danhgia): bên xác nhận TRƯỚC nhập giá cuối; bên còn lại chỉ CHẤP NHẬN giá đó
   * (không nhập lại — finalPrice gửi kèm ở bước 2 bị bỏ qua). Không đồng ý → Khiếu nại (dispute) trong 48 giờ.
   */
  confirmCompletion(userId: string, transactionId: string, input: Record<string, unknown>) {
    return this.change(userId, transactionId, 'COMPLETION_CONFIRMED', (tx, party, now) => {
      if (tx.status === 'HANDOVER_PENDING') {
        const finalPrice = input.finalPrice === undefined ? tx.agreedPrice : int(input.finalPrice, 'finalPrice', { min: 0, max: 1_000_000_000 });
        const completion = { ...tx.completion, [party]: { at: now, finalPrice } };
        transactionMachine.assertTransition(tx.status, 'AWAITING_COUNTERPARTY', party);
        return {
          ...tx,
          status: 'AWAITING_COUNTERPARTY',
          completion,
          counterpartyDeadline: new Date(Date.parse(now) + COUNTERPARTY_TTL_MS).toISOString(),
        };
      }
      if (tx.status !== 'AWAITING_COUNTERPARTY') throw conflict('INVALID_STATE_TRANSITION', `Giao dịch đang ${tx.status}`);
      if (tx.completion[party]) throw conflict('ALREADY_CONFIRMED', 'Bạn đã xác nhận, đang chờ bên kia');
      transactionMachine.assertTransition(tx.status, 'COMPLETED', party);
      const { finalPrice } = tx.completion[other(party)]!; // chấp nhận đúng giá bên kia đã xác nhận
      const completion = { ...tx.completion, [party]: { at: now, finalPrice } };
      return { ...tx, status: 'COMPLETED', completion, finalPrice, closedAt: now };
    });
  }

  /**
   * Bên kia khiếu nại trong 48h (QĐ-18 → QĐ-08). Báo cho Admin: chuông hộp thư chung trên web + log `dispute_opened`
   * → CloudWatch alarm gửi email tới các Admin đã đăng ký (infra/monitoring.tf, scripts/make-admin.sh — mục 7 danhgia).
   */
  async dispute(userId: string, transactionId: string, input: Record<string, unknown>) {
    const reason = str(input.reason, 'reason', { min: 5, max: 1000 });
    const tx = await this.change(userId, transactionId, 'DISPUTED', (tx, party, now) => {
      transactionMachine.assertTransition(tx.status, 'DISPUTED', party);
      if (tx.completion[party]) throw conflict('ALREADY_CONFIRMED', 'Bạn đã xác nhận hoàn tất');
      return { ...tx, status: 'DISPUTED', dispute: { by: party, reason, at: now } };
    });
    log('warn', 'dispute_opened', { transactionId, by: tx.dispute?.by });
    await this.notifications.notifyAdmins({
      type: 'ADMIN_DISPUTE',
      title: `Có khiếu nại mới: ${tx.listingTitle}`,
      body: `${tx.dispute?.by === 'OWNER' ? 'Người bán' : 'Người mua'} khiếu nại — ${reason}`,
      link: `/transactions/${transactionId}`,
    });
    return tx;
  }

  // ------------------------------------------------------------------ Hủy / thất bại (T9.7)

  /** Yêu cầu hủy: 5 phút sau tự hủy dù bên kia có đồng ý hay không (QĐ-38). */
  cancel(userId: string, transactionId: string, input: Record<string, unknown>) {
    const reason = str(input.reason, 'reason', { min: 3, max: 500 });
    return this.change(userId, transactionId, 'CANCEL_REQUESTED', (tx, party, now) => {
      transactionMachine.assertTransition(tx.status, 'CANCELLED', party);
      const effectiveAt = new Date(Date.parse(now) + CANCEL_DELAY_MS).toISOString();
      return { ...tx, cancelRequest: { by: party, reason, at: now, effectiveAt } };
    });
  }

  /** Người yêu cầu rút lại trong 5 phút. */
  withdrawCancel(userId: string, transactionId: string) {
    return this.change(userId, transactionId, 'CANCEL_WITHDRAWN', (tx, party) => {
      if (!tx.cancelRequest) throw conflict('NO_CANCEL_REQUEST', 'Không có yêu cầu hủy');
      if (tx.cancelRequest.by !== party) throw forbidden('Chỉ bên yêu cầu hủy mới rút lại được');
      const { cancelRequest: _request, ...rest } = tx;
      return rest;
    });
  }

  /** Bên kia đồng ý → hủy ngay, không chờ hết 5 phút. */
  confirmCancel(userId: string, transactionId: string) {
    return this.change(userId, transactionId, 'CANCELLED', (tx, party, now) => {
      if (!tx.cancelRequest) throw conflict('NO_CANCEL_REQUEST', 'Không có yêu cầu hủy');
      if (tx.cancelRequest.by === party) throw conflict('OWN_CANCEL_REQUEST', 'Đang chờ bên kia — giao dịch tự hủy khi hết 5 phút');
      return this.cancelled(tx, now);
    });
  }

  /** Hết 5 phút (job nền hoặc khi đọc). Chạy trùng an toàn: chỉ ghi khi yêu cầu hủy còn và đã tới hạn. */
  async finalizeCancel(transactionId: string): Promise<Transaction | undefined> {
    let done: Transaction;
    try {
      done = await this.mutate(transactionId, 'SYSTEM', 'SYSTEM', 'CANCELLED', (tx, now) => {
        if (!tx.cancelRequest || now < tx.cancelRequest.effectiveAt) throw conflict('NOT_DUE', 'Chưa tới hạn');
        return this.cancelled(tx, now);
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_DUE') return this.loadTx(transactionId);
      throw err;
    }
    await this.notifications.notify([done.ownerId, done.partnerId], {
      type: 'TX_CANCELLED',
      title: 'Giao dịch đã hủy sau 5 phút — tin quay lại Chợ nếu còn hạn',
      body: done.listingTitle,
      link: `/transactions/${transactionId}`,
    });
    return done;
  }

  private cancelled(tx: Transaction, now: string): Transaction {
    const request = tx.cancelRequest!;
    transactionMachine.assertTransition(tx.status, 'CANCELLED', request.by);
    const { cancelRequest: _request, ...rest } = tx;
    return { ...rest, status: 'CANCELLED', cancel: { by: request.by, reason: request.reason, at: now }, closedAt: now };
  }

  reportFailure(userId: string, transactionId: string, input: Record<string, unknown>) {
    const reason = oneOf<FailureReason>(input.reason, FAILURE_REASONS, 'reason');
    const note = str(input.note, 'note', { max: 500, optional: true });
    return this.change(userId, transactionId, 'FAILED', (tx, party, now) => {
      transactionMachine.assertTransition(tx.status, 'FAILED', party);
      return { ...tx, status: 'FAILED', failure: { by: party, reason, note, at: now }, closedAt: now };
    });
  }

  // ------------------------------------------------------------------ Admin (T13.3)

  /** Tranh chấp đang mở, chờ lâu nhất trước (QĐ-08: Admin quyết trong 7 ngày). */
  async listDisputed() {
    const all = await this.table.query<Transaction>(gsi1.txStatusPk('DISPUTED'), { index: 'gsi1' });
    return all.filter((t) => t.status === 'DISPUTED').sort((a, b) => (a.dispute?.at ?? '').localeCompare(b.dispute?.at ?? ''));
  }

  /** Admin kết luận tranh chấp → báo cả 2 bên kết luận + ghi chú (mục 25 danhgia). */
  async resolveDispute(adminId: string, transactionId: string, input: Record<string, unknown>) {
    const outcome = oneOf<'COMPLETED' | 'FAILED'>(input.outcome, ['COMPLETED', 'FAILED'], 'outcome');
    const note = str(input.note, 'note', { min: 3, max: 1000 });
    const finalPrice = outcome === 'COMPLETED' ? int(input.finalPrice, 'finalPrice', { min: 0, max: 1_000_000_000 }) : undefined;
    const tx = await this.mutate(transactionId, 'ADMIN', adminId, 'DISPUTE_RESOLVED', (tx, now) => {
      transactionMachine.assertTransition(tx.status, outcome, 'ADMIN');
      return {
        ...tx,
        status: outcome,
        finalPrice: finalPrice ?? tx.finalPrice,
        dispute: { ...tx.dispute!, resolution: { outcome, finalPrice, note, by: adminId, at: now } },
        closedAt: now,
      };
    });
    await this.notifications.notify([tx.ownerId, tx.partnerId], {
      type: 'TX_DISPUTE_RESOLVED',
      title:
        outcome === 'COMPLETED'
          ? `Admin kết luận tranh chấp: giao dịch hoàn tất với giá ${finalPrice!.toLocaleString('vi-VN')}đ`
          : 'Admin kết luận tranh chấp: giao dịch thất bại',
      body: `${tx.listingTitle} — ${note}`,
      link: `/transactions/${transactionId}`,
    });
    return tx;
  }

  // ------------------------------------------------------------------ Đánh giá hai chiều (T12.1, QĐ-22)

  private canReview(tx: Transaction, party: Party, reviews: Review[]) {
    if (!['COMPLETED', 'FAILED'].includes(tx.status) || !tx.closedAt) return false;
    if (Date.parse(tx.closedAt) + REVIEW_WINDOW_MS < this.clock.now().getTime()) return false;
    return !reviews.some((r) => r.by === party);
  }

  async review(userId: string, transactionId: string, input: Record<string, unknown>) {
    const rating = int(input.rating, 'rating', { min: 1, max: 5 });
    const comment = str(input.comment, 'comment', { max: 1000, optional: true });
    const tx = await this.loadAndSettle(transactionId);
    if (!tx) throw notFound('giao dịch');
    const party = this.partyOf(tx, userId);
    if (!party) throw notFound('giao dịch');
    const existing = await this.table.query<Review>(keys.transactionPk(transactionId), { skPrefix: 'REVIEW#' });
    if (!this.canReview(tx, party, existing)) throw conflict('REVIEW_NOT_ALLOWED', 'Không thể đánh giá giao dịch này (chưa kết thúc, đã đánh giá hoặc quá 14 ngày)');

    const now = this.clock.now().toISOString();
    const revieweeId = party === 'OWNER' ? tx.partnerId : tx.ownerId;
    const label: Review['label'] =
      tx.status === 'FAILED' ? 'FAILED_TRANSACTION' : tx.dispute?.resolution ? 'ADMIN_RESOLVED' : 'VERIFIED_TRANSACTION';
    const review: Review = {
      ...keys.review(transactionId, party),
      transactionId,
      by: party,
      reviewerId: userId,
      revieweeId,
      rating,
      comment,
      label,
      createdAt: now,
    };
    await this.table.transact([
      putVersioned(review, 0),
      putNew({ ...keys.receivedReview(revieweeId, now, transactionId), transactionId, rating, label, by: party, comment, createdAt: now }),
    ]);
    await this.notifications.notify(revieweeId, {
      type: 'REVIEW_RECEIVED',
      title: `Bạn nhận được đánh giá ${rating}★`,
      link: `/transactions/${transactionId}`,
    });
    return { ...review, version: 1 };
  }

  // ------------------------------------------------------------------ Nội bộ

  private partyOf(tx: Transaction, userId: string): Party | undefined {
    if (tx.ownerId === userId) return 'OWNER';
    if (tx.partnerId === userId) return 'PARTNER';
    return undefined;
  }

  private async loadListing(listingId: string) {
    const k = keys.listing(listingId);
    const listing = await this.table.get<Listing>(k.pk, k.sk);
    if (!listing) throw notFound('tin đăng');
    return listing;
  }

  private async loadTx(transactionId: string) {
    const k = keys.transaction(transactionId);
    return this.table.get<Transaction>(k.pk, k.sk);
  }

  /** Đọc giao dịch; nếu đã quá 48h chờ bên kia thì tự hoàn tất trước khi trả về (chưa có job nền — Epic 10). */
  async loadAndSettle(transactionId: string): Promise<Transaction | undefined> {
    const tx = await this.loadTx(transactionId);
    if (tx?.cancelRequest && this.clock.now().toISOString() >= tx.cancelRequest.effectiveAt) return this.finalizeCancel(transactionId);
    if (!tx || tx.status !== 'AWAITING_COUNTERPARTY' || !tx.counterpartyDeadline) return tx;
    if (this.clock.now().toISOString() < tx.counterpartyDeadline) return tx;
    return this.autoComplete(transactionId);
  }

  /** Job nền: nhắc bên chưa xác nhận ở mốc 24h (QĐ-18). */
  async remindIfWaiting(transactionId: string) {
    const tx = await this.loadTx(transactionId);
    if (!tx || tx.status !== 'AWAITING_COUNTERPARTY') return;
    const waiting = tx.completion.OWNER ? tx.partnerId : tx.ownerId;
    await this.notifications.notify(waiting, {
      type: 'TX_REMIND',
      title: 'Nhắc: hãy xác nhận hoàn tất giao dịch — còn khoảng 24 giờ trước khi hệ thống tự hoàn tất',
      body: tx.listingTitle,
      link: `/transactions/${transactionId}`,
    });
  }

  /** Tự hoàn tất khi hết 48h (job nền hoặc khi đọc). Chạy trùng an toàn: chỉ ghi nếu vẫn AWAITING_COUNTERPARTY. */
  async autoComplete(transactionId: string): Promise<Transaction | undefined> {
    const before = await this.loadTx(transactionId);
    const after = await this.autoCompleteInner(transactionId);
    if (before?.status === 'AWAITING_COUNTERPARTY' && after?.status === 'COMPLETED') {
      await this.notifications.notify([after.ownerId, after.partnerId], {
        type: 'TX_AUTO_COMPLETED',
        title: 'Giao dịch đã tự hoàn tất sau 48 giờ',
        body: after.listingTitle,
        link: `/transactions/${transactionId}`,
      });
    }
    return after;
  }

  private async autoCompleteInner(transactionId: string): Promise<Transaction | undefined> {
    try {
      return await this.mutate(transactionId, 'SYSTEM', 'SYSTEM', 'AUTO_COMPLETED', (tx, now) => {
        if (tx.status !== 'AWAITING_COUNTERPARTY' || !tx.counterpartyDeadline || now < tx.counterpartyDeadline) {
          throw conflict('NOT_DUE', 'Chưa tới hạn');
        }
        transactionMachine.assertTransition(tx.status, 'COMPLETED', 'SYSTEM');
        const first = Object.values(tx.completion)[0];
        return { ...tx, status: 'COMPLETED', finalPrice: first?.finalPrice ?? tx.agreedPrice, closedAt: now };
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_DUE') return this.loadTx(transactionId);
      throw err;
    }
  }

  private eventOp(tx: Transaction, seq: number, actor: Actor, type: string, data: Record<string, unknown> = {}): WriteOp {
    const at = this.clock.now().toISOString();
    return putNew({ ...keys.transactionEvent(tx.transactionId, at, seq), type, actor, from: tx.status, data, at });
  }

  /** Thay đổi do Owner/Partner thực hiện. */
  private async change(
    userId: string,
    transactionId: string,
    eventType: string,
    fn: (tx: Transaction, party: Party, now: string) => Transaction,
    data: Record<string, unknown> = {},
  ) {
    let actingParty: Party = 'OWNER';
    await this.loadAndSettle(transactionId); // yêu cầu hủy đã quá 5 phút → hủy trước khi làm tiếp
    const next = await this.mutate(transactionId, undefined, userId, eventType, (tx, now) => {
      const party = this.partyOf(tx, userId);
      if (!party) throw notFound('giao dịch');
      if (tx.cancelRequest && !CANCEL_EVENTS.includes(eventType)) {
        throw conflict('CANCEL_PENDING', 'Giao dịch đang chờ hủy — rút yêu cầu hủy trước, hoặc chờ hết 5 phút');
      }
      actingParty = party;
      return fn(tx, party, now);
    }, data);
    await this.notifyCounterparty(next, actingParty, eventType);
    return next;
  }

  /**
   * Ghi trạng thái mới + sự kiện (T9.8) + đồng bộ Listing khi giao dịch kết thúc (A5):
   * COMPLETED → Listing COMPLETED; CANCELLED/FAILED → Listing mở lại nếu còn hạn, không thì EXPIRED.
   */
  private async mutate(
    transactionId: string,
    actor: Actor | undefined,
    actorId: string,
    eventType: string,
    fn: (tx: Transaction, now: string) => Transaction,
    data: Record<string, unknown> = {},
  ): Promise<Transaction> {
    let endedByParties = false;
    const result = await withOptimisticRetry(async () => {
      const tx = await this.loadTx(transactionId);
      if (!tx) throw notFound('giao dịch');
      const now = this.clock.now().toISOString();
      const next: Transaction = { ...fn(tx, now), updatedAt: now };
      // Admin lọc giao dịch theo trạng thái (K1) — gồm cả hàng đợi tranh chấp TX#STATUS#DISPUTED
      Object.assign(next, gsi1.txStatus(next));

      const resolvedActor: Actor = actor ?? (tx.ownerId === actorId ? 'OWNER' : 'PARTNER');
      // Hủy / thất bại do hai bên (không phải Admin kết luận tranh chấp) → dữ liệu chống né phí (QĐ-39)
      endedByParties =
        !TERMINAL.includes(tx.status) && (next.status === 'CANCELLED' || next.status === 'FAILED') && resolvedActor !== 'ADMIN';
      const ops: WriteOp[] = [
        putVersioned(next, tx.version ?? 1),
        this.eventOp(tx, (tx.version ?? 1) + 1, resolvedActor, eventType, { ...data, to: next.status }),
      ];
      // Mốc 24h nhắc + 48h tự hoàn tất khi một bên vừa xác nhận (QĐ-18)
      if (tx.status !== 'AWAITING_COUNTERPARTY' && next.status === 'AWAITING_COUNTERPARTY' && next.counterpartyDeadline) {
        ops.push(
          timerOp('TX_REMIND', tx.transactionId, new Date(Date.parse(now) + COUNTERPARTY_TTL_MS / 2).toISOString()),
          timerOp('TX_AUTO_COMPLETE', tx.transactionId, next.counterpartyDeadline),
        );
      }
      // Yêu cầu hủy → mốc tự hủy sau 5 phút (QĐ-38); đọc giao dịch / tin cũng tự hủy khi quá hạn
      if (!tx.cancelRequest && next.cancelRequest) ops.push(timerOp('TX_CANCEL', tx.transactionId, next.cancelRequest.effectiveAt, true));
      // Phí dịch vụ 10.000đ / giao dịch hoàn tất, người bán trả, gom hóa đơn theo tháng (QĐ-37)
      if (tx.status !== 'COMPLETED' && next.status === 'COMPLETED') ops.push(...this.billing.feeOps(next, now));
      if (!TERMINAL.includes(tx.status) && TERMINAL.includes(next.status)) {
        const listing = await this.loadListing(tx.listingId);
        if (listing.status === 'MATCHED' && listing.activeTransactionId === tx.transactionId) {
          const reopen: ListingStatus = next.status === 'COMPLETED' ? 'COMPLETED' : now < listing.expiresAt ? 'ACTIVE' : 'EXPIRED';
          const lastEndedDeal =
            endedByParties && reopen === 'ACTIVE'
              ? { transactionId: tx.transactionId, buyerId: tx.partnerId, status: next.status as 'CANCELLED' | 'FAILED', at: now }
              : listing.lastEndedDeal;
          ops.push(putVersioned({ ...listing, status: reopen, activeTransactionId: undefined, lastEndedDeal, updatedAt: now }, listing.version ?? 1));
        }
      }
      if (endedByParties) ops.push(this.risk.dealEndedOp({ ...next, status: next.status as 'CANCELLED' | 'FAILED' }, now));
      await this.table.transact(ops);
      return { ...next, version: (tx.version ?? 1) + 1 };
    });
    if (endedByParties) {
      await this.risk.evaluate(result.ownerId).catch((err) => log('error', 'risk_evaluate_failed', { ownerId: result.ownerId, error: err instanceof Error ? err.message : String(err) }));
    }
    return result;
  }

  private async notifyCounterparty(tx: Transaction, by: Party, eventType: string) {
    const target = by === 'OWNER' ? tx.partnerId : tx.ownerId;
    const titles: Record<string, string> = {
      HANDOVER_PROPOSED: 'Có đề xuất lịch bàn giao mới',
      HANDOVER_AGREED: 'Lịch bàn giao đã được chấp nhận',
      PRICE_ADJUSTMENT_PROPOSED: 'Đối tác đề nghị điều chỉnh giá',
      PRICE_ADJUSTMENT_ACCEPTED: 'Chủ tin đồng ý giá mới',
      PRICE_ADJUSTMENT_REJECTED: 'Chủ tin từ chối giá mới',
      COMPLETION_CONFIRMED:
        tx.status === 'AWAITING_COUNTERPARTY'
          ? `Bên kia xác nhận đã bàn giao, giá cuối ${(Object.values(tx.completion)[0]?.finalPrice ?? tx.agreedPrice).toLocaleString('vi-VN')}đ — bấm Chấp nhận để hoàn tất hoặc Khiếu nại trong 48 giờ`
          : 'Giao dịch đã cập nhật',
      DISPUTED: 'Giao dịch đang tranh chấp — Admin sẽ xem xét',
      CANCEL_REQUESTED: 'Bên kia yêu cầu hủy giao dịch — tự hủy sau 5 phút nếu không rút lại',
      CANCEL_WITHDRAWN: 'Bên kia đã rút yêu cầu hủy, giao dịch tiếp tục',
      PRICE_AGREED: 'Giá giao dịch đã đổi theo lời ra giá trong chat',
      CANCELLED: 'Giao dịch đã bị hủy',
      FAILED: 'Giao dịch được báo thất bại',
    };
    await this.notifications.notify(target, {
      type: `TX_${eventType}`,
      title: tx.status === 'COMPLETED' ? 'Giao dịch đã hoàn tất' : (titles[eventType] ?? 'Giao dịch đã cập nhật'),
      body: tx.listingTitle,
      link: `/transactions/${tx.transactionId}`,
    });
  }
}
