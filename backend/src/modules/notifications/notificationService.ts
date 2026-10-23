import { log } from '../../http/log';
import type { Clock } from '../../shared/clock';
import { notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { keys } from '../../store/keys';
import { putVersioned, type Item, type Table } from '../../store/table';

export interface Notification extends Item {
  notificationId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  /** Đường dẫn trong web app, vd /listings/<id> */
  link?: string;
  read: boolean;
  createdAt: string;
  /** DynamoDB TTL (giây) — giữ 90 ngày (QĐ-27). */
  ttl: number;
}

const TTL_SECONDS = 90 * 24 * 3600;

/**
 * Hộp thư chung của Admin (mục 7 danhgia): mọi tài khoản trong nhóm Admins cùng xem, một người đọc = cả nhóm đã đọc
 * (tránh 2 người cùng xử lý một việc). userId thật là Cognito sub (UUID) nên không trùng tên này.
 */
export const ADMIN_INBOX = 'ADMINS';

export interface NotifyInput {
  type: string;
  title: string;
  body?: string;
  link?: string;
}

/** Thông báo lưu DynamoDB + frontend polling (T11.1–T11.3). */
export class NotificationService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
  ) {}

  /**
   * Ghi thông báo. Không nằm trong transaction nghiệp vụ: lỗi ghi thông báo không được làm hỏng
   * thao tác chính → chỉ log.
   */
  async notify(userIds: string | string[], input: NotifyInput): Promise<void> {
    const ids = [...new Set(Array.isArray(userIds) ? userIds : [userIds])];
    const now = this.clock.now();
    const at = now.toISOString();
    try {
      for (let i = 0; i < ids.length; i += 25) {
        await this.table.transact(
          ids.slice(i, i + 25).map((userId) => {
            const notificationId = newId();
            const item: Notification = {
              ...keys.notification(userId, at, notificationId),
              notificationId,
              userId,
              ...input,
              read: false,
              createdAt: at,
              ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
            };
            return putVersioned(item, 0);
          }),
        );
      }
    } catch (err) {
      log('error', 'notify_failed', { type: input.type, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Gửi vào hộp thư chung của Admin. */
  notifyAdmins(input: NotifyInput): Promise<void> {
    return this.notify(ADMIN_INBOX, input);
  }

  list(userId: string, limit = 50) {
    return this.table.query<Notification>(keys.notificationPk(userId), { skPrefix: 'NOTIF#', ascending: false, limit });
  }

  async unreadCount(userId: string) {
    return (await this.list(userId, 100)).filter((n) => !n.read).length;
  }

  /** at = createdAt của thông báo (web gửi kèm) → đọc thẳng theo khóa, kể cả thông báo cũ hơn 100 cái gần nhất. */
  async markRead(userId: string, notificationId: string, at?: string) {
    const k = at ? keys.notification(userId, at, notificationId) : undefined;
    const n = k ? await this.table.get<Notification>(k.pk, k.sk) : (await this.list(userId, 100)).find((x) => x.notificationId === notificationId);
    if (!n) throw notFound('thông báo');
    if (!n.read) await this.table.transact([putVersioned({ ...n, read: true }, n.version ?? 1)]);
    return { ...n, read: true };
  }

  async markAllRead(userId: string) {
    const unread = (await this.list(userId, 100)).filter((n) => !n.read);
    for (let i = 0; i < unread.length; i += 25) {
      await this.table.transact(unread.slice(i, i + 25).map((n) => putVersioned({ ...n, read: true }, n.version ?? 1)));
    }
    return { updated: unread.length };
  }
}
