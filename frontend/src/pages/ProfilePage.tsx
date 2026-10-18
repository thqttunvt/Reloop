import { useEffect, useState } from 'react';
import { api, type Profile, type SavedLocation } from '../lib/api';
import { errorText } from '../lib/format';

export function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    const p = await api<Profile>('GET', '/me');
    setProfile(p);
    setFullName(p.fullName ?? '');
    setPhone(p.phone ?? '');
  };

  useEffect(() => {
    load().catch((e) => setMessage(errorText(e)));
  }, []);

  const save = async () => {
    try {
      setProfile(await api<Profile>('PATCH', '/me', { body: { fullName, phone } }));
      setMessage('Đã lưu');
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  if (!profile) return <p className="muted">{message || 'Đang tải…'}</p>;

  return (
    <div className="stack">
    <section className="card">
      <h2>Hồ sơ</h2>
      <label>
        Họ tên
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </label>
      <label>
        Số điện thoại (không bắt buộc — khi bạn là đối tác, số này hiện cùng email liên hệ để khách gọi khi email chưa được phản hồi)
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0901234567" />
      </label>
      <div className="row">
        <button onClick={save}>Lưu</button>
      </div>
      {message && <p className="muted">{message}</p>}
    </section>
    <SavedLocations />
    </div>
  );
}

/** Địa điểm đã lưu (T2.1). Thêm địa điểm mới khi đăng tin (ô "Lưu địa điểm này"). */
export function SavedLocations() {
  const [items, setItems] = useState<SavedLocation[]>([]);
  const [error, setError] = useState('');
  const load = () =>
    api<{ items: SavedLocation[] }>('GET', '/locations')
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);
  const run = (p: Promise<unknown>) => p.then(load).catch((e) => setError(errorText(e)));

  return (
    <section className="card">
      <h2>Địa điểm đã lưu</h2>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">Chưa có. Khi đăng tin, tích "Lưu địa điểm này" để dùng lại lần sau.</p>}
      {items.map((l) => (
        <div key={l.locationId} className="row between">
          <div>
            <strong>{l.name}</strong> {l.isDefault && <span className="badge ok">Mặc định</span>}
            <div className="muted">
              {l.location.address} · {l.area}
            </div>
          </div>
          <div className="row">
            {!l.isDefault && (
              <button className="secondary" onClick={() => void run(api('PATCH', `/locations/${l.locationId}`, { body: { isDefault: true } }))}>
                Đặt mặc định
              </button>
            )}
            <button className="danger" onClick={() => void run(api('DELETE', `/locations/${l.locationId}`))}>
              Xóa
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
