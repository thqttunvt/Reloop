import { conflict } from '../shared/errors';
import { ConditionFailedError } from './table';

/**
 * Chạy lại cả chu trình "đọc → tính → ghi có điều kiện" khi bị tranh chấp ghi.
 * attempt() phải đọc lại dữ liệu mới mỗi lần chạy.
 */
export async function withOptimisticRetry<T>(attempt: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
      if (i >= maxAttempts) throw conflict('CONCURRENT_UPDATE', 'Dữ liệu đang được cập nhật, vui lòng thử lại');
    }
  }
}
