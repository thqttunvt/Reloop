import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PagedTable, usePagedList, type Page } from '../../components/PagedTable';
import { api, type AdminUserDetail, type UserRow } from '../../lib/api';
import { LISTING_STATUS_LABEL, PARTNER_STATUS_LABEL, PARTNER_TIER_LABEL, TX_STATUS_LABEL, statusTone, tierOf } from '../../lib/catalog';
import { dateTime, errorText, vnd } from '../../lib/format';
import { partnerLabel } from '../../lib/role';

// ---------------------------------------------------------------- Danh sách + tìm email (A2)

export function MembersPage() {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<UserRow[]>();
  const [error, setError] = useState('');
  const fetchPage = useCallback((cursor?: string) => api<Page<UserRow>>('GET', `/admin/users${cursor ? `?cursor=${cursor}` : ''}`), []);
  const list = usePagedList(fetchPage);
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setFound((await api<{ items: UserRow[] }>('GET', `/admin/users?email=${encodeURIComponent(query.trim())}`)).items);
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  };
  const columns = [
    { header: 'Email', cell: (u: UserRow) => <Link to={`/admin/users/${encodeURIComponent(u.userId)}`}>{u.email ?? u.userId}</Link> },
    { header: 'Họ tên', cell: (u: UserRow) => u.fullName ?? '' },
    { header: 'SĐT', cell: (u: UserRow) => u.phone ?? '' },
    { header: 'Tham gia', cell: (u: UserRow) => (u.createdAt ? dateTime(u.createdAt) : '') },
  ];

  return (
    <section className="card stack">
      <h2>Thành viên</h2>
      <form className="row" onSubmit={search}>
        <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm theo email (ít nhất 3 ký tự)" />
        <button type="submit" disabled={query.trim().length < 3}>
          Tìm
        </button>
        {found && (
          <button type="button" className="secondary" onClick={() => setFound(undefined)}>
            Xem tất cả
          </button>
        )}
      </form>
      {error && <p className="error">{error}</p>}
      {found ? (
        found.length === 0 ? (
          <p className="muted">Không tìm thấy.</p>
        ) : (
          <table>
            <tbody>
              {found.map((u) => (
                <tr key={u.userId}>
                  {columns.map((c) => (
                    <td key={c.header}>{c.cell(u)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <>
          <p className="muted small">Thứ tự không theo ngày đăng ký.</p>
          <PagedTable list={list} rowKey={(u) => u.userId} columns={columns} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- Hồ sơ gộp 1 người (A2)

const More = ({ hasMore }: { hasMore: boolean }) => (hasMore ? <p className="muted small">… còn nữa (chỉ hiện các dòng gần nhất)</p> : null);

export function MemberDetailPage() {
  const { id = '' } = useParams();
  const [d, setD] = useState<AdminUserDetail>();
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<AdminUserDetail>('GET', `/admin/users/${encodeURIComponent(id)}`)
      .then((x) => (setD(x), setError('')))
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(load, [load]);

  const suspend = async (on: boolean) => {
    const note = on ? prompt('Lý do tạm ngừng (gửi cho người bị tạm ngừng, ít nhất 5 ký tự):') : '';
    if (on && (!note || note.trim().length < 5)) return;
    try {
      await api('POST', `/admin/partners/${encodeURIComponent(id)}/${on ? 'suspend' : 'reactivate'}`, { body: on ? { note } : {} });
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!d) return <p className={error ? 'error' : 'muted'}>{error || 'Đang tải…'}</p>;
  const p = d.partner;
  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>
          {p?.businessName ?? d.profile?.fullName ?? d.profile?.email ?? id} {partnerLabel(p) && <span className="badge ok">{partnerLabel(p)}</span>}
        </h2>
        <p className="muted">
          {d.profile?.email ?? '—'} · SĐT {d.profile?.phone ?? '—'} · tham gia {d.profile?.createdAt ? dateTime(d.profile.createdAt) : '—'} · điều khoản{' '}
          {d.profile?.terms?.version ?? 'chưa đồng ý'}
        </p>
        <p className="muted small">Mã người dùng: {id}</p>
        {d.debt.level !== 'NONE' && (
          <div className="notice bad">
            Nợ phí quá hạn {d.debt.daysOverdue} ngày: {vnd(d.debt.overdueAmount)} ({d.debt.level})
          </div>
        )}
        {d.risk?.status === 'OPEN' && (
          <div className="notice warn">
            Đang bị gắn cờ từ {dateTime(d.risk.openedAt)}: {d.risk.reasons.map((r) => r.text).join('; ')} — <Link to="/admin/risk-flags">xử lý</Link>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Đối tác</h3>
        {p ? (
          <>
            <p>
              <span className={`badge ${statusTone(p.status)}`}>{PARTNER_STATUS_LABEL[p.status]}</span> {PARTNER_TIER_LABEL[tierOf(p)]} · giấy tờ {p.licenseNo ?? '—'} ·
              email liên hệ {p.contactEmail ?? '—'}
            </p>
            {d.quota && (
              <p className="muted">
                Hạn mức {d.quota.limit} tin ({d.quota.plan}){d.quota.vipUntil && ` · VIP 1 tới ${dateTime(d.quota.vipUntil)}`}
              </p>
            )}
            {d.branches.length > 0 && <p className="muted">Chi nhánh: {d.branches.map((b) => `${b.name} (${b.radiusKm} km)`).join(', ')}</p>}
            {p.status === 'APPROVED' && (
              <button className="danger" onClick={() => void suspend(true)}>
                Tạm ngừng
              </button>
            )}
            {p.status === 'SUSPENDED' && <button onClick={() => void suspend(false)}>Mở lại</button>}
          </>
        ) : (
          <p className="muted">Chưa đăng ký đối tác (khách hàng).</p>
        )}
      </section>

      <section className="card">
        <h3>Tin đăng</h3>
        {d.listings.items.length === 0 ? (
          <p className="muted">Chưa có tin.</p>
        ) : (
          <ul className="plain">
            {d.listings.items.map((l) => (
              <li key={l.listingId}>
                <span className={`badge ${statusTone(l.status)}`}>{LISTING_STATUS_LABEL[l.status]}</span> <Link to={`/listings/${l.listingId}`}>{l.title}</Link>{' '}
                <span className="muted small">{dateTime(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <More hasMore={d.listings.hasMore} />
      </section>

      <section className="card">
        <h3>Giao dịch</h3>
        {d.transactions.items.length === 0 ? (
          <p className="muted">Chưa có giao dịch.</p>
        ) : (
          <ul className="plain">
            {d.transactions.items.map((t) => (
              <li key={t.transactionId}>
                <span className={`badge ${statusTone(t.status)}`}>{TX_STATUS_LABEL[t.status]}</span> <Link to={`/transactions/${t.transactionId}`}>{t.listingTitle}</Link> ·{' '}
                {t.ownerId === id ? `bán cho ${t.partnerName}` : 'mua'} · {vnd(t.finalPrice ?? t.agreedPrice)} <span className="muted small">{dateTime(t.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <More hasMore={d.transactions.hasMore} />
      </section>

      <section className="card">
        <h3>Hóa đơn & phí</h3>
        {d.invoices.items.length === 0 && d.fees.items.length === 0 && <p className="muted">Chưa có phí.</p>}
        <ul className="plain">
          {d.invoices.items.map((i) => (
            <li key={i.month}>
              Hóa đơn {i.month}: {vnd(i.amount)} · <code>{i.paymentCode}</code> · <span className={`badge ${i.status === 'PAID' ? 'ok' : 'warn'}`}>{i.status === 'PAID' ? 'đã thu' : 'chưa thu'}</span>
            </li>
          ))}
          {d.fees.items.map((f) => (
            <li key={`${f.month}${f.transactionId}`} className="muted">
              {f.month} · {f.listingTitle} · {vnd(f.amount)}
              {f.kind && f.kind !== 'TRANSACTION' && ` (${f.kind === 'VIP_PLAN' ? 'gói VIP' : 'nghi bán ngoài'})`}
            </li>
          ))}
        </ul>
        <More hasMore={d.invoices.hasMore || d.fees.hasMore} />
      </section>

      <section className="card">
        <h3>Vi phạm 30 ngày ({d.violations30d.items.length})</h3>
        <ul className="plain">
          {d.violations30d.items.map((v) => (
            <li key={v.violationId}>
              {dateTime(v.at)} · {v.kind} {v.ref.title && `· ${v.ref.title}`} {v.note && `— ${v.note}`}
            </li>
          ))}
        </ul>
        {(d.dealsEnded.items.length > 0 || d.suspicions.items.length > 0) && (
          <p className="muted">
            {d.dealsEnded.items.length} giao dịch hủy / thất bại gần đây · {d.suspicions.items.length} lần hủy rồi gỡ tin
          </p>
        )}
      </section>
    </div>
  );
}
