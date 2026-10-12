import { badRequest } from './errors';

/** Tiền luôn là số nguyên VND (TL-02). */
export type Vnd = number;

export const assertVnd = (value: unknown, field = 'amount'): Vnd => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest('INVALID_AMOUNT', `${field} phải là số nguyên VND dương`);
  }
  return value;
};
