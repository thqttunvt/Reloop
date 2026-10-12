import { useEffect, useState } from 'react';
import { api, type Profile } from '../lib/api';
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

  const verifyPhone = async () => {
    try {
      // TODO: thay bằng OTP thật (T1.4). Bản dev xác minh ngay.
      setProfile(await api<Profile>('POST', '/dev/verify-phone'));
      setMessage('Đã xác minh số điện thoại (dev)');
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  if (!profile) return <p className="muted">{message || 'Đang tải…'}</p>;

  return (
    <section className="card">
      <h2>Hồ sơ</h2>
      <label>
        Họ tên (phải trùng tên chủ tài khoản ngân hàng khi rút tiền)
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </label>
      <label>
        Số điện thoại
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0901234567" />
      </label>
      <div className="row">
        <button onClick={save}>Lưu</button>
        {profile.phone && !profile.phoneVerified && (
          <button className="secondary" onClick={verifyPhone}>
            Xác minh SĐT (dev)
          </button>
        )}
        <span className={profile.phoneVerified ? 'badge ok' : 'badge warn'}>
          {profile.phoneVerified ? 'SĐT đã xác minh' : 'SĐT chưa xác minh'}
        </span>
      </div>
      {message && <p className="muted">{message}</p>}
    </section>
  );
}
