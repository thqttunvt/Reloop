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
