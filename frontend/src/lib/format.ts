export const vnd = (n: number) => `${n.toLocaleString('vi-VN')}đ`;

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const JOURNAL_LABEL: Record<string, string> = {
  HOLD: 'Thanh toán (giữ tiền)',
  SETTLE: 'Kết thúc giao dịch',
  LISTING_FEE: 'Phí đăng bài',
  LISTING_FEE_REFUND: 'Hoàn phí đăng bài',
};

export const km = (n: number) => `khoảng ${n.toLocaleString('vi-VN')} km`;

export const monthYear = (iso: string) => new Date(iso).toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' });

/** "5 phút trước", "3 giờ trước", "2 ngày trước" */
export const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} ngày trước`;
  return new Date(iso).toLocaleDateString('vi-VN');
};
