import { requireGroup } from '../auth/auth';
import { badRequest } from '../shared/errors';
import type { AiService } from '../modules/ai/aiService';
import type { ChatService } from '../modules/chat/chatService';
import type { ListingService } from '../modules/listings/listingService';
import type { LocationService } from '../modules/locations/locationService';
import type { ReportService } from '../modules/reports/reportService';
import { TERMS_VERSION } from '../modules/users/userService';
import type { NotificationService } from '../modules/notifications/notificationService';
import type { ReputationService } from '../modules/reputation/reputationService';
import type { TransactionService } from '../modules/transactions/transactionService';
import { PARTNER_STATUSES, partnerTier, type PartnerService, type PartnerStatus } from '../modules/partners/partnerService';
import type { UserService } from '../modules/users/userService';
import type { WalletService } from '../modules/wallet/walletService';
import { log } from './log';
import { moderateUpload, type ImageStore } from '../storage/imageStore';
import type { ImageModerator } from '../storage/moderator';
import type { Route } from './router';

export interface Services {
  users: UserService;
  wallet: WalletService;
  partners: PartnerService;
  listings: ListingService;
  images: ImageStore;
  moderator: ImageModerator;
  notifications: NotificationService;
  transactions: TransactionService;
  reputation: ReputationService;
  ai: AiService;
  locations: LocationService;
  reports: ReportService;
  chat: ChatService;
}

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) throw badRequest('INVALID_QUERY', `Giá trị phải thuộc: ${allowed.join(', ')}`);
  return value as T;
};

export function apiRoutes(s: Services): Route[] {
  return [
    // ------------------------------------------------------------ Hồ sơ
    {
      method: 'GET',
      path: '/me',
      auth: 'required',
      handle: async (c) => ({ body: { ...(await s.users.getOrCreate(c.principal)), currentTermsVersion: TERMS_VERSION } }),
    },
    {
      method: 'POST',
      path: '/me/accept-terms',
      auth: 'required',
      handle: async (c) => ({ body: await s.users.acceptTerms(c.principal, c.body.version) }),
    },

    // ------------------------------------------------------------ Địa điểm đã lưu (T2.1)
    {
      method: 'GET',
      path: '/locations',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.locations.list(c.principal.userId) } }),
    },
    {
      method: 'POST',
      path: '/locations',
      auth: 'required',
      handle: async (c) => ({ status: 201, body: await s.locations.create(c.principal.userId, c.body) }),
    },
    {
      method: 'PATCH',
      path: '/locations/{id}',
      auth: 'required',
      handle: async (c) => ({ body: await s.locations.update(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'DELETE',
      path: '/locations/{id}',
      auth: 'required',
      handle: async (c) => ({ body: await s.locations.remove(c.principal.userId, c.params.id!) }),
    },

    // ------------------------------------------------------------ Chat người bán ↔ đơn vị thu mua
    {
      method: 'POST',
      path: '/listings/{id}/conversations',
      auth: 'required',
      handle: async (c) => ({ body: await s.chat.open(c.principal.userId, c.params.id!, c.body.partnerId) }),
    },
    {
      method: 'GET',
      path: '/conversations',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.chat.list(c.principal.userId) } }),
    },
    {
      method: 'GET',
      path: '/conversations/{id}/messages',
      auth: 'required',
      handle: async (c) => ({ body: await s.chat.messages(c.principal.userId, c.params.id!, c.query.after) }),
    },
    {
      method: 'POST',
      path: '/conversations/{id}/messages',
      auth: 'required',
      handle: async (c) => ({ status: 201, body: await s.chat.send(c.principal.userId, c.params.id!, c.body.text) }),
    },
    {
      method: 'POST',
      path: '/conversations/{id}/read',
      auth: 'required',
      handle: async (c) => ({ body: await s.chat.markRead(c.principal.userId, c.params.id!) }),
    },

    // ------------------------------------------------------------ Báo cáo vi phạm (C13)
    {
      method: 'POST',
      path: '/reports',
      auth: 'required',
      handle: async (c) => ({ status: 201, body: await s.reports.create(c.principal.userId, c.body) }),
    },
    {
      method: 'PATCH',
      path: '/me',
      auth: 'required',
      handle: async (c) => ({ body: await s.users.update(c.principal, { fullName: c.body.fullName, phone: c.body.phone }) }),
    },

    // ------------------------------------------------------------ Phí (QĐ-32) & ví (chỉ xem; nạp/rút đã bỏ)
    {
      method: 'GET',
      path: '/fees',
      auth: 'required',
      handle: async (c) => {
        const price = c.query.price === undefined ? 0 : Number(c.query.price);
        if (!Number.isSafeInteger(price) || price < 0) throw badRequest('INVALID_QUERY', 'price phải là số nguyên VND ≥ 0');
        return { body: s.wallet.feeQuote(price) };
      },
    },
    { method: 'GET', path: '/wallet', auth: 'required', handle: async (c) => ({ body: await s.wallet.getWallet(c.principal.userId) }) },
    {
      method: 'GET',
      path: '/wallet/ledger',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.wallet.listLedger(c.principal.userId) } }),
    },

    // ------------------------------------------------------------ Ảnh (T4.1)
    {
      method: 'POST',
      path: '/uploads/presign',
      auth: 'required',
      handle: async (c) => ({ status: 201, body: await s.images.createUpload(c.principal.userId, c.body.contentType) }),
    },
    {
      // Gọi ngay sau khi trình duyệt upload xong: Rekognition kiểm duyệt, ảnh vi phạm bị xóa (M6, giaiphap E5)
      method: 'POST',
      path: '/uploads/moderate',
      auth: 'required',
      handle: async (c) => ({
        body: await moderateUpload(s.images, s.moderator, c.principal.userId, c.body.key, (key, labels) =>
          log('warn', 'image_rejected', { userId: c.principal.userId, key, labels }),
        ),
      }),
    },
    {
      // Frontend hỏi để biết có hiện bước upload ảnh / AI hay không
      method: 'GET',
      path: '/features',
      auth: 'required',
      handle: async () => ({ body: { images: s.images.enabled, ai: s.ai.enabled } }),
    },

    // ------------------------------------------------------------ AI phân tích ảnh (Epic 5)
    {
      method: 'POST',
      path: '/ai/analyses',
      auth: 'required',
      handle: async (c) => ({ status: 202, body: await s.ai.create(c.principal.userId, c.body.imageKeys) }),
    },
    {
      method: 'GET',
      path: '/ai/analyses/{id}',
      auth: 'required',
      handle: async (c) => ({ body: await s.ai.get(c.principal.userId, c.params.id!) }),
    },

    // ------------------------------------------------------------ Tin đăng (Owner)
    {
      method: 'POST',
      path: '/listings',
      auth: 'required',
      idempotent: true,
      handle: async (c) => ({ status: 201, body: await s.listings.create(c.principal, c.body) }),
    },
    {
      // Bảng tin kiểu chợ — mọi người đã đăng nhập
      method: 'GET',
      path: '/feed',
      auth: 'required',
      handle: async (c) => ({ body: await s.listings.feed(c.principal.userId, c.query.cursor) }),
    },
    {
      method: 'GET',
      path: '/listings/mine',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.listings.listMine(c.principal.userId) } }),
    },
    {
      method: 'GET',
      path: '/listings/{id}',
      auth: 'required',
      handle: async (c) => {
        const detail = await s.listings.getForViewer(c.params.id!, c.principal.userId);
        // Owner so sánh báo giá kèm uy tín đối tác (T8.6 spec)
        const partnerIds = detail.role === 'OWNER' ? [...new Set(detail.quotes.map((q) => q.partnerId))] : [];
        const reputation = Object.fromEntries(await Promise.all(partnerIds.map(async (id) => [id, await s.reputation.of(id, 'PARTNER')])));
        // Người xem từ bảng tin thấy uy tín người bán (đánh giá nhận được khi bán)
        const sellerReputation = detail.role === 'OWNER' ? undefined : await s.reputation.of(detail.listing.ownerId, 'OWNER');
        return { body: { ...detail, reputation, sellerReputation } };
      },
    },
    {
      method: 'POST',
      path: '/listings/{id}/cancel',
      auth: 'required',
      handle: async (c) => ({ body: await s.listings.cancel(c.principal.userId, c.params.id!) }),
    },
    {
      method: 'POST',
      path: '/listings/{id}/quotes/{quoteId}/request-confirmation',
      auth: 'required',
      handle: async (c) => ({ body: await s.listings.requestConfirmation(c.principal.userId, c.params.id!, c.params.quoteId!) }),
    },

    // ------------------------------------------------------------ Báo giá (Partner)
    {
      method: 'POST',
      path: '/listings/{id}/quotes/{quoteId}/confirm',
      auth: 'required',
      handle: async (c) => ({ body: await s.listings.confirm(c.principal.userId, c.params.id!, c.params.quoteId!, c.body) }),
    },
    {
      method: 'POST',
      path: '/listings/{id}/quotes/{quoteId}/reject',
      auth: 'required',
      handle: async (c) => ({ body: await s.listings.reject(c.principal.userId, c.params.id!, c.params.quoteId!, c.body) }),
    },
    {
      method: 'POST',
      path: '/listings/{id}/quotes/{quoteId}/withdraw',
      auth: 'required',
      handle: async (c) => ({ body: await s.listings.withdraw(c.principal.userId, c.params.id!, c.params.quoteId!) }),
    },
    {
      method: 'POST',
      path: '/listings/{id}/offers',
      auth: 'required',
      idempotent: true,
      handle: async (c) => ({ status: 201, body: await s.listings.manualOffer(c.principal.userId, c.params.id!, c.body) }),
    },

    // ------------------------------------------------------------ Giao dịch (Epic 9)
    {
      method: 'POST',
      path: '/transactions',
      auth: 'required',
      idempotent: true,
      handle: async (c) => ({ status: 201, body: await s.transactions.select(c.principal.userId, c.body) }),
    },
    {
      method: 'GET',
      path: '/transactions',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.transactions.list(c.principal.userId) } }),
    },
    {
      method: 'GET',
      path: '/transactions/{id}',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.get(c.principal.userId, c.params.id!, c.principal.groups.includes('admin')) }),
    },
    {
      method: 'PUT',
      path: '/transactions/{id}/handover-plan',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.proposeHandover(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/handover-plan/accept',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.acceptHandover(c.principal.userId, c.params.id!) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/price-adjustment',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.proposePriceAdjustment(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/price-adjustment/accept',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.respondPriceAdjustment(c.principal.userId, c.params.id!, true) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/price-adjustment/reject',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.respondPriceAdjustment(c.principal.userId, c.params.id!, false) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/confirm-completion',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.confirmCompletion(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/dispute',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.dispute(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/cancel',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.cancel(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/report-failure',
      auth: 'required',
      handle: async (c) => ({ body: await s.transactions.reportFailure(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'POST',
      path: '/transactions/{id}/review',
      auth: 'required',
      handle: async (c) => ({ status: 201, body: await s.transactions.review(c.principal.userId, c.params.id!, c.body) }),
    },

    // ------------------------------------------------------------ Thông báo (Epic 11)
    {
      method: 'GET',
      path: '/notifications',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.notifications.list(c.principal.userId) } }),
    },
    {
      method: 'GET',
      path: '/notifications/unread-count',
      auth: 'required',
      handle: async (c) => ({ body: { count: await s.notifications.unreadCount(c.principal.userId) } }),
    },
    {
      method: 'POST',
      path: '/notifications/read-all',
      auth: 'required',
      handle: async (c) => ({ body: await s.notifications.markAllRead(c.principal.userId) }),
    },
    {
      method: 'POST',
      path: '/notifications/{id}/read',
      auth: 'required',
      handle: async (c) => ({ body: await s.notifications.markRead(c.principal.userId, c.params.id!) }),
    },

    // ------------------------------------------------------------ Đối tác
    {
      method: 'GET',
      path: '/partners/{id}/public',
      auth: 'required',
      handle: async (c) => {
        const partner = await s.partners.get(c.params.id!);
        if (!partner || partner.status !== 'APPROVED') return { status: 404, body: { code: 'NOT_FOUND', message: 'Không tìm thấy đối tác' } };
        const branches = (await s.partners.listBranches(partner.partnerId)).filter((b) => b.active);
        return {
          body: {
            partnerId: partner.partnerId,
            businessName: partner.businessName,
            tier: partnerTier(partner),
            businessType: partner.businessType,
            contact: await s.partners.contactOf(partner),
            branches: branches.map((b) => ({ name: b.name, address: b.location.address, radiusKm: b.radiusKm, categories: b.categories })),
            reputation: await s.reputation.of(partner.partnerId, 'PARTNER'),
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/partners/apply',
      auth: 'required',
      handle: async (c) => ({ body: await s.partners.apply(c.principal, c.body) }),
    },
    {
      method: 'GET',
      path: '/partners/me',
      auth: 'required',
      handle: async (c) => {
        const id = c.principal.userId;
        const [partner, branches, rules] = await Promise.all([s.partners.get(id), s.partners.listBranches(id), s.partners.listRules(id)]);
        return { body: { partner: partner ?? null, branches, rules } };
      },
    },
    {
      method: 'PATCH',
      path: '/partners/me/contact',
      auth: 'required',
      handle: async (c) => ({ body: await s.partners.updateContact(c.principal.userId, c.body) }),
    },
    {
      method: 'POST',
      path: '/partners/me/branches',
      auth: 'required',
      handle: async (c) => ({ status: 201, body: await s.partners.addBranch(c.principal.userId, c.body) }),
    },
    {
      method: 'PATCH',
      path: '/partners/me/branches/{id}',
      auth: 'required',
      handle: async (c) => ({ body: await s.partners.updateBranch(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'POST',
      path: '/partners/me/rules',
      auth: 'required',
      handle: async (c) => ({ status: 201, body: await s.partners.addRule(c.principal.userId, c.body) }),
    },
    {
      method: 'PATCH',
      path: '/partners/me/rules/{id}',
      auth: 'required',
      handle: async (c) => ({ body: await s.partners.updateRule(c.principal.userId, c.params.id!, c.body) }),
    },
    {
      method: 'GET',
      path: '/partners/me/requests',
      auth: 'required',
      handle: async (c) => ({ body: { items: await s.listings.partnerRequests(c.principal.userId) } }),
    },

    // ------------------------------------------------------------ Admin
    {
      method: 'GET',
      path: '/admin/partners',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        const status = oneOf<PartnerStatus>(c.query.status, PARTNER_STATUSES, 'PENDING');
        return { body: { items: await s.partners.listByStatus(status) } };
      },
    },
    {
      method: 'POST',
      path: '/admin/partners/{id}/review',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        if (typeof c.body.approve !== 'boolean') throw badRequest('INVALID_BODY', 'approve phải là true/false');
        const note = typeof c.body.note === 'string' && c.body.note.trim() ? c.body.note.trim() : undefined;
        return { body: await s.partners.review(c.principal.userId, c.params.id!, c.body.approve, note) };
      },
    },
    {
      method: 'POST',
      path: '/admin/partners/{id}/suspend',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        const note = typeof c.body.note === 'string' ? c.body.note : undefined;
        return { body: await s.partners.setSuspended(c.principal.userId, c.params.id!, true, note) };
      },
    },
    {
      method: 'POST',
      path: '/admin/partners/{id}/reactivate',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        return { body: await s.partners.setSuspended(c.principal.userId, c.params.id!, false) };
      },
    },
    {
      method: 'GET',
      path: '/admin/reports',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        return { body: { items: await s.reports.listOpen() } };
      },
    },
    {
      method: 'POST',
      path: '/admin/reports/{id}/resolve',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        return { body: await s.reports.resolve(c.principal.userId, c.params.id!, c.body) };
      },
    },
    {
      // Thống kê nhanh cho Admin (T14.6) — chỉ dùng truy vấn theo trạng thái, không Scan
      method: 'GET',
      path: '/admin/stats',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        const partnerCounts = Object.fromEntries(
          await Promise.all(PARTNER_STATUSES.map(async (st) => [st, (await s.partners.listByStatus(st)).length] as const)),
        );
        const [disputes, reports] = await Promise.all([s.transactions.listDisputed(), s.reports.listOpen()]);
        return { body: { partners: partnerCounts, openDisputes: disputes.length, openReports: reports.length } };
      },
    },
    {
      method: 'GET',
      path: '/admin/disputes',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        return { body: { items: await s.transactions.listDisputed() } };
      },
    },
    {
      method: 'POST',
      path: '/admin/transactions/{id}/resolve',
      auth: 'required',
      handle: async (c) => {
        requireGroup(c.principal, 'admin');
        return { body: await s.transactions.resolveDispute(c.principal.userId, c.params.id!, c.body) };
      },
    },
  ];
}
