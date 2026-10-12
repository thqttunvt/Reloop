import { useCallback, useEffect, useState } from 'react';
import { api, type BankAccount, type Bucket, type Withdrawal } from '../lib/api';
import { dateTime, errorText, vnd } from '../lib/format';

interface Reconciliation {
  invariant: { ok: boolean; walletTotal: number; bankBalance: number; totals: Record<Bucket, number> };
  revenue: number;
  openItems: { reconId: string; reason: string; direction: string; amount: number; content: string; at: string }[];
}

export function AdminPage({ groups }: { groups: string[] }) {
  const isAdmin = groups.includes('admin');
  const isFinance = groups.includes('admin_finance');
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    try {
      if (isAdmin) setAccounts((await api<{ items: BankAccount[] }>('GET', '/admin/bank-accounts')).items);
      if (isFinance) {
        const [req, proc] = await Promise.all([
          api<{ items: Withdrawal[] }>('GET', '/admin/withdrawals?status=REQUESTED'),
          api<{ items: Withdrawal[] }>('GET', '/admin/withdrawals?status=PROCESSING'),
        ]);
        setWithdrawals([...req.items, ...proc.items]);
        setRecon(await api<Reconciliation>('GET', '/admin/reconciliation'));
      }
    } catch (e) {
      setMessage(errorText(e));
    }
  }, [isAdmin, isFinance]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMessage('');
      await refresh();
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  return (
    <div className="stack">
      {message && <p className="error">{message}</p>}

      {isFinance && recon && (
        <section className="card">
          <h2>Đối soát</h2>
          <p>
            <span className={`badge ${recon.invariant.ok ? 'ok' : 'bad'}`}>{recon.invariant.ok ? 'KHỚP' : 'LỆCH'}</span> Tổng ví{' '}
            <b>{vnd(recon.invariant.walletTotal)}</b> · Tiền trong TK ReLoop <b>{vnd(recon.invariant.bankBalance)}</b> · Chưa
            gắn được <b>{vnd(recon.invariant.totals.unallocated)}</b>
          </p>
          <p>
            Doanh thu ReLoop (hoa hồng + phí đăng bài): <b>{vnd(recon.revenue)}</b>
          </p>
          {recon.openItems.map((r) => (
            <p key={r.reconId} className="muted">
              {dateTime(r.at)} · {r.direction} {vnd(r.amount)} · “{r.content}” — {r.reason}
            </p>
          ))}
        </section>
      )}

      {isAdmin && (
        <section className="card">
          <h2>Tài khoản ngân hàng chờ xác minh</h2>
          {accounts.length === 0 && <p className="muted">Không có.</p>}
          {accounts.map((a) => (
            <div key={a.accountId} className="row between">
              <span>
                <b>{a.accountName}</b> · {a.accountNo} (BIN {a.bankBin}) · hồ sơ: {a.registeredName ?? '—'}{' '}
                <span className={`badge ${a.nameMatches ? 'ok' : 'bad'}`}>{a.nameMatches ? 'Tên khớp' : 'Tên KHÔNG khớp'}</span>
              </span>
              <span className="row">
                <button onClick={() => run(() => api('POST', `/admin/users/${a.userId}/bank-accounts/${a.accountId}/review`, { body: { approve: true } }))}>
                  Duyệt
                </button>
                <button
                  className="secondary"
                  onClick={() => run(() => api('POST', `/admin/users/${a.userId}/bank-accounts/${a.accountId}/review`, { body: { approve: false } }))}
                >
                  Từ chối
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      {isFinance && (
        <section className="card">
          <h2>Lệnh rút cần chuyển (cam kết 24 giờ)</h2>
          {withdrawals.length === 0 && <p className="muted">Không có.</p>}
          {withdrawals.map((w) => (
            <div key={w.withdrawalId} className="qr">
              {w.transferQrImageUrl && <img src={w.transferQrImageUrl} alt="QR chuyển tiền" width={160} height={160} />}
              <div className="stack">
                <span>
                  {vnd(w.amount)} → <b>{w.destination.accountName}</b> · {w.destination.accountNo} · nội dung{' '}
                  <b className="code">{w.code}</b> <span className="badge">{w.status}</span>
                </span>
                <span className="muted">Tạo lúc {dateTime(w.createdAt)} · user {w.userId}</span>
                <span className="row">
                  {w.status === 'REQUESTED' && (
                    <button onClick={() => run(() => api('POST', `/admin/users/${w.userId}/withdrawals/${w.withdrawalId}/processing`))}>
                      Đang chuyển
                    </button>
                  )}
                  <button
                    className="secondary"
                    onClick={() =>
                      run(() => api('POST', '/dev/bank-events', { body: { direction: 'OUT', amount: w.amount, content: `${w.code} rut tien` } }))
                    }
                  >
                    Giả lập ngân hàng báo tiền ra (dev)
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      const reason = prompt('Lý do thất bại?');
                      if (reason) void run(() => api('POST', `/admin/users/${w.userId}/withdrawals/${w.withdrawalId}/fail`, { body: { reason } }));
                    }}
                  >
                    Thất bại
                  </button>
                </span>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
