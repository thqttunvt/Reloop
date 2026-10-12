import { timingSafeEqual } from 'node:crypto';
import { badRequest, unauthenticated } from '../shared/errors';

/** Một biến động số dư trên TK ngân hàng ReLoop, đã chuẩn hóa từ webhook của nhà cung cấp. */
export interface BankEvent {
  provider: string;
  /** Mã giao dịch phía ngân hàng/nhà cung cấp — khóa chống xử lý trùng (TL-03). */
  bankTxnId: string;
  direction: 'IN' | 'OUT';
  amount: number;
  content: string;
  occurredAt: string;
  raw: unknown;
}

/**
 * Cổng nhận webhook ngân hàng. Mỗi nhà cung cấp (SePay, payOS, Casso, MB Open API...)
 * là một adapter riêng; nghiệp vụ ví không đổi khi thay adapter.
 */
export interface BankProvider {
  readonly name: string;
  /** Xác thực nguồn gửi + chuyển payload thành BankEvent. Ném lỗi nếu không hợp lệ. */
  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): BankEvent[];
}

export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Adapter giả cho dev local / test. Header: x-webhook-secret.
 * Body: { bankTxnId, direction: "IN"|"OUT", amount, content, occurredAt? }
 */
export class FakeBankProvider implements BankProvider {
  readonly name = 'fake';

  constructor(private readonly secret: string) {}

  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): BankEvent[] {
    if (!safeEqual(headers['x-webhook-secret'] ?? '', this.secret)) throw unauthenticated();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw badRequest('INVALID_JSON', 'Payload không phải JSON');
    }
    const { bankTxnId, direction, amount, content, occurredAt } = body;
    if (typeof bankTxnId !== 'string' || !bankTxnId) throw badRequest('INVALID_WEBHOOK', 'Thiếu bankTxnId');
    if (direction !== 'IN' && direction !== 'OUT') throw badRequest('INVALID_WEBHOOK', 'direction phải là IN/OUT');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      throw badRequest('INVALID_WEBHOOK', 'amount không hợp lệ');
    }
    return [
      {
        provider: this.name,
        bankTxnId: `${this.name}:${bankTxnId}`,
        direction,
        amount,
        content: typeof content === 'string' ? content : '',
        occurredAt: typeof occurredAt === 'string' ? occurredAt : new Date().toISOString(),
        raw: body,
      },
    ];
  }
}
