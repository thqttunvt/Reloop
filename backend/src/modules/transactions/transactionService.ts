import { HANDOVER_METHODS, type HandoverMethod } from '../../domain/catalog';
import { quoteMachine, transactionMachine, type Actor, type ListingStatus, type TransactionStatus } from '../../domain/stateMachines';
import { HOUR_MS, type Clock } from '../../shared/clock';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { int, oneOf, str } from '../../shared/validate';
import { assertOwnImageKeys, type ImageStore } from '../../storage/imageStore';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';
import { timerOp } from '../jobs/timers';
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

export const FAILURE_REASONS = ['NO_SHOW_OWNER', 'NO_SHOW_PARTNER', 'DEVICE_MISMATCH', 'PRICE_DISAGREEMENT', 'OTHER'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

type Party = 'OWNER' | 'PARTNER';
const other = (p: Party): Party => (p === 'OWNER' ? 'PARTNER' : 'OWNER');

export interface Transaction extends Item {
  transactionId: string;
  listingId: string;
  quoteId: string;
  ownerId: string;
  partnerId: string;
  branchId: string;
  /** Chiều thu mua: Partner trả, Owner nhận (QĐ-29). */
  direction: 'BUYBACK';
  payerId: string;
  payeeId: string;
  /** Nạp/rút qua ví đã tạm bỏ → hai bên thanh toán trực tiếp khi gặp. */
  paymentMode: 'OFFLINE';
  status: TransactionStatus;
  listingTitle: string;
  partnerName: string;
  branchName: string;
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
  ) {}

  // ------------------------------------------------------------------ Tạo giao dịch (T9.1)

  /** Owner chọn một offer đã xác nhận. 2 request đồng thời → chỉ 1 thành công (điều kiện version của Listing). */
  async select(ownerId: string, input: Record<string, unknown>): Promise<Transaction> {
    await this.users.requireTerms({ userId: ownerId, groups: [] });
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

      const now = this.clock.now().toISOString();
      const transactionId = newId();
      const price = quote.offer!.price;
      const tx: Transaction = {
        ...keys.transaction(transactionId),
        transactionId,
        listingId,
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
      await this.table.transact([
        putVersioned({ ...listing, status: 'MATCHED', activeTransactionId: transactionId, updatedAt: now }, listing.version ?? 1),
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
    return tx;
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

    const [listing, owner, ownerPartner, partner, branch, events, reviews] = await Promise.all([
      this.loadListing(tx.listingId),
      this.users.get(tx.ownerId),
      this.partners.get(tx.ownerId),
      this.partners.get(tx.partnerId),
      this.partners.getBranch(tx.partnerId, tx.branchId),
      this.table.query<Item>(keys.transactionPk(transactionId), { skPrefix: 'EVENT#' }),
      this.table.query<Review>(keys.transactionPk(transactionId), { skPrefix: 'REVIEW#' }),
    ]);
    const partnerContact = partner ? await this.partners.contactOf(partner) : undefined;
    const contacts = {
      owner: {
        fullName: ownerPartner?.businessName ?? owner?.fullName,
        email: ownerPartner?.contactEmail,
        phone: owner?.phone,
        address: listing.location.address,
        location: listing.location,
      },
      partner: {
        businessName: partner?.businessName,
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

  confirmCompletion(userId: string, transactionId: string, input: Record<string, unknown>) {
    return this.change(userId, transactionId, 'COMPLETION_CONFIRMED', (tx, party, now) => {
      const finalPrice = input.finalPrice === undefined ? tx.agreedPrice : int(input.finalPrice, 'finalPrice', { min: 0, max: 1_000_000_000 });
      const completion = { ...tx.completion, [party]: { at: now, finalPrice } };
      if (tx.status === 'HANDOVER_PENDING') {
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
      const first = tx.completion[other(party)]!;
      if (first.finalPrice !== finalPrice) {
        // Hai bên nhập giá cuối khác nhau → tranh chấp, Admin xem (giaiphap C7)
        return { ...tx, status: 'DISPUTED', completion, dispute: { by: party, reason: `Giá cuối không khớp: ${first.finalPrice} ≠ ${finalPrice}`, at: now } };
      }
      return { ...tx, status: 'COMPLETED', completion, finalPrice, closedAt: now };
    });
  }

  /** Bên kia khiếu nại trong 48h (QĐ-18 → QĐ-08). */
  dispute(userId: string, transactionId: string, input: Record<string, unknown>) {
    const reason = str(input.reason, 'reason', { min: 5, max: 1000 });
    return this.change(userId, transactionId, 'DISPUTED', (tx, party, now) => {
      transactionMachine.assertTransition(tx.status, 'DISPUTED', party);
      if (tx.completion[party]) throw conflict('ALREADY_CONFIRMED', 'Bạn đã xác nhận hoàn tất');
      return { ...tx, status: 'DISPUTED', dispute: { by: party, reason, at: now } };
    });
  }

  // ------------------------------------------------------------------ Hủy / thất bại (T9.7)

  cancel(userId: string, transactionId: string, input: Record<string, unknown>) {
    const reason = str(input.reason, 'reason', { min: 3, max: 500 });
    return this.change(userId, transactionId, 'CANCELLED', (tx, party, now) => {
      transactionMachine.assertTransition(tx.status, 'CANCELLED', party);
      return { ...tx, status: 'CANCELLED', cancel: { by: party, reason, at: now }, closedAt: now };
    });
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

  async listDisputed() {
    const all = await this.table.query<Transaction>('TX#STATUS#DISPUTED', { index: 'gsi1', ascending: false });
    return all.filter((t) => t.status === 'DISPUTED');
  }

  resolveDispute(adminId: string, transactionId: string, input: Record<string, unknown>) {
    const outcome = oneOf<'COMPLETED' | 'FAILED'>(input.outcome, ['COMPLETED', 'FAILED'], 'outcome');
    const note = str(input.note, 'note', { min: 3, max: 1000 });
    const finalPrice = outcome === 'COMPLETED' ? int(input.finalPrice, 'finalPrice', { min: 0, max: 1_000_000_000 }) : undefined;
    return this.mutate(transactionId, 'ADMIN', adminId, 'DISPUTE_RESOLVED', (tx, now) => {
      transactionMachine.assertTransition(tx.status, outcome, 'ADMIN');
      return {
        ...tx,
        status: outcome,
        finalPrice: finalPrice ?? tx.finalPrice,
        dispute: { ...tx.dispute!, resolution: { outcome, finalPrice, note, by: adminId, at: now } },
        closedAt: now,
      };
    });
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
    const next = await this.mutate(transactionId, undefined, userId, eventType, (tx, now) => {
      const party = this.partyOf(tx, userId);
      if (!party) throw notFound('giao dịch');
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
  private mutate(
    transactionId: string,
    actor: Actor | undefined,
    actorId: string,
    eventType: string,
    fn: (tx: Transaction, now: string) => Transaction,
    data: Record<string, unknown> = {},
  ): Promise<Transaction> {
    return withOptimisticRetry(async () => {
      const tx = await this.loadTx(transactionId);
      if (!tx) throw notFound('giao dịch');
      const now = this.clock.now().toISOString();
      const next: Transaction = { ...fn(tx, now), updatedAt: now };
      // Hàng đợi tranh chấp cho Admin
      if (next.status === 'DISPUTED') Object.assign(next, { gsi1pk: 'TX#STATUS#DISPUTED', gsi1sk: now });
      else {
        delete next.gsi1pk;
        delete next.gsi1sk;
      }

      const resolvedActor: Actor = actor ?? (tx.ownerId === actorId ? 'OWNER' : 'PARTNER');
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
      if (!TERMINAL.includes(tx.status) && TERMINAL.includes(next.status)) {
        const listing = await this.loadListing(tx.listingId);
        if (listing.status === 'MATCHED' && listing.activeTransactionId === tx.transactionId) {
          const reopen: ListingStatus = next.status === 'COMPLETED' ? 'COMPLETED' : now < listing.expiresAt ? 'ACTIVE' : 'EXPIRED';
          ops.push(putVersioned({ ...listing, status: reopen, activeTransactionId: undefined, updatedAt: now }, listing.version ?? 1));
        }
      }
      await this.table.transact(ops);
      return { ...next, version: (tx.version ?? 1) + 1 };
    });
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
        tx.status === 'AWAITING_COUNTERPARTY' ? 'Bên kia đã xác nhận hoàn tất — vui lòng xác nhận trong 48 giờ' : 'Giao dịch đã cập nhật',
      DISPUTED: 'Giao dịch đang tranh chấp — Admin sẽ xem xét',
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
