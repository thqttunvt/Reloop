/** Lỗi nghiệp vụ có mã ổn định để frontend xử lý (xem API contract). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Chưa đăng nhập');
export const forbidden = (message = 'Không có quyền thực hiện thao tác này') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `Không tìm thấy ${what}`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
