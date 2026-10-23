/** 抽賞紀錄：會員只看得到近 3 個月；封存工作只「標記」90 天以前的紀錄，原始資料與稽核鏈完整保留 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { listMemberDraws, runDrawArchive } from '../src/server/modules/draw/history';
import { verifyAuditChain } from '../src/server/modules/audit/audit';
import { GET as drawsRoute } from '../src/app/api/me/draws/route';
import { GET as drawRoute } from '../src/app/api/me/draws/[id]/route';
import { POST as archiveRoute } from '../src/app/api/admin/jobs/draw-archive/route';
import { apiRequest, ctx, makeUser, publishPool, setupTestDb, smallPool } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

/** 測試用：模擬時間經過（draws 為 append-only，以 superuser 的 replica 模式改寫建立時間） */
async function age(drawId: string, days: number) {
  await db().begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE draws SET created_at = now() - make_interval(days => ${days}) WHERE id = ${drawId}`;
  });
}

describe('draw history retention', () => {
  it('members only see the last 90 days (oldest drop first); archive marks old rows without deleting; idempotent; audit chain intact', async () => {
    const poolId = await publishPool(smallPool({ setCount: 1 }));
    const u = await makeUser({ coins: 5000 });
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) ids.push((await executeDraw(u.id, `ret-${process.pid}-${i}`, { poolId, setNo: 1, ticketNos: [i] })).response.drawId);
    await age(ids[0]!, 120);
    await age(ids[1]!, 91);
    await age(ids[2]!, 89);

    const res = await drawsRoute(apiRequest('GET', '/api/me/draws', { token: u.token }), undefined as never);
    const body = (await res.json()) as { visibleDays: number; draws: { drawId: string; results: { displayName: string }[] }[] };
    assert.equal(body.visibleDays, 90);
    assert.deepEqual(body.draws.map((d) => d.drawId), [ids[3], ids[2]], 'newest first; > 90 days hidden even before the archive job runs');
    assert.ok(body.draws[0]!.results[0]!.displayName);
    assert.equal((await drawRoute(apiRequest('GET', `/api/me/draws/${ids[0]}`, { token: u.token }), ctx({ id: ids[0]! }))).status, 404);
    assert.equal((await drawRoute(apiRequest('GET', `/api/me/draws/${ids[2]}`, { token: u.token }), ctx({ id: ids[2]! }))).status, 200);
    const other = await makeUser();
    assert.equal((await drawRoute(apiRequest('GET', `/api/me/draws/${ids[3]}`, { token: other.token }), ctx({ id: ids[3]! }))).status, 404);
    const page = await listMemberDraws(db(), u.id, { limit: 1 });
    assert.equal(page.draws.length, 1);
    assert.deepEqual((await listMemberDraws(db(), u.id, { before: page.draws[0]!.createdAt })).draws.map((d) => d.drawId), [ids[2]]);

    const ops = await makeUser({ roles: ['OPS'] });
    const m = await makeUser();
    assert.equal((await archiveRoute(apiRequest('POST', '/api/admin/jobs/draw-archive', { token: m.token }), undefined as never)).status, 403);
    const run = (await (await archiveRoute(apiRequest('POST', '/api/admin/jobs/draw-archive', { token: ops.token }), undefined as never)).json()) as { archived: number };
    assert.equal(run.archived, 2);
    assert.deepEqual(await runDrawArchive(), { archived: 0, batchId: null }, 'idempotent');
    const archived = await db()`SELECT draw_id FROM draw_archive ORDER BY draw_created_at`;
    assert.deepEqual(archived.map((a) => a.drawId), [ids[0], ids[1]]);
    // 原始紀錄完整保留（會計/爭議證據）
    const [{ n }] = (await db()`SELECT count(*)::int AS n FROM draws WHERE user_id = ${u.id}`) as unknown as [{ n: number }];
    assert.equal(n, 4);
    const [{ r }] = (await db()`SELECT count(*)::int AS r FROM draw_results WHERE draw_id = ANY(${ids}::uuid[])`) as unknown as [{ r: number }];
    assert.equal(r, 4);
    await assert.rejects(db()`DELETE FROM draw_archive WHERE draw_id = ${ids[0]!}`, /append-only/);
    await assert.rejects(db()`DELETE FROM draws WHERE id = ${ids[0]!}`, /append-only/);
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'DRAW_HISTORY_ARCHIVED'`;
    assert.match(a!.payloadJson as string, /"count":2/);
    assert.equal((await verifyAuditChain(db())).ok, true);
    assert.equal((await listMemberDraws(db(), u.id)).draws.length, 2);
  });
});
