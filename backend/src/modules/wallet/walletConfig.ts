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
