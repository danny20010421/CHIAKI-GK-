/**
 * 業主 2026-10 第九批：
 *  1. 卡牌機率賞「世界之王」（種子）：每套 200,010 籤、抽包 1/10/100、4 獎固定機率 50%、抽賞演出 VIDEO；
 *     100 抽以抽選索引完成（每抽不掃描整套籤表；索引與 pickTickets 逐張一致、可驗證）。
 *  2. 抽賞結果「轉換 UC幣」：POST /api/me/draws/:drawId/convert。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, transaction } from '../src/server/db';
import { executeDraw, type DrawResponse } from '../src/server/modules/draw/draw';
import { checkoutProbIndex, probIndexStats, releaseProbIndex, resetProbIndexCache } from '../src/server/modules/draw/prob-cache';
import { pickTickets as pickProbTickets, ProbIndex, ProbRng, replayProbSet, type LevelOdds } from '../src/server/modules/pool/prob';
import { WK_POOL } from '../src/server/seed/reference';
import { reconcileWallets } from '../src/server/modules/wallet/wallet';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { GET as setRoute } from '../src/app/api/pools/[id]/sets/[no]/route';
import { GET as listRoute } from '../src/app/api/pools/route';
import { POST as convertRoute } from '../src/app/api/me/draws/[id]/convert/route';
import { apiRequest, ctx, customPool, expectAppError, ledgerOf, makeUser, pickTickets, publishPool, setupTestDb, walletOf } from './helpers';

const key = () => `wk-${randomUUID()}`;
const none = undefined as never;
const j = async <T>(r: Response) => ({ status: r.status, body: (await r.json()) as T });

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

describe('ProbIndex (pure)', () => {
  it('picks exactly the same tickets as pickTickets for the same seed stream (fixed odds, exhausted levels, REST and ALL fallbacks)', () => {
    const layout: { ticketNo: number; levelNo: number }[] = [];
    const counts = [1, 2, 3, 40, 60];
    let no = 1;
    counts.forEach((c, i) => {
      for (let k = 0; k < c; k++) layout.push({ ticketNo: no++, levelNo: i + 1 });
    });
    // 打亂籤號與等級的對應（模擬洗牌後的籤表）
    const shuffled = layout.map((t, i) => ({ ticketNo: t.ticketNo, levelNo: layout[(i * 37) % layout.length]!.levelNo }));
    for (const odds of [
      new Map<number, number | null>([[1, 0.05], [2, null], [3, null], [4, 0.5], [5, null]]),
      new Map<number, number | null>([[1, null], [2, null], [3, null], [4, null], [5, null]]),
      new Map<number, number | null>([[1, 0.1], [2, 0.1], [3, 0.1], [4, 0.3], [5, 0.3]]),
    ] as LevelOdds[]) {
      const remaining = shuffled.map((t) => ({ ...t }));
      const idx = new ProbIndex(shuffled.map((t) => ({ ...t, available: true })), odds);
      const seed = 'ab'.repeat(32);
      for (let nonce = 1; remaining.length; nonce++) {
        const n = Math.min(remaining.length, (nonce % 7) + 1);
        const a = pickProbTickets(remaining, odds, new ProbRng(seed, 'c', nonce), n).map((t) => t.ticketNo);
        const b = idx.pick(new ProbRng(seed, 'c', nonce), n).map((t) => t.ticketNo);
        assert.deepEqual(b, a, `nonce ${nonce}`);
        assert.equal(idx.remaining, remaining.length);
      }
    }
  });
});

describe('世界之王 card pool (seed)', () => {
  let poolId: string;
  before(async () => {
    poolId = await publishPool(WK_POOL);
    resetProbIndexCache();
  });

  it('seed definition: custom PROB, IP 航海王, tag 卡牌 everywhere, 200 per draw, packs 1/10/100, VIDEO animation, 200,010 tickets per set', async () => {
    const { status, body: p } = await j<{
      slug: string; source: string; playType: string; ip: string; priceCoins: number; drawPacks: (number | 'all')[]; animation: string; tags: string[];
      levels: { levelNo: number; name: string; isSmall: boolean; odds?: number | null; prizes?: unknown[] }[];
    }>(await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId })));
    assert.equal(status, 200);
    assert.deepEqual([p.slug, p.source, p.playType, p.ip, p.priceCoins, p.drawPacks, p.animation, p.tags], ['wk-world-king', 'CUSTOM', 'PROB', '航海王', 200, [1, 10, 100], 'VIDEO', ['卡牌']]);
    const prizes = await db()<{ levelNo: number; levelName: string; isSmall: boolean; odds: number | null; name: string; qty: number; recycleValue: number; shipMethod: string; tag: string }[]>`
      SELECT pl.level_no, pl.name AS level_name, pl.is_small, pl.odds, pr.name, pr.qty_per_set AS qty, pr.recycle_value, pr.ship_method, pr.tag
      FROM pool_prizes pr JOIN pool_levels pl ON pl.id = pr.level_id WHERE pr.pool_id = ${poolId} ORDER BY pl.level_no, pr.sort_order, pr.name`;
    assert.deepEqual(
      prizes.map((x) => [x.levelNo, x.levelName, x.name, x.qty, x.recycleValue, x.shipMethod]),
      [
        [1, '大獎', 'PSA10 漫畫尼卡', 1, 300_000, 'home'],
        [1, '大獎', 'PSA10 漫畫洛克斯', 1, 160_000, 'home'],
        [2, '2 獎', 'PSA10 漫畫女帝', 1, 50_000, 'home'],
        [2, '2 獎', 'PSA10 漫畫紅髮', 1, 50_000, 'home'],
        [3, '3 獎', '隨機未開封卡盒', 1, 3_000, 'c711'],
        [4, '4 獎', '隨機 SR 卡', 100_005, 250, 'c711'],
        [5, '5 獎', '隨機普卡', 100_000, 100, 'c711'],
      ],
    );
    assert.ok(prizes.every((x) => x.tag === '卡牌'));
    const l4 = prizes.find((x) => x.levelNo === 4)!;
    assert.deepEqual([l4.isSmall, l4.odds], [false, 0.5]);
    assert.ok(prizes.filter((x) => x.levelNo !== 4).every((x) => x.odds === null));
    const board = await j<{ total: number; remaining: number; tickets: unknown[]; ticketsOmitted?: boolean }>(
      await setRoute(apiRequest('GET', `/api/pools/${poolId}/sets/1`), ctx({ id: poolId, no: '1' })),
    );
    assert.deepEqual([board.body.total, board.body.remaining, board.body.tickets.length, board.body.ticketsOmitted], [200_010, 200_010, 0, true], 'large board omits per-ticket list');
    const list = await j<{ id: string; animation: string }[] | { pools: { id: string; animation: string }[] }>(await listRoute(apiRequest('GET', '/api/pools'), none));
    const pools = Array.isArray(list.body) ? list.body : list.body.pools;
    assert.equal(pools.find((x) => x.id === poolId)!.animation, 'VIDEO');
  });

  it('100-draw packs use the pick index (built once, reused across draws, delta-synced when stale); results verifiable by replay', async () => {
    const u = await makeUser({ coins: 200 * 211 });
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 5 }), 'DRAW_PACK_NOT_ALLOWED');
    const builds0 = probIndexStats.builds;
    const t0 = Date.now();
    const r1 = await executeDraw(u.id, key(), { poolId, setNo: 1, count: 100 });
    const t1 = Date.now();
    const r2 = await executeDraw(u.id, key(), { poolId, setNo: 1, count: 100, clientSeed: 'my-seed' });
    const t2 = Date.now();
    assert.equal(probIndexStats.builds - builds0, 1, 'index built once for the set');
    assert.ok(probIndexStats.hits >= 1, 'second draw reuses the cached index');
    assert.ok(t2 - t1 < 5000, `cached 100-draw took ${t2 - t1} ms (first incl. build ${t1 - t0} ms)`);
    for (const r of [r1, r2]) {
      assert.equal(r.response.results.length, 100);
      assert.equal(r.response.amountCoins, 20_000);
      assert.equal(new Set(r.response.ticketNos).size, 100);
    }
    assert.deepEqual([r1.response.prob!.nonce, r2.response.prob!.nonce, r2.response.prob!.clientSeed], [1, 2, 'my-seed']);
    assert.equal(r1.response.ticketNos.filter((n) => r2.response.ticketNos.includes(n)).length, 0);

    // 模擬「另一個實例」完成的抽賞：把 nonce 2 之前的索引放回快取（過時），下一筆只補讀差異（delta），不重建
    const stale = await transaction(async (tx) => {
      const [s] = await tx<{ id: string; commitment: string }[]>`SELECT id, commitment FROM pool_sets WHERE pool_id = ${poolId} AND set_no = 1`;
      const odds = new Map((await tx<{ levelNo: number; odds: number | null }[]>`SELECT level_no, odds FROM pool_levels WHERE pool_id = ${poolId}`).map((o) => [o.levelNo, o.odds]));
      const cur = await checkoutProbIndex(tx, { setId: s!.id, commitment: s!.commitment, nonce: 2, odds });
      // 以 nonce 1 時的狀態重建一份過時索引（只移除 nonce 1 抽出的籤）
      const all = await tx<{ ticketNo: number; levelNo: number }[]>`
        SELECT t.ticket_no, pl.level_no FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id JOIN pool_levels pl ON pl.id = pr.level_id
        WHERE t.set_id = ${s!.id} ORDER BY t.ticket_no`;
      const taken1 = new Set(r1.response.ticketNos);
      const old = new ProbIndex(all.map((t) => ({ ...t, available: !taken1.has(t.ticketNo) })), odds);
      void cur;
      return { setId: s!.id, commitment: s!.commitment, idx: old };
    });
    releaseProbIndex(stale, 1);
    const b1 = probIndexStats.builds;
    const d1 = probIndexStats.deltas;
    const r3 = await executeDraw(u.id, key(), { poolId, setNo: 1, count: 10 });
    assert.deepEqual([probIndexStats.builds - b1, probIndexStats.deltas - d1], [0, 1], 'stale cache caught up by delta');
    assert.equal(r3.response.ticketNos.filter((n) => r1.response.ticketNos.includes(n) || r2.response.ticketNos.includes(n)).length, 0);

    // 可驗證：以 server seed 由初始籤表依 nonce 重算，三筆抽賞逐張一致
    const [s] = await db()<{ id: string; seed: string; seedHash: string }[]>`SELECT id, prob_server_seed AS seed, prob_seed_hash AS seed_hash FROM pool_sets WHERE pool_id = ${poolId} AND set_no = 1`;
    const layout = await db()<{ ticketNo: number; levelNo: number }[]>`
      SELECT t.ticket_no, pl.level_no FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id JOIN pool_levels pl ON pl.id = pr.level_id WHERE t.set_id = ${s!.id} ORDER BY t.ticket_no`;
    const levels = await db()<{ levelNo: number; odds: number | null }[]>`SELECT level_no, odds FROM pool_levels WHERE pool_id = ${poolId}`;
    const draws = [r1, r2, r3].map((r) => ({ nonce: r.response.prob!.nonce, clientSeed: r.response.prob!.clientSeed, ticketNos: r.response.ticketNos }));
    assert.deepEqual(replayProbSet({ serverSeed: s!.seed, seedHash: s!.seedHash, layout, levels, draws }), { ok: true, seedOk: true, mismatches: [] });
    const [c] = await db()<{ taken: number }[]>`SELECT count(*)::int AS taken FROM tickets WHERE set_id = ${s!.id} AND status = 'TAKEN'`;
    assert.equal(c!.taken, 210);
    // 4 獎固定 50%：210 張中的比例落在合理範圍
    const sr = [r1, r2, r3].flatMap((r) => r.response.results).filter((x) => x.levelNo === 4).length;
    assert.ok(sr > 70 && sr < 140, `level-4 count ${sr}/210`);
    assert.ok((await reconcileWallets(db(), u.id)).every((x) => x.ok));
  });

  it('a failed draw (insufficient funds) discards its index checkout; the next draw rebuilds and stays consistent', async () => {
    const poor = await makeUser({ coins: 100 });
    await expectAppError(executeDraw(poor.id, key(), { poolId, setNo: 1, count: 1 }), 'INSUFFICIENT_FUNDS');
    const u = await makeUser({ coins: 2000 });
    const b0 = probIndexStats.builds;
    const r = await executeDraw(u.id, key(), { poolId, setNo: 1, count: 10 });
    assert.equal(probIndexStats.builds - b0, 1, 'rolled-back checkout was dropped → rebuilt from the database');
    assert.equal(r.response.results.length, 10);
  });
});

describe('convert draw results to UC幣 (POST /api/me/draws/:drawId/convert)', () => {
  /** 自製池：大獎不可回收、中獎 400、小獎 50 */
  async function drawAll(coins = 400) {
    const poolId = await publishPool(customPool());
    const u = await makeUser({ coins });
    const r = await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: (await pickTickets(poolId, 40)).slice(0, 40) });
    return { u, poolId, d: r.response };
  }
  const convert = (token: string, drawId: string, itemIds: string[]) =>
    convertRoute(apiRequest('POST', `/api/me/draws/${drawId}/convert`, { token, body: { itemIds } }), ctx({ id: drawId }));
  type Conv = { drawId: string; converted: { itemId: string; coins: number; displayName: string }[]; alreadyConverted: string[]; totalCoins: number; coins: number; refundableCoins: number; nonRefundableCoins: number };
  const byName = (d: DrawResponse, name: string) => d.results.filter((x) => x.prizeName === name);

  it('partial selection credits non-refundable UC幣 at recycle value in one ledger entry; returns items, total and new balances', async () => {
    const { u, d } = await drawAll();
    const smalls = byName(d, '壓克力立牌').slice(0, 3);
    const mid = byName(d, '半身像')[0]!;
    const before = await walletOf(u.id);
    const ledger0 = (await ledgerOf(u.id)).length;
    const res = await j<Conv>(await convert(u.token, d.drawId, [...smalls.map((x) => x.warehouseItemId), mid.warehouseItemId]));
    assert.equal(res.status, 200);
    assert.equal(res.body.totalCoins, 3 * 50 + 400);
    assert.deepEqual(res.body.converted.map((c) => c.coins).sort((a, b) => a - b), [50, 50, 50, 400]);
    assert.deepEqual(res.body.alreadyConverted, []);
    assert.deepEqual([res.body.coins, res.body.nonRefundableCoins, res.body.refundableCoins], [before.coins + 550, before.nonRefundableCoins + 550, before.coins - before.nonRefundableCoins]);
    const led = await ledgerOf(u.id);
    assert.equal(led.length, ledger0 + 1, 'one ledger entry per request');
    assert.deepEqual([led.at(-1)!.entryType, led.at(-1)!.amount, led.at(-1)!.refundable], ['RECYCLE_CREDIT', 550, false]);
    const st = await db()<{ id: string; status: string; recycledCoins: number | null; recycleReason: string | null }[]>`
      SELECT id, status, recycled_coins, recycle_reason FROM warehouse_items WHERE draw_id = ${d.drawId}`;
    assert.equal(st.filter((x) => x.status === 'RECYCLED').length, 4);
    assert.ok(st.filter((x) => x.status === 'RECYCLED').every((x) => x.recycleReason === 'USER'));
    assert.equal(st.filter((x) => x.status === 'STORED').length, 36, 'unselected items stay stored');
    const [a] = await db()<{ payloadJson: string }[]>`SELECT payload_json FROM audit_log WHERE action = 'ITEMS_RECYCLED' AND actor_id = ${u.id} ORDER BY seq DESC LIMIT 1`;
    assert.match(a!.payloadJson, /"via":"DRAW_RESULT"/);
    assert.ok((await reconcileWallets(db(), u.id)).every((x) => x.ok));
  });

  it('idempotent per item: double submit (sequential and concurrent) credits once; already-converted items are reported, not re-credited', async () => {
    const { u, d } = await drawAll();
    const ids = byName(d, '壓克力立牌').slice(0, 5).map((x) => x.warehouseItemId);
    const rs = await Promise.all([convert(u.token, d.drawId, ids), convert(u.token, d.drawId, ids), convert(u.token, d.drawId, ids)].map(async (p) => j<Conv>(await p)));
    assert.ok(rs.every((r) => r.status === 200));
    assert.deepEqual(rs.map((r) => r.body.totalCoins).sort((a, b) => a - b), [0, 0, 250]);
    assert.equal(rs.filter((r) => r.body.alreadyConverted.length === 5).length, 2);
    const again = await j<Conv>(await convert(u.token, d.drawId, [ids[0]!, byName(d, '壓克力立牌')[5]!.warehouseItemId]));
    assert.deepEqual([again.status, again.body.totalCoins, again.body.alreadyConverted, again.body.converted.length], [200, 50, [ids[0]], 1]);
    assert.equal((await ledgerOf(u.id)).filter((l) => l.entryType === 'RECYCLE_CREDIT').length, 2, 'zero-credit repeats write no ledger entry');
    assert.equal((await walletOf(u.id)).nonRefundableCoins, 300);
  });

  it('rejects non-recyclable, shipped / ship-requested, other members’ and other draws’ items (nothing is converted)', async () => {
    const { u, d } = await drawAll(410);
    const grand = byName(d, '原創雕像')[0]!;
    const small = byName(d, '壓克力立牌');
    const w0 = await walletOf(u.id);
    const nr = await convert(u.token, d.drawId, [small[0]!.warehouseItemId, grand.warehouseItemId]);
    assert.equal(nr.status, 422);
    assert.equal(((await nr.json()) as { error: { code: string } }).error.code, 'NOT_RECYCLABLE');
    // 已申請出貨 / 已出貨
    await db()`UPDATE warehouse_items SET status = 'SHIP_REQUESTED', updated_at = now() WHERE id IN (${small[1]!.warehouseItemId}, ${small[2]!.warehouseItemId})`;
    await db()`UPDATE warehouse_items SET status = 'SHIPPED', updated_at = now() WHERE id = ${small[2]!.warehouseItemId}`;
    for (const it of [small[1]!, small[2]!]) {
      const sh = await convert(u.token, d.drawId, [small[0]!.warehouseItemId, it.warehouseItemId]);
      assert.equal(sh.status, 409);
      assert.equal(((await sh.json()) as { error: { code: string } }).error.code, 'INVALID_STATE');
    }
    // 他人的獎品（同一筆抽賞 id 或他人的抽賞）
    const other = await drawAll();
    const otherItem = other.d.results.find((x) => x.recyclable)!.warehouseItemId;
    assert.equal((await convert(u.token, d.drawId, [otherItem])).status, 404);
    assert.equal((await convert(u.token, other.d.drawId, [otherItem])).status, 404, 'cannot convert inside someone else’s draw');
    assert.equal((await convert(other.u.token, d.drawId, [small[0]!.warehouseItemId])).status, 404);
    // 同一會員、別筆抽賞的獎品
    const poolId2 = await publishPool(customPool());
    const d2 = (await executeDraw(u.id, key(), { poolId: poolId2, setNo: 1, ticketNos: await pickTickets(poolId2, 1) })).response;
    assert.equal((await convert(u.token, d.drawId, [d2.results[0]!.warehouseItemId])).status, 404);
    assert.equal((await convert(u.token, randomUUID(), [small[0]!.warehouseItemId])).status, 404);
    assert.equal((await convertRoute(apiRequest('POST', `/api/me/draws/${d.drawId}/convert`, { token: u.token, body: { itemIds: [] } }), ctx({ id: d.drawId }))).status, 400);
    assert.equal((await convertRoute(apiRequest('POST', `/api/me/draws/${d.drawId}/convert`, { body: { itemIds: [small[0]!.warehouseItemId] } }), ctx({ id: d.drawId }))).status, 401);
    const st = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM warehouse_items WHERE draw_id = ${d.drawId} AND status = 'RECYCLED'`;
    assert.equal(st[0]!.n, 0, 'rejected requests convert nothing');
    assert.deepEqual(await walletOf(u.id), { coins: w0.coins - 10, nonRefundableCoins: w0.nonRefundableCoins }, 'only the extra 1-ticket draw was charged');
  });
});
