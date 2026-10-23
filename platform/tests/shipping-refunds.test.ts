/**
 * 業主 2026-10 第三批：逐件運費退還（每回收一件小獎退 運費 ÷ N 代幣，依會員×套累計、餘數累積）、
 * 回收的小獎仍計入「滿 20 件再收一份」門檻、到期轉換同樣退還、冪等、並發不超退、不可退款代幣、無新台幣運費退款。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { listWarehouse, recycleItems } from '../src/server/modules/warehouse/warehouse';
import { runStorageSweep } from '../src/server/modules/warehouse/storage';
import { updateSetConfig } from '../src/server/modules/pool/admin';
import { getCoinBreakdown, getWallet, NONREFUNDABLE_LABEL, postLedger, reconcileWallets } from '../src/server/modules/wallet/wallet';
import { createRefundRequest } from '../src/server/modules/wallet/refunds';
import { feesNeededFor, itemRefundTotal } from '../src/server/modules/shipping/prepaid';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import * as myShippingRefunds from '../src/app/api/me/shipping-refunds/route';
import { GET as breakdownRoute } from '../src/app/api/me/wallet/breakdown/route';
import { POST as recycleRoute } from '../src/app/api/me/recycle/route';
import { apiRequest, customPool, expectAppError, FEE_CVS, ledgerOf, makeUser, pickTickets, publishPool, setupTestDb } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `sr-${process.pid}-${++k}-${Date.now()}`;
const none = undefined as never;
before(async () => {
  env = await setupTestDb({ RISK_DRAW_LIMIT_PER_MIN: '1000' });
});
after(async () => {
  await env.teardown();
});

/** 只有小獎的自製賞池（每抽 10、小獎回收值 50）；宅配運費可指定（150–300） */
const smallOnly = (home = 150, qty = 80) => customPool({ shippingFeeHome: home, prizes: [{ name: '小獎', grade: 'SMALL', qtyPerSet: qty, recycleValue: 50 }] });
const setIdOf = async (poolId: string) => ((await db()`SELECT id FROM pool_sets WHERE pool_id = ${poolId} AND set_no = 1`) as unknown as [{ id: string }])[0].id;
const smallsOf = async (userId: string) => (await listWarehouse(db(), userId, 'STORED')).filter((i) => i.isSmall);
const draw = async (userId: string, poolId: string, count: number, method: 'HOME_DELIVERY' | 'CVS_711_C2C' = 'HOME_DELIVERY') =>
  executeDraw(userId, key(), { poolId, setNo: 1, ...([1, 3, 5, 10, 20].includes(count) ? { count } : { ticketNos: await pickTickets(poolId, count) }), shippingMethod: method }).then((r) => r.response);
const refundLedger = async (userId: string) => (await ledgerOf(userId)).filter((l) => l.entryType === 'SHIPPING_REFUND_COINS');
const accOf = async (userId: string, setId: string) =>
  (await db()<{ feeCoins: number; divisor: number; refundedUnits: number; refundedAmount: number }[]>`
    SELECT fee_coins, divisor, refunded_units, refunded_amount FROM shipping_item_refunds WHERE user_id = ${userId} AND set_id = ${setId}`)[0];

describe('formulas', () => {
  it('refund total = floor(fee × units / N); fees needed = floor(smalls / 20) + 1', () => {
    assert.deepEqual([1, 2, 3, 4].map((u) => itemRefundTotal(150, u, 20)), [7, 15, 22, 30]);
    assert.equal(itemRefundTotal(200, 5, 20), 50);
    assert.equal(itemRefundTotal(20, 1, 20), 1, 'owner example: fee 20 → 1 coin per item');
    assert.deepEqual([0, 19, 20, 39, 40].map((n) => feesNeededFor(n, 20)), [1, 1, 2, 2, 3]);
  });
});

describe('per-item shipping refund on recycle', () => {
  it('fee 150: recycle 1 → 7, another → 8 (remainder carried), 2 more → 15; non-refundable coins; notified', async () => {
    const poolId = await publishPool(smallOnly(150));
    const setId = await setIdOf(poolId);
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 4);
    const smalls = await smallsOf(u.id);
    const r1 = await recycleItems(u.id, [smalls[0]!.id]);
    assert.deepEqual([r1.shippingRefundCoins, r1.shippingRefunds[0]!.unitsAfter, r1.shippingRefunds[0]!.amountAfter], [7, 1, 7]);
    const r2 = await recycleItems(u.id, [smalls[1]!.id]);
    assert.equal(r2.shippingRefundCoins, 8);
    const r3 = await recycleItems(u.id, [smalls[2]!.id, smalls[3]!.id]);
    assert.equal(r3.shippingRefundCoins, 15);
    assert.deepEqual(await accOf(u.id, setId), { feeCoins: 150, divisor: 20, refundedUnits: 4, refundedAmount: 30 });
    assert.deepEqual((await refundLedger(u.id)).map((l) => [l.amount, l.refundable]), [[7, false], [8, false], [15, false]]);
    assert.equal((await getWallet(db(), u.id)).nonRefundableCoins, 30);
    const notes = await db()`SELECT body FROM notifications WHERE user_id = ${u.id} AND type = 'SHIPPING_FEE_REFUND' ORDER BY created_at`;
    assert.equal(notes.length, 3);
    assert.match(notes[2]!.body as string, /回收 2 件小獎，已退還運費 15 代幣（不可退款・無法轉換，如有疑問請聯絡官方小編）/);
    const events = await db()`SELECT source_type, units, amount, units_after, amount_after FROM shipping_item_refund_events WHERE user_id = ${u.id} ORDER BY units_after`;
    assert.deepEqual(events.map((e) => [e.sourceType, e.units, e.amount, e.unitsAfter, e.amountAfter]), [['USER_RECYCLE', 1, 7, 1, 7], ['USER_RECYCLE', 1, 8, 2, 15], ['USER_RECYCLE', 2, 15, 4, 30]]);
    const view = (await (await myShippingRefunds.GET(apiRequest('GET', '/api/me/shipping-refunds', { token: u.token }), none)).json()) as { sets: { refundedUnits: number; refundedAmount: number }[]; rule: string };
    assert.deepEqual(view.sets.map((x) => [x.refundedUnits, x.refundedAmount]), [[4, 30]]);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
    assert.equal((await verifyAuditChain(db())).ok, true);
  });

  it('fee 200: recycling 5 at once → 50; the fee (and N) are locked from the first prepaid fee', async () => {
    const poolId = await publishPool(smallOnly(200));
    const setId = await setIdOf(poolId);
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 8);
    // 後台之後調整運費與 N：已預收者沿用鎖定的運費；N 於第一次退還時鎖定
    const ops = await makeUser({ roles: ['OPS'] });
    await updateSetConfig(ops.principal, poolId, 1, { shippingFeeHome: 300 });
    const smalls = await smallsOf(u.id);
    assert.equal((await recycleItems(u.id, smalls.slice(0, 5).map((i) => i.id))).shippingRefundCoins, 50);
    await updateSetConfig(ops.principal, poolId, 1, { shipRefundDiv: 10 });
    assert.equal((await recycleItems(u.id, [smalls[5]!.id])).shippingRefundCoins, 10, 'N stays 20 for this member: floor(200×6/20) − 50');
    assert.deepEqual(await accOf(u.id, setId), { feeCoins: 200, divisor: 20, refundedUnits: 6, refundedAmount: 60 });
    // 新會員在 N=10 之後才第一次退還 → 使用 N=10、運費為其預收的 300
    const v = await makeUser({ coins: 5000 });
    await draw(v.id, poolId, 1);
    assert.equal((await recycleItems(v.id, [(await smallsOf(v.id))[0]!.id])).shippingRefundCoins, 30);
  });

  it('only SMALL prizes refund; prizes from sets without a prepaid fee refund nothing', async () => {
    const poolId = await publishPool(customPool({ shippingFeeHome: 160 }));
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 40);
    const items = await listWarehouse(db(), u.id, 'STORED');
    const mid = items.find((i) => i.levelNo === 2)!;
    const small = items.find((i) => i.isSmall)!;
    const r = await recycleItems(u.id, [mid.id, small.id]);
    assert.deepEqual([r.shippingRefundCoins, r.shippingRefunds[0]!.units], [8, 1], 'MID recycled for points only; 1 SMALL → 160/20');
  });
});

describe('recycled smalls still count toward the fee threshold (no double benefit)', () => {
  it('draw 19 → recycle 10 (refund) → draw 1 more: 20 smalls drawn → second fee charged', async () => {
    const poolId = await publishPool(smallOnly(150));
    const u = await makeUser({ coins: 5000 });
    assert.equal((await draw(u.id, poolId, 19)).shipping.feesToCharge, 1);
    const r = await recycleItems(u.id, (await smallsOf(u.id)).slice(0, 10).map((i) => i.id));
    assert.equal(r.shippingRefundCoins, 75);
    const d = await draw(u.id, poolId, 1);
    assert.deepEqual([d.shipping.smallItemsDrawn, d.shipping.feesToCharge, d.shipping.feesPaidAfter], [19, 1, 2]);
    // 沒有任何「釋放已付運費」：份數只增不減
    assert.equal(((await db()`SELECT count(*)::int AS n FROM shipping_prepayments WHERE user_id = ${u.id}`) as unknown as [{ n: number }])[0].n, 2);
  });
});

describe('idempotency and concurrency', () => {
  it('Idempotency-Key replays the same result without a second credit; reused key with other items → 422; DB rejects a duplicate event', async () => {
    const poolId = await publishPool(smallOnly(150));
    const setId = await setIdOf(poolId);
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 3);
    const [a, b] = await smallsOf(u.id);
    const req = (ids: string[], k2: string) => recycleRoute(apiRequest('POST', '/api/me/recycle', { token: u.token, headers: { 'idempotency-key': k2 }, body: { itemIds: ids } }), none);
    const first = await req([a!.id], 'recycle-key-0001');
    assert.equal(first.status, 200);
    const b1 = (await first.json()) as { batchId: string; shippingRefundCoins: number; replayed: boolean };
    const again = await req([a!.id], 'recycle-key-0001');
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    const b2 = (await again.json()) as { batchId: string; shippingRefundCoins: number };
    assert.deepEqual([b2.batchId, b2.shippingRefundCoins], [b1.batchId, 7]);
    assert.equal((await req([b!.id], 'recycle-key-0001')).status, 422);
    assert.equal((await refundLedger(u.id)).length, 1, 'credited once');
    assert.equal((await recycleRoute(apiRequest('POST', '/api/me/recycle', { token: u.token, body: { itemIds: [a!.id] } }), none)).status, 409, 'same item cannot be recycled twice');
    await assert.rejects(
      db()`INSERT INTO shipping_item_refund_events (user_id, set_id, source_type, source_id, units, amount, units_after, amount_after)
           VALUES (${u.id}, ${setId}, 'USER_RECYCLE', ${b1.batchId}, 1, 0, 2, 15)`,
      /shipping_item_refund_events_source_id_set_id_key/,
    );
    await assert.rejects(db()`UPDATE shipping_item_refunds SET refunded_amount = 999 WHERE user_id = ${u.id}`, /shipping_item_refunds_formula/);
  });

  it('concurrent recycles of the same set never over-refund (10 × 1 item, fee 150 → exactly 75)', async () => {
    const poolId = await publishPool(smallOnly(150));
    const setId = await setIdOf(poolId);
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 10);
    const smalls = await smallsOf(u.id);
    const rs = await Promise.all(smalls.map((s) => recycleItems(u.id, [s.id])));
    assert.equal(rs.reduce((acc, r) => acc + r.shippingRefundCoins, 0), 75);
    assert.deepEqual(await accOf(u.id, setId), { feeCoins: 150, divisor: 20, refundedUnits: 10, refundedAmount: 75 });
    assert.deepEqual((await refundLedger(u.id)).reduce((acc, l) => acc + l.amount, 0), 75);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });
});

describe('storage-expiry auto-conversion uses the same per-item refund', () => {
  it('user recycle (7) + 3 expired smalls → total floor(150 × 4 / 20) = 30 → expiry pays 23', async () => {
    const poolId = await publishPool(smallOnly(150));
    const setId = await setIdOf(poolId);
    const u = await makeUser({ coins: 5000 });
    await draw(u.id, poolId, 4);
    const smalls = await smallsOf(u.id);
    await recycleItems(u.id, [smalls[0]!.id]);
    const res = await runStorageSweep(new Date(smalls[0]!.storageExpiresAt.getTime() + 1000));
    assert.ok(res.shippingRefundCoins >= 23);
    assert.deepEqual((await refundLedger(u.id)).map((l) => l.amount), [7, 23]);
    assert.deepEqual(await accOf(u.id, setId), { feeCoins: 150, divisor: 20, refundedUnits: 4, refundedAmount: 30 });
    const [ev] = await db()`SELECT source_type, units FROM shipping_item_refund_events WHERE user_id = ${u.id} AND source_type = 'STORAGE_EXPIRY'`;
    assert.equal(ev!.units, 3);
    assert.equal((await getWallet(db(), u.id)).nonRefundableCoins, 30 + 3 * 50);
  });
});

describe('non-refundable coins and no NT$ shipping refunds', () => {
  it('breakdown label; refunds limited to refundable coins; non-refundable spent first; cash shipping refunds removed', async () => {
    const poolId = await publishPool(smallOnly(150));
    const u = await makeUser({ coins: 1000 });
    await draw(u.id, poolId, 2, 'CVS_711_C2C');
    await recycleItems(u.id, [(await smallsOf(u.id))[0]!.id]); // floor(70/20) = 3
    const b = (await (await breakdownRoute(apiRequest('GET', '/api/me/wallet/breakdown', { token: u.token }), none)).json()) as Awaited<ReturnType<typeof getCoinBreakdown>>;
    assert.equal(b.nonRefundableLabel, '不可退款・無法轉換，如有疑問請聯絡官方小編');
    assert.equal(NONREFUNDABLE_LABEL, b.nonRefundableLabel);
    assert.deepEqual([b.nonRefundableCoins, b.nonRefundableCredited.SHIPPING_REFUND_COINS], [Math.floor(FEE_CVS / 20), 3]);
    await expectAppError(createRefundRequest(u.id, b.refundableCoins + 1, 'x'), 'INSUFFICIENT_FUNDS');
    await assert.rejects(transaction((tx) => postLedger(tx, { userId: u.id, currency: 'COINS', amount: 5, entryType: 'SHIPPING_REFUND_COINS', refType: 't', refId: 't', refundable: true })), /always non-refundable/);
    const before = await getWallet(db(), u.id);
    await draw(u.id, poolId, 1, 'CVS_711_C2C');
    const w = await getWallet(db(), u.id);
    assert.deepEqual([w.nonRefundableCoins, w.refundableCoins], [0, before.refundableCoins - (10 - 3)]);
    // 新台幣運費退款已移除：只有唯讀 GET；舊表禁止新增
    assert.deepEqual(Object.keys(myShippingRefunds).filter((x) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(x)), ['GET']);
    const [pp] = await db()`SELECT id, set_id FROM shipping_prepayments WHERE user_id = ${u.id} LIMIT 1`;
    await assert.rejects(
      db()`INSERT INTO shipping_fee_refunds (user_id, set_id, prepayment_id, mode, fee_coins, ratio_bp, amount, status)
           VALUES (${u.id}, ${pp!.setId}, ${pp!.id}, 'COINS', 70, 5000, 35, 'PAID')`,
      /append-only/,
    );
  });
});
