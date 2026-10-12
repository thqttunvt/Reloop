import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers';

const expectInvariant = async (t: ReturnType<typeof makeTestApp>) => {
  const r = await t.services.wallet.reconcile();
  expect(r.negative).toEqual([]);
  expect(r.walletTotal).toBe(r.bankBalance);
  expect(r.ok).toBe(true);
};

describe('Ví — nạp tiền', () => {
  it('chưa xác minh SĐT thì không được nạp (QĐ-09)', async () => {
    const t = makeTestApp();
    const res = await t.call('POST', '/wallet/topups', { user: 'u1', body: { amount: 100_000 }, headers: { 'idempotency-key': 'k1' } });
    expect(res.status).toBe(403);
  });

  it('hạn mức: nạp tối thiểu 10.000đ, số dư tối đa 20 triệu (QĐ-30)', async () => {
    const t = makeTestApp();
    await t.verifiedUser('u1');
    const small = await t.call('POST', '/wallet/topups', { user: 'u1', body: { amount: 9_999 }, headers: { 'idempotency-key': 'a' } });
    expect(small.body.code).toBe('TOPUP_TOO_SMALL');
    const big = await t.call('POST', '/wallet/topups', { user: 'u1', body: { amount: 20_000_001 }, headers: { 'idempotency-key': 'b' } });
    expect(big.body.code).toBe('BALANCE_LIMIT_EXCEEDED');
  });

  it('tạo lệnh nạp trả VietQR có mã nạp trong nội dung', async () => {
    const t = makeTestApp();
    await t.verifiedUser('u1');
    const res = await t.call('POST', '/wallet/topups', { user: 'u1', body: { amount: 100_000 }, headers: { 'idempotency-key': 'k' } });
    expect(res.status).toBe(201);
    expect(res.body.topUp.code).toMatch(/^RLN[A-Z0-9]{6}$/);
    expect(res.body.payment.content).toBe(res.body.topUp.code);
    expect(res.body.payment.qrImageUrl).toContain('img.vietqr.io');
  });

  it('webhook khớp mã → cộng đúng số tiền thực nhận vào Khả dụng', async () => {
    const t = makeTestApp();
    await t.verifiedUser('u1');
    await t.topUp('u1', 150_000);
    const wallet = await t.call('GET', '/wallet', { user: 'u1' });
    expect(wallet.body.balances.available).toBe(150_000);
    await expectInvariant(t);
  });

  it('webhook gửi trùng chỉ cộng 1 lần (TL-03)', async () => {
    const t = makeTestApp();
    await t.verifiedUser('u1');
    const created = await t.call('POST', '/wallet/topups', { user: 'u1', body: { amount: 50_000 }, headers: { 'idempotency-key': 'x' } });
    const payload = { bankTxnId: 'FT123', direction: 'IN', amount: 50_000, content: created.body.topUp.code };
    const first = await t.bankEvent(payload);
    const second = await t.bankEvent(payload);
    expect(first.body.results[0].alreadyProcessed).toBe(false);
    expect(second.body.results[0].alreadyProcessed).toBe(true);
    expect((await t.call('GET', '/wallet', { user: 'u1' })).body.balances.available).toBe(50_000);
    await expectInvariant(t);
  });

  it('nội dung CK bị ngân hàng chèn khoảng trắng / gạch vẫn khớp mã', async () => {
    const t = makeTestApp();
    await t.verifiedUser('u1');
    const created = await t.call('POST', '/wallet/topups', { user: 'u1', body: { amount: 20_000 }, headers: { 'idempotency-key': 'x' } });
    const code: string = created.body.topUp.code;
    await t.bankEvent({ bankTxnId: 'FT9', direction: 'IN', amount: 20_000, content: `MBVCB.123.${code.slice(0, 3)}-${code.slice(3)}.CT tu 0123` });
    expect((await t.call('GET', '/wallet', { user: 'u1' })).body.balances.available).toBe(20_000);
  });

  it('tiền vào không có mã → ví SYSTEM.unallocated + hàng đợi đối soát', async () => {
    const t = makeTestApp();
    await t.bankEvent({ bankTxnId: 'FT777', direction: 'IN', amount: 30_000, content: 'chuyen tien' });
    const recon = await t.call('GET', '/admin/reconciliation', { user: 'admin', groups: ['admin_finance'] });
    expect(recon.body.openItems).toHaveLength(1);
    expect(recon.body.invariant.totals.unallocated).toBe(30_000);
    expect(recon.body.invariant.ok).toBe(true);
  });

  it('webhook sai bí mật bị từ chối', async () => {
    const t = makeTestApp();
    const res = await t.call('POST', '/webhooks/bank', {
      body: { bankTxnId: 'x', direction: 'IN', amount: 1, content: '' },
      headers: { 'x-webhook-secret': 'sai' },
    });
    expect(res.status).toBe(401);
  });
});

describe('Ví — giữ tiền & kết thúc giao dịch', () => {
  it('không đủ số dư thì không giữ được, không ghi gì', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 100_000);
    const res = await t.call('POST', '/dev/transactions/T1/hold', { user: 'partner', body: { amount: 100_001 } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
    expect((await t.call('GET', '/wallet', { user: 'partner' })).body.balances).toMatchObject({ available: 100_000, held: 0 });
  });

  it('bấm Thanh toán 2 lần → chỉ trừ 1 lần', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 500_000);
    await Promise.all([
      t.services.wallet.holdForTransaction('T1', 'partner', 300_000),
      t.services.wallet.holdForTransaction('T1', 'partner', 300_000),
    ]);
    const w = await t.services.wallet.getWallet('partner');
    expect(w.balances).toMatchObject({ available: 200_000, held: 300_000 });
    await expectInvariant(t);
  });

  it('2 giao dịch khác nhau giữ tiền đồng thời vượt số dư → chỉ 1 thành công, ví không âm', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 500_000);
    const results = await Promise.allSettled([
      t.services.wallet.holdForTransaction('T1', 'partner', 400_000),
      t.services.wallet.holdForTransaction('T2', 'partner', 400_000),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const w = await t.services.wallet.getWallet('partner');
    expect(w.balances).toMatchObject({ available: 100_000, held: 400_000 });
    await expectInvariant(t);
  });

  it('hoàn tất đúng giá: Owner nhận đủ, ReLoop thu 10%, Partner trả cộng thêm (QĐ-32)', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 220_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 220_000);
    await t.services.wallet.settleTransaction('T1', 'owner', 200_000);
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(200_000);
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(20_000);
    expect((await t.services.wallet.getWallet('partner')).balances).toMatchObject({ available: 0, held: 0 });
    await expectInvariant(t);
  });

  it('hoàn tất có giảm giá: phí tính trên giá cuối, phần giữ dư về Partner (QĐ-15, QĐ-32)', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 440_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 440_000); // giá xác nhận 400k + phí 40k
    await t.services.wallet.settleTransaction('T1', 'owner', 350_000);
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(350_000);
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(35_000);
    expect((await t.services.wallet.getWallet('partner')).balances).toMatchObject({ available: 55_000, held: 0 });
    await expectInvariant(t);
  });

  it('giá cuối + hoa hồng vượt số giữ → từ chối, gợi ý giá tối đa', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 100_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 100_000);
    await expect(t.services.wallet.settleTransaction('T1', 'owner', 100_000)).rejects.toMatchObject({
      code: 'PAYEE_AMOUNT_EXCEEDS_HOLD',
      details: { maxPayeeAmount: 90_909 },
    });
  });

  it('kết thúc 2 lần không chi 2 lần', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 110_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 110_000);
    const a = await t.services.wallet.settleTransaction('T1', 'owner', 100_000);
    const b = await t.services.wallet.settleTransaction('T1', 'owner', 100_000);
    expect(a.alreadyPosted).toBe(false);
    expect(b.alreadyPosted).toBe(true);
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(100_000);
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(10_000);
  });

  it('giao dịch hủy → hoàn 100% cho bên trả, không thu phí (QĐ-07, QĐ-32)', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 200_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 200_000);
    await t.services.wallet.settleTransaction('T1', undefined, 0);
    expect((await t.services.wallet.getWallet('partner')).balances).toMatchObject({ available: 200_000, held: 0 });
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(0);
  });

  it('tiền đang tranh chấp bị đóng băng, chỉ Admin kết thúc được (QĐ-08)', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 200_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 200_000);
    await t.services.wallet.freezeHold('T1');
    await expect(t.services.wallet.settleTransaction('T1', 'owner', 200_000)).rejects.toMatchObject({ code: 'HOLD_FROZEN' });
    await t.services.wallet.settleTransaction('T1', 'owner', 120_000, { byAdmin: true });
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(120_000);
    expect((await t.services.wallet.getWallet('partner')).balances.available).toBe(68_000); // 200k - 120k - phí 12k
    await expectInvariant(t);
  });

  it('hàng theo kg: giữ thêm lần 2 khi cân vượt ước tính (QĐ-26)', async () => {
    const t = makeTestApp();
    await t.verifiedUser('partner');
    await t.topUp('partner', 300_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 120_000, 1);
    await t.services.wallet.holdForTransaction('T1', 'partner', 45_000, 2);
    expect((await t.services.wallet.getHold('T1'))?.amount).toBe(165_000);
    await t.services.wallet.settleTransaction('T1', 'owner', 150_000);
    await expectInvariant(t);
  });
});

describe('Phí (QĐ-32, QĐ-33)', () => {
  it('hoa hồng 10%, tối thiểu 5.000đ', async () => {
    const t = makeTestApp();
    const quote = (price: number) => t.call('GET', `/fees?price=${price}`, { user: 'u' }).then((r) => r.body);
    expect(await quote(200_000)).toMatchObject({ commission: 20_000, payerTotal: 220_000 });
    expect(await quote(30_000)).toMatchObject({ commission: 5_000, payerTotal: 35_000 });
    expect(await quote(0)).toMatchObject({ commission: 0, payerTotal: 0 });
  });

  it('bài đăng đầu tiên miễn phí, từ bài thứ 2 thu 20.000đ vào ví doanh thu', async () => {
    const t = makeTestApp();
    await t.verifiedUser('owner');
    await t.topUp('owner', 50_000);
    expect(await t.services.wallet.chargeListingFee('L1', 'owner')).toMatchObject({ amount: 0, status: 'WAIVED' });
    expect(await t.services.wallet.chargeListingFee('L2', 'owner')).toMatchObject({ amount: 20_000, status: 'CHARGED' });
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(30_000);
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(20_000);
    await expectInvariant(t);
  });

  it('thu phí đăng bài 2 lần cùng tin chỉ trừ 1 lần, và không tốn lượt miễn phí', async () => {
    const t = makeTestApp();
    await t.verifiedUser('owner');
    await t.topUp('owner', 50_000);
    await t.services.wallet.chargeListingFee('L1', 'owner');
    await t.services.wallet.chargeListingFee('L1', 'owner');
    expect(await t.services.wallet.chargeListingFee('L2', 'owner')).toMatchObject({ amount: 20_000 });
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(30_000);
  });

  it('không đủ tiền đăng bài → INSUFFICIENT_FUNDS kèm số còn thiếu, không tốn lượt', async () => {
    const t = makeTestApp();
    await t.verifiedUser('owner');
    await t.services.wallet.chargeListingFee('L1', 'owner'); // miễn phí
    await expect(t.services.wallet.chargeListingFee('L2', 'owner')).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { required: 20_000 },
    });
    expect(await t.services.wallet.getListingFee('L2')).toBeUndefined();
  });

  it('hoàn phí đăng bài đúng 1 lần; bài miễn phí không có gì để hoàn', async () => {
    const t = makeTestApp();
    await t.verifiedUser('owner');
    await t.topUp('owner', 20_000);
    await t.services.wallet.chargeListingFee('L1', 'owner');
    await t.services.wallet.chargeListingFee('L2', 'owner');
    expect(await t.services.wallet.refundListingFee('L2')).toMatchObject({ status: 'REFUNDED' });
    await t.services.wallet.refundListingFee('L2');
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(20_000);
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(0);
    await expect(t.services.wallet.refundListingFee('L1')).rejects.toMatchObject({ code: 'LISTING_FEE_NOT_REFUNDABLE' });
    await expectInvariant(t);
  });
});

describe('Ví — rút tiền (QĐ-31)', () => {
  const setup = async () => {
    const t = makeTestApp();
    await t.verifiedUser('owner');
    await t.topUp('owner', 300_000);
    const acc = await t.call('POST', '/bank-accounts', {
      user: 'owner',
      body: { bankBin: '970422', accountNo: '0123456789', accountName: 'nguyen van an' },
    });
    return { t, accountId: acc.body.accountId as string };
  };

  it('STK chưa được Admin xác minh thì không rút được', async () => {
    const { t, accountId } = await setup();
    const res = await t.call('POST', '/wallet/withdrawals', {
      user: 'owner',
      body: { amount: 100_000, bankAccountId: accountId },
      headers: { 'idempotency-key': 'w1' },
    });
    expect(res.body.code).toBe('BANK_ACCOUNT_NOT_VERIFIED');
  });

  it('Admin thấy gợi ý tên chủ TK khớp tên hồ sơ (bỏ dấu, không phân biệt hoa thường)', async () => {
    const { t } = await setup();
    const res = await t.call('GET', '/admin/bank-accounts', { user: 'admin', groups: ['admin'] });
    expect(res.body.items[0]).toMatchObject({ accountName: 'NGUYEN VAN AN', nameMatches: true });
  });

  it('người không thuộc nhóm admin không gọi được API Admin', async () => {
    const { t } = await setup();
    expect((await t.call('GET', '/admin/bank-accounts', { user: 'owner' })).status).toBe(403);
    expect((await t.call('GET', '/admin/withdrawals', { user: 'admin', groups: ['admin'] })).status).toBe(403);
  });

  it('luồng đầy đủ: yêu cầu rút → Admin chuyển → webhook tiền ra → PAID', async () => {
    const { t, accountId } = await setup();
    await t.call('POST', `/admin/users/owner/bank-accounts/${accountId}/review`, {
      user: 'admin',
      groups: ['admin'],
      body: { approve: true },
    });
    const req = await t.call('POST', '/wallet/withdrawals', {
      user: 'owner',
      body: { amount: 100_000, bankAccountId: accountId },
      headers: { 'idempotency-key': 'w1' },
    });
    expect(req.status).toBe(201);
    expect((await t.services.wallet.getWallet('owner')).balances).toMatchObject({ available: 200_000, withdrawing: 100_000 });

    const queue = await t.call('GET', '/admin/withdrawals', { user: 'fin', groups: ['admin_finance'] });
    expect(queue.body.items[0].transferQrImageUrl).toContain('0123456789');
    await t.call('POST', `/admin/users/owner/withdrawals/${req.body.withdrawalId}/processing`, { user: 'fin', groups: ['admin_finance'] });

    await t.bankEvent({ bankTxnId: 'OUT1', direction: 'OUT', amount: 100_000, content: `${req.body.code} rut tien` });
    const list = await t.call('GET', '/wallet/withdrawals', { user: 'owner' });
    expect(list.body.items[0].status).toBe('PAID');
    expect((await t.services.wallet.getWallet('owner')).balances).toMatchObject({ available: 200_000, withdrawing: 0 });
    await expectInvariant(t);
  });

  it('cùng Idempotency-Key gửi 2 lần chỉ tạo 1 lệnh rút', async () => {
    const { t, accountId } = await setup();
    await t.call('POST', `/admin/users/owner/bank-accounts/${accountId}/review`, { user: 'a', groups: ['admin'], body: { approve: true } });
    const send = () =>
      t.call('POST', '/wallet/withdrawals', {
        user: 'owner',
        body: { amount: 100_000, bankAccountId: accountId },
        headers: { 'idempotency-key': 'same' },
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const again = await send();
    expect(again.body.withdrawalId).toBe(a.status === 201 ? a.body.withdrawalId : b.body.withdrawalId);
    expect((await t.services.wallet.getWallet('owner')).balances.withdrawing).toBe(100_000);
  });

  it('chuyển khoản lỗi → trả tiền về Khả dụng', async () => {
    const { t, accountId } = await setup();
    await t.call('POST', `/admin/users/owner/bank-accounts/${accountId}/review`, { user: 'a', groups: ['admin'], body: { approve: true } });
    const req = await t.call('POST', '/wallet/withdrawals', {
      user: 'owner',
      body: { amount: 100_000, bankAccountId: accountId },
      headers: { 'idempotency-key': 'w' },
    });
    await t.call('POST', `/admin/users/owner/withdrawals/${req.body.withdrawalId}/fail`, {
      user: 'fin',
      groups: ['admin_finance'],
      body: { reason: 'Sai STK' },
    });
    expect((await t.services.wallet.getWallet('owner')).balances).toMatchObject({ available: 300_000, withdrawing: 0 });
    await expectInvariant(t);
  });
});
