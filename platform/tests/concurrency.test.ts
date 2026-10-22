import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { db } from '../src/server/db';
import { POST as drawRoute } from '../src/app/api/draws/route';
import { POST as holdRoute } from '../src/app/api/pools/[id]/sets/[no]/holds/route';
import { reconcileWallets } from '../src/server/modules/wallet/wallet';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import { executeDraw } from '../src/server/modules/draw/draw';
import { apiRequest, ctx, makeUser, publishPool, setupTestDb, smallPool } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const N = 40; // ≥ 30 名玩家同時搶同一張籤
const START = 1000;

describe('concurrency (real PostgreSQL, row locks)', () => {
  it(`${N} users race for the same ticket via POST /api/draws → exactly one wins, nobody else is charged`, async () => {
    const poolId = await publishPool(smallPool({ priceCoins: 300, prizes: [{ rank: 'A', name: 'A', qtyPerSet: 1 }, { rank: 'H', name: 'H', qtyPerSet: 99 }] }));
    const users = await Promise.all(Array.from({ length: N }, () => makeUser({ coins: START })));
    const [{ before }] = (await db()`SELECT sum(coins)::bigint AS before FROM wallets`) as unknown as [{ before: number }];

    const responses = await Promise.all(
      users.map((u, i) =>
        drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': `race-${i}-${Date.now()}` }, body: { poolId, setNo: 1, ticketNos: [7] } }), undefined as never),
      ),
    );
    const statuses = responses.map((r) => r.status);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ error?: { code: string } }>));
    const winners = statuses.filter((s) => s === 201).length;
    const losers = bodies.filter((b) => b.error?.code === 'TICKET_TAKEN').length;
    console.log(`    race result: ${winners} × 201, ${losers} × 409 TICKET_TAKEN, other: ${N - winners - losers}`);
    assert.equal(winners, 1);
    assert.equal(losers, N - 1);
    for (const [i, s] of statuses.entries()) if (s !== 201) assert.equal(s, 409, `user ${i} got ${s}`);

    const winnerIdx = statuses.indexOf(201);
    const coins = await db()<{ userId: string; coins: number }[]>`SELECT user_id, coins FROM wallets WHERE user_id = ANY(${users.map((u) => u.id)}::uuid[])`;
    for (const c of coins) assert.equal(c.coins, c.userId === users[winnerIdx]!.id ? START - 300 : START);
    const [{ after: afterSum }] = (await db()`SELECT sum(coins)::bigint AS after FROM wallets`) as unknown as [{ after: number }];
    assert.equal(afterSum, before - 300, 'system-wide balances reconcile to the coin');

    const [t] = await db()`SELECT t.taken_by FROM tickets t JOIN pool_sets s ON s.id = t.set_id WHERE s.pool_id = ${poolId} AND s.set_no = 1 AND t.ticket_no = 7`;
    assert.equal(t!.takenBy, users[winnerIdx]!.id);
    const [{ n }] = (await db()`SELECT count(*)::int AS n FROM draws WHERE pool_id = ${poolId}`) as unknown as [{ n: number }];
    assert.equal(n, 1);
    const [{ d }] = (await db()`SELECT count(*)::int AS d FROM wallet_ledger WHERE entry_type = 'DRAW_DEBIT'`) as unknown as [{ d: number }];
    assert.equal(d, 1, 'losers have no debit ledger rows');
    const rec = await reconcileWallets(db());
    assert.ok(rec.every((r) => r.ok), 'every wallet: cached == sum(ledger) == last balance_after');
    assert.equal((await verifyAuditChain(db())).ok, true);
  });

  it(`${N} users race to HOLD the same ticket → exactly one hold succeeds`, async () => {
    const poolId = await publishPool(smallPool());
    const users = await Promise.all(Array.from({ length: N }, () => makeUser()));
    const responses = await Promise.all(
      users.map((u) => holdRoute(apiRequest('POST', `/api/pools/${poolId}/sets/1/holds`, { token: u.token, body: { ticketNos: [3] } }), ctx({ id: poolId, no: '1' }))),
    );
    const ok = responses.filter((r) => r.status === 201).length;
    const held = (await Promise.all(responses.filter((r) => r.status !== 201).map((r) => r.json() as Promise<{ error: { code: string } }>))).filter((b) => b.error.code === 'TICKET_HELD').length;
    assert.equal(ok, 1);
    assert.equal(held, N - 1);
  });

  it('chaotic overlapping multi-draws: no ticket sold twice, debits == price × tickets sold, ledgers reconcile', async () => {
    const poolId = await publishPool(smallPool({ setCount: 1, priceCoins: 70, lastPrizeName: null, prizes: [{ rank: 'A', name: 'A', qtyPerSet: 2 }, { rank: 'H', name: 'H', qtyPerSet: 38 }] }));
    const users = await Promise.all(Array.from({ length: 30 }, () => makeUser({ coins: 700 })));
    const attempts = users.flatMap((u, i) =>
      Array.from({ length: 3 }, (_, j) => {
        const start = randomInt(1, 38);
        const nos = Array.from(new Set([start, start + randomInt(0, 3), start + randomInt(0, 3)])).filter((x) => x <= 40);
        return executeDraw(u.id, `chaos-${i}-${j}-${Date.now()}`, { poolId, setNo: 1, ticketNos: nos }).then(
          (r) => ({ ok: true as const, n: r.response.ticketNos.length, user: u.id }),
          (e: { code?: string }) => ({ ok: false as const, code: e.code ?? 'UNKNOWN', user: u.id }),
        );
      }),
    );
    const results = await Promise.all(attempts);
    const unexpected = results.filter((r) => !r.ok && !['TICKET_TAKEN', 'INSUFFICIENT_FUNDS', 'SET_NOT_ON_SALE'].includes(r.code));
    assert.deepEqual(unexpected, [], 'only clean business errors');
    const soldInResponses = results.reduce((s, r) => s + (r.ok ? r.n : 0), 0);
    const [{ sold }] = (await db()`SELECT count(*)::int AS sold FROM tickets t JOIN pool_sets s ON s.id = t.set_id WHERE s.pool_id = ${poolId} AND t.status = 'TAKEN'`) as unknown as [{ sold: number }];
    assert.equal(sold, soldInResponses, 'every taken ticket belongs to exactly one successful draw');
    const [{ dupes }] = (await db()`SELECT count(*)::int AS dupes FROM (SELECT ticket_no FROM draw_results r JOIN draws d ON d.id = r.draw_id WHERE d.pool_id = ${poolId} AND r.kind = 'TICKET' GROUP BY ticket_no HAVING count(*) > 1) x`) as unknown as [{ dupes: number }];
    assert.equal(dupes, 0);
    const [{ debited }] = (await db()`SELECT COALESCE(-sum(amount), 0)::bigint AS debited FROM wallet_ledger WHERE entry_type = 'DRAW_DEBIT' AND ref_id IN (SELECT id::text FROM draws WHERE pool_id = ${poolId})`) as unknown as [{ debited: number }];
    assert.equal(debited, sold * 70);
    const rec = await reconcileWallets(db());
    assert.ok(rec.every((r) => r.ok));
    assert.equal((await verifyAuditChain(db())).ok, true);
    console.log(`    chaos: ${results.filter((r) => r.ok).length}/${results.length} draws succeeded, ${sold} tickets sold`);
  });
});
