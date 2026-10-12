import { useCallback, useEffect, useState } from 'react';
import {
  api,
  newIdempotencyKey,
  type BankAccount,
  type LedgerLine,
  type PaymentInstruction,
  type TopUp,
  type Wallet,
  type Withdrawal,
} from '../lib/api';
import { JOURNAL_LABEL, dateTime, errorText, vnd } from '../lib/format';

export function WalletPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<LedgerLine[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [w, l, a, wd] = await Promise.all([
        api<Wallet>('GET', '/wallet'),
        api<{ items: LedgerLine[] }>('GET', '/wallet/ledger'),
        api<{ items: BankAccount[] }>('GET', '/bank-accounts'),
        api<{ items: Withdrawal[] }>('GET', '/wallet/withdrawals'),
      ]);
      setWallet(w);
      setLedger(l.items);
      setAccounts(a.items);
      setWithdrawals(wd.items);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Ví của tôi</h2>
        <div className="tiles">
          <Tile label="Khả dụng" value={wallet?.balances.available} hint="Dùng để thanh toán hoặc rút" />
          <Tile label="Đang giữ" value={wallet?.balances.held} hint="Đã trả cho giao dịch chưa hoàn tất" />
          <Tile label="Đang rút" value={wallet?.balances.withdrawing} hint="Chờ Admin chuyển khoản" />
        </div>
      </section>
      <TopUpCard onCredited={refresh} />
      <WithdrawCard accounts={accounts} withdrawals={withdrawals} onChange={refresh} />
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
                <th className="num">Đang rút</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.journalId}>
                  <td>{dateTime(l.at)}</td>
                  <td>{JOURNAL_LABEL[l.type] ?? l.type}</td>
                  <Delta n={l.delta.available} />
                  <Delta n={l.delta.held} />
                  <Delta n={l.delta.withdrawing} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value?: number; hint: string }) {
  return (
    <div className="tile">
      <span className="muted">{label}</span>
      <strong>{value === undefined ? '…' : vnd(value)}</strong>
      <small className="muted">{hint}</small>
    </div>
  );
}

function Delta({ n }: { n: number }) {
  if (!n) return <td className="num muted">—</td>;
  return <td className={`num ${n > 0 ? 'pos' : 'neg'}`}>{`${n > 0 ? '+' : ''}${vnd(n)}`}</td>;
}

function TopUpCard({ onCredited }: { onCredited: () => Promise<void> }) {
  const [amount, setAmount] = useState(100_000);
  const [pending, setPending] = useState<{ topUp: TopUp; payment: PaymentInstruction } | null>(null);
  const [message, setMessage] = useState('');

  // Chờ webhook ngân hàng: hỏi lại trạng thái lệnh nạp mỗi 3 giây.
  useEffect(() => {
    if (!pending || pending.topUp.status === 'CREDITED') return;
    const timer = setInterval(async () => {
      try {
        const r = await api<{ topUp: TopUp; payment: PaymentInstruction }>('GET', `/wallet/topups/${pending.topUp.topUpId}`);
        if (r.topUp.status === 'CREDITED') {
          setPending(r);
          setMessage(`Đã nhận ${vnd(r.topUp.creditedAmount ?? r.topUp.amount)} vào ví`);
          await onCredited();
        }
      } catch {
        // thử lại ở lần sau
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [pending, onCredited]);

  const create = async () => {
    try {
      setMessage('');
      setPending(await api('POST', '/wallet/topups', { body: { amount }, idempotencyKey: newIdempotencyKey() }));
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  const simulateTransfer = async () => {
    if (!pending) return;
    try {
      await api('POST', '/dev/bank-events', {
        body: { direction: 'IN', amount: pending.payment.amount, content: `CK ${pending.payment.content}` },
      });
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  return (
    <section className="card">
      <h2>Nạp tiền</h2>
      <div className="row">
        <input type="number" min={10000} step={10000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        <button onClick={create}>Tạo mã QR</button>
      </div>
      {pending && pending.topUp.status !== 'CREDITED' && (
        <div className="qr">
          <img src={pending.payment.qrImageUrl} alt="VietQR" width={220} height={220} />
          <div className="stack">
            <span>
              Ngân hàng (BIN): <b>{pending.payment.bankBin}</b>
            </span>
            <span>
              Số TK: <b>{pending.payment.accountNo}</b> — {pending.payment.accountName}
            </span>
            <span>
              Số tiền: <b>{vnd(pending.payment.amount)}</b>
            </span>
            <span>
              Nội dung CK (bắt buộc): <b className="code">{pending.payment.content}</b>
            </span>
            <span className="muted">Hết hạn: {dateTime(pending.topUp.expiresAt)} · Đang chờ tiền về…</span>
            <button className="secondary" onClick={simulateTransfer}>
              Giả lập ngân hàng báo tiền vào (dev)
            </button>
          </div>
        </div>
      )}
      {message && <p className="muted">{message}</p>}
    </section>
  );
}

function WithdrawCard({
  accounts,
  withdrawals,
  onChange,
}: {
  accounts: BankAccount[];
  withdrawals: Withdrawal[];
  onChange: () => Promise<void>;
}) {
  const verified = accounts.filter((a) => a.status === 'VERIFIED');
  const [form, setForm] = useState({ bankBin: '970422', accountNo: '', accountName: '' });
  const [amount, setAmount] = useState(50_000);
  const [accountId, setAccountId] = useState('');
  const [message, setMessage] = useState('');

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMessage(ok);
      await onChange();
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  return (
    <section className="card">
      <h2>Rút tiền</h2>
      <h3>Tài khoản nhận</h3>
      {accounts.length === 0 && <p className="muted">Chưa có tài khoản. Tên chủ TK phải trùng tên trong hồ sơ.</p>}
      <ul className="plain">
        {accounts.map((a) => (
          <li key={a.accountId}>
            {a.accountNo} — {a.accountName} <span className={`badge ${a.status === 'VERIFIED' ? 'ok' : 'warn'}`}>{a.status}</span>
          </li>
        ))}
      </ul>
      <div className="row">
        <input value={form.bankBin} onChange={(e) => setForm({ ...form, bankBin: e.target.value })} placeholder="BIN" size={7} />
        <input value={form.accountNo} onChange={(e) => setForm({ ...form, accountNo: e.target.value })} placeholder="Số tài khoản" />
        <input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} placeholder="Tên chủ TK" />
        <button className="secondary" onClick={() => run(() => api('POST', '/bank-accounts', { body: form }), 'Đã gửi, chờ Admin xác minh')}>
          Thêm
        </button>
      </div>

      <h3>Tạo lệnh rút</h3>
      <div className="row">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">— chọn tài khoản đã xác minh —</option>
          {verified.map((a) => (
            <option key={a.accountId} value={a.accountId}>
              {a.accountNo} — {a.accountName}
            </option>
          ))}
        </select>
        <input type="number" min={50000} step={10000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        <button
          disabled={!accountId}
          onClick={() =>
            run(
              () => api('POST', '/wallet/withdrawals', { body: { amount, bankAccountId: accountId }, idempotencyKey: newIdempotencyKey() }),
              'Đã tạo lệnh rút — Admin xử lý trong 24 giờ',
            )
          }
        >
          Rút
        </button>
      </div>
      {withdrawals.length > 0 && (
        <ul className="plain">
          {withdrawals.map((w) => (
            <li key={w.withdrawalId}>
              {dateTime(w.createdAt)} · {vnd(w.amount)} → {w.destination.accountNo} <span className="badge">{w.status}</span>
              {w.failReason && <span className="muted"> ({w.failReason})</span>}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="muted">{message}</p>}
    </section>
  );
}
