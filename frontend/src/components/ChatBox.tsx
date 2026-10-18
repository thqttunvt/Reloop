import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ChatMessage, type Conversation } from '../lib/api';
import { dateTime, errorText } from '../lib/format';

/** Khung chat dùng chung (trang Tin nhắn và cột phải của Chợ). Polling 5 giây/lần khi tab đang mở. */
export function ChatBox({ conversationId, userId, onLoaded }: { conversationId: string; userId: string; onLoaded?: (c: Conversation) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const lastAt = useRef<string | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const poll = useCallback(async () => {
    try {
      const q = lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : '';
      const r = await api<{ conversation: Conversation; open: boolean; items: ChatMessage[] }>('GET', `/conversations/${conversationId}/messages${q}`);
      onLoadedRef.current?.(r.conversation);
      setOpen(r.open);
      if (r.items.length) {
        lastAt.current = r.items[r.items.length - 1]!.at;
        setMessages((ms) => {
          const seen = new Set(ms.map((m) => m.messageId));
          return [...ms, ...r.items.filter((m) => !seen.has(m.messageId))];
        });
        await api('POST', `/conversations/${conversationId}/read`).catch(() => undefined);
      }
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, [conversationId]);

  useEffect(() => {
    lastAt.current = undefined;
    setMessages([]);
    void poll();
    const timer = setInterval(() => document.visibilityState === 'visible' && void poll(), 5000);
    return () => clearInterval(timer);
  }, [poll]);

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await api('POST', `/conversations/${conversationId}/messages`, { body: { text: text.trim() } });
      setText('');
      await poll();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat">
      <div className="messages" ref={list}>
        {messages.length === 0 && <p className="muted">Hãy gửi lời chào và câu hỏi về thiết bị.</p>}
        {messages.map((m) => (
          <div key={m.messageId} className={`bubble ${m.senderId === userId ? 'mine' : ''}`}>
            <span>{m.text}</span>
            <span className="time">{dateTime(m.at)}</span>
          </div>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {open ? (
        <form className="row" onSubmit={send}>
          <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nhập tin nhắn…" maxLength={1000} />
          <button type="submit" disabled={sending || !text.trim()}>
            Gửi
          </button>
        </form>
      ) : (
        <p className="muted">Tin đã kết thúc — cuộc trò chuyện chỉ còn để xem lại.</p>
      )}
    </div>
  );
}
