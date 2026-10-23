import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { forbidden } from '../shared/errors';

/** Nhóm quản trị lấy từ Cognito groups (D11). Vai trò OWNER/PARTNER lấy từ hồ sơ DynamoDB. */
export type AdminGroup = 'admin' | 'admin_finance';

export interface Principal {
  userId: string;
  email?: string;
  groups: string[];
}

export interface AuthProvider {
  /** undefined = request không kèm danh tính hợp lệ. */
  authenticate(event: APIGatewayProxyEventV2): Principal | undefined;
}

const splitGroups = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  // Cognito qua HTTP API trả groups dạng "[admin admin_finance]" hoặc "admin,admin_finance"
  return raw.replace(/[[\]]/g, '').split(/[\s,]+/).filter(Boolean);
};

/**
 * CHỈ DÙNG KHI DEV LOCAL. Danh tính đọc từ header:
 *   x-dev-user: <userId>   x-dev-email: <email>   x-dev-groups: admin,admin_finance
 */
export class LocalAuthProvider implements AuthProvider {
  authenticate(event: APIGatewayProxyEventV2): Principal | undefined {
    const userId = event.headers['x-dev-user'];
    if (!userId) return undefined;
    return { userId, email: event.headers['x-dev-email'], groups: splitGroups(event.headers['x-dev-groups']) };
  }
}

/**
 * Tên group trong user pool ReLoop-user-pool → nhóm quyền trong code.
 * "Owners" / "Partners" không dùng để phân quyền: vai trò nghiệp vụ lấy từ hồ sơ DynamoDB (D11).
 */
export const COGNITO_GROUP_MAP: Record<string, AdminGroup> = { Admins: 'admin', FinanceAdmins: 'admin_finance' };

/** API Gateway HTTP API đã kiểm tra JWT; Lambda chỉ đọc claims đã được xác thực. */
export class CognitoAuthProvider implements AuthProvider {
  authenticate(event: APIGatewayProxyEventV2): Principal | undefined {
    const claims = (event.requestContext as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } }).authorizer
      ?.jwt?.claims;
    const sub = claims?.sub;
    if (typeof sub !== 'string') return undefined;
    return {
      userId: sub,
      email: typeof claims?.email === 'string' ? claims.email : undefined,
      groups: splitGroups(claims?.['cognito:groups']).flatMap((g) => (COGNITO_GROUP_MAP[g] ? [COGNITO_GROUP_MAP[g]] : [])),
    };
  }
}

export const requireGroup = (principal: Principal, group: AdminGroup): void => {
  if (!principal.groups.includes(group)) throw forbidden();
};
