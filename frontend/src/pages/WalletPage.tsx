import { useEffect, useState } from 'react';
import { api, type LedgerLine, type Wallet } from '../lib/api';
import { JOURNAL_LABEL, dateTime, errorText, vnd } from '../lib/format';

/** Ví chỉ để xem. Nạp / rút tiền qua ngân hàng đã tạm bỏ (2026-10-16). */
export function WalletPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<LedgerLine[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api<Wallet>('GET', '/wallet'), api<{ items: LedgerLine[] }>('GET', '/wallet/ledger')])
      .then(([w, l]) => {
        setWallet(w);
        setLedger(l.items);
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Ví của tôi</h2>
        <div className="tiles">
          <div className="tile">
            <span className="muted">Khả dụng</span>
            <strong>{wallet ? vnd(wallet.balances.available) : '…'}</strong>
          </div>
          <div className="tile">
            <span className="muted">Đang giữ cho giao dịch</span>
            <strong>{wallet ? vnd(wallet.balances.held) : '…'}</strong>
          </div>
        </div>
        <p className="muted">Nạp và rút tiền qua ngân hàng hiện chưa mở.</p>
      </section>
      <section className="card">
        <h2>Lịch sử</h2>
        {ledger.length === 0 ? (
          <p className="muted">Chưa có giao dịch.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Loại</th>
                <th className="num">Khả dụng</th>
                <th className="num">Đang giữ</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.journalId}>
                  <td>{dateTime(l.at)}</td>
                  <td>{JOURNAL_LABEL[l.type] ?? l.type}</td>
                  <td className={`num ${l.delta.available > 0 ? 'pos' : l.delta.available < 0 ? 'neg' : ''}`}>{vnd(l.delta.available)}</td>
                  <td className="num">{vnd(l.delta.held)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
