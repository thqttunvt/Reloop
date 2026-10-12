export const vnd = (n: number) => `${n.toLocaleString('vi-VN')}đ`;

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const JOURNAL_LABEL: Record<string, string> = {
  TOPUP: 'Nạp tiền',
  HOLD: 'Thanh toán (giữ tiền)',
  SETTLE: 'Kết thúc giao dịch',
  LISTING_FEE: 'Phí đăng bài',
  LISTING_FEE_REFUND: 'Hoàn phí đăng bài',
  WITHDRAW_REQUEST: 'Yêu cầu rút',
  WITHDRAW_PAID: 'Rút thành công',
  WITHDRAW_FAILED: 'Rút thất bại — hoàn lại',
};
