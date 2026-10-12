import { describe, expect, it } from 'vitest';
import { listingMachine, quoteMachine, transactionMachine, withdrawalMachine } from '../src/domain/stateMachines';
import { AppError } from '../src/shared/errors';

const errorOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('không ném lỗi');
};

describe('state machines', () => {
  it('Listing: không còn ACTIVE_PRIORITY/PUBLIC, MATCHED mở lại được (QĐ-12, A5)', () => {
    expect(listingMachine.nextStates('ACTIVE').sort()).toEqual(['CANCELLED', 'EXPIRED', 'MATCHED']);
    expect(listingMachine.canTransition('MATCHED', 'ACTIVE', 'SYSTEM')).toBe(true);
    expect(listingMachine.canTransition('MATCHED', 'CANCELLED', 'OWNER')).toBe(false);
  });

  it('Transaction: chỉ hoàn tất qua bước chờ bên kia xác nhận (QĐ-18)', () => {
    expect(transactionMachine.canTransition('HANDOVER_PENDING', 'COMPLETED', 'OWNER')).toBe(false);
    expect(transactionMachine.canTransition('AWAITING_COUNTERPARTY', 'COMPLETED', 'SYSTEM')).toBe(true);
  });

  it('Transaction: tranh chấp chỉ Admin quyết (QĐ-08)', () => {
    expect(errorOf(() => transactionMachine.assertTransition('DISPUTED', 'COMPLETED', 'OWNER')).status).toBe(403);
    expect(() => transactionMachine.assertTransition('DISPUTED', 'FAILED', 'ADMIN')).not.toThrow();
  });

  it('Quote: chỉ Partner xác nhận, chỉ Owner chọn', () => {
    expect(quoteMachine.canTransition('CONFIRMATION_REQUESTED', 'CONFIRMED_OFFER', 'OWNER')).toBe(false);
    expect(quoteMachine.canTransition('CONFIRMED_OFFER', 'SELECTED', 'OWNER')).toBe(true);
    expect(quoteMachine.canTransition('ESTIMATED', 'SELECTED', 'OWNER')).toBe(false);
  });

  it('cạnh không tồn tại → 409 INVALID_STATE_TRANSITION', () => {
    const err = errorOf(() => withdrawalMachine.assertTransition('PAID', 'FAILED', 'ADMIN'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('INVALID_STATE_TRANSITION');
  });
});
