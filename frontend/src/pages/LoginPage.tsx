import { useState } from 'react';
import { cognitoEnabled, startLogin } from '../lib/cognito';
import type { Session } from '../lib/session';

const dev = (userId: string, groups: string[] = []): Session => ({ kind: 'dev', userId, label: userId, groups });

const PRESETS: { label: string; session: Session }[] = [
  { label: 'Owner (người bán)', session: dev('owner1') },
  { label: 'Partner (đơn vị thu mua)', session: dev('partner1') },
  { label: 'Admin', session: dev('admin1', ['admin', 'admin_finance']) },
];

/** Cognito managed login khi có VITE_COGNITO_*; nếu không thì đăng nhập giả để dev local. */
export function LoginPage({ onSignIn, error }: { onSignIn: (s: Session) => void; error?: string }) {
  const [userId, setUserId] = useState('');

  if (cognitoEnabled) {
    return (
      <div className="landing">
        <section className="hero">
          <h1>ReLoop</h1>
          <p>Đồ điện tử cũ, hỏng không còn dùng? Đăng tin trong 1 phút, nhận báo giá từ các đơn vị thu mua, sửa chữa, tái chế trong bán kính 5 km.</p>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button onClick={() => void startLogin()}>Đăng nhập / Đăng ký</button>
          </div>
        </section>
        <section className="steps">
          <div className="card">
            <h3>1. Chụp ảnh & đăng tin</h3>
            <p className="muted">AI gợi ý loại thiết bị, hãng, tình trạng từ ảnh. Bạn kiểm tra lại rồi đăng.</p>
          </div>
          <div className="card">
            <h3>2. Nhận báo giá gần bạn</h3>
            <p className="muted">Hệ thống tìm đối tác đã xác minh trong 5 km và hiện giá dự kiến. Đối tác chỉ thấy khu vực, không thấy địa chỉ của bạn.</p>
          </div>
          <div className="card">
            <h3>3. Chọn đối tác & bàn giao</h3>
            <p className="muted">Hẹn lịch, gặp mặt, thanh toán trực tiếp; hai bên xác nhận hoàn tất và đánh giá nhau.</p>
          </div>
          <div className="card">
            <h3>Bạn là đơn vị thu mua?</h3>
            <p className="muted">Đăng ký đối tác (cần giấy phép kinh doanh), khai chi nhánh và bảng giá để nhận tin phù hợp.</p>
          </div>
        </section>
        <p className="muted center-text">Dự án thực tập AWS Cloud Engineering.</p>
      </div>
    );
  }

  return (
    <div className="center">
      <div className="card narrow">
        <h1>ReLoop</h1>
        <p className="muted">Chế độ dev local — chọn người dùng để đăng nhập.</p>
        <div className="stack">
          {PRESETS.map((p) => (
            <button key={p.session.userId} onClick={() => onSignIn(p.session)}>
              {p.label} <span className="muted">({p.session.userId})</span>
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (userId.trim()) onSignIn(dev(userId.trim()));
          }}
        >
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="hoặc nhập userId khác" />
          <button type="submit">Vào</button>
        </form>
      </div>
    </div>
  );
}
