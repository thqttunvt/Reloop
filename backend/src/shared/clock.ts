export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Đồng hồ điều khiển được, dùng trong test các mốc thời gian (hết hạn, 12h, 48h). */
export class ManualClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const HOUR_MS = 60 * 60 * 1000;

/** Tháng theo giờ Việt Nam (UTC+7): giao dịch xong 23h ngày 31 vẫn thuộc tháng đó. */
export const vnMonth = (at: Date | string) => new Date(new Date(at).getTime() + 7 * HOUR_MS).toISOString().slice(0, 7);

/** Ngày theo giờ Việt Nam (YYYY-MM-DD) — hạn mức theo ngày reset lúc 0h giờ VN, không phải 7h sáng (mục 12 danhgia). */
export const vnDay = (at: Date | string) => new Date(new Date(at).getTime() + 7 * HOUR_MS).toISOString().slice(0, 10);

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
