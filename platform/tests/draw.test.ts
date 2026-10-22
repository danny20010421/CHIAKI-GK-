import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { holdTickets, releaseHolds } from '../src/server/modules/draw/holds';
import { getSetBoard, revealSet } from '../src/server/modules/pool/queries';
import { verifyCommitment } from '../src/server/modules/pool/commitment';
import { reconcileWallets } from '../src/server/modules/wallet/wallet';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import { expectAppError, FEE_CVS, layoutOf, makeUser, publishPool, setupTestDb, smallPool, walletOf } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `test-key-${process.pid}-${++k}-${Date.now()}`;

before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

describe('draw transaction', () => {
  it('debits coins, marks tickets taken, credits warehouse, writes ledger + audit', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 1000 });
    const { response, replayed } = await executeDraw(u.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [3, 1] });
    assert.equal(replayed, false);
    assert.deepEqual(response.ticketNos, [1, 3]);
    assert.equal(response.amountCoins, 200);
    assert.equal(response.shipping.feesToCharge, 1, 'first paid draw in a set prepays one shipping fee');
    assert.equal(response.shipping.amount, FEE_CVS);
    assert.equal(response.totalCoins, 200 + FEE_CVS);
    assert.equal(response.coinsAfter, 800 - FEE_CVS);
    assert.equal(response.results.length, 2);
    const layout = await layoutOf(poolId, 1);
    for (const r of response.results) {
      assert.equal(r.kind, 'TICKET');
      assert.equal(r.rank, layout.find((t) => t.ticketNo === r.ticketNo)!.rank, 'result equals pre-committed layout');
      assert.equal(r.grade, layout.find((t) => t.ticketNo === r.ticketNo)!.grade);
      assert.equal(r.displayName, `${r.rank}賞 ${r.prizeName}`, 'official pool: rank label + name');
    }
    assert.equal((await walletOf(u.id)).coins, 800 - FEE_CVS);
    const items = await db()`SELECT id FROM warehouse_items WHERE user_id = ${u.id} AND status = 'STORED'`;
    assert.equal(items.length, 2);
    const taken = layout.filter((t) => t.status === 'TAKEN').map((t) => t.ticketNo);
    assert.deepEqual(taken, [1, 3]);
    const ledger = await db()`SELECT amount, balance_after, entry_type FROM wallet_ledger WHERE user_id = ${u.id} ORDER BY id`;
    assert.deepEqual(ledger.at(-2), { amount: -200, balanceAfter: 800, entryType: 'DRAW_DEBIT' });
    assert.deepEqual(ledger.at(-1), { amount: -FEE_CVS, balanceAfter: 800 - FEE_CVS, entryType: 'SHIPPING_PREPAID' });
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
    assert.equal((await verifyAuditChain(db())).ok, true);
  });

  it('requires age verification before the first paid draw', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 1000, ageVerified: false });
    await expectAppError(executeDraw(u.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1] }), 'AGE_VERIFICATION_REQUIRED');
    assert.equal((await walletOf(u.id)).coins, 1000);
  });

  it('insufficient funds: clean error, nothing changes (all-or-nothing)', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 150 });
    await expectAppError(executeDraw(u.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1, 2] }), 'INSUFFICIENT_FUNDS');
    assert.equal((await walletOf(u.id)).coins, 150);
    assert.ok((await layoutOf(poolId, 1)).every((t) => t.status === 'AVAILABLE'));
    const [{ n }] = (await db()`SELECT count(*)::int AS n FROM draws WHERE user_id = ${u.id}`) as unknown as [{ n: number }];
    assert.equal(n, 0);
  });

  it('requires an Idempotency-Key, replays identical result without double charge, rejects key reuse', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 1000 });
    await expectAppError(executeDraw(u.id, undefined, { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [5] }), 'IDEMPOTENCY_KEY_REQUIRED');
    const kk = key();
    const a = await executeDraw(u.id, kk, { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [5] });
    const b = await executeDraw(u.id, kk, { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [5] });
    assert.equal(b.replayed, true);
    assert.deepEqual(b.response, a.response);
    assert.equal((await walletOf(u.id)).coins, 900 - FEE_CVS);
    await expectAppError(executeDraw(u.id, kk, { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [6] }), 'IDEMPOTENCY_KEY_REUSED');
  });

  it('concurrent retries with the same key → exactly one charge, all responses identical', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 1000 });
    const kk = key();
    const rs = await Promise.all(Array.from({ length: 12 }, () => executeDraw(u.id, kk, { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [7, 8] })));
    assert.equal(rs.filter((r) => !r.replayed).length, 1);
    for (const r of rs) assert.deepEqual(r.response, rs[0]!.response);
    assert.equal((await walletOf(u.id)).coins, 800 - FEE_CVS);
    const [{ f }] = (await db()`SELECT count(*)::int AS f FROM shipping_prepayments WHERE user_id = ${u.id}`) as unknown as [{ f: number }];
    assert.equal(f, 1, 'replays never charge shipping twice');
    const [{ n }] = (await db()`SELECT count(*)::int AS n FROM draws WHERE user_id = ${u.id}`) as unknown as [{ n: number }];
    assert.equal(n, 1);
  });

  it('server-side random pick (count) uses only available tickets', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 5000 });
    await executeDraw(u.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1, 2, 3] });
    const { response } = await executeDraw(u.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, count: 4 });
    assert.equal(response.ticketNos.length, 4);
    assert.ok(response.ticketNos.every((n) => n > 3));
    await expectAppError(executeDraw(u.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, count: 4 }), 'NOT_ENOUGH_TICKETS');
  });

  it('drawing a taken ticket fails cleanly', async () => {
    const poolId = await publishPool(smallPool());
    const a = await makeUser({ coins: 1000 });
    const b = await makeUser({ coins: 1000 });
    await executeDraw(a.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [4] });
    await expectAppError(executeDraw(b.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [4, 5] }), 'TICKET_TAKEN');
    assert.equal((await walletOf(b.id)).coins, 1000);
    assert.equal((await layoutOf(poolId, 1)).find((t) => t.ticketNo === 5)!.status, 'AVAILABLE', 'multi-draw is all-or-nothing');
  });
});

describe('holds (鎖籤)', () => {
  it('blocks other users, allows the holder to draw, expires lazily, can be released', async () => {
    const poolId = await publishPool(smallPool());
    const a = await makeUser({ coins: 1000 });
    const b = await makeUser({ coins: 1000 });
    const h = await holdTickets(a.id, poolId, 1, [1, 2]);
    assert.deepEqual(h.ticketNos, [1, 2]);
    const secs = (h.heldUntil.getTime() - Date.now()) / 1000;
    assert.ok(secs > 170 && secs <= 181, `default hold ~180s, got ${secs}`);

    await expectAppError(holdTickets(b.id, poolId, 1, [2, 3]), 'TICKET_HELD');
    assert.equal((await layoutOf(poolId, 1)).find((t) => t.ticketNo === 3)!.status, 'AVAILABLE');
    const [t3] = await db()`SELECT held_by FROM tickets t JOIN pool_sets s ON s.id = t.set_id WHERE s.pool_id = ${poolId} AND s.set_no = 1 AND t.ticket_no = 3`;
    assert.equal(t3!.heldBy, null, 'all-or-nothing: ticket 3 must not be held by B');
    await expectAppError(executeDraw(b.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1] }), 'TICKET_HELD');

    const board = await getSetBoard(db(), poolId, 1, b.id);
    assert.equal(board.tickets.find((t) => t.no === 1)!.state, 'HELD');
    assert.equal((board.tickets.find((t) => t.no === 1) as { heldByMe?: boolean }).heldByMe, undefined);
    const mine = await getSetBoard(db(), poolId, 1, a.id);
    assert.equal((mine.tickets.find((t) => t.no === 1) as { heldByMe?: boolean }).heldByMe, true);

    // 持有者可抽；抽後保留清除
    await executeDraw(a.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1] });
    // 讓 2 號的保留過期 → B 可以保留
    await db()`UPDATE tickets SET held_until = now() - interval '1 second' FROM pool_sets s
               WHERE s.id = tickets.set_id AND s.pool_id = ${poolId} AND s.set_no = 1 AND tickets.ticket_no = 2`;
    const hb = await holdTickets(b.id, poolId, 1, [2]);
    assert.deepEqual(hb.ticketNos, [2]);
    const rel = await releaseHolds(b.id, poolId, 1);
    assert.deepEqual(rel.released, [2]);
    await expectAppError(holdTickets(b.id, poolId, 1, [1]), 'TICKET_TAKEN');
  });

  it('hold duration is configurable', async () => {
    const poolId = await publishPool(smallPool());
    const a = await makeUser();
    const h = await holdTickets(a.id, poolId, 1, [9], 30);
    const secs = (h.heldUntil.getTime() - Date.now()) / 1000;
    assert.ok(secs > 25 && secs <= 31);
  });
});

describe('sell-out, Last賞, reveal & verify', () => {
  it('final ticket drawer gets Last賞; set sells out; next set opens; reveal verifies the commitment', async () => {
    const poolId = await publishPool(smallPool());
    const a = await makeUser({ coins: 5000 });
    const b = await makeUser({ coins: 5000 });
    await expectAppError(revealSet(db(), poolId, 1), 'NOT_SOLD_OUT');
    await expectAppError(executeDraw(a.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 2, ticketNos: [1] }), 'SET_NOT_ON_SALE');

    await executeDraw(a.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    const before = await getSetBoard(db(), poolId, 1);
    assert.equal(before.remaining, 1);
    const last = await executeDraw(b.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [10] });
    assert.equal(last.response.setSoldOut, true);
    assert.equal(last.response.nextSetNo, 2);
    assert.deepEqual(last.response.results.map((r) => r.kind), ['TICKET', 'LAST']);
    assert.equal(last.response.results[1]!.prizeName, 'Last賞（測試）');
    const lastItems = await db()`SELECT user_id FROM warehouse_items WHERE pool_id = ${poolId} AND source = 'LAST'`;
    assert.deepEqual(lastItems.map((r) => r.userId), [b.id], 'exactly one Last prize, to the drawer of the final ticket');

    const rv = await revealSet(db(), poolId, 1);
    assert.equal(rv.verified, true);
    assert.equal(rv.layout.length, 10);
    assert.equal(verifyCommitment({ poolId, setNo: 1, rulesHash: rv.rulesHash, layout: rv.layout }, rv.salt, rv.commitment), true);
    const tampered = rv.layout.map((t) => ({ ...t }));
    const ai = tampered.findIndex((t) => t.rank === 'A');
    const di = tampered.findIndex((t) => t.rank === 'D');
    [tampered[ai]!.ticketNo, tampered[di]!.ticketNo] = [tampered[di]!.ticketNo, tampered[ai]!.ticketNo];
    assert.equal(verifyCommitment({ poolId, setNo: 1, rulesHash: rv.rulesHash, layout: tampered }, rv.salt, rv.commitment), false);

    await executeDraw(a.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 2, ticketNos: [1] });
    await expectAppError(revealSet(db(), poolId, 2), 'NOT_SOLD_OUT');
  });

  it('sells out the whole pool → pool ENDED', async () => {
    const poolId = await publishPool(smallPool({ setCount: 1, lastPrizeName: null }));
    const a = await makeUser({ coins: 5000 });
    const r = await executeDraw(a.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, count: 10 });
    assert.equal(r.response.setSoldOut, true);
    assert.equal(r.response.nextSetNo, null);
    assert.equal(r.response.results.length, 10, 'no Last prize configured');
    const [p] = await db()`SELECT status FROM pools WHERE id = ${poolId}`;
    assert.equal(p!.status, 'ENDED');
  });
});

describe('live remaining & probabilities', () => {
  it('computed from DB: remaining of rank / total remaining', async () => {
    const poolId = await publishPool(smallPool());
    const a = await makeUser({ coins: 5000 });
    const layout = await layoutOf(poolId, 1);
    const aTicket = layout.find((t) => t.rank === 'A')!.ticketNo;
    const dTickets = layout.filter((t) => t.rank === 'D').slice(0, 2).map((t) => t.ticketNo);
    await executeDraw(a.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [aTicket, ...dTickets] });
    const board = await getSetBoard(db(), poolId, 1);
    assert.equal(board.remaining, 7);
    const by = Object.fromEntries(board.prizes.map((p) => [p.rank, p]));
    assert.equal(by.A!.remaining, 0);
    assert.equal(by.A!.probability, 0);
    assert.equal(by.D!.remaining, 4);
    assert.equal(by.D!.probability, Math.round((4 / 7) * 1e6) / 1e6);
    assert.equal(by.C!.probability, Math.round((2 / 7) * 1e6) / 1e6);
    const sum = board.prizes.reduce((s, p) => s + p.remaining, 0);
    assert.equal(sum, board.remaining);
    // 已抽出的籤顯示賞級；未抽出的籤不揭露
    for (const t of board.tickets) {
      if (t.state === 'TAKEN') assert.ok('rank' in t);
      else assert.ok(!('rank' in t));
    }
  });
});
