import { freshIdToken } from './cognito';
import { loadSession } from './session';

const BASE = import.meta.env.VITE_API_BASE ?? '/api';

export const ACCOUNT_LOCKED_EVENT = 'reloop:account-locked';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const session = loadSession();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session?.kind === 'cognito') {
    const token = await freshIdToken(session);
    if (token) headers.authorization = `Bearer ${token}`;
  } else if (session) {
    headers['x-dev-user'] = session.userId;
    if (session.groups.length) headers['x-dev-groups'] = session.groups.join(',');
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (!res.ok) {
    // Nợ phí quá hạn > 7 ngày → App chuyển sang màn hình "cần thanh toán phí" (QĐ-40)
    if (data?.code === 'ACCOUNT_LOCKED_UNPAID') window.dispatchEvent(new Event(ACCOUNT_LOCKED_EVENT));
    throw new ApiError(res.status, data?.code ?? 'HTTP_ERROR', data?.message ?? res.statusText);
  }
  return data as T;
}

/** Mỗi lần người dùng bấm nút tạo 1 key mới; bấm lại do mạng lỗi thì dùng lại key cũ. */
export const newIdempotencyKey = () => crypto.randomUUID();

// ---- Kiểu dữ liệu trả về (khớp backend) ----
export interface Profile {
  userId: string;
  email?: string;
  fullName?: string;
  phone?: string;
  roles: string[];
}

export interface GeoPoint {
  lat: number;
  lng: number;
  address: string;
}

export type ListingStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'MATCHED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
export type QuoteStatus =
  | 'ESTIMATED'
  | 'CONFIRMATION_REQUESTED'
  | 'CONFIRMED_OFFER'
  | 'SELECTED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'INVALIDATED';

export interface Listing {
  listingId: string;
  ownerId: string;
  title: string;
  category: string;
  brand?: string;
  model?: string;
  condition: string;
  description: string;
  unit: 'PER_DEVICE' | 'PER_KG';
  quantity: number;
  weightKg?: number;
  handoverMethods: string[];
  location?: GeoPoint;
  area: string;
  imageKeys: string[];
  /** Ảnh có chữ bị gắn cờ → chờ Admin duyệt (QĐ-36) */
  review?: {
    reason: string;
    images: { key: string; text: string; kind?: 'TEXT' | 'SENSITIVE' }[];
    at: string;
    decision?: { approved: boolean; note?: string; at: string };
  };
  moderated?: { note?: string; at: string };
  /** Chỉ chủ tin thấy: giao dịch gần nhất bị hủy / thất bại — gỡ tin trong 72 giờ sau đó bị tính phí (QĐ-39) */
  lastEndedDeal?: { transactionId: string; buyerId: string; status: 'CANCELLED' | 'FAILED'; at: string };
  status: ListingStatus;
  matchingStatus: 'PENDING' | 'DONE';
  matchCount: number;
  quoteCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface Match {
  listingId: string;
  branchId: string;
  partnerId: string;
  partnerName: string;
  branchName: string;
  distanceKm: number;
  handoverMethods: string[];
}

export interface Quote {
  quoteId: string;
  listingId: string;
  partnerId: string;
  branchId: string;
  partnerName: string;
  branchName: string;
  distanceKm: number;
  kind: 'AUTO' | 'MANUAL';
  status: QuoteStatus;
  estimate?: { unit: string; unitMin: number; unitMax: number; quantity?: number; totalMin?: number; totalMax?: number };
  offer?: { price: number; note?: string; validUntil: string; at: string; differsFromEstimate: boolean };
  responseDeadline?: string;
  rejectNote?: string;
  /** Tin đang giao dịch với người khác: báo giá giữ lại (chọn lại được nếu giao dịch hủy) nhưng chưa làm gì được */
  takenByOther?: boolean;
}

export interface Contact {
  email?: string;
  phone?: string;
}

export interface Seller {
  /** Tên trong hồ sơ đối tác (người bán là đối tác đã duyệt — QĐ-34) */
  displayName: string;
  memberSince?: string;
  tier?: PartnerTier;
  contact?: Contact;
}

export interface ListingDetail {
  /** VIEWER = người xem từ bảng tin (không phải chủ tin, không được match) */
  role: 'OWNER' | 'PARTNER' | 'VIEWER';
  listing: Listing & { activeTransactionId?: string };
  images: string[];
  seller: Seller;
  matches: Match[];
  quotes: Quote[];
  /** Uy tín đối tác theo partnerId (chỉ Owner) */
  reputation: Record<string, Reputation>;
  /** Uy tín người bán (người xem / đối tác) */
  sellerReputation?: Reputation;
}

export interface FeedItem {
  listing: Listing;
  seller: Seller;
  images: string[];
  isMine: boolean;
}

export type PartnerStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
/** INDIVIDUAL = cấp 1 (khách lẻ), BUSINESS = cấp 2 (doanh nghiệp / hộ kinh doanh) */
export type PartnerTier = 'INDIVIDUAL' | 'BUSINESS';
export type BusinessType = 'PERSONAL' | 'HOUSEHOLD' | 'ENTERPRISE';

export interface Partner {
  partnerId: string;
  /** Hồ sơ cũ không có → cấp 2 */
  tier?: PartnerTier;
  businessType?: BusinessType;
  businessName: string;
  licenseNo?: string;
  contactEmail?: string;
  phone?: string;
  status: PartnerStatus;
  reviewNote?: string;
  /** Gói VIP 1 của cấp 1 (QĐ-41) — còn hiệu lực khi chưa tới until */
  vip?: { plan: 'VIP1'; since: string; until: string };
  createdAt: string;
}

/** Hạn mức tin đang mở cùng lúc (QĐ-41): BASIC 3 · VIP1 5 · BUSINESS 10 */
export interface ListingQuota {
  plan: 'BASIC' | 'VIP1' | 'BUSINESS';
  limit: number;
  open: number;
  vipUntil?: string;
  vipPrice: number;
  vipDays: number;
}

export interface Branch {
  branchId: string;
  name: string;
  location: GeoPoint;
  radiusKm: number;
  categories: string[];
  conditions: string[];
  handoverMethods: string[];
  active: boolean;
}

export interface PricingRule {
  ruleId: string;
  branchId: string;
  category: string;
  conditions: string[];
  unit: 'PER_DEVICE' | 'PER_KG';
  minPrice: number;
  maxPrice: number;
  minQuantity: number;
  active: boolean;
}

export interface PartnerRequest {
  listingId: string;
  branchId: string;
  branchName: string;
  distanceKm: number;
  title: string;
  category: string;
  condition: string;
  unit: 'PER_DEVICE' | 'PER_KG';
  quantity: number;
  weightKg?: number;
  area: string;
  createdAt: string;
  expiresAt: string;
  listingStatus: ListingStatus;
  quotes: Quote[];
}

export interface UploadTicket {
  key: string;
  url: string;
  fields: Record<string, string>;
}

/** Thu nhỏ ảnh về cạnh dài ≤ 1600 px (JPEG) trước khi upload (giaiphap E6) — nhẹ hơn và hợp giới hạn ảnh của AI. */
async function shrink(file: File, maxSide = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('resize'))), 'image/jpeg', 0.85));
  } catch {
    return file; // trình duyệt không hỗ trợ → gửi ảnh gốc
  }
}

/**
 * Upload ảnh thẳng lên S3 bằng presigned POST, rồi kiểm duyệt.
 * flagged = ảnh có chữ bất thường (QĐ-36): vẫn dùng được nhưng tin đăng phải chờ Admin duyệt.
 */
export async function uploadImage(original: File): Promise<{ key: string; flagged: boolean }> {
  const file = await shrink(original);
  const ticket = await api<UploadTicket>('POST', '/uploads/presign', { body: { contentType: file.type || original.type } });
  const form = new FormData();
  Object.entries(ticket.fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', file);
  const res = await fetch(ticket.url, { method: 'POST', body: form });
  if (!res.ok) throw new ApiError(res.status, 'UPLOAD_FAILED', 'Upload ảnh thất bại (tối đa 5 MB, JPEG/PNG/WebP)');
  // Kiểm duyệt ảnh nhạy cảm (Rekognition); ảnh vi phạm bị xóa và trả lỗi IMAGE_REJECTED
  const checked = await api<{ flagged?: boolean }>('POST', '/uploads/moderate', { body: { key: ticket.key } });
  return { key: ticket.key, flagged: checked.flagged === true };
}

export type TransactionStatus =
  | 'AWAITING_PAYMENT'
  | 'HANDOVER_PENDING'
  | 'PRICE_ADJUSTMENT_PENDING'
  | 'AWAITING_COUNTERPARTY'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'DISPUTED';

export type Party = 'OWNER' | 'PARTNER';

export interface Transaction {
  transactionId: string;
  listingId: string;
  /** CHAT: chốt lời ra giá trong chat (QĐ-38); QUOTE / không có: chọn báo giá của đối tác */
  source?: 'QUOTE' | 'CHAT';
  conversationId?: string;
  ownerId: string;
  partnerId: string;
  status: TransactionStatus;
  listingTitle: string;
  partnerName: string;
  branchName?: string;
  originalPrice: number;
  agreedPrice: number;
  finalPrice?: number;
  priceAdjustments: { price: number; reason: string; at: string; outcome?: 'ACCEPTED' | 'REJECTED' }[];
  handoverPlan?: { method: string; time: string; place: string; note?: string; proposedBy: Party; status: 'PROPOSED' | 'AGREED' };
  completion: Partial<Record<Party, { at: string; finalPrice: number }>>;
  counterpartyDeadline?: string;
  cancel?: { by: Party; reason: string; at: string };
  /** Đang chờ hủy — tự hủy lúc effectiveAt (QĐ-38) */
  cancelRequest?: { by: Party; reason: string; at: string; effectiveAt: string };
  failure?: { by: Party; reason: string; note?: string; at: string };
  dispute?: { by: Party; reason: string; at: string; resolution?: { outcome: string; note: string; at: string } };
  createdAt: string;
  closedAt?: string;
}

export interface TransactionDetail {
  role: Party | 'ADMIN';
  transaction: Transaction;
  contacts: {
    owner: { fullName?: string; email?: string; phone?: string; address?: string };
    partner: { businessName?: string; email?: string; phone?: string; branchName?: string; address?: string };
  };
  events: { type: string; actor: string; at: string; data?: Record<string, unknown> }[];
  reviews: { by: Party; rating: number; comment?: string; createdAt: string }[];
  adjustmentImages: string[];
  canReview: boolean;
}

export interface Reputation {
  averageRating: number | null;
  reviewCount: number;
  completedCount: number;
  completionRate: number | null;
  cancellationRate: number | null;
}

export interface Notification {
  notificationId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  read: boolean;
  createdAt: string;
}

export interface Features {
  images: boolean;
  ai: boolean;
  /** Kiểm tra chữ trong ảnh (QĐ-36) */
  textCheck?: boolean;
}

export interface AiAnalysis {
  analysisId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  error?: string;
  result?: {
    isElectronicDevice: boolean;
    isInappropriate: boolean;
    category: string;
    brand: string | null;
    model: string | null;
    condition: string;
    visibleDamage: string[];
    suggestedTitle: string;
    suggestedDescription: string;
    confidence: 'low' | 'medium' | 'high';
  };
}

export interface SavedLocation {
  locationId: string;
  name: string;
  location: GeoPoint;
  area: string;
  isDefault: boolean;
}

export interface Report {
  reportId: string;
  reporterId: string;
  targetType: string;
  targetId: string;
  reason: string;
  createdAt: string;
  /** Thứ bị báo cáo (chỉ ở hàng đợi Admin) */
  target?: { title: string; status?: string; link?: string };
  /** Người vi phạm + số vi phạm 30 ngày — chặn tạm ngừng nhầm (QĐ-43) */
  violator?: { userId: string; name: string; partnerStatus?: string; violations30d: number };
}

export interface Conversation {
  conversationId: string;
  listingId: string;
  listingTitle: string;
  ownerId: string;
  partnerId: string;
  partnerName: string;
  lastMessage?: string;
  lastMessageAt?: string;
  createdAt: string;
  myRole?: 'OWNER' | 'PARTNER';
  myUnread: number;
  /** Lời ra giá đang chờ bên kia trả lời (QĐ-38) */
  pendingOffer?: { offerId: string; price: number; by: 'OWNER' | 'PARTNER'; at: string };
}

export interface ChatMessage {
  messageId: string;
  senderId: string;
  senderRole: 'OWNER' | 'PARTNER';
  /** TEXT: tin thường · OFFER: lời ra giá · SYSTEM: kết quả chấp nhận / từ chối giá */
  kind?: 'TEXT' | 'OFFER' | 'SYSTEM';
  text: string;
  price?: number;
  offerId?: string;
  at: string;
}

/** Phí dịch vụ theo tháng (QĐ-37) */
export interface Invoice {
  userId: string;
  month: string;
  paymentCode: string;
  transactionCount: number;
  feePerTransaction: number;
  amount: number;
  status: 'ISSUED' | 'PAID';
  issuedAt: string;
  dueAt: string;
  paidAt?: string;
  paidNote?: string;
  overdue: boolean;
  /** Chỉ có ở danh sách của Admin */
  partnerName?: string;
}

export interface BillingSummary {
  feePerTransaction: number;
  dueDays: number;
  postingLockDays: number;
  fullLockDays: number;
  /** Mức khóa do nợ phí quá hạn (QĐ-40) */
  debt: DebtStatus;
  bank?: { bankName: string; accountNo: string; accountName: string };
  currentMonth: {
    month: string;
    transactionCount: number;
    amount: number;
    lines: FeeLine[];
  };
  /** Phí nghi bán ngoài tháng này + tháng trước (QĐ-39) */
  suspected: FeeLine[];
  invoices: Invoice[];
}

/** NONE · WARNING: quá hạn, chưa khóa · NO_POSTING: quá hạn > 3 ngày, không đăng tin mới · FULL: quá hạn > 7 ngày, khóa mọi chức năng */
export interface DebtStatus {
  level: 'NONE' | 'WARNING' | 'NO_POSTING' | 'FULL';
  invoice?: { month: string; amount: number; paymentCode: string; dueAt: string };
  overdueAmount: number;
  daysOverdue: number;
  postingLockAt?: string;
  fullLockAt?: string;
}

export interface FeeAppeal {
  reason: string;
  at: string;
  status: 'OPEN' | 'WAIVED' | 'KEPT';
  note?: string;
  resolvedAt?: string;
}

export interface FeeLine {
  month: string;
  transactionId: string;
  listingTitle: string;
  amount: number;
  completedAt: string;
  /** SUSPECTED_OFFLINE: hủy giao dịch rồi gỡ tin trong 72 giờ (QĐ-39) */
  kind: 'TRANSACTION' | 'SUSPECTED_OFFLINE' | 'VIP_PLAN';
  appeal?: FeeAppeal;
}

/** Cờ "nghi né phí" cho Admin (QĐ-39) */
export interface RiskFlag {
  userId: string;
  sellerName?: string;
  reasons: { code: string; count: number; text: string }[];
  openedAt: string;
  resolution?: { action: string; note?: string; at: string };
  dealsEnded: { transactionId: string; buyerName: string; listingTitle: string; status: 'CANCELLED' | 'FAILED'; at: string }[];
  cancelThenRemove: { transactionId: string; listingId: string; listingTitle: string; at: string }[];
  /** Vi phạm 30 ngày (QĐ-43) */
  violations?: { violationId: string; kind: string; ref: { type: string; id: string; title?: string }; note?: string; at: string }[];
}
