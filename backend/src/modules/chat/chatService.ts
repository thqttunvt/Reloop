import { log } from '../../http/log';
import type { Clock } from '../../shared/clock';
import { conflict, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { int, str } from '../../shared/validate';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { ConditionFailedError, putNew, putVersioned, type Item, type Table, type WriteOp } from '../../store/table';
import type { Listing, ListingService, Match } from '../listings/listingService';
import type { NotificationService } from '../notifications/notificationService';
import type { PartnerService } from '../partners/partnerService';
import type { Transaction, TransactionService } from '../transactions/transactionService';
import type { UserService } from '../users/userService';

type Side = 'OWNER' | 'PARTNER';

/** Lời ra giá đang chờ bên kia trả lời (QĐ-38). Mỗi cuộc trò chuyện tối đa 1 lời; lời mới thay lời cũ. */
export interface PendingOffer {
  offerId: string;
  price: number;
  by: Side;
  at: string;
}

/**
 * Cuộc trò chuyện giữa người bán (chủ tin) và một người mua về một tin.
 * Người mua là bất kỳ ai đã đăng nhập (bảng tin kiểu chợ); trường partnerId / partnerName = người mua.
 */
export interface Conversation extends Item {
  conversationId: string;
  listingId: string;
  listingTitle: string;
  ownerId: string;
  partnerId: string;
  partnerName: string;
  lastMessage?: string;
  lastMessageAt?: string;
  lastSenderId?: string;
  unread: Record<Side, number>;
  pendingOffer?: PendingOffer;
  createdAt: string;
}

/** TEXT: tin nhắn thường · OFFER: lời ra giá · SYSTEM: hệ thống ghi lại kết quả (chấp nhận / từ chối giá). */
export type MessageKind = 'TEXT' | 'OFFER' | 'SYSTEM';

export interface Message extends Item {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderRole: Side;
  kind?: MessageKind;
  text: string;
  /** Lời ra giá (kind = OFFER) */
  price?: number;
  offerId?: string;
  at: string;
}

const vnd = (n: number) => `${n.toLocaleString('vi-VN')}đ`;

export class ChatService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly listings: ListingService,
    private readonly partners: PartnerService,
    private readonly users: UserService,
    private readonly notifications: NotificationService,
    private readonly transactions: TransactionService,
  ) {}

  static idOf(listingId: string, partnerId: string) {
    return `${listingId}.${partnerId}`;
  }

  /**
   * Mở (hoặc lấy lại) cuộc trò chuyện về một tin.
   * Người mua (bất kỳ ai đã đăng nhập, trừ chủ tin): khi tin còn mở.
   * Chủ tin: chủ động nhắn một đơn vị thu mua đã được match (partnerId), hoặc mở lại cuộc trò chuyện đã có.
   */
  async open(userId: string, listingId: string, partnerIdInput?: unknown): Promise<Conversation> {
    const listing = await this.listings.current(listingId);
    const isOwner = listing.ownerId === userId;
    const partnerId = isOwner ? str(partnerIdInput, 'partnerId', { max: 80 }) : userId;
    const conversationId = ChatService.idOf(listingId, partnerId);
    const existing = await this.get(conversationId);
    if (existing) return existing;

    // Tin đã có người chốt → chỉ người mua trong giao dịch còn nhắn được (QĐ-38)
    if (!(await this.chatOpen(listing, partnerId))) throw conflict('CHAT_CLOSED', 'Tin đã có người chốt hoặc đã kết thúc');
    const match = (await this.table.query<Match>(keys.listingPk(listingId), { skPrefix: 'MATCH#' })).find((m) => m.partnerId === partnerId);
    if (isOwner && !match) throw notFound('người mua');
    const partner = await this.partners.get(partnerId);
    const buyer = await this.users.get(partnerId);
    const partnerName =
      match?.partnerName ??
      (partner?.status === 'APPROVED' ? partner.businessName : undefined) ??
      buyer?.fullName ??
      (buyer?.email ? buyer.email.split('@')[0]! : 'Người mua');
    const conv: Conversation = {
      ...keys.conversation(conversationId),
      conversationId,
      listingId,
      listingTitle: listing.title,
      ownerId: listing.ownerId,
      partnerId,
      partnerName,
      unread: { OWNER: 0, PARTNER: 0 },
      createdAt: this.clock.now().toISOString(),
    };
    try {
      await this.table.transact([
        putVersioned(conv, 0),
        putNew({ ...keys.userConversation(listing.ownerId, conversationId), conversationId }),
        putNew({ ...keys.userConversation(partnerId, conversationId), conversationId }),
        putNew({ ...keys.listingConversation(listingId, partnerId), conversationId, partnerId }),
      ]);
      return { ...conv, version: 1 };
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
      return (await this.get(conversationId))!; // bên kia vừa mở cùng lúc
    }
  }

  send(userId: string, conversationId: string, rawText: unknown): Promise<Message> {
    const text = str(rawText, 'text', { min: 1, max: 1000 });
    return this.post(userId, conversationId, { kind: 'TEXT', text });
  }

  /**
   * Ra giá (QĐ-38): tin đang mở → chấp nhận sẽ tạo giao dịch; đang giao dịch (chờ bàn giao) → chấp nhận sẽ đổi giá.
   * Lời mới thay lời đang chờ của cuộc trò chuyện.
   */
  async sendOffer(userId: string, conversationId: string, rawPrice: unknown): Promise<Message> {
    const price = int(rawPrice, 'price', { min: 1_000, max: 1_000_000_000 });
    const conv = await this.require(userId, conversationId);
    const tx = await this.activeTransaction(await this.listings.current(conv.listingId));
    if (tx && (tx.status !== 'HANDOVER_PENDING' || tx.cancelRequest)) {
      throw conflict('OFFER_NOT_ALLOWED', 'Chỉ ra giá mới khi giao dịch đang chờ bàn giao');
    }
    return this.post(userId, conversationId, { kind: 'OFFER', text: `Ra giá ${vnd(price)}`, price, offerId: newId() });
  }

  /** Bên còn lại chấp nhận / từ chối lời ra giá đang chờ. */
  async respondOffer(userId: string, conversationId: string, offerId: string, accept: boolean) {
    const conv = await this.require(userId, conversationId);
    const offer = conv.pendingOffer;
    if (!offer || offer.offerId !== offerId) throw conflict('OFFER_NOT_PENDING', 'Lời ra giá không còn hiệu lực');
    const side = this.sideOf(conv, userId);
    if (offer.by === side) throw conflict('OWN_OFFER', 'Bên kia phải trả lời lời ra giá của bạn');
    const listing = await this.listings.current(conv.listingId);
    if (!(await this.chatOpen(listing, conv.partnerId))) throw conflict('CHAT_CLOSED', 'Tin đã có người chốt hoặc đã kết thúc');

    if (!accept) {
      const message = await this.post(userId, conversationId, { kind: 'SYSTEM', text: `Đã từ chối giá ${vnd(offer.price)}` }, offerId);
      return { message };
    }

    if (listing.status === 'ACTIVE') return this.closeDeal(userId, conv, offer, side);

    const tx = await this.activeTransaction(listing);
    if (!tx || tx.partnerId !== conv.partnerId) throw conflict('LISTING_NOT_ACTIVE', 'Tin đã có người chốt hoặc đã kết thúc');
    await this.transactions.agreeChatPrice(userId, tx.transactionId, offer.price);
    const message = await this.post(userId, conversationId, { kind: 'SYSTEM', text: `Đã chấp nhận giá mới ${vnd(offer.price)}` }, offerId);
    return { message, transactionId: tx.transactionId };
  }

  /** Chấp nhận khi tin còn mở → tạo giao dịch, tin rời Chợ, báo cho những người còn lại. */
  private async closeDeal(userId: string, first: Conversation, offer: PendingOffer, side: Side) {
    // Người bán phải còn bán được (đã duyệt, không bị tạm ngừng / khóa do nợ — QĐ-34, QĐ-40); người mua đã đồng ý điều khoản
    if (side === 'OWNER') await this.partners.requireSeller(first.ownerId);
    else if (!(await this.partners.isAvailable(first.ownerId))) {
      throw conflict('SELLER_UNAVAILABLE', 'Người bán đang tạm ngừng hoạt động — chưa chốt được giao dịch');
    }
    await this.users.requireTerms({ userId: first.partnerId, groups: [] });

    const { tx, message } = await withOptimisticRetry(async () => {
      const conv = await this.require(userId, first.conversationId);
      if (conv.pendingOffer?.offerId !== offer.offerId) throw conflict('OFFER_NOT_PENDING', 'Lời ra giá không còn hiệu lực');
      const listing = await this.listings.current(conv.listingId);
      if (this.listings.effectiveListingStatus(listing) !== 'ACTIVE') throw conflict('LISTING_NOT_ACTIVE', 'Tin đã có người chốt hoặc đã kết thúc');
      const deal = this.transactions.chatDealOps(listing, { userId: conv.partnerId, name: conv.partnerName, conversationId: conv.conversationId }, offer.price, side);
      const { ops, message } = this.messageOps(conv, userId, { kind: 'SYSTEM', text: `Đã chốt giá ${vnd(offer.price)} — giao dịch đã được tạo` }, offer.offerId);
      await this.table.transact([...deal.ops, ...ops]);
      return { tx: deal.tx, message };
    });

    const link = `/transactions/${tx.transactionId}`;
    await this.notifications.notify(side === 'OWNER' ? first.partnerId : first.ownerId, {
      type: 'CHAT_DEAL',
      title: `Đã chốt giá ${vnd(offer.price)} — giao dịch đã được tạo`,
      body: first.listingTitle,
      link,
    });
    await this.listings.notifyTaken(first.listingId, first.listingTitle, [first.ownerId, first.partnerId]);
    return { message, transactionId: tx.transactionId };
  }

  /** 100 tin nhắn gần nhất (cũ → mới); `after` để polling lấy tin mới. */
  async messages(userId: string, conversationId: string, after?: string) {
    const conv = await this.require(userId, conversationId);
    const latest = await this.table.query<Message>(keys.conversationPk(conversationId), { skPrefix: 'MSG#', ascending: false, limit: 100 });
    // >= : tin gửi cùng mili giây với tin cuối web đã có không bị bỏ sót (web tự bỏ trùng theo messageId)
    const items = latest.reverse().filter((m) => !after || m.at >= after);
    const listing = await this.listings.current(conv.listingId);
    const tx = await this.activeTransaction(listing);
    return {
      conversation: conv,
      open: await this.chatOpen(listing, conv.partnerId),
      /** Giao dịch đang chạy giữa đúng 2 người của cuộc trò chuyện này */
      transactionId: tx && tx.partnerId === conv.partnerId ? tx.transactionId : undefined,
      items,
    };
  }

  async markRead(userId: string, conversationId: string) {
    return withOptimisticRetry(async () => {
      const conv = await this.require(userId, conversationId);
      const side = this.sideOf(conv, userId);
      if (conv.unread[side] === 0) return conv;
      const next = { ...conv, unread: { ...conv.unread, [side]: 0 } };
      await this.table.transact([putVersioned(next, conv.version ?? 1)]);
      return next;
    });
  }

  /** Danh sách trò chuyện của tôi, mới nhất trước, kèm số tin chưa đọc. */
  async list(userId: string) {
    const refs = await this.table.query<Item & { conversationId: string }>(keys.userPk(userId), { skPrefix: 'CONV#' });
    const convs = (await Promise.all(refs.map((r) => this.get(r.conversationId)))).filter((c): c is Conversation => !!c);
    return convs
      .map((c) => ({ ...c, myRole: this.sideOf(c, userId), myUnread: c.unread[this.sideOf(c, userId)] }))
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
  }

  /**
   * Admin xem mọi cuộc trò chuyện về một tin (chỉ đọc) khi xét tranh chấp / khiếu nại phí / cờ nghi né phí (mục 20 danhgia).
   * Mỗi lần xem ghi log có cấu trúc (ai xem, tin nào) để tra cứu trên CloudWatch.
   */
  async adminListingChats(adminId: string, listingId: string) {
    const listing = await this.listings.current(listingId);
    const [refs, matches] = await Promise.all([
      this.table.query<Item & { conversationId: string }>(keys.listingPk(listingId), { skPrefix: 'CONV#' }),
      this.table.query<Match>(keys.listingPk(listingId), { skPrefix: 'MATCH#' }),
    ]);
    // Cuộc trò chuyện cũ (trước QĐ-38) chưa có con trỏ theo tin → thử thêm theo các đơn vị đã được match
    const ids = new Set([...refs.map((r) => r.conversationId), ...matches.map((m) => ChatService.idOf(listingId, m.partnerId))]);
    const conversations = (
      await Promise.all(
        [...ids].map(async (id) => {
          const conv = await this.get(id);
          if (!conv) return undefined;
          const messages = (await this.table.query<Message>(keys.conversationPk(id), { skPrefix: 'MSG#', ascending: false, limit: 100 })).reverse();
          return { conversation: conv, messages };
        }),
      )
    ).filter((c): c is NonNullable<typeof c> => !!c);
    log('info', 'admin_chat_viewed', { adminId, listingId, conversations: conversations.length });
    return { listing: { listingId, title: listing.title, ownerId: listing.ownerId, status: listing.status }, conversations };
  }

  // ------------------------------------------------------------------ Nội bộ

  /** Ghi 1 tin nhắn (thường / ra giá / hệ thống). closesOffer = offerId đang chờ được trả lời → xóa khỏi cuộc trò chuyện. */
  private async post(userId: string, conversationId: string, content: Pick<Message, 'kind' | 'text' | 'price' | 'offerId'>, closesOffer?: string) {
    const { message, conv, wasUnread } = await withOptimisticRetry(async () => {
      const conv = await this.require(userId, conversationId);
      const listing = await this.listings.current(conv.listingId);
      if (!(await this.chatOpen(listing, conv.partnerId))) {
        throw conflict('CHAT_CLOSED', 'Tin đã có người chốt hoặc đã kết thúc, không gửi tin nhắn được nữa');
      }
      if (closesOffer && conv.pendingOffer?.offerId !== closesOffer) throw conflict('OFFER_NOT_PENDING', 'Lời ra giá không còn hiệu lực');
      const { ops, message, next } = this.messageOps(conv, userId, content, closesOffer);
      await this.table.transact(ops);
      return { message, conv: next, wasUnread: conv.unread[message.senderRole === 'OWNER' ? 'PARTNER' : 'OWNER'] > 0 };
    });
    // Tin thường: chỉ báo ở tin đầu tiên chưa đọc (tránh spam). Ra giá luôn báo.
    if (!wasUnread || message.kind === 'OFFER') {
      const recipient = message.senderRole === 'OWNER' ? conv.partnerId : conv.ownerId;
      const who = message.senderRole === 'OWNER' ? 'Người bán' : conv.partnerName;
      await this.notifications.notify(recipient, {
        type: message.kind === 'OFFER' ? 'CHAT_OFFER' : 'CHAT_MESSAGE',
        title: message.kind === 'OFFER' ? `${who} ra giá ${vnd(message.price!)}` : message.senderRole === 'OWNER' ? 'Người bán nhắn tin cho bạn' : `${who} hỏi về tin của bạn`,
        body: `${conv.listingTitle}: ${message.text.slice(0, 80)}`,
        link: `/chat/${conversationId}`,
      });
    }
    return message;
  }

  private messageOps(conv: Conversation, userId: string, content: Pick<Message, 'kind' | 'text' | 'price' | 'offerId'>, closesOffer?: string) {
    const side = this.sideOf(conv, userId);
    const other: Side = side === 'OWNER' ? 'PARTNER' : 'OWNER';
    const at = this.clock.now().toISOString();
    const messageId = newId();
    const message: Message = {
      ...keys.chatMessage(conv.conversationId, at, conv.version ?? 1, messageId),
      messageId,
      conversationId: conv.conversationId,
      senderId: userId,
      senderRole: side,
      ...content,
      at,
    };
    const next: Conversation = {
      ...conv,
      lastMessage: content.text.slice(0, 120),
      lastMessageAt: at,
      lastSenderId: userId,
      unread: { ...conv.unread, [other]: conv.unread[other] + 1 },
    };
    if (content.kind === 'OFFER') next.pendingOffer = { offerId: content.offerId!, price: content.price!, by: side, at };
    else if (closesOffer) delete next.pendingOffer;
    const ops: WriteOp[] = [putNew(message), putVersioned(next, conv.version ?? 1)];
    return { ops, message, next };
  }

  /** Giao dịch đang chạy của tin (nếu có). */
  private async activeTransaction(listing: Listing): Promise<Transaction | undefined> {
    if (listing.status !== 'MATCHED' || !listing.activeTransactionId) return undefined;
    const k = keys.transaction(listing.activeTransactionId);
    return this.table.get<Transaction>(k.pk, k.sk);
  }

  /** Chat mở khi tin còn mở; tin đã có người chốt → chỉ còn mở giữa người bán và người mua của giao dịch. */
  private async chatOpen(listing: Listing, buyerId: string) {
    const status = this.listings.effectiveListingStatus(listing);
    // Tin đang mở: chỉ chat được khi người bán còn hoạt động (không bị tạm ngừng / khóa do nợ — mục 3 danhgia)
    if (status === 'ACTIVE') return this.partners.isAvailable(listing.ownerId);
    if (status !== 'MATCHED') return false;
    return (await this.activeTransaction(listing))?.partnerId === buyerId;
  }

  private sideOf(conv: Conversation, userId: string): Side {
    return conv.ownerId === userId ? 'OWNER' : 'PARTNER';
  }

  private async get(conversationId: string) {
    const k = keys.conversation(conversationId);
    return this.table.get<Conversation>(k.pk, k.sk);
  }

  private async require(userId: string, conversationId: string) {
    const conv = await this.get(conversationId);
    if (!conv || (conv.ownerId !== userId && conv.partnerId !== userId)) throw notFound('cuộc trò chuyện');
    return conv;
  }
}
