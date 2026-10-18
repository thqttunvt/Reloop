/** Nhãn tiếng Việt cho các giá trị lưu ở backend (backend/src/domain/catalog.ts). */
export const CATEGORY_LABEL: Record<string, string> = {
  PHONE: 'Điện thoại',
  LAPTOP: 'Laptop',
  TABLET: 'Máy tính bảng',
  DESKTOP: 'Máy tính để bàn',
  MONITOR_TV: 'Màn hình / TV',
  HOUSEHOLD_APPLIANCE: 'Đồ gia dụng điện',
  COMPONENT: 'Linh kiện',
  ACCESSORY: 'Phụ kiện, dây cáp',
  BATTERY: 'Pin, ắc quy',
  OTHER: 'Khác',
};

export const CONDITION_LABEL: Record<string, string> = {
  WORKING: 'Còn hoạt động',
  PARTIALLY_WORKING: 'Hỏng một phần',
  NOT_WORKING: 'Không hoạt động',
  UNKNOWN: 'Không rõ',
};

export const HANDOVER_LABEL: Record<string, string> = {
  DROP_OFF: 'Mang đến cửa hàng',
  PICKUP: 'Đối tác đến nhận',
  NEGOTIABLE: 'Tự thỏa thuận',
};

export const UNIT_LABEL: Record<string, string> = { PER_DEVICE: 'theo cái', PER_KG: 'theo kg' };

export const LISTING_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Đang mở',
  MATCHED: 'Đã chọn đối tác',
  COMPLETED: 'Hoàn tất',
  EXPIRED: 'Hết hạn',
  CANCELLED: 'Đã hủy',
};

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  ESTIMATED: 'Giá dự kiến — chưa được đối tác xác nhận',
  CONFIRMATION_REQUESTED: 'Đang chờ đối tác xác nhận',
  CONFIRMED_OFFER: 'Đối tác đã xác nhận giá',
  SELECTED: 'Đã chọn',
  REJECTED: 'Đối tác từ chối',
  WITHDRAWN: 'Đối tác đã rút',
  EXPIRED: 'Hết hạn',
  INVALIDATED: 'Không còn hiệu lực',
};

export const PARTNER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Bị từ chối',
  SUSPENDED: 'Tạm ngừng',
};

export const PARTNER_TIER_LABEL: Record<string, string> = {
  INDIVIDUAL: 'Đối tác cấp 1 — khách lẻ',
  BUSINESS: 'Đối tác cấp 2 — doanh nghiệp / hộ kinh doanh',
};

export const BUSINESS_TYPE_LABEL: Record<string, string> = { PERSONAL: 'Cá nhân', HOUSEHOLD: 'Hộ kinh doanh', ENTERPRISE: 'Doanh nghiệp' };
/** Cấp 2 bắt buộc là doanh nghiệp / hộ kinh doanh (QĐ-10); cấp 1 chọn được cả 3. */
export const TIER2_BUSINESS_TYPES = ['ENTERPRISE', 'HOUSEHOLD'];

/** Hồ sơ đối tác cũ (trước khi chia cấp) không có tier → cấp 2. */
export const tierOf = (p: { tier?: string }) => p.tier ?? 'BUSINESS';

export const keysOf = (labels: Record<string, string>) => Object.keys(labels);

export const statusTone = (s: string) =>
  ['ACTIVE', 'APPROVED', 'CONFIRMED_OFFER', 'COMPLETED', 'SELECTED'].includes(s)
    ? 'ok'
    : ['PENDING', 'CONFIRMATION_REQUESTED', 'ESTIMATED', 'MATCHED', 'HANDOVER_PENDING', 'PRICE_ADJUSTMENT_PENDING', 'AWAITING_COUNTERPARTY'].includes(s)
      ? 'warn'
      : 'bad';

export const TX_STATUS_LABEL: Record<string, string> = {
  AWAITING_PAYMENT: 'Chờ thanh toán',
  HANDOVER_PENDING: 'Chờ bàn giao',
  PRICE_ADJUSTMENT_PENDING: 'Chờ chủ tin duyệt giá mới',
  AWAITING_COUNTERPARTY: 'Chờ bên kia xác nhận hoàn tất',
  COMPLETED: 'Hoàn tất',
  CANCELLED: 'Đã hủy',
  FAILED: 'Thất bại',
  DISPUTED: 'Đang tranh chấp',
};

export const FAILURE_LABEL: Record<string, string> = {
  NO_SHOW_OWNER: 'Chủ tin không đến',
  NO_SHOW_PARTNER: 'Đối tác không đến',
  DEVICE_MISMATCH: 'Thiết bị khác mô tả',
  PRICE_DISAGREEMENT: 'Không thống nhất giá',
  OTHER: 'Lý do khác',
};

export const PARTY_LABEL: Record<string, string> = { OWNER: 'Chủ tin', PARTNER: 'Đối tác', ADMIN: 'Admin', SYSTEM: 'Hệ thống' };
