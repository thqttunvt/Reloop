import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers';

const expectInvariant = async (t: ReturnType<typeof makeTestApp>) => {
  const r = await t.services.wallet.reconcile();
  expect(r.negative).toEqual([]);
  expect(r.walletTotal).toBe(r.bankBalance);
  expect(r.ok).toBe(true);
};

describe('Ví — giữ tiền & kết thúc giao dịch', () => {
  it('không đủ số dư thì không giữ được, không ghi gì', async () => {
    const t = makeTestApp();
    await t.fund('partner', 100_000);
    await expect(t.services.wallet.holdForTransaction('T1', 'partner', 100_001)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect((await t.call('GET', '/wallet', { user: 'partner' })).body.balances).toMatchObject({ available: 100_000, held: 0 });
  });

  it('bấm Thanh toán 2 lần → chỉ trừ 1 lần', async () => {
    const t = makeTestApp();
    await t.fund('partner', 500_000);
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
    await t.fund('partner', 500_000);
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
    await t.fund('partner', 220_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 220_000);
    await t.services.wallet.settleTransaction('T1', 'owner', 200_000);
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(200_000);
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(20_000);
    expect((await t.services.wallet.getWallet('partner')).balances).toMatchObject({ available: 0, held: 0 });
    await expectInvariant(t);
  });

  it('hoàn tất có giảm giá: phí tính trên giá cuối, phần giữ dư về Partner (QĐ-15, QĐ-32)', async () => {
    const t = makeTestApp();
    await t.fund('partner', 440_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 440_000); // giá xác nhận 400k + phí 40k
    await t.services.wallet.settleTransaction('T1', 'owner', 350_000);
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(350_000);
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(35_000);
    expect((await t.services.wallet.getWallet('partner')).balances).toMatchObject({ available: 55_000, held: 0 });
    await expectInvariant(t);
  });

  it('giá cuối + hoa hồng vượt số giữ → từ chối, gợi ý giá tối đa', async () => {
    const t = makeTestApp();
    await t.fund('partner', 100_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 100_000);
    await expect(t.services.wallet.settleTransaction('T1', 'owner', 100_000)).rejects.toMatchObject({
      code: 'PAYEE_AMOUNT_EXCEEDS_HOLD',
      details: { maxPayeeAmount: 90_909 },
    });
  });

  it('kết thúc 2 lần không chi 2 lần', async () => {
    const t = makeTestApp();
    await t.fund('partner', 110_000);
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
    await t.fund('partner', 200_000);
    await t.services.wallet.holdForTransaction('T1', 'partner', 200_000);
    await t.services.wallet.settleTransaction('T1', undefined, 0);
    expect((await t.services.wallet.getWallet('partner')).balances).toMatchObject({ available: 200_000, held: 0 });
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(0);
  });

  it('tiền đang tranh chấp bị đóng băng, chỉ Admin kết thúc được (QĐ-08)', async () => {
    const t = makeTestApp();
    await t.fund('partner', 200_000);
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
    await t.fund('partner', 300_000);
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
    await t.fund('owner', 50_000);
    expect(await t.services.wallet.chargeListingFee('L1', 'owner')).toMatchObject({ amount: 0, status: 'WAIVED' });
    expect(await t.services.wallet.chargeListingFee('L2', 'owner')).toMatchObject({ amount: 20_000, status: 'CHARGED' });
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(30_000);
    expect((await t.services.wallet.getRevenueWallet()).balances.available).toBe(20_000);
    await expectInvariant(t);
  });

  it('thu phí đăng bài 2 lần cùng tin chỉ trừ 1 lần, và không tốn lượt miễn phí', async () => {
    const t = makeTestApp();
    await t.fund('owner', 50_000);
    await t.services.wallet.chargeListingFee('L1', 'owner');
    await t.services.wallet.chargeListingFee('L1', 'owner');
    expect(await t.services.wallet.chargeListingFee('L2', 'owner')).toMatchObject({ amount: 20_000 });
    expect((await t.services.wallet.getWallet('owner')).balances.available).toBe(30_000);
  });

  it('không đủ tiền đăng bài → INSUFFICIENT_FUNDS kèm số còn thiếu, không tốn lượt', async () => {
    const t = makeTestApp();
    await t.services.wallet.chargeListingFee('L1', 'owner'); // miễn phí
    await expect(t.services.wallet.chargeListingFee('L2', 'owner')).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { required: 20_000 },
    });
    expect(await t.services.wallet.getListingFee('L2')).toBeUndefined();
  });

  it('hoàn phí đăng bài đúng 1 lần; bài miễn phí không có gì để hoàn', async () => {
    const t = makeTestApp();
    await t.fund('owner', 20_000);
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
