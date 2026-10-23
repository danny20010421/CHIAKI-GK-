/** 後台管理賞池與套：下架/上架、套名稱與備註、0 銷售重新產生籤表、新增套、軟刪除/還原/30 天後硬刪除、原因必填與稽核 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { holdTickets } from '../src/server/modules/draw/holds';
import { getSetBoard, revealSet } from '../src/server/modules/pool/queries';
import { verifyCommitment } from '../src/server/modules/pool/commitment';
import { purgeDeleted } from '../src/server/modules/pool/manage';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import { listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { GET as poolsRoute } from '../src/app/api/pools/route';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { GET as playGet } from '../src/app/api/play/[poolId]/route';
import { DELETE as poolDelete, GET as adminPoolGet } from '../src/app/api/admin/pools/[id]/route';
import { POST as poolOffline } from '../src/app/api/admin/pools/[id]/offline/route';
import { POST as poolRestore } from '../src/app/api/admin/pools/[id]/restore/route';
import { POST as addSetRoute } from '../src/app/api/admin/pools/[id]/sets/route';
import { DELETE as setDelete } from '../src/app/api/admin/pools/[id]/sets/[no]/route';
import { PATCH as setEdit } from '../src/app/api/admin/pools/[id]/sets/[no]/edit/route';
import { POST as setOffline } from '../src/app/api/admin/pools/[id]/sets/[no]/offline/route';
import { POST as setRestore } from '../src/app/api/admin/pools/[id]/sets/[no]/restore/route';
import { POST as purgeRoute } from '../src/app/api/admin/jobs/purge-deleted/route';
import { apiRequest, ctx, customPool, expectAppError, layoutOf, makeUser, publishPool, setupTestDb, smallPool, type TestUser } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let ops: TestUser;
let boss: TestUser;
let k = 0;
const key = () => `pm-${process.pid}-${++k}-${Date.now()}`;
before(async () => {
  env = await setupTestDb();
  ops = await makeUser({ roles: ['OPS'] });
  boss = await makeUser({ roles: ['SUPER_ADMIN'] });
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
type Err = { error: { code: string; message: string } };
const as = (u: TestUser, method: string, path: string, body?: unknown) => apiRequest(method, path, { token: u.token, body });
const listed = async () => (await j<{ pools: { id: string }[] }>(await poolsRoute(apiRequest('GET', '/api/pools'), none))).body.pools.map((p) => p.id);
const auditCount = async (action: string) => ((await db()`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`) as unknown as [{ n: number }])[0].n;

describe('take down / put back', () => {
  it('offline pool: hidden from listings, no holds/draws/free play (holds released); existing draws & warehouse untouched; reason required', async () => {
    const id = await publishPool(smallPool());
    const u = await makeUser({ coins: 5000 });
    const v = await makeUser({ coins: 5000 });
    await executeDraw(u.id, key(), { poolId: id, setNo: 1, ticketNos: [1] });
    await holdTickets(v.id, id, 1, [5]);
    assert.ok((await listed()).includes(id));
    assert.equal((await poolOffline(as(ops, 'POST', `/api/admin/pools/${id}/offline`, { offline: true }), ctx({ id }))).status, 400, 'reason required');
    assert.equal((await poolOffline(as(ops, 'POST', `/api/admin/pools/${id}/offline`, { offline: true, reason: '  ' }), ctx({ id }))).status, 400);
    const member = await makeUser();
    assert.equal((await poolOffline(as(member, 'POST', `/api/admin/pools/${id}/offline`, { offline: true, reason: 'x' }), ctx({ id }))).status, 403);
    const r = await j<{ offline: boolean; holdsReleased: number }>(await poolOffline(as(ops, 'POST', `/api/admin/pools/${id}/offline`, { offline: true, reason: '獎品圖片有誤' }), ctx({ id })));
    assert.deepEqual([r.status, r.body.offline, r.body.holdsReleased], [200, true, 1]);
    assert.ok(!(await listed()).includes(id), 'hidden from public listing');
    const detail = await j<{ offline: boolean }>(await poolRoute(apiRequest('GET', `/api/pools/${id}`), ctx({ id })));
    assert.deepEqual([detail.status, detail.body.offline], [200, true], 'direct link still works (verification), flagged offline');
    await expectAppError(holdTickets(v.id, id, 1, [6]), 'SET_NOT_ON_SALE');
    await expectAppError(executeDraw(v.id, key(), { poolId: id, setNo: 1, ticketNos: [6] }), 'SET_NOT_ON_SALE');
    assert.equal((await playGet(apiRequest('GET', `/api/play/${id}`), ctx({ poolId: id }))).status, 409);
    assert.equal((await listWarehouse(db(), u.id)).length, 1, 'warehouse untouched');
    assert.equal((await poolOffline(as(ops, 'POST', `/api/admin/pools/${id}/offline`, { offline: false, reason: '已修正' }), ctx({ id }))).status, 200);
    assert.ok((await listed()).includes(id));
    await executeDraw(v.id, key(), { poolId: id, setNo: 1, ticketNos: [6] });
    assert.equal(await auditCount('POOL_TAKEN_OFFLINE'), 1);
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'POOL_TAKEN_OFFLINE'`;
    assert.match(a!.payloadJson as string, /獎品圖片有誤/);
  });

  it('offline set: that set cannot be held or drawn; other sets unaffected; listing current set skips it', async () => {
    const id = await publishPool(smallPool({ setCount: 2 }));
    const v = await makeUser({ coins: 5000 });
    const res = await j<{ offline: boolean }>(await setOffline(as(ops, 'POST', `/api/admin/pools/${id}/sets/1/offline`, { offline: true, reason: '籤表疑慮' }), ctx({ id, no: '1' })));
    assert.equal(res.status, 200);
    await expectAppError(holdTickets(v.id, id, 1, [1]), 'SET_NOT_ON_SALE');
    const board = await getSetBoard(db(), id, 1);
    assert.equal(board.offline, true);
    const list = await j<{ pools: { id: string; currentSet: unknown }[] }>(await poolsRoute(apiRequest('GET', '/api/pools'), none));
    assert.equal(list.body.pools.find((p) => p.id === id)!.currentSet, null);
    await setOffline(as(ops, 'POST', `/api/admin/pools/${id}/sets/1/offline`, { offline: false, reason: 'ok' }), ctx({ id, no: '1' }));
    await holdTickets(v.id, id, 1, [1]);
  });
});

describe('edit set', () => {
  it('display name + internal note anytime; regenerate only with 0 sales (old commitment kept & verifiable); with sales → 409 已有銷售紀錄，只能下架', async () => {
    const id = await publishPool(smallPool({ setCount: 2 }));
    const before = await layoutOf(id, 2);
    const [old] = await db()`SELECT commitment FROM pool_sets WHERE pool_id = ${id} AND set_no = 2`;
    const r = await j<{ displayName: string; regenerated: boolean; commitment: string }>(
      await setEdit(as(ops, 'PATCH', `/api/admin/pools/${id}/sets/2/edit`, { displayName: '第二套（補貨）', internalNote: '倉庫 B 區', regenerate: true, reason: '原籤表獎項設定錯誤' }), ctx({ id, no: '2' })),
    );
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.displayName, r.body.regenerated], ['第二套（補貨）', true]);
    assert.notEqual(r.body.commitment, old!.commitment);
    const after = await layoutOf(id, 2);
    assert.equal(after.length, before.length);
    assert.deepEqual(after.map((t) => t.levelNo).sort(), before.map((t) => t.levelNo).sort(), 'same prize distribution');
    const pub = await j<{ sets: { setNo: number; displayName: string | null; internalNote?: string }[] }>(await poolRoute(apiRequest('GET', `/api/pools/${id}`), ctx({ id })));
    assert.equal(pub.body.sets.find((s) => s.setNo === 2)!.displayName, '第二套（補貨）');
    assert.ok(pub.body.sets.every((s) => !('internalNote' in s)), 'internal note never public');
    const admin = await j<{ sets: { setNo: number; internalNote: string; sales: number }[] }>(await adminPoolGet(as(ops, 'GET', `/api/admin/pools/${id}`), ctx({ id })));
    assert.equal(admin.body.sets.find((s) => s.setNo === 2)!.internalNote, '倉庫 B 區');

    // 賣完第 2 套後公開：新承諾驗證通過，被取代的舊承諾也可用其舊 salt/籤表驗證
    const u = await makeUser({ coins: 10_000 });
    await executeDraw(u.id, key(), { poolId: id, setNo: 1, count: 10 });
    await executeDraw(u.id, key(), { poolId: id, setNo: 2, count: 10 });
    const rv = await revealSet(db(), id, 2);
    assert.equal(rv.verified, true);
    assert.equal(rv.superseded.length, 1);
    const s0 = rv.superseded[0]!;
    assert.equal(s0.commitment, old!.commitment);
    assert.ok(verifyCommitment({ scheme: s0.commitScheme as never, poolId: id, setNo: 2, rulesHash: s0.rulesHash, layout: s0.layout }, s0.salt, s0.commitment));

    // 有銷售：可改名，不可重新產生
    assert.equal((await setEdit(as(ops, 'PATCH', `/api/admin/pools/${id}/sets/1/edit`, { displayName: '首套', reason: '命名' }), ctx({ id, no: '1' }))).status, 200);
    const sold = await j<Err>(await setEdit(as(ops, 'PATCH', `/api/admin/pools/${id}/sets/1/edit`, { regenerate: true, reason: 'x' }), ctx({ id, no: '1' })));
    assert.deepEqual([sold.status, sold.body.error.code, sold.body.error.message], [409, 'HAS_SALES', '已有銷售紀錄，只能下架']);
    assert.equal((await setEdit(as(ops, 'PATCH', `/api/admin/pools/${id}/sets/1/edit`, { displayName: 'x' }), ctx({ id, no: '1' }))).status, 400, 'reason required');
    // 資料庫層：即使繞過程式，已有銷售的套也無法改承諾
    await assert.rejects(db().begin(async (tx) => {
      await tx`SELECT set_config('chiaki.relayout', 'on', true)`;
      await tx`UPDATE pool_sets SET commitment = 'x' WHERE pool_id = ${id} AND set_no = 1`;
    }), /immutable/);
    // 0 銷售的套：沒有在交易內明確開啟 chiaki.relayout 時，承諾與籤表仍不可改
    const fresh = await publishPool(smallPool({ setCount: 1 }));
    await assert.rejects(db()`UPDATE pool_sets SET commitment = 'x' WHERE pool_id = ${fresh}`, /immutable/);
    await assert.rejects(db()`UPDATE tickets SET prize_id = (SELECT pp.id FROM pool_prizes pp WHERE pp.pool_id = ${fresh} AND pp.kind = 'TICKET' AND pp.id <> tickets.prize_id LIMIT 1) WHERE set_id = (SELECT id FROM pool_sets WHERE pool_id = ${fresh}) AND ticket_no = 2`, /immutable/);
    await assert.rejects(db()`DELETE FROM tickets WHERE set_id = (SELECT id FROM pool_sets WHERE pool_id = ${fresh})`, /cannot be deleted/);
    await assert.rejects(db()`DELETE FROM pool_sets WHERE pool_id = ${fresh}`, /cannot be deleted/);
    assert.equal((await verifyAuditChain(db())).ok, true);
  });
});

describe('add set', () => {
  it('generates a new set from current levels with a new commitment; ended pool reopens', async () => {
    const id = await publishPool(smallPool({ setCount: 1, lastPrizeName: null }));
    const u = await makeUser({ coins: 10_000 });
    await executeDraw(u.id, key(), { poolId: id, setNo: 1, count: 10 });
    const [p0] = await db()`SELECT status FROM pools WHERE id = ${id}`;
    assert.equal(p0!.status, 'ENDED');
    assert.equal((await addSetRoute(as(ops, 'POST', `/api/admin/pools/${id}/sets`, {}), ctx({ id }))).status, 400, 'reason required');
    const r = await j<{ setNo: number; status: string; commitment: string }>(await addSetRoute(as(ops, 'POST', `/api/admin/pools/${id}/sets`, { reason: '加開一套', displayName: '加開' }), ctx({ id })));
    assert.deepEqual([r.status, r.body.setNo, r.body.status], [201, 2, 'ON_SALE']);
    const [p1] = await db()`SELECT status, set_count FROM pools WHERE id = ${id}`;
    assert.deepEqual(p1, { status: 'PUBLISHED', setCount: 2 });
    const l = await layoutOf(id, 2);
    assert.deepEqual(l.map((t) => t.levelNo).sort(), [1, 2, 3, 3, 4, 4, 4, 4, 4, 4]);
    await executeDraw(u.id, key(), { poolId: id, setNo: 2, count: 10 });
    assert.equal((await revealSet(db(), id, 2)).verified, true);
    const q = await j<{ setNo: number; status: string }>(await addSetRoute(as(ops, 'POST', `/api/admin/pools/${id}/sets`, { reason: '再加一套' }), ctx({ id })));
    assert.deepEqual([q.body.setNo, q.body.status], [3, 'ON_SALE']);
    assert.equal(await auditCount('SET_ADDED'), 2);
  });
});

describe('delete / restore / purge', () => {
  it('set with sales → 409; 0-sale set soft-deleted (next set opens), hidden, restorable; purge after 30 days', async () => {
    const id = await publishPool(smallPool({ setCount: 3 }));
    const u = await makeUser({ coins: 10_000 });
    await executeDraw(u.id, key(), { poolId: id, setNo: 1, ticketNos: [1] });
    const sold = await j<Err>(await setDelete(as(ops, 'DELETE', `/api/admin/pools/${id}/sets/1`, { reason: '刪錯' }), ctx({ id, no: '1' })));
    assert.deepEqual([sold.status, sold.body.error.code, sold.body.error.message], [409, 'HAS_SALES', '已有銷售紀錄，只能下架']);
    assert.equal((await setDelete(as(ops, 'DELETE', `/api/admin/pools/${id}/sets/2`, {}), ctx({ id, no: '2' }))).status, 400, 'reason required');
    const d = await j<{ deleted: boolean; poolDeleted: boolean }>(await setDelete(as(ops, 'DELETE', `/api/admin/pools/${id}/sets/2`, { reason: '重複建立' }), ctx({ id, no: '2' })));
    assert.deepEqual([d.status, d.body.deleted, d.body.poolDeleted], [200, true, false]);
    const pub = await j<{ sets: { setNo: number }[] }>(await poolRoute(apiRequest('GET', `/api/pools/${id}`), ctx({ id })));
    assert.deepEqual(pub.body.sets.map((s) => s.setNo), [1, 3]);
    await expectAppError(getSetBoard(db(), id, 2), 'NOT_FOUND');
    // 第 1 套賣完 → 跳過已刪除的第 2 套，開賣第 3 套
    await executeDraw(u.id, key(), { poolId: id, setNo: 1, count: 'all' });
    const sets = await db()`SELECT set_no, status FROM pool_sets WHERE pool_id = ${id} ORDER BY set_no`;
    assert.deepEqual(sets.map((s) => [s.setNo, s.status]), [[1, 'SOLD_OUT'], [2, 'QUEUED'], [3, 'ON_SALE']]);
    // 還原：已有其他開賣中的套 → 排隊
    assert.equal((await setRestore(as(ops, 'POST', `/api/admin/pools/${id}/sets/2/restore`, { reason: '誤刪' }), ctx({ id, no: '2' }))).status, 200);
    assert.equal((await setRestore(as(ops, 'POST', `/api/admin/pools/${id}/sets/2/restore`, { reason: '誤刪' }), ctx({ id, no: '2' }))).status, 409, 'not deleted any more');
    await setDelete(as(ops, 'DELETE', `/api/admin/pools/${id}/sets/2`, { reason: '真的不要' }), ctx({ id, no: '2' }));
    // 30 天內不硬刪；超過 → 硬刪（籤與套一併移除），已有銷售的套永不受影響
    assert.deepEqual(await purgeDeleted(new Date(Date.now() + 29 * 86_400_000)), { poolsPurged: 0, setsPurged: 0 });
    await db()`UPDATE pool_sets SET deleted_at = now() - interval '31 days' WHERE pool_id = ${id} AND set_no = 2`;
    const late = await j<Err>(await setRestore(as(ops, 'POST', `/api/admin/pools/${id}/sets/2/restore`, { reason: '太晚' }), ctx({ id, no: '2' })));
    assert.equal(late.status, 409);
    const member = await makeUser();
    assert.equal((await purgeRoute(as(member, 'POST', '/api/admin/jobs/purge-deleted'), none)).status, 403);
    const pr = await j<{ setsPurged: number }>(await purgeRoute(as(ops, 'POST', '/api/admin/jobs/purge-deleted'), none));
    assert.ok(pr.body.setsPurged >= 1);
    assert.deepEqual((await db()`SELECT set_no FROM pool_sets WHERE pool_id = ${id} ORDER BY set_no`).map((s) => s.setNo), [1, 3]);
    assert.equal(await auditCount('SET_PURGED'), 1);
    assert.equal((await verifyAuditChain(db())).ok, true);
  });

  it('deleting the last set deletes the pool (admin only); pool delete/restore need admin; pool with sales cannot be deleted; purge removes everything', async () => {
    const id = await publishPool(customPool());
    assert.equal((await setDelete(as(ops, 'DELETE', `/api/admin/pools/${id}/sets/1`, { reason: '整池建錯' }), ctx({ id, no: '1' }))).status, 403, 'last set = pool → needs SUPER_ADMIN');
    assert.equal((await poolDelete(as(ops, 'DELETE', `/api/admin/pools/${id}`, { reason: 'x' }), ctx({ id }))).status, 403);
    const d = await j<{ poolDeleted: boolean }>(await setDelete(as(boss, 'DELETE', `/api/admin/pools/${id}/sets/1`, { reason: '整池建錯' }), ctx({ id, no: '1' })));
    assert.deepEqual([d.status, d.body.poolDeleted], [200, true]);
    assert.equal((await poolRoute(apiRequest('GET', `/api/pools/${id}`), ctx({ id }))).status, 404);
    assert.ok(!(await listed()).includes(id));
    assert.equal((await poolRestore(as(ops, 'POST', `/api/admin/pools/${id}/restore`, { reason: 'x' }), ctx({ id }))).status, 403);
    assert.equal((await poolRestore(as(boss, 'POST', `/api/admin/pools/${id}/restore`, { reason: '誤刪' }), ctx({ id }))).status, 200);
    assert.equal((await poolRoute(apiRequest('GET', `/api/pools/${id}`), ctx({ id }))).status, 200);

    const withSales = await publishPool(customPool());
    const u = await makeUser({ coins: 1000 });
    await executeDraw(u.id, key(), { poolId: withSales, setNo: 1, count: 1 });
    const e = await j<Err>(await poolDelete(as(boss, 'DELETE', `/api/admin/pools/${withSales}`, { reason: 'x' }), ctx({ id: withSales })));
    assert.deepEqual([e.status, e.body.error.message], [409, '已有銷售紀錄，只能下架']);

    // 草稿也可刪除；30 天後硬刪除整個賞池（規則版本、籤、等級、獎項）
    const ops2 = await makeUser({ roles: ['OPS'] });
    const { createPoolDraft } = await import('../src/server/modules/pool/admin');
    const { poolId: draft } = await createPoolDraft(ops2.principal, customPool());
    assert.equal((await poolDelete(as(boss, 'DELETE', `/api/admin/pools/${draft}`, { reason: '草稿作廢' }), ctx({ id: draft }))).status, 200);
    assert.equal((await poolDelete(as(boss, 'DELETE', `/api/admin/pools/${id}`, { reason: '確定刪除' }), ctx({ id }))).status, 200);
    await db()`UPDATE pools SET deleted_at = now() - interval '31 days' WHERE id IN (${id}, ${draft})`;
    const r = await purgeDeleted();
    assert.ok(r.poolsPurged >= 2);
    const left = await db()`SELECT
      (SELECT count(*)::int FROM pools WHERE id IN (${id}, ${draft})) AS pools,
      (SELECT count(*)::int FROM pool_rule_versions WHERE pool_id = ${id}) AS rules,
      (SELECT count(*)::int FROM pool_levels WHERE pool_id IN (${id}, ${draft})) AS levels`;
    assert.deepEqual(left[0], { pools: 0, rules: 0, levels: 0 });
    assert.equal((await db()`SELECT 1 FROM pools WHERE id = ${withSales}`).length, 1);
    assert.equal((await poolRestore(as(boss, 'POST', `/api/admin/pools/${id}/restore`, { reason: 'x' }), ctx({ id }))).status, 404);
    assert.equal((await verifyAuditChain(db())).ok, true);
  });
});
