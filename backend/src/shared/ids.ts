import { randomInt, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID().replace(/-/g, '');

// Bỏ các ký tự dễ nhầm (0/O, 1/I/L) vì người dùng phải gõ mã vào nội dung chuyển khoản.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Mã ngắn in hoa, không dấu gạch (ngân hàng thường bỏ ký tự đặc biệt trong nội dung CK). */
export const shortCode = (length: number): string => {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
};
