/**
 * 業主 2026-10 商業規則：等級制獎項、每套每獎回收值、寄存 30 天＋到期自動轉代幣（不可退款）、
 * 運費按套預收（一份涵蓋 20 件小獎）、物流方式與運費範圍、試算端點、出貨時程說明。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../src/server/db';
import { resetConfig } from '../src/server/config';
import { executeDraw } from '../src/server/modules/draw/draw';
import { createPoolDraft, updateSetConfig } from '../src/server/modules/pool/admin';
import { getSetBoard } from '../src/server/modules/pool/queries';
import { listWarehouse, recycleItems } from '../src/server/modules/warehouse/warehouse';
import { runStorageSweep } from '../src/server/modules/warehouse/storage';
import { requestShipment } from '../src/server/modules/shipping/shipping';
import { getWallet, postLedger, reconcileWallets } from '../src/server/modules/wallet/wallet';
import { createRefundRequest } from '../src/server/modules/wallet/refunds';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import { POST as quoteRoute } from '../src/app/api/draws/quote/route';
import { POST as drawRoute } from '../src/app/api/draws/route';
import { GET as notificationsRoute, POST as markReadRoute } from '../src/app/api/me/notifications/route';
import { GET as warehouseRoute } from '../src/app/api/me/warehouse/route';
import { PATCH as setConfigRoute } from '../src/app/api/admin/pools/[id]/sets/[no]/route';
import { PATCH as poolSettingsRoute } from '../src/app/api/admin/pools/[id]/route';
import { POST as sweepRoute } from '../src/app/api/admin/jobs/storage-sweep/route';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { apiRequest, ctx, customPool, expectAppError, FEE_CVS, FEE_HOME, layoutOf, ledgerOf, makeUser, publishPool, setupTestDb, walletOf } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `br-${process.pid}-${++k}-${Date.now()}`;
const none = undefined as never;
before(async () => {
  env = await setupTestDb({ RISK_DRAW_LIMIT_PER_MIN: '1000' });
});
after(async () => {
  await env.teardown();
});

const prepaidCount = async (userId: string) =>
  ((await db()`SELECT count(*)::int AS n FROM shipping_prepayments WHERE user_id = ${userId}`) as unknown as [{ n: number }])[0].n;
const ledgerTypes = async (userId: string, type: string) => (await ledgerOf(userId)).filter((l) => l.entryType === type);

/** 依等級挑籤號 */
async function ticketsByGrade(poolId: string, setNo = 1) {
  const l = await layoutOf(poolId, setNo);
  const avail = l.filter((t) => t.status === 'AVAILABLE');
  return {
    GRAND: avail.filter((t) => t.grade === 'GRAND').map((t) => t.ticketNo),
    MID: avail.filter((t) => t.grade === 'MID').map((t) => t.ticketNo),
    SMALL: avail.filter((t) => t.grade === 'SMALL').map((t) => t.ticketNo),
  };
}

describe('rule 1 — custom pools have no ranks: displayName & grade in API output', () => {
  it('draw results, set board, warehouse expose displayName (= name) and grade; never a rank letter', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 5000 });
    const t = await ticketsByGrade(poolId);
    const res = await drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, ticketNos: [t.GRAND[0], t.MID[0], t.SMALL[0]], shippingMethod: 'CVS_711_C2C' } }), none);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { results: { rank: string | null; grade: string; displayName: string; prizeName: string }[] };
    const order = { GRAND: 0, MID: 1, SMALL: 2 } as Record<string, number>;
    const got = body.results.map((r) => [r.rank, r.grade, r.displayName] as const).sort((a, b) => order[a[1]]! - order[b[1]]!);
    assert.deepEqual(got, [[null, 'GRAND', '原創雕像'], [null, 'MID', '半身像'], [null, 'SMALL', '壓克力立牌']]);
    const board = await getSetBoard(db(), poolId, 1);
    assert.ok(board.prizes.every((p) => p.rank === null && p.displayName === p.name));
    const taken = board.tickets.filter((x) => x.state === 'TAKEN') as { grade?: string; displayName?: string; rank?: string }[];
    assert.equal(taken.length, 3);
    assert.ok(taken.every((x) => x.grade && x.displayName && !('rank' in x)));
    const wh = (await (await warehouseRoute(apiRequest('GET', '/api/me/warehouse', { token: u.token }), none)).json()) as { items: { grade: string; displayName: string; rank: string | null; storageExpiresAt: string; recycleValue: number | null }[] };
    assert.deepEqual(wh.items.map((i) => i.grade).sort(), ['GRAND', 'MID', 'SMALL']);
    assert.ok(wh.items.every((i) => i.rank === null && i.displayName && i.storageExpiresAt));
    const pool = (await (await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId }))).json()) as { shippingNote: string; prizes: { displayName: string; grade: string }[] };
    assert.equal(pool.shippingNote, '平台商品依平台公告時程');
    assert.deepEqual(pool.prizes.map((p) => p.displayName), ['原創雕像', '半身像', '壓克力立牌']);
  });
});

describe('rule 2 — recycle value is per prize per set (admin), user recycling credits POINTS', () => {
  it('uses the set-specific value; admin can change value / recyclable flag per set; GRAND default non-recyclable', async () => {
    const poolId = await publishPool(
      customPool({
        setCount: 2,
        prizes: [
          { name: '原創雕像', grade: 'GRAND', qtyPerSet: 1 },
          { name: '半身像', grade: 'MID', qtyPerSet: 1, recycleValue: 400 },
          { name: '壓克力立牌', grade: 'SMALL', qtyPerSet: 8, recycleValue: 50 },
        ],
      }),
    );
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    const [small] = await db()<{ id: string }[]>`SELECT id FROM pool_prizes WHERE pool_id = ${poolId} AND name = '壓克力立牌'`;
    const [mid] = await db()<{ id: string }[]>`SELECT id FROM pool_prizes WHERE pool_id = ${poolId} AND name = '半身像'`;
    await expectAppError(updateSetConfig(member.principal, poolId, 1, { prizes: [{ prizeId: small!.id, recycleValue: 1 }] }), 'FORBIDDEN');
    await updateSetConfig(ops.principal, poolId, 1, { prizes: [{ prizeId: small!.id, recycleValue: 77 }, { prizeId: mid!.id, recyclable: false }] });

    const u = await makeUser({ coins: 5000 });
    await executeDraw(u.id, key(), { poolId, setNo: 1, count: 10, shippingMethod: 'CVS_711_C2C' }); // 整套 → 第 2 套開賣
    await executeDraw(u.id, key(), { poolId, setNo: 2, ticketNos: (await ticketsByGrade(poolId, 2)).SMALL.slice(0, 1), shippingMethod: 'CVS_711_C2C' });
    const items = await listWarehouse(db(), u.id, 'STORED');
    const set1Small = items.filter((i) => i.setNo === 1 && i.grade === 'SMALL');
    const set2Small = items.filter((i) => i.setNo === 2 && i.grade === 'SMALL');
    assert.ok(set1Small.every((i) => i.recycleValue === 77) && set2Small.every((i) => i.recycleValue === 50));
    const p0 = (await walletOf(u.id)).points;
    const r = await recycleItems(u.id, [set1Small[0]!.id, set2Small[0]!.id]);
    assert.equal(r.points, 77 + 50, 'set 1 value 77, set 2 keeps default 50');
    assert.equal((await walletOf(u.id)).points, p0 + 127);
    assert.equal((await ledgerTypes(u.id, 'RECYCLE_CREDIT')).length, 1);
    const grand = items.find((i) => i.grade === 'GRAND')!;
    await expectAppError(recycleItems(u.id, [grand.id]), 'NOT_RECYCLABLE');
    const set1Mid = items.find((i) => i.setNo === 1 && i.grade === 'MID')!;
    await expectAppError(recycleItems(u.id, [set1Mid.id]), 'NOT_RECYCLABLE');
    const [audit] = await db()`SELECT payload_json FROM audit_log WHERE action = 'SET_CONFIG_UPDATED' ORDER BY seq DESC LIMIT 1`;
    assert.match(audit!.payloadJson as string, /"recycleValue":77/);
  });
});

describe('rule 3 — storage: 30 days free, 7-day + expiry-day notices, auto-convert to non-refundable COINS', () => {
  it('sweep notifies, converts at per-prize value, holds non-recyclable items, is idempotent (also concurrently), coins excluded from refundable balance', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 1000 });
    const t = await ticketsByGrade(poolId);
    await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t.GRAND[0]!, t.MID[0]!, ...t.SMALL.slice(0, 4)], shippingMethod: 'CVS_711_C2C' });
    const items = await listWarehouse(db(), u.id);
    const expiresAt = items[0]!.storageExpiresAt;
    const days = (expiresAt.getTime() - items[0]!.createdAt.getTime()) / 86_400_000;
    assert.ok(Math.abs(days - 30) < 0.01, `30-day free storage, got ${days}`);
    // 一件小獎在到期前已出貨申請 → 不受到期轉換影響
    const shipped = items.find((i) => i.grade === 'SMALL')!;
    await requestShipment(u.id, { itemIds: [shipped.id], method: 'CVS_711_C2C', recipientName: 'A', recipientPhone: '0912345678', cvsStoreId: '1234' });

    // 掃描是全域的（本檔其他測試的會員也會被處理），因此以下以「本會員」的資料驗證
    const DAY = 86_400_000;
    const ZERO = { autoConverted: 0, coinsCredited: 0, expiredHeld: 0, warnedToday: 0, warned7d: 0, notifications: 0 };
    const notesOf = async (type: string) =>
      ((await db()`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${u.id} AND type = ${type}`) as unknown as [{ n: number }])[0].n;
    const marks = async (col: 'storage_warned_7d_at' | 'storage_warned_day_at') =>
      ((await db()`SELECT count(*)::int AS n FROM warehouse_items WHERE user_id = ${u.id} AND ${db()(col)} IS NOT NULL`) as unknown as [{ n: number }])[0].n;
    assert.deepEqual(await runStorageSweep(new Date()), ZERO, 'nothing due yet');
    // 到期前 7 天（台灣日期）
    const r7 = await runStorageSweep(new Date(expiresAt.getTime() - 7 * DAY + 60_000));
    assert.ok(r7.warned7d >= 5);
    assert.equal(await marks('storage_warned_7d_at'), 5, 'only the 5 STORED items (the ship-requested one is excluded)');
    assert.equal(await notesOf('STORAGE_EXPIRY_7D'), 1, 'one grouped notification per user');
    assert.equal((await runStorageSweep(new Date(expiresAt.getTime() - 7 * DAY + 120_000))).notifications, 0, '7-day notice only once');
    assert.equal(await notesOf('STORAGE_EXPIRY_7D'), 1);
    // 到期當日（台灣日期，到期時刻之前）
    const twMidnight = Math.floor((expiresAt.getTime() + 8 * 3600_000) / DAY) * DAY - 8 * 3600_000;
    const sameDay = new Date(twMidnight + Math.floor((expiresAt.getTime() - twMidnight) / 2));
    const rDay = await runStorageSweep(sameDay);
    assert.ok(rDay.warnedToday >= 5);
    assert.equal(await marks('storage_warned_day_at'), 5);
    assert.equal(await notesOf('STORAGE_EXPIRY_TODAY'), 1);
    assert.equal(await ledgerTypes(u.id, 'EXPIRY_AUTO_CONVERT').then((l) => l.length), 0, 'not converted before the expiry instant');
    assert.equal((await runStorageSweep(sameDay)).notifications, 0, 'expiry-day notice only once');

    // 到期後：3 件小獎（每件 50）＋中獎 400 → 共 550 代幣；大獎不可回收 → 保留＋通知
    const coins0 = (await walletOf(u.id)).coins;
    const after = new Date(expiresAt.getTime() + 1000);
    const runs = await Promise.all([runStorageSweep(after), runStorageSweep(after), runStorageSweep(after)]);
    assert.ok(runs.reduce((s, r) => s + r.autoConverted, 0) >= 4);
    assert.deepEqual(await runStorageSweep(new Date(after.getTime() + DAY)), ZERO, 'idempotent: a later run finds nothing to do');
    assert.equal(await notesOf('STORAGE_AUTO_CONVERTED'), 1, 'concurrent sweeps notify once');
    assert.equal(await notesOf('STORAGE_EXPIRED_HOLD'), 1);

    const conv = await ledgerTypes(u.id, 'EXPIRY_AUTO_CONVERT');
    assert.equal(conv.length, 1, 'one credit for the batch');
    assert.equal(conv[0]!.amount, 550);
    assert.equal(conv[0]!.refundable, false, 'auto-converted coins are non-refundable by default');
    assert.equal((await walletOf(u.id)).coins, coins0 + 550, 'credited as COINS (代幣), not points');
    const after2 = await listWarehouse(db(), u.id);
    assert.equal(after2.filter((i) => i.recycleReason === 'STORAGE_EXPIRY' && i.status === 'RECYCLED').length, 4);
    assert.ok(after2.filter((i) => i.recycleReason === 'STORAGE_EXPIRY').every((i) => i.recycledCoins !== null && i.recycledPoints === null));
    assert.equal(after2.find((i) => i.grade === 'GRAND')!.status, 'STORED', 'non-recyclable prize is held for CS, not destroyed');
    assert.equal(after2.find((i) => i.id === shipped.id)!.status, 'SHIP_REQUESTED');
    const [audit] = await db()`SELECT count(*)::int AS n FROM audit_log WHERE action = 'STORAGE_EXPIRY_AUTO_CONVERT' AND payload_json LIKE ${'%' + u.id + '%'}`;
    assert.equal(audit!.n, 1);

    const notes = (await (await notificationsRoute(apiRequest('GET', '/api/me/notifications', { token: u.token }), none)).json()) as { notifications: { id: string; type: string; readAt: string | null }[] };
    assert.deepEqual(notes.notifications.map((n) => n.type).sort(), ['STORAGE_AUTO_CONVERTED', 'STORAGE_EXPIRED_HOLD', 'STORAGE_EXPIRY_7D', 'STORAGE_EXPIRY_TODAY']);
    const mr = (await (await markReadRoute(apiRequest('POST', '/api/me/notifications', { token: u.token, body: { ids: notes.notifications.map((n) => n.id) } }), none)).json()) as { updated: number };
    assert.equal(mr.updated, 4);

    // 可退款餘額不含自動轉換代幣
    const w = await getWallet(db(), u.id);
    assert.equal(w.nonRefundableCoins, 550);
    assert.equal(w.refundableCoins, w.coins - 550);
    await expectAppError(createRefundRequest(u.id, w.refundableCoins + 1, 'x'), 'INSUFFICIENT_FUNDS');
    await expectAppError(transaction((tx) => postLedger(tx, { userId: u.id, currency: 'COINS', amount: -(w.refundableCoins + 1), entryType: 'REFUND_DEBIT', refType: 't', refId: 't' })), 'INSUFFICIENT_FUNDS');
    await createRefundRequest(u.id, w.refundableCoins, 'all refundable coins');
    // 一般消費優先使用不可退款代幣
    await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t.SMALL[10]!] });
    assert.equal((await getWallet(db(), u.id)).nonRefundableCoins, 550 - 10);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok, 'reconciliation covers non-refundable balance chain');
    assert.equal((await verifyAuditChain(db())).ok, true);
    // 會員自己回收已到期轉換的物品 → 已非 STORED
    await expectAppError(recycleItems(u.id, [after2.find((i) => i.recycleReason === 'STORAGE_EXPIRY')!.id]), 'INVALID_STATE');
  });

  it('EXPIRY_COINS_REFUNDABLE=true makes auto-converted coins refundable (configurable)', async () => {
    process.env.EXPIRY_COINS_REFUNDABLE = 'true';
    resetConfig();
    try {
      const poolId = await publishPool(customPool());
      const u = await makeUser({ coins: 1000 });
      await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: (await ticketsByGrade(poolId)).SMALL.slice(0, 2), shippingMethod: 'CVS_711_C2C' });
      const [it0] = await listWarehouse(db(), u.id);
      await runStorageSweep(new Date(it0!.storageExpiresAt.getTime() + 1000));
      const conv = await ledgerTypes(u.id, 'EXPIRY_AUTO_CONVERT');
      assert.equal(conv[0]!.refundable, true);
      const w = await getWallet(db(), u.id);
      assert.equal(w.nonRefundableCoins, 0);
      assert.equal(w.refundableCoins, w.coins);
    } finally {
      delete process.env.EXPIRY_COINS_REFUNDABLE;
      resetConfig();
    }
  });

  it('POST /api/admin/jobs/storage-sweep requires jobs.run', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const m = await makeUser();
    assert.equal((await sweepRoute(apiRequest('POST', '/api/admin/jobs/storage-sweep', { token: m.token }), none)).status, 403);
    assert.equal((await sweepRoute(apiRequest('POST', '/api/admin/jobs/storage-sweep', { token: ops.token }), none)).status, 200);
  });
});

describe('rule 4 — shipping prepaid per set (按套收取)', () => {
  it('first paid draw charges the chosen method fee atomically; method required; within 20 SMALL no extra fee; >20 charges again; GRAND/MID do not count', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 5000 });
    const t = await ticketsByGrade(poolId);
    // 首抽未選物流方式 → 拒絕、零扣款
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t.SMALL[0]!] }), 'SHIPPING_METHOD_REQUIRED');
    await assert.rejects(executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t.SMALL[0]!], shippingMethod: 'CVS_OK' }), /Invalid enum value/);
    assert.equal((await walletOf(u.id)).coins, 5000);
    // 首抽：5 小獎，全家店到店 → 收一份超商運費（同一交易）
    let r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: t.SMALL.slice(0, 5), shippingMethod: 'CVS_FAMI_C2C' })).response;
    assert.deepEqual([r.shipping.feesToCharge, r.shipping.amount, r.shipping.method, r.shipping.feesPaidAfter, r.shipping.coverageAfter], [1, FEE_CVS, 'CVS_FAMI_C2C', 1, 20]);
    assert.equal(r.coinsAfter, 5000 - 50 - FEE_CVS);
    const [pp] = await db()`SELECT draw_id, seq, method, fee_coins, small_items_covered FROM shipping_prepayments WHERE user_id = ${u.id}`;
    assert.deepEqual(pp, { drawId: r.drawId, seq: 1, method: 'CVS_FAMI_C2C', feeCoins: FEE_CVS, smallItemsCovered: 20 });
    // 5 + 10 = 15 ≤ 20 → 不收（未指定方式亦可）
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: t.SMALL.slice(5, 15) })).response;
    assert.equal(r.shipping.feesToCharge, 0);
    // 大獎、中獎不計入：15 小獎 + 大獎 + 2 中獎 + 5 小獎 → 最壞 15 + 8 = 23 > 20 → 再收一份（沿用上次方式）
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t.GRAND[0]!, ...t.MID, ...t.SMALL.slice(15, 20)] })).response;
    assert.deepEqual([r.shipping.smallItemsHeld, r.shipping.worstCaseSmallItems, r.shipping.feesToCharge, r.shipping.method], [15, 23, 1, 'CVS_FAMI_C2C']);
    // 實際只持有 20 小獎（大獎/中獎不算）→ 下一抽 20 + 1 = 21 ≤ 40 → 不收
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t.SMALL[20]!] })).response;
    assert.deepEqual([r.shipping.smallItemsHeld, r.shipping.feesToCharge], [20, 0]);
    assert.equal(await prepaidCount(u.id), 2);
    const fees = await ledgerTypes(u.id, 'SHIPPING_PREPAID');
    assert.deepEqual(fees.map((f) => f.amount), [-FEE_CVS, -FEE_CVS]);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });

  it('home delivery uses the set home fee; one draw of many tickets can charge several fees at once', async () => {
    const poolId = await publishPool(customPool({ prizes: [{ name: '小獎', grade: 'SMALL', qtyPerSet: 50 }] }));
    const u = await makeUser({ coins: 5000 });
    const r = (await executeDraw(u.id, key(), { poolId, setNo: 1, count: 45, shippingMethod: 'HOME_DELIVERY' })).response;
    assert.deepEqual([r.shipping.feesToCharge, r.shipping.unitFee, r.shipping.amount], [3, FEE_HOME, 3 * FEE_HOME]);
    assert.equal(r.totalCoins, 450 + 3 * FEE_HOME);
    assert.deepEqual((await db()`SELECT seq FROM shipping_prepayments WHERE user_id = ${u.id} ORDER BY seq`).map((x) => x.seq), [1, 2, 3]);
  });

  it('recycled SMALL items free coverage → no second fee; shipped items still count (no free re-shipping)', async () => {
    const poolId = await publishPool(customPool());
    const t = await ticketsByGrade(poolId);
    const a = await makeUser({ coins: 5000 });
    await executeDraw(a.id, key(), { poolId, setNo: 1, ticketNos: t.SMALL.slice(0, 18), shippingMethod: 'CVS_711_C2C' });
    const smalls = (await listWarehouse(db(), a.id, 'STORED')).filter((i) => i.grade === 'SMALL');
    await recycleItems(a.id, smalls.slice(0, 5).map((i) => i.id)); // 持有 13
    const r = (await executeDraw(a.id, key(), { poolId, setNo: 1, ticketNos: t.SMALL.slice(18, 25) })).response; // 13 + 7 = 20
    assert.deepEqual([r.shipping.smallItemsHeld, r.shipping.feesToCharge], [13, 0], 'user who recycled small prizes is not charged again');
    assert.equal(await prepaidCount(a.id), 1);

    const b = await makeUser({ coins: 5000 });
    await executeDraw(b.id, key(), { poolId, setNo: 1, ticketNos: t.SMALL.slice(25, 35), shippingMethod: 'CVS_711_C2C' });
    const bItems = (await listWarehouse(db(), b.id, 'STORED')).map((i) => i.id);
    const s = await requestShipment(b.id, { itemIds: bItems, method: 'CVS_711_C2C', recipientName: 'B', recipientPhone: '0912345678', cvsStoreId: '1234' });
    assert.equal(s.feeCoins, 0, 'shipment of prepaid items is free');
    const rb = (await executeDraw(b.id, key(), { poolId, setNo: 1, ticketNos: t.SMALL.slice(35, 37).concat(t.MID) })).response;
    assert.equal(rb.shipping.smallItemsHeld, 10, 'shipped small items still consume the prepaid coverage');
    assert.equal(rb.shipping.feesToCharge, 0);
  });

  it('fee ranges: home 150–300, CVS C2C 60–150 (draft, admin per-set update, DB CHECK); new fee applies to later charges', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    for (const [home, cvs] of [[149, 70], [301, 70], [150, 59], [150, 151]] as const) {
      await assert.rejects(createPoolDraft(ops.principal, customPool({ shippingFeeHome: home, shippingFeeCvs: cvs })), /運費須介於/);
    }
    for (const [home, cvs] of [[150, 60], [300, 150]] as const) await createPoolDraft(ops.principal, customPool({ shippingFeeHome: home, shippingFeeCvs: cvs }));
    const poolId = await publishPool(customPool());
    const bad = await setConfigRoute(apiRequest('PATCH', `/api/admin/pools/${poolId}/sets/1`, { token: ops.token, body: { shippingFeeCvs: 151 } }), ctx({ id: poolId, no: '1' }));
    assert.equal(bad.status, 400);
    const m = await makeUser();
    assert.equal((await setConfigRoute(apiRequest('PATCH', `/api/admin/pools/${poolId}/sets/1`, { token: m.token, body: { shippingFeeCvs: 100 } }), ctx({ id: poolId, no: '1' }))).status, 403);
    const ok = await setConfigRoute(apiRequest('PATCH', `/api/admin/pools/${poolId}/sets/1`, { token: ops.token, body: { shippingFeeHome: 300, shippingFeeCvs: 150 } }), ctx({ id: poolId, no: '1' }));
    assert.equal(ok.status, 200);
    await assert.rejects(db()`UPDATE pool_sets SET ship_fee_home = 400 WHERE pool_id = ${poolId}`, /check constraint/);
    await assert.rejects(db()`UPDATE pool_sets SET ship_fee_cvs = 59 WHERE pool_id = ${poolId}`, /check constraint/);
    const u = await makeUser({ coins: 1000 });
    const r = (await executeDraw(u.id, key(), { poolId, setNo: 1, count: 1, shippingMethod: 'CVS_711_C2C' })).response;
    assert.equal(r.shipping.amount, 150);
    const note = await poolSettingsRoute(apiRequest('PATCH', `/api/admin/pools/${poolId}`, { token: ops.token, body: { shippingNote: '官方商品依官方出貨時程；平台商品依平台公告時程' } }), ctx({ id: poolId }));
    assert.equal(note.status, 200);
    const pool = (await (await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId }))).json()) as { shippingNote: string };
    assert.equal(pool.shippingNote, '官方商品依官方出貨時程；平台商品依平台公告時程');
  });

  it('insufficient coins for draw + fee → whole draw rolls back', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 10 + FEE_CVS - 1 });
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 1, shippingMethod: 'CVS_711_C2C' }), 'INSUFFICIENT_FUNDS');
    assert.equal((await walletOf(u.id)).coins, 10 + FEE_CVS - 1);
    assert.equal(await prepaidCount(u.id), 0);
    assert.equal((await layoutOf(poolId, 1)).filter((x) => x.status === 'TAKEN').length, 0);
  });

  it('race: many concurrent draws by the same user in one set charge exactly ceil(tickets / 20) fees', async () => {
    const poolId = await publishPool(customPool({ priceCoins: 5, prizes: [{ name: '小獎', grade: 'SMALL', qtyPerSet: 80 }] }));
    const START = 10_000;
    const u = await makeUser({ coins: START });
    const N = 30; // 30 筆 × 2 籤 = 60 籤 → 恰 3 份運費
    const keys = Array.from({ length: N }, () => key());
    const calls = keys.flatMap((kk, i) => {
      const body = { poolId, setNo: 1, ticketNos: [2 * i + 1, 2 * i + 2], shippingMethod: 'CVS_711_C2C' as const };
      // 每筆另外同鍵重送一次（冪等重播不得重複收運費）
      return [executeDraw(u.id, kk, body), executeDraw(u.id, kk, body)];
    });
    const rs = await Promise.all(calls);
    assert.equal(rs.filter((r) => !r.replayed).length, N);
    const charged = rs.filter((r) => !r.replayed).reduce((s, r) => s + r.response.shipping.feesToCharge, 0);
    assert.equal(charged, 3);
    assert.equal(await prepaidCount(u.id), 3);
    assert.deepEqual((await db()`SELECT seq FROM shipping_prepayments WHERE user_id = ${u.id} ORDER BY seq`).map((x) => x.seq), [1, 2, 3]);
    assert.equal((await ledgerTypes(u.id, 'SHIPPING_PREPAID')).length, 3);
    assert.equal((await walletOf(u.id)).coins, START - 60 * 5 - 3 * FEE_CVS);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
    assert.equal((await verifyAuditChain(db())).ok, true);
  });
});

describe('POST /api/draws/quote', () => {
  it('returns the shipping breakdown before payment and matches the actual draw charge', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 1000 });
    assert.equal((await quoteRoute(apiRequest('POST', '/api/draws/quote', { body: { poolId, setNo: 1, count: 1 } }), none)).status, 401);
    type Q = { ticketCount: number; drawCoins: number; totalCoins: number; coinsBalance: number; sufficientFunds: boolean; shipping: { methodRequired: boolean; feesToCharge: number; amount: number; method: string | null; options: { method: string; amount: number }[]; setFees: Record<string, number>; worstCaseSmallItems: number; rule: string } };
    const q0 = (await (await quoteRoute(apiRequest('POST', '/api/draws/quote', { token: u.token, body: { poolId, setNo: 1, count: 3 } }), none)).json()) as Q;
    assert.equal(q0.shipping.methodRequired, true);
    assert.equal(q0.shipping.feesToCharge, 1);
    assert.equal(q0.sufficientFunds, false, 'method must be chosen first');
    assert.deepEqual(q0.shipping.options, [
      { method: 'HOME_DELIVERY', unitFee: FEE_HOME, amount: FEE_HOME },
      { method: 'CVS_711_C2C', unitFee: FEE_CVS, amount: FEE_CVS },
      { method: 'CVS_FAMI_C2C', unitFee: FEE_CVS, amount: FEE_CVS },
    ]);
    assert.deepEqual(q0.shipping.setFees, { HOME_DELIVERY: FEE_HOME, CVS_711_C2C: FEE_CVS, CVS_FAMI_C2C: FEE_CVS });
    const res = await quoteRoute(apiRequest('POST', '/api/draws/quote', { token: u.token, body: { poolId, setNo: 1, count: 3, shippingMethod: 'HOME_DELIVERY' } }), none);
    const q1 = (await res.json()) as Q;
    assert.deepEqual([q1.drawCoins, q1.shipping.amount, q1.totalCoins, q1.sufficientFunds, q1.coinsBalance], [30, FEE_HOME, 30 + FEE_HOME, true, 1000]);
    const d = (await executeDraw(u.id, key(), { poolId, setNo: 1, count: 3, shippingMethod: 'HOME_DELIVERY' })).response;
    assert.equal(d.totalCoins, q1.totalCoins, 'quote == actual charge');
    assert.equal((await walletOf(u.id)).coins, 1000 - q1.totalCoins);
    // 已預收：再試算 30 籤 → 最壞 (持有小獎) + 30 > 20 → 需再收 1 份（沿用宅配）
    const q2 = (await (await quoteRoute(apiRequest('POST', '/api/draws/quote', { token: u.token, body: { poolId, setNo: 1, count: 30 } }), none)).json()) as Q;
    assert.equal(q2.shipping.method, 'HOME_DELIVERY');
    assert.ok(q2.shipping.worstCaseSmallItems > 20 && q2.shipping.worstCaseSmallItems <= 33);
    assert.equal(q2.shipping.feesToCharge, Math.ceil(q2.shipping.worstCaseSmallItems / 20) - 1);
  });
});

describe('rule 6 — age threshold stays 18', () => {
  it('AGE_MIN defaults to 18', async () => {
    const { config } = await import('../src/server/config');
    assert.equal(config().AGE_MIN, 18);
    const { verifyAge } = await import('../src/server/modules/auth/users');
    const u = await makeUser({ ageVerified: false });
    const now = new Date('2026-10-23T04:00:00Z');
    await expectAppError(verifyAge(u.id, '2008-10-24', now), 'FORBIDDEN');
    assert.equal((await verifyAge(u.id, '2008-10-23', now)).age, 18);
  });
});
