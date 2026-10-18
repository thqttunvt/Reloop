import { useState } from 'react';
import { api } from '../lib/api';
import { errorText } from '../lib/format';

/** Báo cáo vi phạm (giaiphap C13). */
export function ReportButton({ targetType, targetId }: { targetType: 'LISTING' | 'PARTNER' | 'REVIEW' | 'TRANSACTION'; targetId: string }) {
  const [msg, setMsg] = useState('');
  const report = async () => {
    const reason = prompt('Mô tả vi phạm (ít nhất 5 ký tự):');
    if (!reason) return;
    try {
      await api('POST', '/reports', { body: { targetType, targetId, reason } });
      setMsg('Đã gửi báo cáo cho Admin.');
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <span className="row">
      <button className="link" onClick={() => void report()}>
        ⚑ Báo cáo vi phạm
      </button>
      {msg && <span className="muted">{msg}</span>}
    </span>
  );
}
