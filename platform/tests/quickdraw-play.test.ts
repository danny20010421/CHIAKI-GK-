/** 快速抽包（drawPacks）與免費試玩（/api/play/:poolId，demo，不動庫存/帳務/倉庫） */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { resetConfig } from '../src/server/config';
import { rateLimitStore } from '../src/server/security/rate-limit';
import { executeDraw, quoteDraw } from '../src/server/modules/draw/draw';
import { POST as drawRoute } from '../src/app/api/draws/route';
import { PATCH as poolSettings } from '../src/app/api/admin/pools/[id]/route';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { GET as playGet, POST as playPost } from '../src/app/api/play/[poolId]/route';
import { apiRequest, ctx, customPool, expectAppError, layoutOf, makeUser, publishPool, setupTestDb, smallPool, walletOf } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `qd-${process.pid}-${++k}-${Date.now()}`;
const none = undefined as never;
before(async () => {
  env = await setupTestDb({ FREE_PLAY_PER_MIN: '30' });
});
after(async () => {
  await env.teardown();
});
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });

describe('quick draw packs', () => {
  it('default packs are 1/5/10; admin can change them; count must be in the pool packs; server picks N random free tickets atomically', async () => {
    const draft = customPool();
    delete (draft as { drawPacks?: unknown }).drawPacks;
    const poolId = await publishPool(draft);
    const detail = await j<{ drawPacks: (number | string)[] }>(await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId })));
    assert.deepEqual(detail.body.drawPacks, [1, 5, 10]);
    const u = await makeUser({ coins: 10_000 });
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 3, shippingMethod: 'CVS_711_C2C' }), 'DRAW_PACK_NOT_ALLOWED');
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 'all', shippingMethod: 'CVS_711_C2C' }), 'DRAW_PACK_NOT_ALLOWED');
    await expectAppError(quoteDraw(u.id, { poolId, setNo: 1, count: 3 }), 'DRAW_PACK_NOT_ALLOWED');
    assert.equal((await walletOf(u.id)).coins, 10_000, 'rejected before any charge');
    const r = (await executeDraw(u.id, key(), { poolId, setNo: 1, count: 5, shippingMethod: 'CVS_711_C2C' })).response;
    assert.equal(r.ticketNos.length, 5);
    assert.equal(new Set(r.ticketNos).size, 5);
    // 自選籤號不受抽包限制
    const free = (await layoutOf(poolId, 1)).filter((t) => t.status === 'AVAILABLE').map((t) => t.ticketNo);
    assert.equal((await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: free.slice(0, 2) })).response.ticketNos.length, 2);

    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    assert.equal((await poolSettings(apiRequest('PATCH', `/api/admin/pools/${poolId}`, { token: member.token, body: { drawPacks: [1] } }), ctx({ id: poolId }))).status, 403);
    assert.equal((await poolSettings(apiRequest('PATCH', `/api/admin/pools/${poolId}`, { token: ops.token, body: { drawPacks: [2] } }), ctx({ id: poolId }))).status, 400);
    assert.equal((await poolSettings(apiRequest('PATCH', `/api/admin/pools/${poolId}`, { token: ops.token, body: { drawPacks: [] } }), ctx({ id: poolId }))).status, 400);
    const ok = await j<{ drawPacks: (number | string)[] }>(await poolSettings(apiRequest('PATCH', `/api/admin/pools/${poolId}`, { token: ops.token, body: { drawPacks: ['all', 20, 3, 1] } }), ctx({ id: poolId })));
    assert.deepEqual([ok.status, ok.body.drawPacks], [200, [1, 3, 20, 'all']]);
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'POOL_SETTINGS_UPDATED' AND entity_id = ${poolId}`;
    assert.match(a!.payloadJson as string, /"drawPacks"/);
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 5 }), 'DRAW_PACK_NOT_ALLOWED');
    // 40 - 7 = 33 張剩餘：20 可；再 20 超過剩餘 → NOT_ENOUGH_TICKETS；'all' 抽完剩下的 13 張
    assert.equal((await executeDraw(u.id, key(), { poolId, setNo: 1, count: 20 })).response.ticketNos.length, 20);
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 20 }), 'NOT_ENOUGH_TICKETS');
    const q = await quoteDraw(u.id, { poolId, setNo: 1, count: 'all' });
    assert.equal(q.ticketCount, 13);
    const all = (await executeDraw(u.id, key(), { poolId, setNo: 1, count: 'all' })).response;
    assert.deepEqual([all.ticketNos.length, all.setSoldOut], [13, true]);
  });

  it('count mode skips tickets held by others; concurrent quick draws never overlap', async () => {
    const poolId = await publishPool(customPool({ priceCoins: 1, prizes: [{ name: '小獎', grade: 'SMALL', qtyPerSet: 100 }] }));
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser({ coins: 1000 })));
    const rs = await Promise.all(users.map((u) => executeDraw(u.id, key(), { poolId, setNo: 1, count: 10, shippingMethod: 'CVS_711_C2C' })));
    const nos = rs.flatMap((r) => r.response.ticketNos);
    assert.equal(nos.length, 100);
    assert.equal(new Set(nos).size, 100, 'no ticket drawn twice');
    const [{ n }] = (await db()`SELECT count(*)::int AS n FROM tickets t JOIN pool_sets s ON s.id = t.set_id WHERE s.pool_id = ${poolId} AND t.status = 'AVAILABLE'`) as unknown as [{ n: number }];
    assert.equal(n, 0);
  });

  it('API: count accepts numbers or "all"; other strings are rejected', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 5000 });
    const bad = await drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, count: 'half', shippingMethod: 'CVS_711_C2C' } }), none);
    assert.equal(bad.status, 400);
    const ok = await drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, count: 'all', shippingMethod: 'CVS_711_C2C' } }), none);
    assert.equal(ok.status, 201);
    const body = (await ok.json()) as { ticketNos: number[]; results: { kind: string }[] };
    assert.equal(body.ticketNos.length, 10);
    assert.deepEqual(body.results.map((r) => r.kind).filter((x) => x === 'LAST'), ['LAST']);
  });
});

describe('free play (試玩)', () => {
  type Play = { demo: boolean; setNo: number; count: number; remaining: number; results: { levelNo: number | null; levelName: string; displayName: string; ticketNo?: number }[] };
  const snapshot = async (poolId: string) => {
    const [r] = await db()`
      SELECT (SELECT count(*)::int FROM tickets t JOIN pool_sets s ON s.id = t.set_id WHERE s.pool_id = ${poolId} AND t.status = 'AVAILABLE') AS avail,
             (SELECT count(*)::int FROM draws) AS draws, (SELECT count(*)::int FROM draw_results) AS results,
             (SELECT count(*)::int FROM warehouse_items) AS items, (SELECT count(*)::int FROM wallet_ledger) AS ledger,
             (SELECT count(*)::int FROM audit_log) AS audit`;
    return r;
  };

  it('no auth; simulated results from the current set distribution; demo: true; touches nothing', async () => {
    rateLimitStore().reset?.();
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 5000 });
    await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: (await layoutOf(poolId, 1)).filter((t) => t.levelNo === 1).map((t) => t.ticketNo), shippingMethod: 'CVS_711_C2C' });
    const before = await snapshot(poolId);
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 20; i++) {
      const r = await j<Play>(await playGet(apiRequest('GET', `/api/play/${poolId}?count=5`, { headers }), ctx({ poolId })));
      assert.equal(r.status, 200);
      assert.equal(r.body.demo, true);
      assert.deepEqual([r.body.setNo, r.body.count, r.body.remaining], [1, 5, 9]);
      assert.ok(r.body.results.every((x) => x.levelNo !== 1), 'the drawn A prize is no longer in the distribution');
      assert.ok(r.body.results.every((x) => !('ticketNo' in x)), 'no ticket numbers');
      assert.ok(r.body.results.filter((x) => x.levelNo === 2).length <= 1, 'sampling without replacement (only one B left)');
    }
    const p = await j<Play>(await playPost(apiRequest('POST', `/api/play/${poolId}?count=10`, { headers }), ctx({ poolId })));
    assert.deepEqual([p.status, p.body.count, p.body.results.length], [200, 9, 10], 'capped at remaining; selling out simulates the LAST prize');
    assert.equal(p.body.results.at(-1)!.levelName, '最後賞');
    assert.equal((await playGet(apiRequest('GET', `/api/play/${poolId}?count=3`, { headers }), ctx({ poolId }))).status, 400);
    assert.equal((await playGet(apiRequest('GET', `/api/play/no-such-pool?count=1`, { headers }), ctx({ poolId: 'no-such-pool' }))).status, 404);
    assert.deepEqual(await snapshot(poolId), before, 'inventory, draws, warehouse, ledger and audit untouched');
  });

  it('rate limited per IP (30/min)', async () => {
    rateLimitStore().reset?.();
    resetConfig();
    const poolId = await publishPool(smallPool());
    const ip = { 'x-forwarded-for': '198.51.100.9' };
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await playGet(apiRequest('GET', `/api/play/${poolId}`, { headers: ip }), ctx({ poolId }))).status);
    assert.deepEqual(codes.slice(0, 30), Array(30).fill(200));
    assert.ok(codes.slice(30).filter((c) => c === 429).length >= 5, `bucket refills only 0.5/s: ${codes.slice(30).join(',')}`);
    const other = await playGet(apiRequest('GET', `/api/play/${poolId}`, { headers: { 'x-forwarded-for': '198.51.100.10' } }), ctx({ poolId }));
    assert.equal(other.status, 200, 'per IP');
  });
});
