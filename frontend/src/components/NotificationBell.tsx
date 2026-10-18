import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Notification } from '../lib/api';
import { dateTime } from '../lib/format';

/** Chuông thông báo: polling số chưa đọc 30 giây/lần khi tab đang hiển thị (giaiphap E8). */
export function NotificationBell() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);

  const poll = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    api<{ count: number }>('GET', '/notifications/unread-count')
      .then((r) => setCount(r.count))
      .catch(() => undefined);
  }, []);

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
    if (!open) setItems((await api<{ items: Notification[] }>('GET', '/notifications')).items);
    setOpen(!open);
  };

  const go = async (n: Notification) => {
    setOpen(false);
    if (!n.read) {
      await api('POST', `/notifications/${n.notificationId}/read`).catch(() => undefined);
      setCount((c) => Math.max(0, c - 1));
    }
    if (n.link) navigate(n.link);
  };

  const readAll = async () => {
    await api('POST', '/notifications/read-all');
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
            <button key={n.notificationId} className={`note ${n.read ? '' : 'unread'}`} onClick={() => void go(n)}>
              <strong>{n.title}</strong>
              {n.body && <span>{n.body}</span>}
              <span className="muted">{dateTime(n.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
