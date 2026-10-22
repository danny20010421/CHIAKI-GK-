/**
 * 業主 2026-10 第二批：不可退款代幣、運費門檻字面規則 floor(n/20)+1、回收後多收運費自動部分退還（不可退款代幣）、
 * 新台幣運費退款申請（雙人覆核撥款、與代幣擇一、冪等、綠界刷退替身）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../src/server/db';
import { resetConfig } from '../src/server/config';
import { executeDraw } from '../src/server/modules/draw/draw';
import { listWarehouse, recycleItems } from '../src/server/modules/warehouse/warehouse';
import { runStorageSweep } from '../src/server/modules/warehouse/storage';
import { getCoinBreakdown, getWallet, NONREFUNDABLE_LABEL, postLedger, reconcileWallets } from '../src/server/modules/wallet/wallet';
import { createRefundRequest } from '../src/server/modules/wallet/refunds';
import { activePrepayments, feesNeededFor } from '../src/server/modules/shipping/prepaid';
import { createCashRefundRequest, decideCashRefund, listRefundableShippingFees, payoutCashRefund } from '../src/server/modules/shipping/shipping-refunds';
import { setEcpayRefundGateway } from '../src/server/modules/payment/ecpay-refund';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import { GET as breakdownRoute } from '../src/app/api/me/wallet/breakdown/route';
import { GET as walletRoute } from '../src/app/api/me/wallet/route';
import { POST as recycleRoute } from '../src/app/api/me/recycle/route';
import { GET as myShipRefundsRoute, POST as shipRefundRoute } from '../src/app/api/me/shipping-refunds/route';
import { POST as decisionRoute } from '../src/app/api/admin/shipping-refunds/[id]/decision/route';
import { POST as payoutRoute } from '../src/app/api/admin/shipping-refunds/[id]/payout/route';
import { apiRequest, ctx, customPool, expectAppError, FEE_CVS, ledgerOf, makeUser, publishPool, setupTestDb } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `sr-${process.pid}-${++k}-${Date.now()}`;
const none = undefined as never;
before(async () => {
  env = await setupTestDb({ RISK_DRAW_LIMIT_PER_MIN: '1000' });
});
after(async () => {
  setEcpayRefundGateway(null);
  await env.teardown();
});

/** 只有小獎的自製賞池（每抽 10、小獎回收值 50） */
const smallOnly = (qty = 80) => customPool({ prizes: [{ name: '小獎', grade: 'SMALL', qtyPerSet: qty, recycleValue: 50 }] });
const setIdOf = async (poolId: string) => ((await db()`SELECT id FROM pool_sets WHERE pool_id = ${poolId} AND set_no = 1`) as unknown as [{ id: string }])[0].id;
const smallsOf = async (userId: string) => (await listWarehouse(db(), userId, 'STORED')).filter((i) => i.grade === 'SMALL');
const draw = (userId: string, poolId: string, count: number) => executeDraw(userId, key(), { poolId, setNo: 1, count, shippingMethod: 'CVS_711_C2C' }).then((r) => r.response);
const typesOf = async (userId: string, t: string) => (await ledgerOf(userId)).filter((l) => l.entryType === t);

describe('shipping threshold = floor((held SMALL + tickets) / 20) + 1', () => {
  it('pure formula', () => {
    assert.deepEqual([0, 1, 19, 20, 21, 39, 40, 45].map((n) => feesNeededFor(n, 20)), [1, 1, 1, 2, 2, 2, 3, 3]);
  });

  it('buying 20 at once pre-collects two fees; 19 then +1 also reaches two', async () => {
    const poolId = await publishPool(smallOnly());
    const a = await makeUser({ coins: 5000 });
    const r = await draw(a.id, poolId, 20);
    assert.deepEqual([r.shipping.feesToCharge, r.shipping.feesNeeded, r.shipping.amount], [2, 2, 2 * FEE_CVS]);
    const b = await makeUser({ coins: 5000 });
    assert.equal((await draw(b.id, poolId, 19)).shipping.feesToCharge, 1);
    const r2 = await draw(b.id, poolId, 1);
    assert.deepEqual([r2.shipping.smallItemsHeld, r2.shipping.feesToCharge, r2.shipping.feesPaidAfter], [19, 1, 2]);
  });
});

describe('recycling SMALL items refunds surplus fees as non-refundable coins', () => {
  it('surplus fee refunded at SHIPPING_REFUND_RATIO (0.5), paid count decremented, re-charged when needed again', async () => {
    const poolId = await publishPool(smallOnly());
    const setId = await setIdOf(poolId);
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 20); // 2 份
    const smalls = await smallsOf(u.id);
    const rec = await recycleItems(u.id, [smalls[0]!.id]); // 持有 19 → 需要 1 份 → 退 1 份
    assert.equal(rec.shippingFeeRefunds.length, 1);
    assert.deepEqual([rec.shippingFeeRefunds[0]!.seq, rec.shippingFeeRefunds[0]!.feeCoins, rec.shippingFeeRefunds[0]!.refundCoins], [2, FEE_CVS, Math.floor(FEE_CVS / 2)]);
    const refund = await typesOf(u.id, 'SHIPPING_REFUND_COINS');
    assert.deepEqual(refund.map((l) => [l.amount, l.refundable]), [[35, false]]);
    assert.equal((await activePrepayments(db(), u.id, setId)).length, 1, 'paid fee count decremented');
    const [row] = await db()`SELECT mode, status, ratio_bp, amount FROM shipping_fee_refunds WHERE user_id = ${u.id}`;
    assert.deepEqual(row, { mode: 'COINS', status: 'PAID', ratioBp: 5000, amount: 35 });
    // 再回收 18 件（持有 1）→ 仍需 1 份 → 不再退
    assert.equal((await recycleItems(u.id, smalls.slice(1, 19).map((i) => i.id))).shippingFeeRefunds.length, 0);
    // 再抽：1 + 19 = 20 → 需要 2 份 → 補收一份（序號 3，序號不重用）
    const r = await draw(u.id, poolId, 19);
    assert.deepEqual([r.shipping.feesPaidBefore, r.shipping.feesToCharge], [1, 1]);
    assert.deepEqual((await db()`SELECT seq FROM shipping_prepayments WHERE user_id = ${u.id} ORDER BY seq`).map((x) => x.seq), [1, 2, 3]);
    // 退還通知（站內）
    const [n] = await db()`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${u.id} AND type = 'SHIPPING_FEE_REFUND'`;
    assert.equal(n!.n, 1);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });

  it('concurrent recycles never refund the same fee twice', async () => {
    const poolId = await publishPool(smallOnly());
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 45); // 3 份
    const smalls = await smallsOf(u.id);
    // 兩批同時回收各 20 件 → 持有 5 → 需要 1 份 → 合計恰退 2 份
    const rs = await Promise.all([recycleItems(u.id, smalls.slice(0, 20).map((i) => i.id)), recycleItems(u.id, smalls.slice(20, 40).map((i) => i.id))]);
    assert.equal(rs.reduce((s, r) => s + r.shippingFeeRefunds.length, 0), 2);
    assert.equal((await typesOf(u.id, 'SHIPPING_REFUND_COINS')).length, 2);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });

  it('ratio is configurable (SHIPPING_REFUND_RATIO)', async () => {
    process.env.SHIPPING_REFUND_RATIO = '0.25';
    resetConfig();
    try {
      const poolId = await publishPool(smallOnly());
      const u = await makeUser({ coins: 5000 });
      await draw(u.id, poolId, 20);
      const r = await recycleItems(u.id, [(await smallsOf(u.id))[0]!.id]);
      assert.equal(r.shippingFeeRefunds[0]!.refundCoins, Math.floor(FEE_CVS / 4));
    } finally {
      delete process.env.SHIPPING_REFUND_RATIO;
      resetConfig();
    }
  });

  it('storage-expiry auto-conversion also refunds the surplus fee', async () => {
    const poolId = await publishPool(smallOnly());
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 20);
    const [first] = await listWarehouse(db(), u.id);
    const res = await runStorageSweep(new Date(first!.storageExpiresAt.getTime() + 1000));
    assert.ok(res.shippingFeesRefunded >= 1);
    assert.deepEqual((await typesOf(u.id, 'SHIPPING_REFUND_COINS')).map((l) => l.amount), [35]);
    const w = await getWallet(db(), u.id);
    assert.equal(w.nonRefundableCoins, 20 * 50 + 35, 'expiry coins + shipping refund are both non-refundable');
  });
});

describe('non-refundable coins: label, breakdown, spending order, cannot be withdrawn', () => {
  it('breakdown shows refundable vs non-refundable with the owner label; refunds limited; non-refundable spent first', async () => {
    const poolId = await publishPool(smallOnly());
    const u = await makeUser({ coins: 1000 });
    await draw(u.id, poolId, 20);
    await recycleItems(u.id, [(await smallsOf(u.id))[0]!.id]); // +35 不可退款
    const res = await breakdownRoute(apiRequest('GET', '/api/me/wallet/breakdown', { token: u.token }), none);
    const b = (await res.json()) as Awaited<ReturnType<typeof getCoinBreakdown>>;
    assert.equal(b.nonRefundableLabel, '不可退款・無法轉換，如有疑問請聯絡官方小編');
    assert.equal(NONREFUNDABLE_LABEL, b.nonRefundableLabel);
    assert.equal(b.nonRefundableCoins, 35);
    assert.equal(b.nonRefundableCredited.SHIPPING_REFUND_COINS, 35);
    assert.equal(b.refundableCoins, b.coins - 35);
    const wallet = (await (await walletRoute(apiRequest('GET', '/api/me/wallet', { token: u.token }), none)).json()) as { coinBreakdown: { nonRefundableLabel: string }; refundableCoins: number };
    assert.equal(wallet.coinBreakdown.nonRefundableLabel, NONREFUNDABLE_LABEL);
    assert.equal(wallet.refundableCoins, b.refundableCoins);
    await expectAppError(createRefundRequest(u.id, b.refundableCoins + 1, 'x'), 'INSUFFICIENT_FUNDS');
    // 邀請獎勵類型同樣強制不可退款（postLedger 不允許覆寫）
    await assert.rejects(transaction((tx) => postLedger(tx, { userId: u.id, currency: 'COINS', amount: 5, entryType: 'SHIPPING_REFUND_COINS', refType: 't', refId: 't', refundable: true })), /always non-refundable/);
    // 消費先扣不可退款：再抽 1 籤（10）＋ 持有 19+1=20 需再收一份運費（70）= 80 → 先扣光 35 不可退款，其餘 45 扣可退款
    const before = await getWallet(db(), u.id);
    const r = await draw(u.id, poolId, 1);
    assert.equal(r.totalCoins, 10 + FEE_CVS);
    const w = await getWallet(db(), u.id);
    assert.deepEqual([w.nonRefundableCoins, w.refundableCoins], [0, before.refundableCoins - (10 + FEE_CVS - 35)]);
  });
});

describe('NT$ shipping refund requests', () => {
  async function surplusFor(coins: number, nonRefundableOnly = false) {
    const poolId = await publishPool(smallOnly());
    const u = await makeUser({ coins: nonRefundableOnly ? 0 : coins });
    if (nonRefundableOnly) {
      await transaction((tx) => postLedger(tx, { userId: u.id, currency: 'COINS', amount: coins, entryType: 'EXPIRY_AUTO_CONVERT', refType: 'test', refId: u.id }));
    }
    await draw(u.id, poolId, 20);
    const r = await recycleItems(u.id, [(await smallsOf(u.id))[0]!.id], { shippingRefund: 'CASH' });
    return { u, poolId, setId: await setIdOf(poolId), kept: r.shippingFeesRefundableInCash, rec: r };
  }

  it('workflow PENDING → APPROVED → PAID with two people; idempotent; never both coin and cash; reject restores the fee', async () => {
    const { u, setId, kept, rec } = await surplusFor(5000);
    assert.equal(rec.shippingFeeRefunds.length, 0, 'CASH choice: no automatic coin refund');
    assert.equal(kept.length, 1);
    const prepaymentId = kept[0]!.prepaymentIds[0]!;
    const list = (await (await myShipRefundsRoute(apiRequest('GET', '/api/me/shipping-refunds', { token: u.token }), none)).json()) as { fees: { prepaymentId: string; coinRefund: number; cashRefundTwd: number }[] };
    assert.deepEqual(list.fees.map((f) => [f.prepaymentId, f.coinRefund, f.cashRefundTwd]), [[prepaymentId, 35, 35]]);

    const body = { prepaymentId, payoutMethod: 'BANK_TRANSFER', bankCode: '812', bankAccount: '12345678901234', accountName: '王小明' };
    const c1 = await shipRefundRoute(apiRequest('POST', '/api/me/shipping-refunds', { token: u.token, body }), none);
    assert.equal(c1.status, 201);
    const req1 = (await c1.json()) as { id: string; status: string; amount: number };
    assert.deepEqual([req1.status, req1.amount], ['PENDING', 35]);
    const c2 = await shipRefundRoute(apiRequest('POST', '/api/me/shipping-refunds', { token: u.token, body }), none);
    assert.equal(c2.status, 200, 'same fee → same request (idempotent)');
    assert.equal(((await c2.json()) as { id: string }).id, req1.id);
    assert.equal((await activePrepayments(db(), u.id, setId)).length, 1, 'requested fee no longer counts as paid');
    // 不可同時退代幣：該份運費已不在有效清單 → 回收也不會再退；直接寫入代幣退還列被唯一索引擋下
    await assert.rejects(
      db()`INSERT INTO shipping_fee_refunds (user_id, set_id, prepayment_id, mode, fee_coins, ratio_bp, amount, status)
           VALUES (${u.id}, ${setId}, ${prepaymentId}, 'COINS', 70, 5000, 35, 'PAID')`,
      /shipping_fee_refunds_one_active/,
    );

    const f1 = await makeUser({ roles: ['FINANCE'] });
    const f2 = await makeUser({ roles: ['FINANCE'] });
    const member = await makeUser();
    assert.equal((await decisionRoute(apiRequest('POST', `/api/admin/shipping-refunds/${req1.id}/decision`, { token: member.token, body: { decision: 'APPROVE' } }), ctx({ id: req1.id }))).status, 403);
    const ok = await decisionRoute(apiRequest('POST', `/api/admin/shipping-refunds/${req1.id}/decision`, { token: f1.token, body: { decision: 'APPROVE' } }), ctx({ id: req1.id }));
    assert.equal(ok.status, 200);
    const self = await payoutRoute(apiRequest('POST', `/api/admin/shipping-refunds/${req1.id}/payout`, { token: f1.token, body: { bankTransferRef: 'TX-1' } }), ctx({ id: req1.id }));
    assert.equal(((await self.json()) as { error: { code: string } }).error.code, 'SELF_APPROVAL');
    await expectAppError(payoutCashRefund(f2.principal, req1.id, {}), 'VALIDATION');
    const paid = await payoutRoute(apiRequest('POST', `/api/admin/shipping-refunds/${req1.id}/payout`, { token: f2.token, body: { bankTransferRef: 'TX-0001' } }), ctx({ id: req1.id }));
    assert.equal(paid.status, 200);
    const p1 = (await paid.json()) as { status: string; paidBy: string; providerRef: string; replayed: boolean };
    assert.deepEqual([p1.status, p1.paidBy, p1.providerRef, p1.replayed], ['PAID', f2.id, 'TX-0001', false]);
    const again = await payoutCashRefund(f2.principal, req1.id, { bankTransferRef: 'TX-0002' });
    assert.deepEqual([again.replayed, again.providerRef], [true, 'TX-0001'], 'payout is idempotent');
    // 資料庫最後防線：核准者 = 撥款者 不可能
    await assert.rejects(db()`UPDATE shipping_fee_refunds SET paid_by = decided_by WHERE id = ${req1.id}`, /shipping_refund_two_person/);
    const replay = await createCashRefundRequest(u.id, body as never);
    assert.deepEqual([replay.replayed, replay.id, replay.status], [true, req1.id, 'PAID'], 're-request after payout replays the same record');
  });

  it('reject restores the fee; fees paid with non-refundable coins cannot become cash; no surplus → refused', async () => {
    const { u, setId, kept } = await surplusFor(5000);
    const f1 = await makeUser({ roles: ['FINANCE'] });
    const r = await createCashRefundRequest(u.id, { prepaymentId: kept[0]!.prepaymentIds[0]!, payoutMethod: 'BANK_TRANSFER', bankCode: '812', bankAccount: '12345678', accountName: 'A' });
    assert.equal((await activePrepayments(db(), u.id, setId)).length, 1);
    await decideCashRefund(f1.principal, r.id, 'REJECT', '資料不符');
    assert.equal((await activePrepayments(db(), u.id, setId)).length, 2, 'rejected request → fee active again');
    const n = await db()`SELECT body FROM notifications WHERE user_id = ${u.id} AND type = 'REFUND_STATUS'`;
    assert.ok(n.some((x) => /已駁回/.test(x.body as string)));

    const nr = await surplusFor(5000, true);
    await expectAppError(
      createCashRefundRequest(nr.u.id, { prepaymentId: nr.kept[0]!.prepaymentIds[0]!, payoutMethod: 'BANK_TRANSFER', bankCode: '812', bankAccount: '12345678', accountName: 'A' }),
      'INVALID_STATE',
    );
    const nrList = await listRefundableShippingFees(nr.u.id);
    assert.deepEqual(nrList.fees.map((f) => [f.coinRefund, f.cashRefundTwd]), [[35, 0]], 'paid with non-refundable coins → coin refund only');

    const poolId = await publishPool(smallOnly());
    const x = await makeUser({ coins: 1000 });
    await draw(x.id, poolId, 3);
    const [pp] = await db()`SELECT id FROM shipping_prepayments WHERE user_id = ${x.id}`;
    await expectAppError(createCashRefundRequest(x.id, { prepaymentId: pp!.id as string, payoutMethod: 'BANK_TRANSFER', bankCode: '812', bankAccount: '12345678', accountName: 'A' }), 'INVALID_STATE');
    await assert.rejects(createCashRefundRequest(x.id, { prepaymentId: pp!.id as string, payoutMethod: 'BANK_TRANSFER' }), /銀行轉帳需填/);
  });

  it('ECPay card refund goes through the gateway interface (stub); failures keep the request APPROVED', async () => {
    const { u, kept } = await surplusFor(5000);
    const [order] = await db()<{ id: string }[]>`
      INSERT INTO payment_orders (user_id, provider, merchant_trade_no, package_code, amount_twd, coins, status, provider_trade_no, payment_type, paid_at)
      VALUES (${u.id}, 'ECPAY', ${`CKTEST${Date.now()}`.slice(0, 20)}, 'P1000', 1000, 1000, 'PAID', '2310230000000001', 'Credit_CreditCard', now()) RETURNING id`;
    const r = await createCashRefundRequest(u.id, { prepaymentId: kept[0]!.prepaymentIds[0]!, payoutMethod: 'ECPAY_CARD', paymentOrderId: order!.id });
    const f1 = await makeUser({ roles: ['FINANCE'] });
    const f2 = await makeUser({ roles: ['FINANCE'] });
    await decideCashRefund(f1.principal, r.id, 'APPROVE');
    await expectAppError(payoutCashRefund(f2.principal, r.id), 'NOT_IMPLEMENTED');
    const [still] = await db()`SELECT status FROM shipping_fee_refunds WHERE id = ${r.id}`;
    assert.equal(still!.status, 'APPROVED');
    const calls: unknown[] = [];
    setEcpayRefundGateway({ refundCard: async (x) => (calls.push(x), { providerRef: 'ECPAY-REF-1' }) });
    try {
      const p = await payoutCashRefund(f2.principal, r.id);
      assert.deepEqual([p.status, p.providerRef], ['PAID', 'ECPAY-REF-1']);
      assert.deepEqual(calls, [{ merchantTradeNo: (await db()`SELECT merchant_trade_no FROM payment_orders WHERE id = ${order!.id}`)[0]!.merchantTradeNo, providerTradeNo: '2310230000000001', amount: 35, idempotencyKey: r.id }]);
    } finally {
      setEcpayRefundGateway(null);
    }
    // 不是本人的信用卡訂單 → 拒絕
    const other = await surplusFor(5000);
    await assert.rejects(createCashRefundRequest(other.u.id, { prepaymentId: other.kept[0]!.prepaymentIds[0]!, payoutMethod: 'ECPAY_CARD', paymentOrderId: order!.id }), /本人已付款/);
    assert.equal((await verifyAuditChain(db())).ok, true);
  });

  it('HTTP: recycle with shippingRefund=CASH skips the automatic coin refund', async () => {
    const poolId = await publishPool(smallOnly());
    const u = await makeUser({ coins: 2000 });
    await draw(u.id, poolId, 20);
    const res = await recycleRoute(apiRequest('POST', '/api/me/recycle', { token: u.token, body: { itemIds: [(await smallsOf(u.id))[0]!.id], shippingRefund: 'CASH' } }), none);
    const b = (await res.json()) as { shippingFeeRefunds: unknown[]; shippingFeesRefundableInCash: { prepaymentIds: string[] }[] };
    assert.equal(b.shippingFeeRefunds.length, 0);
    assert.equal(b.shippingFeesRefundableInCash[0]!.prepaymentIds.length, 1);
  });
});
