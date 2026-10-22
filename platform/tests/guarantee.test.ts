import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { getSetBoard } from '../src/server/modules/pool/queries';
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

// 自製賞池（無賞級）20 籤：大獎 1、中獎 2、小獎甲 3、小獎乙 14；保底：每 3 次未抽中「中獎」以上 → 保底中獎（庫存 2）
const guaranteePool = () =>
  customPool({
    playType: 'GUARANTEE',
    priceCoins: 100,
    prizes: [
      { name: '大獎雕像', grade: 'GRAND', qtyPerSet: 1 },
      { name: '中獎半身像', grade: 'MID', qtyPerSet: 2 },
      { name: '小獎甲', grade: 'SMALL', qtyPerSet: 3 },
      { name: '小獎乙', grade: 'SMALL', qtyPerSet: 14 },
    ],
    guarantee: { everyN: 3, minGrade: 'MID', reservePrizeName: '中獎（保底庫存）', reserveGrade: 'MID', reserveTotal: 2, reserveRecycleValue: 500 },
  });

describe('guarantee (保底挑戰) — grade based', () => {
  it('awards an extra prize from reserve after N draws below minGrade, resets on qualifying grade, stops when reserve exhausted, never alters ticket odds', async () => {
    const poolId = await publishPool(guaranteePool());
    const u = await makeUser({ coins: 10_000 });
    const other = await makeUser({ coins: 10_000 });
    const layout = await layoutOf(poolId, 1);
    assert.ok(layout.every((t) => t.rank === null), 'custom pools have no rank');
    const misses = layout.filter((t) => t.grade === 'SMALL').map((t) => t.ticketNo); // 17
    const wins = layout.filter((t) => t.grade !== 'SMALL').map((t) => t.ticketNo); // 3
    const take = (n: number) => misses.splice(0, n);

    // 兩次小獎 → 尚無保底
    let r = (await executeDraw(u.id, key(), { poolId, shippingMethod: SHIP, setNo: 1, ticketNos: take(2) })).response;
    assert.equal(r.results.filter((x) => x.kind === 'GUARANTEE').length, 0);
    assert.equal(r.guarantee!.misses, 2);
    assert.equal(r.guarantee!.minGrade, 'MID');
    // 抽中中獎以上 → 歸零
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [wins.shift()!] })).response;
    assert.equal(r.guarantee!.misses, 0);
    // 另一玩家的計數獨立
    r = (await executeDraw(other.id, key(), { poolId, shippingMethod: SHIP, setNo: 1, ticketNos: take(1) })).response;
    assert.equal(r.guarantee!.misses, 1);
    // 一次多抽 3 個小獎 → 第 3 個之後插入保底獎
    const before = await getSetBoard(db(), poolId, 1);
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: take(3) })).response;
    assert.deepEqual(r.results.map((x) => x.kind), ['TICKET', 'TICKET', 'TICKET', 'GUARANTEE']);
    assert.equal(r.results[3]!.grade, 'MID');
    assert.equal(r.results[3]!.rank, null);
    assert.equal(r.results[3]!.displayName, '中獎（保底庫存）', 'custom pool: displayName is the prize name');
    assert.ok(r.results.slice(0, 3).every((x) => x.grade === 'SMALL'));
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
    const items = await db()`SELECT grade, prize_id FROM warehouse_items WHERE pool_id = ${poolId} AND source = 'GUARANTEE'`;
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.grade === 'MID' && i.prizeId), 'guarantee items carry grade + reserve prize id');
  });

  it('minGrade GRAND: a MID prize does NOT reset the counter (eligibility is by grade, not by rank)', async () => {
    const poolId = await publishPool(
      customPool({
        playType: 'GUARANTEE',
        prizes: [
          { name: '大獎', grade: 'GRAND', qtyPerSet: 1 },
          { name: '中獎', grade: 'MID', qtyPerSet: 5 },
          { name: '小獎', grade: 'SMALL', qtyPerSet: 14 },
        ],
        guarantee: { everyN: 3, minGrade: 'GRAND', reservePrizeName: '保底大獎', reserveGrade: 'GRAND', reserveTotal: 5 },
      }),
    );
    const u = await makeUser({ coins: 10_000 });
    const layout = await layoutOf(poolId, 1);
    const mids = layout.filter((t) => t.grade === 'MID').map((t) => t.ticketNo);
    const r = (await executeDraw(u.id, key(), { poolId, shippingMethod: SHIP, setNo: 1, ticketNos: mids.slice(0, 3) })).response;
    assert.deepEqual(r.results.map((x) => `${x.kind}:${x.grade}`), ['TICKET:MID', 'TICKET:MID', 'TICKET:MID', 'GUARANTEE:GRAND']);
  });

  it('official pools keep ranks; default grade mapping LAST/A→GRAND, B/C→MID, others→SMALL; admin may override', async () => {
    const poolId = await publishPool({
      ...customPool(),
      source: 'OFFICIAL',
      lastPrizeName: '最後賞 公仔',
      prizes: [
        { rank: 'A', name: '公仔', qtyPerSet: 1 },
        { rank: 'B', name: '色紙', qtyPerSet: 1 },
        { rank: 'C', name: '毛巾', qtyPerSet: 1 },
        { rank: 'D', name: '吊飾', qtyPerSet: 1, grade: 'MID' }, // 覆寫
        { rank: 'E', name: '貼紙', qtyPerSet: 6 },
      ],
    });
    const detail = await (await import('../src/server/modules/pool/queries')).getPoolDetail(db(), poolId);
    assert.deepEqual(detail.prizes.map((p) => `${p.rank}:${p.grade}`), ['A:GRAND', 'B:MID', 'C:MID', 'D:MID', 'E:SMALL']);
    assert.deepEqual(detail.prizes.map((p) => p.displayName), ['A賞 公仔', 'B賞 色紙', 'C賞 毛巾', 'D賞 吊飾', 'E賞 貼紙']);
    assert.equal(detail.lastPrize!.grade, 'GRAND');
    assert.equal(detail.lastPrize!.displayName, 'LAST賞 最後賞 公仔');
  });

  it('concurrent draws cannot over-spend the guarantee reserve', async () => {
    const poolId = await publishPool(
      customPool({
        playType: 'GUARANTEE',
        prizes: [{ name: '大獎', grade: 'GRAND', qtyPerSet: 1 }, { name: '小獎', grade: 'SMALL', qtyPerSet: 59 }],
        guarantee: { everyN: 1, minGrade: 'MID', reservePrizeName: '保底中獎', reserveGrade: 'MID', reserveTotal: 5 },
      }),
    );
    const layout = await layoutOf(poolId, 1);
    const ds = layout.filter((t) => t.grade === 'SMALL').map((t) => t.ticketNo).slice(0, 20);
    const users = await Promise.all(ds.map(() => makeUser({ coins: 1000 })));
    const rs = await Promise.all(users.map((u, i) => executeDraw(u.id, key(), { poolId, shippingMethod: SHIP, setNo: 1, ticketNos: [ds[i]!] })));
    const awarded = rs.reduce((s, r) => s + r.response.results.filter((x) => x.kind === 'GUARANTEE').length, 0);
    assert.equal(awarded, 5);
    const [g] = await db()`SELECT reserve_used FROM pool_guarantees WHERE pool_id = ${poolId}`;
    assert.equal(g!.reserveUsed, 5);
  });

  it('draft validation: GUARANTEE play type requires a guarantee config (and only it); custom pools reject ranks and require grades', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const { createPoolDraft } = await import('../src/server/modules/pool/admin');
    await assert.rejects(createPoolDraft(ops.principal, customPool({ playType: 'GUARANTEE', guarantee: null })), /guarantee config/);
    await assert.rejects(
      createPoolDraft(ops.principal, customPool({ playType: 'STANDARD', guarantee: { everyN: 1, minGrade: 'MID', reservePrizeName: 'x', reserveGrade: 'MID', reserveTotal: 1 } })),
      /guarantee config/,
    );
    await assert.rejects(createPoolDraft(ops.principal, customPool({ prizes: [{ rank: 'A', name: 'x', grade: 'GRAND', qtyPerSet: 1 }] })), /自製賞池沒有賞級/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ prizes: [{ name: 'x', qtyPerSet: 1 }] })), /必須設定等級/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ source: 'MIXED', prizes: [{ name: 'x', grade: 'GRAND', qtyPerSet: 1 }] })), /必須有賞級/);
    await assert.rejects(
      createPoolDraft(ops.principal, customPool({ prizes: [{ name: 'x', grade: 'GRAND', qtyPerSet: 1 }, { name: 'x', grade: 'SMALL', qtyPerSet: 1 }] })),
      /names must be unique/,
    );
  });
});
