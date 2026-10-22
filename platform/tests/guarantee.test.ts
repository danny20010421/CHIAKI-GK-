import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { getSetBoard } from '../src/server/modules/pool/queries';
import { layoutOf, makeUser, publishPool, setupTestDb, smallPool } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `g-${process.pid}-${++k}-${Date.now()}`;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

// 20 籤：A1 B2 C3 D14；保底：每 3 次未抽中 B 以上(tier>=2) → 保底 B（保底庫存 2）
const guaranteePool = () =>
  smallPool({
    playType: 'GUARANTEE',
    setCount: 1,
    lastPrizeName: null,
    prizes: [
      { rank: 'A', name: 'A', qtyPerSet: 1 },
      { rank: 'B', name: 'B', qtyPerSet: 2 },
      { rank: 'C', name: 'C', qtyPerSet: 3 },
      { rank: 'D', name: 'D', qtyPerSet: 14 },
    ],
    guarantee: { everyN: 3, minTier: 2, reserveRank: 'B', reservePrizeName: 'B（保底庫存）', reserveTotal: 2 },
  });

describe('guarantee (保底挑戰)', () => {
  it('awards an extra prize from reserve after N misses, resets on qualifying win, stops when reserve exhausted, never alters ticket odds', async () => {
    const poolId = await publishPool(guaranteePool());
    const u = await makeUser({ coins: 10_000 });
    const other = await makeUser({ coins: 10_000 });
    const layout = await layoutOf(poolId, 1);
    const misses = layout.filter((t) => t.tier < 2).map((t) => t.ticketNo); // C + D = 17
    const wins = layout.filter((t) => t.tier >= 2).map((t) => t.ticketNo); // A + B = 3
    const take = (n: number) => misses.splice(0, n);

    // 兩次 miss → 尚無保底
    let r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: take(2) })).response;
    assert.equal(r.results.filter((x) => x.kind === 'GUARANTEE').length, 0);
    assert.equal(r.guarantee!.misses, 2);
    // 抽中 B 以上 → 歸零
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [wins.shift()!] })).response;
    assert.equal(r.guarantee!.misses, 0);
    // 另一玩家的計數獨立
    r = (await executeDraw(other.id, key(), { poolId, setNo: 1, ticketNos: take(1) })).response;
    assert.equal(r.guarantee!.misses, 1);
    // 一次多抽 3 個 miss → 第 3 個之後插入保底獎
    const before = await getSetBoard(db(), poolId, 1);
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: take(3) })).response;
    assert.deepEqual(r.results.map((x) => x.kind), ['TICKET', 'TICKET', 'TICKET', 'GUARANTEE']);
    assert.equal(r.results[3]!.rank, 'B');
    assert.equal(r.guarantee!.misses, 0);
    assert.equal(r.guarantee!.reserveRemaining, 1);
    // 保底獎來自獨立庫存：籤池中 B 的剩餘數不受影響
    const afterBoard = await getSetBoard(db(), poolId, 1);
    const bBefore = before.prizes.find((p) => p.rank === 'B')!.remaining;
    assert.equal(afterBoard.prizes.find((p) => p.rank === 'B')!.remaining, bBefore);
    assert.equal(afterBoard.remaining, before.remaining - 3);
    // 再 3 miss → 第二個保底（庫存用完）
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: take(3) })).response;
    assert.equal(r.results.filter((x) => x.kind === 'GUARANTEE').length, 1);
    assert.equal(r.guarantee!.reserveRemaining, 0);
    // 庫存耗盡 → 保底停止（計數繼續累積但不再給獎）
    r = (await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: take(4) })).response;
    assert.equal(r.results.filter((x) => x.kind === 'GUARANTEE').length, 0);
    assert.equal(r.guarantee!.misses, 4);
    const [g] = await db()`SELECT reserve_used, reserve_total FROM pool_guarantees WHERE pool_id = ${poolId}`;
    assert.deepEqual(g, { reserveUsed: 2, reserveTotal: 2 });
    const items = await db()`SELECT count(*)::int AS n FROM warehouse_items WHERE pool_id = ${poolId} AND source = 'GUARANTEE'`;
    assert.equal(items[0]!.n, 2);
  });

  it('concurrent draws cannot over-spend the guarantee reserve', async () => {
    const poolId = await publishPool(
      smallPool({
        playType: 'GUARANTEE',
        setCount: 1,
        lastPrizeName: null,
        prizes: [{ rank: 'A', name: 'A', qtyPerSet: 1 }, { rank: 'D', name: 'D', qtyPerSet: 59 }],
        guarantee: { everyN: 1, minTier: 2, reserveRank: 'B', reservePrizeName: 'B 保底', reserveTotal: 5 },
      }),
    );
    const layout = await layoutOf(poolId, 1);
    const ds = layout.filter((t) => t.rank === 'D').map((t) => t.ticketNo).slice(0, 20);
    const users = await Promise.all(ds.map(() => makeUser({ coins: 1000 })));
    const rs = await Promise.all(users.map((u, i) => executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [ds[i]!] })));
    const awarded = rs.reduce((s, r) => s + r.response.results.filter((x) => x.kind === 'GUARANTEE').length, 0);
    assert.equal(awarded, 5);
    const [g] = await db()`SELECT reserve_used FROM pool_guarantees WHERE pool_id = ${poolId}`;
    assert.equal(g!.reserveUsed, 5);
  });

  it('GUARANTEE play type requires a guarantee config (and only it)', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const { createPoolDraft } = await import('../src/server/modules/pool/admin');
    await assert.rejects(createPoolDraft(ops.principal, smallPool({ playType: 'GUARANTEE', guarantee: null })), /guarantee config/);
    await assert.rejects(
      createPoolDraft(ops.principal, smallPool({ playType: 'STANDARD', guarantee: { everyN: 1, minTier: 1, reserveRank: 'B', reservePrizeName: 'x', reserveTotal: 1 } })),
      /guarantee config/,
    );
  });
});
