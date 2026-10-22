import { useState } from 'react';
import { api } from '../lib/api';
import { errorText } from '../lib/format';

/** Phản ánh vi phạm (giaiphap C13; đổi chữ "Báo cáo" → "Phản ánh" — get.md B3). */
export function ReportButton({ targetType, targetId }: { targetType: 'LISTING' | 'PARTNER' | 'REVIEW' | 'TRANSACTION'; targetId: string }) {
  const [msg, setMsg] = useState('');
  const report = async () => {
    const reason = prompt('Mô tả vi phạm (ít nhất 5 ký tự):');
    if (!reason) return;
    try {
      await api('POST', '/reports', { body: { targetType, targetId, reason } });
      setMsg('Đã gửi phản ánh cho Admin.');
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <span className="row">
      <button className="link" onClick={() => void report()}>
        ⚑ Phản ánh vi phạm
      </button>
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}
