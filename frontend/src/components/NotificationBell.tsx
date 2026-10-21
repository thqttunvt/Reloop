import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Notification } from '../lib/api';
import { dateTime } from '../lib/format';

/** Thông báo của tôi, hoặc của hộp thư chung Admin (tranh chấp mới… — mục 7 danhgia). */
type Item = Notification & { inbox: 'me' | 'admin' };
const BASE = { me: '/notifications', admin: '/admin/notifications' } as const;

/**
 * Chuông thông báo: polling số chưa đọc 30 giây/lần khi tab đang hiển thị (giaiphap E8).
 * Tài khoản Admin thấy thêm hộp thư chung của Admin (một Admin đọc = cả nhóm đã đọc).
 */
export function NotificationBell({ admin = false }: { admin?: boolean }) {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const inboxes = (admin ? ['me', 'admin'] : ['me']) as Item['inbox'][];

  const poll = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    Promise.all(inboxes.map((i) => api<{ count: number }>('GET', `${BASE[i]}/unread-count`).then((r) => r.count)))
      .then((counts) => setCount(counts.reduce((s, c) => s + c, 0)))
      .catch(() => undefined);
  }, [admin]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    poll();
    const timer = setInterval(poll, 30_000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [poll]);

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const toggle = async () => {
    if (!open) {
      const lists = await Promise.all(
        inboxes.map(async (inbox) => (await api<{ items: Notification[] }>('GET', BASE[inbox])).items.map((n) => ({ ...n, inbox }))),
      );
      setItems(lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
    setOpen(!open);
  };

  const go = async (n: Item) => {
    setOpen(false);
    if (!n.read) {
      await api('POST', `${BASE[n.inbox]}/${n.notificationId}/read`).catch(() => undefined);
      setCount((c) => Math.max(0, c - 1));
    }
    if (n.link) navigate(n.link);
  };

  const readAll = async () => {
    await Promise.all(inboxes.map((i) => api('POST', `${BASE[i]}/read-all`)));
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
    setCount(0);
  };

  return (
    <div className="bell" ref={box}>
      <button className="secondary" onClick={() => void toggle()} aria-label="Thông báo">
        🔔{count > 0 && <span className="dot">{count}</span>}
      </button>
      {open && (
        <div className="dropdown">
          <div className="row between">
            <strong>Thông báo</strong>
            {count > 0 && (
              <button className="link" onClick={() => void readAll()}>
                Đánh dấu đã đọc hết
              </button>
            )}
          </div>
          {items.length === 0 && <p className="muted">Chưa có thông báo.</p>}
          {items.map((n) => (
            <button key={`${n.inbox}-${n.notificationId}`} className={`note ${n.read ? '' : 'unread'}`} onClick={() => void go(n)}>
              <strong>
                {n.inbox === 'admin' && <span className="badge warn">Admin</span>} {n.title}
              </strong>
              {n.body && <span>{n.body}</span>}
              <span className="muted">{dateTime(n.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
