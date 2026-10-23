/** 機率賞（PROB）：固定單抽機率、剩餘平均分配、用完滾入、有效機率公開、可驗證亂數（chiaki-prob-v1）與完售後重算 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { holdTickets } from '../src/server/modules/draw/holds';
import { createPoolDraft } from '../src/server/modules/pool/admin';
import { getSetBoard, revealSet } from '../src/server/modules/pool/queries';
import { choosePool, effectiveProbabilities, pickFromCounts, ProbRng, replayProbSet, seedHash, type LevelOdds } from '../src/server/modules/pool/prob';
import { PROB_SAMPLE_POOL } from '../src/server/seed/reference';
import { customPool, expectAppError, makeUser, publishPool, setupTestDb } from './helpers';

const ODDS: LevelOdds = new Map([
  [1, 1 / 30],
  [2, 1 / 50],
  [3, null],
  [4, null],
]);

describe('PROB algorithm (pure)', () => {
  it('statistics: fixed seed, 30k picks with ample stock → 大獎 ≈ 3.33%, 2 獎 ≈ 2.00%, rest split by remaining count', () => {
    const items = [
      { levelNo: 1, remaining: 5_000_000 },
      { levelNo: 2, remaining: 5_000_000 },
      { levelNo: 3, remaining: 30_000_000 },
      { levelNo: 4, remaining: 1_960_000_000 },
    ];
    const rng = new ProbRng('ab'.repeat(32), 'statistical-test', 1);
    const N = 30_000;
    const hits = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      const it = pickFromCounts(items, ODDS, rng);
      hits.set(it.levelNo, (hits.get(it.levelNo) ?? 0) + 1);
    }
    const f = (l: number) => (hits.get(l) ?? 0) / N;
    // 容許誤差約 4σ（σ = √(p(1−p)/N)）
    assert.ok(Math.abs(f(1) - 1 / 30) < 0.0042, `大獎 ${f(1)}`);
    assert.ok(Math.abs(f(2) - 1 / 50) < 0.0033, `2 獎 ${f(2)}`);
    const rest = 1 - 1 / 30 - 1 / 50;
    assert.ok(Math.abs(f(3) - (rest * 30) / 1990) < 0.003, `3 獎 ${f(3)}`);
    assert.ok(Math.abs(f(4) - (rest * 1960) / 1990) < 0.006, `4 獎 ${f(4)}`);
  });

  it('effective probabilities match the published formula and sum to 1', () => {
    const items = [
      { levelNo: 1, remaining: 5 },
      { levelNo: 2, remaining: 5 },
      { levelNo: 3, remaining: 30 },
      { levelNo: 4, remaining: 1960 },
    ];
    const p = effectiveProbabilities(items, ODDS);
    const rest = 1 - 1 / 30 - 1 / 50;
    assert.deepEqual(p.map((x) => Math.round(x * 1e9)), [1 / 30, 1 / 50, (rest * 30) / 1990, (rest * 1960) / 1990].map((x) => Math.round(x * 1e9)));
    assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    // 同等級多個獎項：odds × 該獎剩餘 / 等級剩餘
    const two = effectiveProbabilities([{ levelNo: 1, remaining: 1 }, { levelNo: 1, remaining: 3 }, { levelNo: 2, remaining: 10 }], new Map([[1, 0.2], [2, null]]));
    assert.deepEqual(two.map((x) => Math.round(x * 1e9)), [0.05, 0.15, 0.8].map((x) => Math.round(x * 1e9)));
  });

  it('odds roll over when a level is exhausted; with no un-odded tickets left, picks among all remaining', () => {
    const exhausted = [
      { levelNo: 1, odds: 1 / 30, remaining: 0 },
      { levelNo: 2, odds: 1 / 50, remaining: 5 },
      { levelNo: 3, odds: null, remaining: 30 },
    ];
    // u = 0.01 原本落在大獎（< 1/30），大獎用完 → 跳過，累計從 2 獎開始 → 0.01 < 0.02 → 2 獎
    assert.deepEqual(choosePool(exhausted, 0.01), { kind: 'LEVEL', levelNo: 2 });
    assert.deepEqual(choosePool(exhausted, 0.025), { kind: 'REST' });
    const p = effectiveProbabilities([{ levelNo: 1, remaining: 0 }, { levelNo: 2, remaining: 5 }, { levelNo: 3, remaining: 30 }], new Map([[1, 1 / 30], [2, 1 / 50], [3, null]]));
    assert.equal(p[0], 0);
    assert.equal(Math.round(p[1]! * 1e9), Math.round(0.02 * 1e9));
    assert.equal(Math.round(p[2]! * 1e9), Math.round(0.98 * 1e9), 'the exhausted 1/30 rolled into the rest');
    // 一般獎項抽完 → 全部剩餘中均分剩下的機率
    assert.deepEqual(choosePool([{ levelNo: 1, odds: 0.5, remaining: 5 }, { levelNo: 2, odds: null, remaining: 0 }], 0.9), { kind: 'ALL' });
    assert.deepEqual(effectiveProbabilities([{ levelNo: 1, remaining: 5 }, { levelNo: 2, remaining: 0 }], new Map([[1, 0.5], [2, null]])), [1, 0]);
    // 抽樣也遵守：大獎用完後連抽 2000 次都不會出現
    const items = [{ levelNo: 1, remaining: 0 }, { levelNo: 2, remaining: 100_000 }, { levelNo: 3, remaining: 100_000 }];
    const rng = new ProbRng('cd'.repeat(32), 'rollover', 7);
    for (let i = 0; i < 2000; i++) assert.notEqual(pickFromCounts(items, new Map([[1, 1 / 30], [2, 1 / 50], [3, null]]), rng).levelNo, 1);
  });

  it('the seed stream is deterministic (same seed/client/nonce → same picks) and seedHash = sha256(seed bytes)', () => {
    const a = new ProbRng('11'.repeat(32), 'c', 3);
    const b = new ProbRng('11'.repeat(32), 'c', 3);
    const c = new ProbRng('11'.repeat(32), 'c', 4);
    const xs = Array.from({ length: 20 }, () => a.int(1000));
    assert.deepEqual(Array.from({ length: 20 }, () => b.int(1000)), xs);
    assert.notDeepEqual(Array.from({ length: 20 }, () => c.int(1000)), xs);
    assert.equal(seedHash('00'.repeat(32)), '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
  });
});

describe('PROB pools (DB)', () => {
  let env: Awaited<ReturnType<typeof setupTestDb>>;
  let k = 0;
  const key = () => `prob-${process.pid}-${++k}-${Date.now()}`;
  before(async () => {
    env = await setupTestDb({ RISK_DRAW_LIMIT_PER_MIN: '1000' });
  });
  after(async () => {
    await env.teardown();
  });

  it('sample pool: 2000 tickets, public effective probabilities, seed hash published before sale, quick draw only with nonce + client seed', async () => {
    const poolId = await publishPool(PROB_SAMPLE_POOL);
    const board = await getSetBoard(db(), poolId, 1);
    assert.equal(board.total, 2000);
    assert.equal(board.playType, 'PROB');
    const seedHashPublished = (board.commitment as { prob?: { seedHash: string } }).prob!.seedHash;
    assert.match(seedHashPublished, /^[0-9a-f]{64}$/);
    const byName = Object.fromEntries(board.prizes.map((p) => [p.name, p.probability]));
    const rest = 1 - 1 / 30 - 1 / 50;
    assert.equal(byName['神隱卡西法'], Math.round((1 / 30) * 1e6) / 1e6);
    assert.equal(byName['宮崎駿地毯'], 0.02);
    assert.equal(byName['宮崎駿盲盒'], Math.round(((rest * 30) / 1990) * 1e6) / 1e6);
    assert.equal(byName['宮崎駿同人貼紙'], Math.round(((rest * 1960) / 1990) * 1e6) / 1e6);
    assert.deepEqual(board.levels.map((l) => [l.levelNo, (l as { odds?: number | null }).odds]), [[1, 1 / 30], [2, 1 / 50], [3, null], [4, null]]);
    const [s] = await db()`SELECT prob_server_seed FROM pool_sets WHERE pool_id = ${poolId}`;
    assert.equal(seedHash(s!.probServerSeed as string), seedHashPublished);
    assert.ok(!JSON.stringify(board).includes(s!.probServerSeed as string), 'server seed is secret before the set closes');

    const u = await makeUser({ coins: 10_000 });
    const r1 = (await executeDraw(u.id, key(), { poolId, setNo: 1, count: 10, clientSeed: 'my-lucky-seed' })).response;
    assert.equal(r1.results.length, 10);
    assert.deepEqual(r1.prob, { scheme: 'chiaki-prob-v1', seedHash: seedHashPublished, clientSeed: 'my-lucky-seed', nonce: 1 });
    const k2 = key();
    const r2 = (await executeDraw(u.id, k2, { poolId, setNo: 1, count: 5 })).response;
    assert.deepEqual([r2.prob!.nonce, r2.prob!.clientSeed], [2, k2], 'client seed defaults to the Idempotency-Key');
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 3 }), 'DRAW_PACK_NOT_ALLOWED');
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [1999] }), 'VALIDATION');
    await expectAppError(holdTickets(u.id, poolId, 1, [1999]), 'VALIDATION');
    const draws = await db()`SELECT prob_nonce, prob_client_seed FROM draws WHERE pool_id = ${poolId} ORDER BY prob_nonce`;
    assert.deepEqual(draws.map((d) => d.probNonce), [1, 2]);
  });

  it('validation: odds only on PROB pools; sum of odds < 1', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const lv = (levelNo: number, odds?: string | number | null) => ({ levelNo, name: `L${levelNo}`, odds, items: [{ name: `i${levelNo}`, qtyPerSet: 10 }] });
    await assert.rejects(createPoolDraft(ops.principal, customPool({ playType: 'STANDARD', levels: [lv(1, '1/30'), lv(2)] })), /只有機率賞/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ playType: 'PROB', levels: [lv(1, '1/2'), lv(2, 0.5)] })), /總和必須小於 1/);
    await assert.rejects(createPoolDraft(ops.principal, customPool({ playType: 'PROB', levels: [lv(1, 1.2), lv(2)] })), /機率須介於/);
    await createPoolDraft(ops.principal, customPool({ playType: 'PROB', levels: [lv(1, '1/3'), lv(2, 0.5)] }));
  });

  it('odds roll over in a live set; sold-out set reveals the seed and every draw replays exactly', async () => {
    // 大獎 1 張（固定 1/2）＋ 一般 9 張
    const poolId = await publishPool(
      customPool({
        playType: 'PROB',
        lastPrizeName: '最後賞',
        levels: [
          { levelNo: 1, name: '大獎', odds: 0.5, items: [{ name: '大獎', qtyPerSet: 1 }] },
          { levelNo: 4, name: '小獎', items: [{ name: '小獎', qtyPerSet: 9 }] },
        ],
      }),
    );
    const u = await makeUser({ coins: 10_000 });
    let first = true;
    for (let i = 0; i < 10; i++) {
      const b = await getSetBoard(db(), poolId, 1);
      const big = b.prizes.find((p) => p.name === '大獎')!;
      if (big.remaining === 0) {
        assert.equal(big.probability, 0);
        assert.equal(b.prizes.find((p) => p.name === '小獎')!.probability, 1, 'the exhausted 1/2 rolled into the rest');
        break;
      }
      assert.equal(big.probability, 0.5);
      await executeDraw(u.id, key(), { poolId, setNo: 1, count: 1 });
      first = false;
    }
    await expectAppError(revealSet(db(), poolId, 1), 'NOT_SOLD_OUT');
    const left = (await getSetBoard(db(), poolId, 1)).remaining;
    if (left > 0) await executeDraw(u.id, key(), { poolId, setNo: 1, count: 'all' });
    const rv = await revealSet(db(), poolId, 1);
    const prob = (rv as unknown as { prob: Parameters<typeof replayProbSet>[0] & { verified: boolean } }).prob;
    assert.equal(prob.verified, true);
    assert.equal(seedHash(prob.serverSeed), prob.seedHash);
    assert.equal(prob.draws.reduce((s, d) => s + d.ticketNos.length, 0), 10);
    assert.ok(replayProbSet(prob).ok);
    // 竄改任一筆紀錄 → 重算不符
    const tampered = { ...prob, draws: prob.draws.map((d, i) => (i === 0 ? { ...d, ticketNos: prob.draws.at(-1)!.ticketNos.slice(0, d.ticketNos.length) } : d)) };
    const bad = replayProbSet(tampered);
    assert.equal(bad.ok, false);
    assert.equal(replayProbSet({ ...prob, serverSeed: 'ff'.repeat(32) }).seedOk, false);
  });
});
