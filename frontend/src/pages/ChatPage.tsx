import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChatBox } from '../components/ChatBox';
import { api, type Conversation } from '../lib/api';
import { dateTime, errorText } from '../lib/format';

/** Danh sách cuộc trò chuyện, mới nhất trước. */
export function ConversationsPage() {
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: Conversation[] }>('GET', '/conversations')
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <section className="card">
      <h2>Tin nhắn</h2>
      {error && <p className="error">{error}</p>}
      {items === null ? (
        <p className="muted">Đang tải…</p>
      ) : items.length === 0 ? (
        <p className="muted">
          Chưa có cuộc trò chuyện. Vào <Link to="/feed">Chợ</Link> và bấm "Gửi tin nhắn" ở một tin để hỏi người bán.
        </p>
      ) : (
        <ul className="plain list">
          {items.map((c) => (
            <li key={c.conversationId}>
              <Link to={`/chat/${c.conversationId}`} className="list-item">
                <div>
                  <strong>{c.myRole === 'OWNER' ? c.partnerName : 'Người bán'}</strong> · <span className="muted">{c.listingTitle}</span>
                  <div className="muted">{c.lastMessage ?? 'Chưa có tin nhắn'}</div>
                </div>
                <div className="stack end">
                  {c.myUnread > 0 && <span className="badge bad">{c.myUnread} mới</span>}
                  <span className="muted">{dateTime(c.lastMessageAt ?? c.createdAt)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Một cuộc trò chuyện (toàn trang). */
export function ChatPage({ userId }: { userId: string }) {
  const { id } = useParams();
  const [conv, setConv] = useState<Conversation | null>(null);
  const iAmOwner = conv?.ownerId === userId;

  return (
    <section className="card stack">
      <div className="row between">
        <div>
          <h2>{conv ? (iAmOwner ? conv.partnerName : 'Người bán') : 'Tin nhắn'}</h2>
          {conv && (
            <Link to={`/listings/${conv.listingId}`} className="muted">
              Về tin: {conv.listingTitle}
            </Link>
          )}
        </div>
        <Link to="/chat">← Tất cả tin nhắn</Link>
      </div>
      {id && <ChatBox conversationId={id} userId={userId} onLoaded={setConv} />}
    </section>
  );
}
