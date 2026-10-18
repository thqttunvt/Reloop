import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChatBox } from '../components/ChatBox';
import { ContactLine } from '../components/ContactLine';
import { api, type Conversation, type FeedItem, type ListingDetail } from '../lib/api';
import { CATEGORY_LABEL, CONDITION_LABEL, HANDOVER_LABEL, PARTNER_TIER_LABEL } from '../lib/catalog';
import { errorText, monthYear, timeAgo } from '../lib/format';

/**
 * Chợ — bảng tin kiểu Facebook: cột trái là các thẻ tin; bấm "Gửi tin nhắn" thì cột phải
 * hiện thông tin người bán + khung chat. Trên điện thoại, cột phải phủ toàn màn hình.
 */
export function FeedPage({ userId }: { userId: string }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<{ item: FeedItem; conversationId: string } | null>(null);

  const load = useCallback(async (after?: string) => {
    setLoading(true);
    try {
      const r = await api<{ items: FeedItem[]; nextCursor?: string }>('GET', `/feed${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
      setItems((xs) => (after ? [...xs, ...r.items] : r.items));
      setCursor(r.nextCursor);
      setError('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const message = async (item: FeedItem) => {
    try {
      const c = await api<Conversation>('POST', `/listings/${item.listing.listingId}/conversations`, { body: {} });
      setSelected({ item, conversationId: c.conversationId });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className={`feed-layout ${selected ? 'has-panel' : ''}`}>
      <div className="feed">
        <div className="row between">
          <h2>Chợ đồ điện tử cũ</h2>
          <Link to="/listings/new" className="button">
            + Đăng tin
          </Link>
        </div>
        {error && <p className="error">{error}</p>}
        {!loading && items.length === 0 && <p className="muted">Chưa có tin nào đang mở. Hãy là người đầu tiên đăng tin!</p>}
        {items.map((it) => (
          <FeedCard
            key={it.listing.listingId}
            item={it}
            active={selected?.item.listing.listingId === it.listing.listingId}
            onMessage={() => void message(it)}
          />
        ))}
        {cursor && (
          <button className="secondary" onClick={() => void load(cursor)} disabled={loading}>
            {loading ? 'Đang tải…' : 'Xem thêm'}
          </button>
        )}
      </div>
      {selected && (
        <SellerPanel key={selected.conversationId} item={selected.item} conversationId={selected.conversationId} userId={userId} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function FeedCard({ item, active, onMessage }: { item: FeedItem; active: boolean; onMessage: () => void }) {
  const l = item.listing;
  const [expanded, setExpanded] = useState(false);
  return (
    <article className={`post ${active ? 'active' : ''}`}>
      <header className="post-head">
        <span className="avatar">{item.seller.displayName.charAt(0).toUpperCase()}</span>
        <div>
          <strong>{item.seller.displayName}</strong>
          <div className="muted small">
            {timeAgo(l.createdAt)} · 📍 {l.area}
          </div>
        </div>
      </header>
      <h3 className="post-title">
        <Link to={`/listings/${l.listingId}`}>{l.title}</Link>
      </h3>
      <div className="muted small">
        {CATEGORY_LABEL[l.category]}
        {l.brand && ` · ${l.brand}`}
        {l.model && ` ${l.model}`} · {CONDITION_LABEL[l.condition]} · {l.unit === 'PER_DEVICE' ? `${l.quantity} cái` : `~${l.weightKg} kg`}
      </div>
      <p className={`post-text ${expanded ? '' : 'clamp'}`} onClick={() => setExpanded(true)}>
        {l.description}
      </p>
      {item.images.length > 0 && (
        <div className={`post-images n${Math.min(item.images.length, 3)}`}>
          {item.images.slice(0, 3).map((src, i) => (
            <a key={src} href={src} target="_blank" rel="noreferrer" className="post-img">
              <img src={src} alt="" loading="lazy" />
              {i === 2 && item.images.length > 3 && <span className="more">+{item.images.length - 3}</span>}
            </a>
          ))}
        </div>
      )}
      <footer className="post-actions">
        {item.isMine ? (
          <Link to={`/listings/${l.listingId}`} className="action">
            📋 Tin của bạn — xem báo giá
          </Link>
        ) : (
          <button className="action" onClick={onMessage}>
            💬 Gửi tin nhắn
          </button>
        )}
        <Link to={`/listings/${l.listingId}`} className="action">
          🔎 Xem chi tiết
        </Link>
      </footer>
    </article>
  );
}

function SellerPanel({ item, conversationId, userId, onClose }: { item: FeedItem; conversationId: string; userId: string; onClose: () => void }) {
  const l = item.listing;
  const [detail, setDetail] = useState<ListingDetail | null>(null);
  useEffect(() => {
    api<ListingDetail>('GET', `/listings/${l.listingId}`)
      .then(setDetail)
      .catch(() => undefined);
  }, [l.listingId]);
  const rep = detail?.sellerReputation;

  return (
    <aside className="seller-panel card">
      <div className="row between">
        <button className="link" onClick={onClose}>
          ← Quay lại
        </button>
        <Link to={`/chat/${conversationId}`} className="muted small">
          Mở toàn trang
        </Link>
      </div>
      <div className="seller">
        <span className="avatar big">{item.seller.displayName.charAt(0).toUpperCase()}</span>
        <div>
          <strong>{item.seller.displayName}</strong>
          <div className="muted small">
            {item.seller.memberSince && `Tham gia từ ${monthYear(item.seller.memberSince)}`}
          </div>
          <div className="muted small">
            {rep
              ? rep.averageRating === null
                ? `Chưa đủ đánh giá · ${rep.completedCount} giao dịch hoàn tất`
                : `${rep.averageRating}★ (${rep.reviewCount} đánh giá) · ${rep.completedCount} giao dịch hoàn tất`
              : '…'}
          </div>
          {item.seller.tier && <div className="muted small">{PARTNER_TIER_LABEL[item.seller.tier]}</div>}
          <ContactLine contact={item.seller.contact} />
        </div>
      </div>
      <div className="listing-mini">
        {item.images[0] && <img src={item.images[0]} alt="" />}
        <div>
          <Link to={`/listings/${l.listingId}`}>
            <strong>{l.title}</strong>
          </Link>
          <div className="muted small">
            📍 {l.area} · {l.handoverMethods.map((m) => HANDOVER_LABEL[m]).join(', ')}
          </div>
        </div>
      </div>
      <p className="muted small">Nhắn tin ở đây, hoặc gửi email / gọi điện theo liên hệ trên. Địa chỉ chính xác chỉ hiện khi hai bên đã tạo giao dịch.</p>
      <ChatBox conversationId={conversationId} userId={userId} />
    </aside>
  );
}
