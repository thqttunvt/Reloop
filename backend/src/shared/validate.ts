import { badRequest } from './errors';

/** Kiểm tra input từ body JSON; lỗi trả 400 INVALID_<FIELD> để frontend hiện đúng ô. */
const code = (field: string) => `INVALID_${field.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;

export function str(value: unknown, field: string, opts?: { min?: number; max?: number; optional?: false }): string;
export function str(value: unknown, field: string, opts: { min?: number; max?: number; optional: true }): string | undefined;
export function str(value: unknown, field: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string | undefined {
  const { min = 1, max = 500, optional = false } = opts;
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw badRequest(code(field), `Thiếu ${field}`);
  }
  if (typeof value !== 'string') throw badRequest(code(field), `${field} phải là chuỗi`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw badRequest(code(field), `${field} dài ${min}–${max} ký tự`);
  return v;
}

export const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(code(field), `${field} phải thuộc: ${allowed.join(', ')}`);
  }
  return value as T;
};

export const listOf = <T extends string>(value: unknown, allowed: readonly T[], field: string, minItems = 1): T[] => {
  if (!Array.isArray(value) || value.length < minItems) throw badRequest(code(field), `${field} cần ít nhất ${minItems} giá trị`);
  return [...new Set(value.map((v) => oneOf(v, allowed, field)))];
};

type Range = { min?: number; max?: number };

function checkNumber(value: unknown, field: string, integer: boolean, { min = integer ? 0 : -Infinity, max = Infinity }: Range) {
  const ok = typeof value === 'number' && (integer ? Number.isSafeInteger(value) : Number.isFinite(value)) && value >= min && value <= max;
  if (!ok) throw badRequest(code(field), `${field} phải là số${integer ? ' nguyên' : ''} trong khoảng ${min}–${max}`);
  return value as number;
}

const missing = (value: unknown) => value === undefined || value === null || value === '';

export const int = (value: unknown, field: string, range: Range = {}): number => {
  if (missing(value)) throw badRequest(code(field), `Thiếu ${field}`);
  return checkNumber(value, field, true, range);
};

export const num = (value: unknown, field: string, range: Range = {}): number => {
  if (missing(value)) throw badRequest(code(field), `Thiếu ${field}`);
  return checkNumber(value, field, false, range);
};

export const optionalNum = (value: unknown, field: string, range: Range = {}): number | undefined =>
  missing(value) ? undefined : checkNumber(value, field, false, range);

export const bool = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') throw badRequest(code(field), `${field} phải là true/false`);
  return value;
};

export interface GeoPoint {
  lat: number;
  lng: number;
  address: string;
}

/** Tọa độ + địa chỉ hiển thị. Giới hạn trong lãnh thổ Việt Nam (xấp xỉ) để chặn nhập nhầm. */
export const geoPoint = (value: unknown, field = 'location'): GeoPoint => {
  if (typeof value !== 'object' || value === null) throw badRequest(code(field), `Thiếu ${field}`);
  const v = value as Record<string, unknown>;
  return {
    lat: num(v.lat, `${field}.lat`, { min: 8, max: 24 }),
    lng: num(v.lng, `${field}.lng`, { min: 102, max: 110 }),
    address: str(v.address, `${field}.address`, { max: 300 })!,
  };
};
