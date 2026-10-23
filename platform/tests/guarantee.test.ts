import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { getPoolDetail, getSetBoard } from '../src/server/modules/pool/queries';
import { createPoolDraft } from '../src/server/modules/pool/admin';
import { customPool, layoutOf, makeUser, publishPool, setupTestDb } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `g-${process.pid}-${++k}-${Date.now()}`;
const SHIP = 'CVS_711_C2C';
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

// 20 籤：等級 1 大獎 1、等級 2 中獎 2、等級 4（小獎）甲 3 + 乙 14；保底：每 3 次未抽中等級 ≤ 2 → 保底中獎（等級 2，庫存 2）
const guaranteePool = () =>
  customPool({
    playType: 'GUARANTEE',
    priceCoins: 100,
    levels: [
      { levelNo: 1, name: '大獎', items: [{ name: '大獎雕像', qtyPerSet: 1 }] },
      { levelNo: 2, name: '中獎', items: [{ name: '中獎半身像', qtyPerSet: 2 }] },
      { levelNo: 4, name: '小獎', items: [{ name: '小獎甲', qtyPerSet: 3 }, { name: '小獎乙', qtyPerSet: 14 }] },
    ],
    guarantee: { everyN: 3, minLevel: 2, reserveLevelNo: 2, reservePrizeName: '中獎（保底庫存）', reserveTotal: 2, reserveRecycleValue: 500 },
  });

describe('guarantee (保底挑戰) — level based', () => {
  it('awards an extra prize from reserve after N draws below minLevel, resets on a qualifying level, stops when reserve exhausted, never alters ticket odds', async () => {
    const poolId = await publishPool(guaranteePool());
    const u = await makeUser({ coins: 10_000 });
    const other = await makeUser({ coins: 10_000 });
    const layout = await layoutOf(poolId, 1);
    const misses = layout.filter((t) => t.levelNo > 2).map((t) => t.ticketNo); // 17
    const wins = layout.filter((t) => t.levelNo <= 2).map((t) => t.ticketNo); // 3
    const take = (n: number) => misses.splice(0, n);

    // 兩次小獎 → 尚無保底
    let r = (await executeDraw(u.id, key(), { poolId, shippingMethod: SHIP, setNo: 1, ticketNos: take(2) })).response;
    assert.equal(r.results.filter((x) => x.kind === 'GUARANTEE').length, 0);
    assert.equal(r.guarantee!.misses, 2);
    assert.equal(r.guarantee!.minLevel, 2);
    // 抽中等級 ≤ 2 → 歸零
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [wins.shift()!] })).response;
    assert.equal(r.guarantee!.misses, 0);
    // 另一玩家的計數獨立
    r = (await executeDraw(other.id, key(), { poolId, shippingMethod: SHIP, setNo: 1, ticketNos: take(1) })).response;
    assert.equal(r.guarantee!.misses, 1);
    // 一次多抽 3 個小獎 → 第 3 個之後插入保底獎
    const before = await getSetBoard(db(), poolId, 1);
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: take(3) })).response;
    assert.deepEqual(r.results.map((x) => x.kind), ['TICKET', 'TICKET', 'TICKET', 'GUARANTEE']);
    assert.deepEqual([r.results[3]!.levelNo, r.results[3]!.levelName, r.results[3]!.displayName], [2, '中獎', '中獎 中獎（保底庫存）']);
    assert.ok(r.results.slice(0, 3).every((x) => x.levelNo === 4 && x.isSmall));
    assert.equal(r.guarantee!.misses, 0);
    assert.equal(r.guarantee!.reserveRemaining, 1);
    // 保底獎來自獨立庫存：籤池中「中獎」的剩餘數不受影響
    const afterBoard = await getSetBoard(db(), poolId, 1);
    const midBefore = before.prizes.find((p) => p.name === '中獎半身像')!.remaining;
    assert.equal(afterBoard.prizes.find((p) => p.name === '中獎半身像')!.remaining, midBefore);
    assert.equal(afterBoard.remaining, before.remaining - 3);
    // 再 3 小獎 → 第二個保底（庫存用完）
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: take(3) })).response;
    assert.equal(r.results.filter((x) => x.kind === 'GUARANTEE').length, 1);
    assert.equal(r.guarantee!.reserveRemaining, 0);
    // 庫存耗盡 → 保底停止（計數繼續累積但不再給獎）
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: take(4) })).response;
    assert.equal(r.results.filter((x) => x.kind === 'GUARANTEE').length, 0);
    assert.equal(r.guarantee!.misses, 4);
    const [g] = await db()`SELECT reserve_used, reserve_total FROM pool_guarantees WHERE pool_id = ${poolId}`;
    assert.deepEqual(g, { reserveUsed: 2, reserveTotal: 2 });
    const items = await db()`SELECT level_no, level_name, is_small, prize_id FROM warehouse_items WHERE pool_id = ${poolId} AND source = 'GUARANTEE'`;
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.levelNo === 2 && i.levelName === '中獎' && !i.isSmall && i.prizeId), 'guarantee items carry the level snapshot + reserve prize id');
  });

  it('minLevel 1: a level-2 prize does NOT reset the counter', async () => {
    const poolId = await publishPool(
      customPool({
        playType: 'GUARANTEE',
        levels: [
          { levelNo: 1, name: '大獎', items: [{ name: '大獎', qtyPerSet: 1 }] },
          { levelNo: 2, name: '中獎', items: [{ name: '中獎', qtyPerSet: 5 }] },
          { levelNo: 3, name: '小獎', isSmall: true, items: [{ name: '小獎', qtyPerSet: 14 }] },
        ],
        guarantee: { everyN: 3, minLevel: 1, reserveLevelNo: 1, reservePrizeName: '保底大獎', reserveTotal: 5 },
      }),
    );
    const u = await makeUser({ coins: 10_000 });
    const layout = await layoutOf(poolId, 1);
    const mids = layout.filter((t) => t.levelNo === 2).map((t) => t.ticketNo);
    const r = (await executeDraw(u.id, key(), { poolId, shippingMethod: SHIP, setNo: 1, ticketNos: mids.slice(0, 3) })).response;
    assert.deepEqual(r.results.map((x) => `${x.kind}:${x.levelNo}`), ['TICKET:2', 'TICKET:2', 'TICKET:2', 'GUARANTEE:1']);
  });

  it('every pool type uses the same level model; LAST is outside the levels', async () => {
    const poolId = await publishPool(
      customPool({
        source: 'OFFICIAL',
        lastPrizeName: '最後賞 公仔',
        prizes: [
          { rank: 'A', name: '公仔', qtyPerSet: 1 },
          { rank: 'B', name: '色紙', qtyPerSet: 1 },
          { rank: 'C', name: '毛巾', qtyPerSet: 1 },
          { rank: 'D', name: '吊飾', qtyPerSet: 1 },
          { rank: 'E', name: '貼紙', qtyPerSet: 6 },
        ],
      }),
    );
    const detail = await getPoolDetail(db(), poolId);
    assert.deepEqual(detail.prizes.map((p) => `${p.levelNo}:${p.isSmall}`), ['1:false', '2:false', '3:false', '4:true', '5:true']);
    assert.deepEqual(detail.prizes.map((p) => p.displayName), ['A賞 公仔', 'B賞 色紙', 'C賞 毛巾', 'D賞 吊飾', 'E賞 貼紙']);
    assert.deepEqual([detail.lastPrize!.levelNo, detail.lastPrize!.levelName, detail.lastPrize!.displayName], [null, '最後賞', '最後賞 最後賞 公仔']);
    assert.deepEqual(detail.tags, ['一番賞'], 'official pools always expose 一番賞');
  });

  it('concurrent draws cannot over-spend the guarantee reserve', async () => {
    const poolId = await publishPool(
      customPool({
        playType: 'GUARANTEE',
        levels: [
          { levelNo: 1, name: '大獎', items: [{ name: '大獎', qtyPerSet: 1 }] },
          { levelNo: 5, name: '小獎', items: [{ name: '小獎', qtyPerSet: 59 }] },
        ],
        guarantee: { everyN: 1, minLevel: 2, reserveLevelNo: 1, reservePrizeName: '保底獎', reserveTotal: 5 },
      }),
    );
    const layout = await layoutOf(poolId, 1);
    const ds = layout.filter((t) => t.isSmall).map((t) => t.ticketNo).slice(0, 20);
    const users = await Promise.all(ds.map(() => makeUser({ coins: 1000 })));
    const rs = await Promise.all(users.map((u, i) => executeDraw(u.id, key(), { poolId, shippingMethod: SHIP, setNo: 1, ticketNos: [ds[i]!] })));
    const awarded = rs.reduce((s, r) => s + r.response.results.filter((x) => x.kind === 'GUARANTEE').length, 0);
    assert.equal(awarded, 5);
    const [g] = await db()`SELECT reserve_used FROM pool_guarantees WHERE pool_id = ${poolId}`;
    assert.equal(g!.reserveUsed, 5);
  });

  it('draft validation: guarantee config only for GUARANTEE; reserve level must exist; levels 1–8 unique; names unique', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const g = { everyN: 1, minLevel: 2, reserveLevelNo: 2, reservePrizeName: 'x', reserveTotal: 1 };
    await assert.rejects(createPoolDraft(ops.principal, customPool({ playType: 'GUARANTEE', guarantee: null })), /guarantee config/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ playType: 'STANDARD', guarantee: g })), /guarantee config/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ playType: 'GUARANTEE', guarantee: { ...g, reserveLevelNo: 7 } })), /保底獎項的等級/);
    const lv = (levelNo: number, name = `L${levelNo}`) => ({ levelNo, name, items: [{ name: `item-${levelNo}-${name}`, qtyPerSet: 1 }] });
    await assert.rejects(createPoolDraft(ops.principal, customPool({ levels: [lv(9)] })), /等級須為 1–8/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ levels: [lv(1), lv(1, 'b')] })), /等級號不可重複/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ levels: [] })), /至少一個等級/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ levels: [{ levelNo: 1, name: 'A賞', items: [] }] })), /每個等級至少一個獎項/);
    await assert.rejects(
      createPoolDraft(ops.principal, customPool({ levels: [{ levelNo: 1, name: 'A', items: [{ name: 'x', qtyPerSet: 1 }] }, { levelNo: 2, name: 'B', items: [{ name: 'x', qtyPerSet: 1 }] }] })),
      /names must be unique/,
    );
    await assert.rejects(
      createPoolDraft(ops.principal, customPool({ playType: 'SOLO', levels: [lv(1), lv(2), lv(5)] })),
      /SOLO pools need exactly one main prize/,
    );
    await createPoolDraft(ops.principal, customPool({ playType: 'SOLO', levels: [lv(1), lv(5)] }));
  });
});
