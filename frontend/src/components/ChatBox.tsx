import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, newIdempotencyKey, type ChatMessage, type Conversation } from '../lib/api';
import { dateTime, errorText, vnd } from '../lib/format';

/**
 * Khung chat dùng chung (trang Tin nhắn và cột phải của Chợ). Polling 5 giây/lần khi tab đang mở.
 * Ra giá trong chat (QĐ-38): bên kia bấm Chấp nhận → tạo giao dịch (tin đang mở) hoặc đổi giá (đang giao dịch).
 */
export function ChatBox({ conversationId, userId, onLoaded }: { conversationId: string; userId: string; onLoaded?: (c: Conversation) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [open, setOpen] = useState(true);
  const [transactionId, setTransactionId] = useState<string>();
  const [text, setText] = useState('');
  const [price, setPrice] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const lastAt = useRef<string | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const poll = useCallback(async () => {
    try {
      const q = lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : '';
      const r = await api<{ conversation: Conversation; open: boolean; transactionId?: string; items: ChatMessage[] }>(
        'GET',
        `/conversations/${conversationId}/messages${q}`,
      );
      onLoadedRef.current?.(r.conversation);
      setConv(r.conversation);
      setOpen(r.open);
      setTransactionId(r.transactionId);
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

  const run = async (fn: () => Promise<unknown>) => {
    setSending(true);
    try {
      await fn();
      await poll();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void run(async () => {
      await api('POST', `/conversations/${conversationId}/messages`, { body: { text: text.trim() } });
      setText('');
    });
  };

  // Ô ra giá nhập theo nghìn đồng: 50 → 50.000đ, 1000 → 1.000.000đ
  const priceVnd = Math.round(Number(price) || 0) * 1000;

  const offer = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('POST', `/conversations/${conversationId}/offers`, { body: { price: priceVnd } });
      setPrice('');
    });
  };

  const respond = (offerId: string, accept: boolean) =>
    run(() =>
      api('POST', `/conversations/${conversationId}/offers/${offerId}/${accept ? 'accept' : 'reject'}`, {
        idempotencyKey: accept ? newIdempotencyKey() : undefined,
      }),
    );

  const pending = conv?.pendingOffer;

  return (
    <div className="chat">
      {transactionId && (
        <div className="notice ok-note">
          Hai bên đang giao dịch tin này. <Link to={`/transactions/${transactionId}`}>Xem giao dịch →</Link>
        </div>
      )}
      <div className="messages" ref={list}>
        {messages.length === 0 && <p className="muted">Hãy gửi lời chào, hỏi về thiết bị, rồi ra giá khi đã thống nhất.</p>}
        {messages.map((m) =>
          m.kind === 'SYSTEM' ? (
            <div key={m.messageId} className="chat-system">
              {m.text} · {dateTime(m.at)}
            </div>
          ) : m.kind === 'OFFER' ? (
            <div key={m.messageId} className={`bubble offer ${m.senderId === userId ? 'mine' : ''}`}>
              <span className="small">{m.senderId === userId ? 'Bạn ra giá' : m.senderRole === 'OWNER' ? 'Người bán ra giá' : 'Người mua ra giá'}</span>
              <strong className="offer-price">{vnd(m.price ?? 0)}</strong>
              {pending?.offerId === m.offerId ? (
                m.senderId === userId ? (
                  <span className="small">Đang chờ bên kia trả lời…</span>
                ) : (
                  open && (
                    <span className="row">
                      <button disabled={sending} onClick={() => void respond(m.offerId!, true)}>
                        Chấp nhận
                      </button>
                      <button className="secondary" disabled={sending} onClick={() => void respond(m.offerId!, false)}>
                        Từ chối
                      </button>
                    </span>
                  )
                )
              ) : (
                <span className="small">Đã trả lời / được thay bằng giá mới</span>
              )}
              <span className="time">{dateTime(m.at)}</span>
            </div>
          ) : (
            <div key={m.messageId} className={`bubble ${m.senderId === userId ? 'mine' : ''}`}>
              <span>{m.text}</span>
              <span className="time">{dateTime(m.at)}</span>
            </div>
          ),
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {open ? (
        <>
          <form className="row" onSubmit={send}>
            <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nhập tin nhắn…" maxLength={1000} />
            <button type="submit" disabled={sending || !text.trim()}>
              Gửi
            </button>
          </form>
          <form className="row" onSubmit={offer}>
            <input
              className="grow"
              type="number"
              min={1}
              step={1}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={transactionId ? 'Giá mới (nghìn đồng), vd 200' : 'Ra giá (nghìn đồng), vd 200'}
            />
            <button type="submit" className="secondary" disabled={sending || priceVnd < 1000}>
              {transactionId ? 'Đề nghị giá mới' : 'Ra giá'}
            </button>
          </form>
          {priceVnd >= 1000 && <p className="small muted">= {vnd(priceVnd)}</p>}
          <div className="row">
            {[50_000, 100_000, 200_000, 1_000_000, 2_000_000].map((v) => (
              <button key={v} type="button" className="secondary" onClick={() => setPrice(String(v / 1000))}>
                {v.toLocaleString('vi-VN')}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">Tin đã có người chốt hoặc đã kết thúc — cuộc trò chuyện chỉ còn để xem lại.</p>
      )}
    </div>
  );
}
