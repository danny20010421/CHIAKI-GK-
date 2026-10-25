/**
 * 業主 2026-10 商業規則：等級制獎項、每套每獎回收值、寄存 30 天＋到期自動轉 UC幣（不可退款）、
 * 運費到付（抽賞不收運費）、試算端點、出貨時程說明。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../src/server/db';
import { resetConfig } from '../src/server/config';
import { executeDraw } from '../src/server/modules/draw/draw';
import { updateSetConfig } from '../src/server/modules/pool/admin';
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
import { apiRequest, ctx, customPool, expectAppError, layoutOf, ledgerOf, makeUser, pickTickets, publishPool, setupTestDb, walletOf } from './helpers';

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

const ledgerTypes = async (userId: string, type: string) => (await ledgerOf(userId)).filter((l) => l.entryType === type);

/** 依等級挑籤號 */
async function ticketsByGrade(poolId: string, setNo = 1) {
  const l = await layoutOf(poolId, setNo);
  const avail = l.filter((t) => t.status === 'AVAILABLE');
  return {
    GRAND: avail.filter((t) => t.levelNo === 1).map((t) => t.ticketNo),
    MID: avail.filter((t) => t.levelNo > 1 && !t.isSmall).map((t) => t.ticketNo),
    SMALL: avail.filter((t) => t.isSmall).map((t) => t.ticketNo),
  };
}

describe('rule 1 — prize levels in API output (every pool type)', () => {
  it('draw results, set board, warehouse expose levelNo + levelName + displayName (level name + item name)', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 5000 });
    const t = await ticketsByGrade(poolId);
    const res = await drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, ticketNos: [t.GRAND[0], t.MID[0], t.SMALL[0]] } }), none);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { results: { levelNo: number; levelName: string; isSmall: boolean; displayName: string; prizeName: string; rank?: string; grade?: string }[] };
    const got = body.results.map((r) => [r.levelNo, r.levelName, r.isSmall, r.displayName] as const).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(got, [[1, '大獎', false, '大獎 原創雕像'], [2, '中獎', false, '中獎 半身像'], [3, '小獎', true, '小獎 壓克力立牌']]);
    assert.ok(body.results.every((r) => !('rank' in r) && !('grade' in r)), 'old rank/grade model removed');
    const board = await getSetBoard(db(), poolId, 1);
    assert.deepEqual(board.prizes.map((p) => [p.levelNo, p.levelName, p.displayName]), [[1, '大獎', '大獎 原創雕像'], [2, '中獎', '中獎 半身像'], [3, '小獎', '小獎 壓克力立牌']]);
    assert.deepEqual(board.levels.map((l) => [l.levelNo, l.total, l.remaining]), [[1, 1, 0], [2, 2, 1], [3, 37, 36]]);
    const taken = board.tickets.filter((x) => x.state === 'TAKEN') as { levelNo?: number; displayName?: string }[];
    assert.equal(taken.length, 3);
    assert.ok(taken.every((x) => x.levelNo && x.displayName));
    const wh = (await (await warehouseRoute(apiRequest('GET', '/api/me/warehouse', { token: u.token }), none)).json()) as { items: { levelNo: number; isSmall: boolean; displayName: string; storageExpiresAt: string; recycleValue: number | null }[] };
    assert.deepEqual(wh.items.map((i) => i.levelNo).sort(), [1, 2, 3]);
    assert.ok(wh.items.every((i) => i.displayName && i.storageExpiresAt));
    const pool = (await (await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId }))).json()) as { shippingNote: string; prizes: { displayName: string }[]; levels: { levelNo: number; name: string; isSmall: boolean; items: unknown[] }[] };
    assert.equal(pool.shippingNote, '平台商品依平台公告時程');
    assert.deepEqual(pool.prizes.map((p) => p.displayName), ['大獎 原創雕像', '中獎 半身像', '小獎 壓克力立牌']);
    assert.deepEqual(pool.levels.map((l) => [l.levelNo, l.name, l.isSmall, l.items.length]), [[1, '大獎', false, 1], [2, '中獎', false, 1], [3, '小獎', true, 1]]);
  });
});

describe('rule 2 — recycle value is per prize per set (admin), user recycling credits non-refundable UC幣', () => {
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
    await executeDraw(u.id, key(), { poolId, setNo: 1, count: 10 }); // 整套 → 第 2 套開賣
    await executeDraw(u.id, key(), { poolId, setNo: 2, ticketNos: (await ticketsByGrade(poolId, 2)).SMALL.slice(0, 1) });
    const items = await listWarehouse(db(), u.id, 'STORED');
    const set1Small = items.filter((i) => i.setNo === 1 && i.isSmall);
    const set2Small = items.filter((i) => i.setNo === 2 && i.isSmall);
    assert.ok(set1Small.every((i) => i.recycleValue === 77) && set2Small.every((i) => i.recycleValue === 50));
    const w0 = await walletOf(u.id);
    const r = await recycleItems(u.id, [set1Small[0]!.id, set2Small[0]!.id]);
    assert.equal(r.coins, 77 + 50, 'set 1 value 77, set 2 keeps default 50');
    assert.deepEqual(await walletOf(u.id), { coins: w0.coins + 127, nonRefundableCoins: w0.nonRefundableCoins + 127 }, 'recycle credits non-refundable UC幣 only');
    assert.deepEqual((await ledgerTypes(u.id, 'RECYCLE_CREDIT')).map((l) => [l.amount, l.refundable]), [[127, false]]);
    const grand = items.find((i) => i.levelNo === 1)!;
    await expectAppError(recycleItems(u.id, [grand.id]), 'NOT_RECYCLABLE');
    const set1Mid = items.find((i) => i.setNo === 1 && i.levelNo === 2)!;
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
    await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t.GRAND[0]!, t.MID[0]!, ...t.SMALL.slice(0, 4)] });
    const items = await listWarehouse(db(), u.id);
    const expiresAt = items[0]!.storageExpiresAt;
    const days = (expiresAt.getTime() - items[0]!.createdAt.getTime()) / 86_400_000;
    assert.ok(Math.abs(days - 30) < 0.01, `30-day free storage, got ${days}`);
    // 一件小獎在到期前已出貨申請 → 不受到期轉換影響
    const shipped = items.find((i) => i.isSmall)!;
    await requestShipment(u.id, { itemIds: [shipped.id], destinations: { c711: { recipientName: 'A', recipientPhone: '0912345678', cvsStoreId: '1234' } } });

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

    // 到期後：3 件小獎（每件 50）＋中獎 400 → 共 550 UC幣；大獎不可回收 → 保留＋通知
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
    // 運費到付：到期轉換不再有任何運費退還
    assert.equal((await walletOf(u.id)).coins, coins0 + 550, 'credited as UC幣');
    assert.equal((await ledgerTypes(u.id, 'SHIPPING_REFUND_COINS')).length, 0);
    const after2 = await listWarehouse(db(), u.id);
    assert.equal(after2.filter((i) => i.recycleReason === 'STORAGE_EXPIRY' && i.status === 'RECYCLED').length, 4);
    assert.ok(after2.filter((i) => i.recycleReason === 'STORAGE_EXPIRY').every((i) => i.recycledCoins !== null && !('recycledPoints' in i)));
    assert.equal(after2.find((i) => i.levelNo === 1)!.status, 'STORED', 'non-recyclable prize is held for CS, not destroyed');
    assert.equal(after2.find((i) => i.id === shipped.id)!.status, 'SHIP_REQUESTED');
    const [audit] = await db()`SELECT count(*)::int AS n FROM audit_log WHERE action = 'STORAGE_EXPIRY_AUTO_CONVERT' AND payload_json LIKE ${'%' + u.id + '%'}`;
    assert.equal(audit!.n, 1);

    const notes = (await (await notificationsRoute(apiRequest('GET', '/api/me/notifications', { token: u.token }), none)).json()) as { notifications: { id: string; type: string; readAt: string | null }[] };
    assert.deepEqual(notes.notifications.map((n) => n.type).sort(), ['STORAGE_AUTO_CONVERTED', 'STORAGE_EXPIRED_HOLD', 'STORAGE_EXPIRY_7D', 'STORAGE_EXPIRY_TODAY']);
    const mr = (await (await markReadRoute(apiRequest('POST', '/api/me/notifications', { token: u.token, body: { ids: notes.notifications.map((n) => n.id) } }), none)).json()) as { updated: number };
    assert.equal(mr.updated, 4);

    // 可退款餘額不含自動轉換 UC幣
    const w = await getWallet(db(), u.id);
    assert.equal(w.nonRefundableCoins, 550);
    assert.equal(w.refundableCoins, w.coins - 550);
    await expectAppError(createRefundRequest(u.id, w.refundableCoins + 1, 'x'), 'INSUFFICIENT_FUNDS');
    await expectAppError(transaction((tx) => postLedger(tx, { userId: u.id, amount: -(w.refundableCoins + 1), entryType: 'REFUND_DEBIT', refType: 't', refId: 't' })), 'INSUFFICIENT_FUNDS');
    await createRefundRequest(u.id, w.refundableCoins, 'all refundable coins');
    // 一般消費優先使用不可退款 UC幣
    await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t.SMALL[10]!] });
    assert.equal((await getWallet(db(), u.id)).nonRefundableCoins, 550 - 10);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok, 'reconciliation covers non-refundable balance chain');
    assert.equal((await verifyAuditChain(db())).ok, true);
    // 會員自己回收已到期轉換的物品 → 已非 STORED
    await expectAppError(recycleItems(u.id, [after2.find((i) => i.recycleReason === 'STORAGE_EXPIRY')!.id]), 'INVALID_STATE');
  });

  it('the old EXPIRY_COINS_REFUNDABLE toggle is removed: auto-converted coins are always non-refundable', async () => {
    process.env.EXPIRY_COINS_REFUNDABLE = 'true';
    resetConfig();
    try {
      const poolId = await publishPool(customPool());
      const u = await makeUser({ coins: 1000 });
      await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: (await ticketsByGrade(poolId)).SMALL.slice(0, 2) });
      const [it0] = await listWarehouse(db(), u.id);
      await runStorageSweep(new Date(it0!.storageExpiresAt.getTime() + 1000));
      const conv = await ledgerTypes(u.id, 'EXPIRY_AUTO_CONVERT');
      assert.equal(conv[0]!.refundable, false);
      const w = await getWallet(db(), u.id);
      // 2 件小獎 × 回收值 50，全部不可退款（運費到付：無運費退還）
      assert.equal(w.nonRefundableCoins, 100);
      assert.equal(w.refundableCoins, w.coins - 100);
      await assert.rejects(transaction((tx) => postLedger(tx, { userId: u.id, amount: 1, entryType: 'EXPIRY_AUTO_CONVERT', refType: 't', refId: 't', refundable: true })), /always non-refundable/);
      await assert.rejects(db()`INSERT INTO wallet_ledger (user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, refundable, nonrefundable_after)
                                VALUES (${u.id}, 'COINS', 1, 1, 'REFERRAL_REWARD', 't', 't', true, 0)`, /ledger_nonrefundable_sources/);
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

describe('rule 4 — freight collect (運費到付): no shipping charge at draw time', () => {
  it('a draw debits only the ticket price; no prepaid fee, no method needed; legacy shippingMethod is ignored', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 5000 });
    const t = await ticketsByGrade(poolId);
    const r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: t.SMALL.slice(0, 5) })).response;
    assert.deepEqual([r.amountCoins, r.totalCoins, r.freightCollect, r.coinsAfter], [50, 50, true, 5000 - 50]);
    assert.ok(!('shipping' in r), 'no prepaid shipping block in the response');
    // 舊客戶端仍帶 shippingMethod → 忽略，不收任何運費
    const r2 = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: t.SMALL.slice(5, 30), shippingMethod: 'HOME_DELIVERY' })).response;
    assert.deepEqual([r2.totalCoins, r2.coinsAfter], [250, 5000 - 300]);
    const types = (await ledgerOf(u.id)).map((l) => l.entryType);
    assert.deepEqual(types, ['ADMIN_ADJUST', 'DRAW_DEBIT', 'DRAW_DEBIT']);
    const [d] = await db()`SELECT column_name FROM information_schema.columns WHERE table_name = 'draws' AND column_name = 'shipping_coins'`;
    assert.equal(d, undefined, 'draws.shipping_coins removed');
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });

  it('retired shipping ledger types and prepaid tables are gone; per-set fee config is rejected', async () => {
    const u = await makeUser({ coins: 100 });
    for (const t of ['SHIPPING_PREPAID', 'SHIPPING_FEE', 'SHIPPING_REFUND_COINS']) {
      await assert.rejects(
        db()`INSERT INTO wallet_ledger (user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, nonrefundable_after)
             VALUES (${u.id}, 'COINS', -1, 99, ${t}, 't', 't', 0)`,
        /ledger_retired_entry_types/,
      );
    }
    const tables = await db()<{ t: string }[]>`
      SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'
        AND table_name IN ('shipping_prepayments', 'shipping_fee_refunds', 'shipping_item_refunds', 'shipping_item_refund_events')`;
    assert.equal(tables.length, 0);
    const ops = await makeUser({ roles: ['OPS'] });
    const poolId = await publishPool(customPool());
    const bad = await setConfigRoute(apiRequest('PATCH', `/api/admin/pools/${poolId}/sets/1`, { token: ops.token, body: { shippingFeeCvs: 100 } }), ctx({ id: poolId, no: '1' }));
    assert.equal(bad.status, 400, 'per-set shipping fees no longer exist');
    const m = await makeUser();
    assert.equal((await setConfigRoute(apiRequest('PATCH', `/api/admin/pools/${poolId}/sets/1`, { token: m.token, body: { prizes: [] } }), ctx({ id: poolId, no: '1' }))).status, 403);
    const note = await poolSettingsRoute(apiRequest('PATCH', `/api/admin/pools/${poolId}`, { token: ops.token, body: { shippingNote: '官方商品依官方出貨時程；平台商品依平台公告時程' } }), ctx({ id: poolId }));
    assert.equal(note.status, 200);
    const pool = (await (await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId }))).json()) as {
      shippingNote: string;
      shippingPolicy: { mode: string; freightCollect: boolean };
      sets: Record<string, unknown>[];
      rules: { content: { shippingPolicy: { mode: string } } };
    };
    assert.equal(pool.shippingNote, '官方商品依官方出貨時程；平台商品依平台公告時程');
    assert.deepEqual([pool.shippingPolicy.mode, pool.shippingPolicy.freightCollect, pool.rules.content.shippingPolicy.mode], ['FREIGHT_COLLECT', true, 'FREIGHT_COLLECT']);
    assert.ok(pool.sets.every((x) => !('shippingFees' in x)));
  });

  it('insufficient coins → whole draw rolls back', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 9 });
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 1 }), 'INSUFFICIENT_FUNDS');
    assert.equal((await walletOf(u.id)).coins, 9);
    assert.equal((await layoutOf(poolId, 1)).filter((x) => x.status === 'TAKEN').length, 0);
  });
});

describe('POST /api/draws/quote', () => {
  it('returns the ticket cost (freight collect, no shipping) and matches the actual draw charge', async () => {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins: 1000 });
    assert.equal((await quoteRoute(apiRequest('POST', '/api/draws/quote', { body: { poolId, setNo: 1, count: 1 } }), none)).status, 401);
    type Q = { ticketCount: number; drawCoins: number; totalCoins: number; coinsBalance: number; sufficientFunds: boolean; freightCollect: boolean; shippingNote: string };
    const res = await quoteRoute(apiRequest('POST', '/api/draws/quote', { token: u.token, body: { poolId, setNo: 1, count: 3 } }), none);
    const q1 = (await res.json()) as Q;
    assert.deepEqual([q1.ticketCount, q1.drawCoins, q1.totalCoins, q1.sufficientFunds, q1.coinsBalance, q1.freightCollect], [3, 30, 30, true, 1000, true]);
    assert.match(q1.shippingNote, /運費到付/);
    const d = (await executeDraw(u.id, key(), { poolId, setNo: 1, count: 3 })).response;
    assert.equal(d.totalCoins, q1.totalCoins, 'quote == actual charge');
    assert.equal((await walletOf(u.id)).coins, 1000 - q1.totalCoins);
    const q2 = (await (await quoteRoute(apiRequest('POST', '/api/draws/quote', { token: u.token, body: { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 30) } }), none)).json()) as Q;
    assert.deepEqual([q2.totalCoins, q2.sufficientFunds], [300, true]);
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
