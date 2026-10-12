import { HOUR_MS } from '../../shared/clock';

export interface BankAccountInfo {
  /** Mã BIN ngân hàng theo chuẩn Napas/VietQR (MB Bank = 970422). */
  bankBin: string;
  accountNo: string;
  accountName: string;
}

/** Hạn mức ví (QĐ-30) — chỉnh bằng cấu hình, không sửa code. */
export interface WalletLimits {
  minTopUp: number;
  maxBalance: number;
  minWithdrawal: number;
  topUpTtlMs: number;
}

export const DEFAULT_LIMITS: WalletLimits = {
  minTopUp: 10_000,
  maxBalance: 20_000_000,
  minWithdrawal: 50_000,
  topUpTtlMs: 24 * HOUR_MS,
};

/** Phí của ReLoop (QĐ-32, QĐ-33) — chỉnh bằng cấu hình, không sửa code. */
export interface FeePolicy {
  /** Hoa hồng theo phần vạn: 1000 = 10%. */
  commissionBps: number;
  commissionMin: number;
  listingFee: number;
  /** Số bài đăng đầu tiên được miễn phí cho mỗi tài khoản. */
  freeListings: number;
}

export const DEFAULT_FEES: FeePolicy = {
  commissionBps: 1_000,
  commissionMin: 5_000,
  listingFee: 20_000,
  freeListings: 1,
};

/** Hoa hồng trên giá cuối; giá 0 (hủy/thất bại) thì không thu. Làm tròn tới đồng. */
export const commissionFor = (price: number, fees: FeePolicy): number =>
  price <= 0 ? 0 : Math.max(fees.commissionMin, Math.round((price * fees.commissionBps) / 10_000));

/** Số tiền bên trả phải được giữ để trả giá + hoa hồng (bên trả chịu phí, cộng thêm). */
export const holdAmountFor = (price: number, fees: FeePolicy): number => price + commissionFor(price, fees);

/** Giá lớn nhất có thể chi cho bên nhận từ một khoản giữ (sau khi trừ hoa hồng). */
export const maxPayeeFor = (holdAmount: number, fees: FeePolicy): number => {
  let lo = 0;
  let hi = holdAmount;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (holdAmountFor(mid, fees) <= holdAmount) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** Ảnh QR theo dịch vụ công khai img.vietqr.io; ngân hàng nào hỗ trợ VietQR cũng quét được. */
export const vietQrImageUrl = (to: BankAccountInfo, amount: number, content: string): string =>
  `https://img.vietqr.io/image/${to.bankBin}-${to.accountNo}-compact2.png` +
  `?amount=${amount}&addInfo=${encodeURIComponent(content)}&accountName=${encodeURIComponent(to.accountName)}`;

/** Chuẩn hóa tên để so khớp tên chủ TK với tên đăng ký: bỏ dấu, in hoa, gộp khoảng trắng. */
export const normalizeName = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
