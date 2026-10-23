/** Danh mục dùng chung cho tin đăng, chi nhánh và quy tắc giá (giá trị lưu DB; nhãn tiếng Việt ở frontend). */
export const CATEGORIES = [
  'PHONE',
  'LAPTOP',
  'TABLET',
  'DESKTOP',
  'MONITOR_TV',
  'HOUSEHOLD_APPLIANCE',
  'COMPONENT',
  'ACCESSORY',
  'BATTERY',
  'OTHER',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Tình trạng thiết bị (spec T3.5). UNKNOWN là một lựa chọn riêng, chi nhánh phải chọn rõ (giaiphap D6). */
export const CONDITIONS = ['WORKING', 'PARTIALLY_WORKING', 'NOT_WORKING', 'UNKNOWN'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Hình thức bàn giao (spec T9.2): mang đến cửa hàng / Partner đến nhận / tự thỏa thuận. */
export const HANDOVER_METHODS = ['DROP_OFF', 'PICKUP', 'NEGOTIABLE'] as const;
export type HandoverMethod = (typeof HANDOVER_METHODS)[number];

/** Đơn vị giá (QĐ-25). */
export const PRICE_UNITS = ['PER_DEVICE', 'PER_KG'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

/** Bán kính phục vụ của chi nhánh: 1–5 km (QĐ-11). */
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 5;
