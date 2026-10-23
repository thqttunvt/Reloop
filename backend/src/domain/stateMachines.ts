import { conflict, forbidden } from '../shared/errors';

/** Ai gây ra chuyển trạng thái. SYSTEM = job nền / webhook / chính backend. */
export type Actor = 'OWNER' | 'PARTNER' | 'ADMIN' | 'SYSTEM';

interface Transition<S extends string> {
  from: S;
  to: S;
  actors: Actor[];
}

export interface StateMachine<S extends string> {
  readonly name: string;
  canTransition(from: S, to: S, actor: Actor): boolean;
  /** Ném 409 INVALID_STATE_TRANSITION nếu không có cạnh, 403 nếu sai người thực hiện. */
  assertTransition(from: S, to: S, actor: Actor): void;
  nextStates(from: S): S[];
}

function createMachine<S extends string>(name: string, transitions: Transition<S>[]): StateMachine<S> {
  const find = (from: S, to: S) => transitions.find((t) => t.from === from && t.to === to);
  return {
    name,
    canTransition: (from, to, actor) => find(from, to)?.actors.includes(actor) ?? false,
    assertTransition(from, to, actor) {
      const t = find(from, to);
      if (!t) throw conflict('INVALID_STATE_TRANSITION', `${name}: không thể chuyển ${from} → ${to}`);
      if (!t.actors.includes(actor)) throw forbidden(`${name}: ${actor} không được chuyển ${from} → ${to}`);
    },
    nextStates: (from) => transitions.filter((t) => t.from === from).map((t) => t.to),
  };
}

const edges = <S extends string>(froms: S[], to: S, actors: Actor[]): Transition<S>[] =>
  froms.map((from) => ({ from, to, actors }));

// ---------------------------------------------------------------- Listing (QĐ-12, QĐ-36)
export type ListingStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'MATCHED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
export const listingMachine = createMachine<ListingStatus>('Listing', [
  // Ảnh bị gắn cờ → chờ Admin duyệt (QĐ-36)
  { from: 'PENDING_REVIEW', to: 'ACTIVE', actors: ['ADMIN'] },
  { from: 'PENDING_REVIEW', to: 'CANCELLED', actors: ['ADMIN', 'OWNER'] },
  { from: 'ACTIVE', to: 'MATCHED', actors: ['SYSTEM'] },
  { from: 'ACTIVE', to: 'EXPIRED', actors: ['SYSTEM'] },
  { from: 'ACTIVE', to: 'CANCELLED', actors: ['OWNER', 'ADMIN'] },
  { from: 'MATCHED', to: 'COMPLETED', actors: ['SYSTEM'] },
  { from: 'MATCHED', to: 'ACTIVE', actors: ['SYSTEM'] }, // giao dịch hủy/thất bại, còn hạn
  { from: 'MATCHED', to: 'EXPIRED', actors: ['SYSTEM'] }, // giao dịch hủy/thất bại, hết hạn
]);

// ---------------------------------------------------------------- Yêu cầu gói VIP 1 (QĐ-44)
// Cấp 1 gửi yêu cầu → Admin gửi hóa đơn → người bán chuyển khoản → Admin tài chính xác nhận đã thu → gói tự bật.
export type VipRequestStatus = 'REQUESTED' | 'INVOICED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export const vipRequestMachine = createMachine<VipRequestStatus>('VipRequest', [
  { from: 'REQUESTED', to: 'INVOICED', actors: ['ADMIN'] },
  { from: 'INVOICED', to: 'APPROVED', actors: ['ADMIN'] },
  ...edges<VipRequestStatus>(['REQUESTED', 'INVOICED'], 'REJECTED', ['ADMIN']),
  ...edges<VipRequestStatus>(['REQUESTED', 'INVOICED'], 'CANCELLED', ['OWNER']),
]);

// ---------------------------------------------------------------- Quote (giaiphap B1)
export type QuoteStatus =
  | 'ESTIMATED'
  | 'CONFIRMATION_REQUESTED'
  | 'CONFIRMED_OFFER'
  | 'SELECTED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'INVALIDATED';
export const quoteMachine = createMachine<QuoteStatus>('Quote', [
  { from: 'ESTIMATED', to: 'CONFIRMATION_REQUESTED', actors: ['OWNER'] },
  { from: 'CONFIRMATION_REQUESTED', to: 'CONFIRMED_OFFER', actors: ['PARTNER'] },
  { from: 'CONFIRMATION_REQUESTED', to: 'REJECTED', actors: ['PARTNER'] },
  { from: 'CONFIRMED_OFFER', to: 'SELECTED', actors: ['OWNER'] },
  { from: 'CONFIRMED_OFFER', to: 'WITHDRAWN', actors: ['PARTNER'] },
  ...edges<QuoteStatus>(['ESTIMATED', 'CONFIRMATION_REQUESTED', 'CONFIRMED_OFFER'], 'EXPIRED', ['SYSTEM']),
  ...edges<QuoteStatus>(['ESTIMATED', 'CONFIRMATION_REQUESTED', 'CONFIRMED_OFFER'], 'INVALIDATED', ['SYSTEM', 'ADMIN']),
]);

// ---------------------------------------------------------------- Transaction (quyetdinh mục 5)
export const TRANSACTION_STATUSES = [
  'AWAITING_PAYMENT',
  'HANDOVER_PENDING',
  'PRICE_ADJUSTMENT_PENDING',
  'AWAITING_COUNTERPARTY',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'DISPUTED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export const transactionMachine = createMachine<TransactionStatus>('Transaction', [
  { from: 'AWAITING_PAYMENT', to: 'HANDOVER_PENDING', actors: ['SYSTEM'] }, // ví đã giữ tiền
  { from: 'AWAITING_PAYMENT', to: 'CANCELLED', actors: ['SYSTEM', 'OWNER', 'PARTNER'] }, // quá 12h / hủy
  { from: 'HANDOVER_PENDING', to: 'PRICE_ADJUSTMENT_PENDING', actors: ['PARTNER'] },
  { from: 'PRICE_ADJUSTMENT_PENDING', to: 'HANDOVER_PENDING', actors: ['OWNER'] }, // đồng ý hoặc từ chối
  { from: 'HANDOVER_PENDING', to: 'AWAITING_COUNTERPARTY', actors: ['OWNER', 'PARTNER'] },
  { from: 'AWAITING_COUNTERPARTY', to: 'COMPLETED', actors: ['OWNER', 'PARTNER', 'SYSTEM'] }, // SYSTEM = hết 48h
  { from: 'AWAITING_COUNTERPARTY', to: 'DISPUTED', actors: ['OWNER', 'PARTNER'] },
  { from: 'HANDOVER_PENDING', to: 'CANCELLED', actors: ['OWNER', 'PARTNER'] },
  ...edges<TransactionStatus>(['HANDOVER_PENDING', 'PRICE_ADJUSTMENT_PENDING'], 'FAILED', ['OWNER', 'PARTNER']),
  { from: 'DISPUTED', to: 'COMPLETED', actors: ['ADMIN'] },
  { from: 'DISPUTED', to: 'FAILED', actors: ['ADMIN'] },
]);
