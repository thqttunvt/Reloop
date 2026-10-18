import type { Clock } from '../../shared/clock';
import { conflict, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { str } from '../../shared/validate';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { ConditionFailedError, putNew, putVersioned, type Item, type Table } from '../../store/table';
import type { Listing, ListingService, Match } from '../listings/listingService';
import type { NotificationService } from '../notifications/notificationService';
import type { PartnerService } from '../partners/partnerService';
import type { UserService } from '../users/userService';

type Side = 'OWNER' | 'PARTNER';

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
  createdAt: string;
}

export interface Message extends Item {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderRole: Side;
  text: string;
  at: string;
}

/** Chat đang mở khi tin còn mở hoặc đang giao dịch. */
const CHAT_OPEN = ['ACTIVE', 'MATCHED'];

export class ChatService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
    private readonly listings: ListingService,
    private readonly partners: PartnerService,
    private readonly users: UserService,
    private readonly notifications: NotificationService,
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
    const listing = await this.loadListing(listingId);
    const isOwner = listing.ownerId === userId;
    const partnerId = isOwner ? str(partnerIdInput, 'partnerId', { max: 80 }) : userId;
    const conversationId = ChatService.idOf(listingId, partnerId);
    const existing = await this.get(conversationId);
    if (existing) return existing;

    if (!CHAT_OPEN.includes(this.listings.effectiveListingStatus(listing))) throw conflict('CHAT_CLOSED', 'Tin đã kết thúc');
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
      ]);
      return { ...conv, version: 1 };
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
      return (await this.get(conversationId))!; // bên kia vừa mở cùng lúc
    }
  }

  async send(userId: string, conversationId: string, rawText: unknown): Promise<Message> {
    const text = str(rawText, 'text', { min: 1, max: 1000 });
    const { message, conv, wasUnread } = await withOptimisticRetry(async () => {
      const conv = await this.require(userId, conversationId);
      const listing = await this.loadListing(conv.listingId);
      if (!CHAT_OPEN.includes(this.listings.effectiveListingStatus(listing))) {
        throw conflict('CHAT_CLOSED', 'Tin đã kết thúc, không gửi tin nhắn được nữa');
      }
      const side: Side = conv.ownerId === userId ? 'OWNER' : 'PARTNER';
      const other: Side = side === 'OWNER' ? 'PARTNER' : 'OWNER';
      const at = this.clock.now().toISOString();
      const messageId = newId();
      const message: Message = { ...keys.chatMessage(conversationId, at, conv.version ?? 1, messageId), messageId, conversationId, senderId: userId, senderRole: side, text, at };
      const next: Conversation = {
        ...conv,
        lastMessage: text.slice(0, 120),
        lastMessageAt: at,
        lastSenderId: userId,
        unread: { ...conv.unread, [other]: conv.unread[other] + 1 },
      };
      await this.table.transact([putNew(message), putVersioned(next, conv.version ?? 1)]);
      return { message, conv: next, wasUnread: conv.unread[other] > 0 };
    });
    // Chỉ báo ở tin nhắn đầu tiên chưa đọc — tránh spam chuông thông báo
    if (!wasUnread) {
      const recipient = message.senderRole === 'OWNER' ? conv.partnerId : conv.ownerId;
      await this.notifications.notify(recipient, {
        type: 'CHAT_MESSAGE',
        title: message.senderRole === 'OWNER' ? 'Người bán nhắn tin cho bạn' : `${conv.partnerName} hỏi về tin của bạn`,
        body: `${conv.listingTitle}: ${message.text.slice(0, 80)}`,
        link: `/chat/${conversationId}`,
      });
    }
    return message;
  }

  /** 100 tin nhắn gần nhất (cũ → mới); `after` để polling lấy tin mới. */
  async messages(userId: string, conversationId: string, after?: string) {
    const conv = await this.require(userId, conversationId);
    const latest = await this.table.query<Message>(keys.conversationPk(conversationId), { skPrefix: 'MSG#', ascending: false, limit: 100 });
    const items = latest.reverse().filter((m) => !after || m.at > after);
    const listing = await this.loadListing(conv.listingId);
    return { conversation: conv, open: CHAT_OPEN.includes(this.listings.effectiveListingStatus(listing)), items };
  }

  async markRead(userId: string, conversationId: string) {
    return withOptimisticRetry(async () => {
      const conv = await this.require(userId, conversationId);
      const side: Side = conv.ownerId === userId ? 'OWNER' : 'PARTNER';
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
      .map((c) => ({ ...c, myRole: (c.ownerId === userId ? 'OWNER' : 'PARTNER') as Side, myUnread: c.unread[c.ownerId === userId ? 'OWNER' : 'PARTNER'] }))
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
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

  private async loadListing(listingId: string) {
    const k = keys.listing(listingId);
    const listing = await this.table.get<Listing>(k.pk, k.sk);
    if (!listing) throw notFound('tin đăng');
    return listing;
  }
}
