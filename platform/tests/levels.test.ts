/**
 * 獎項等級 1–12（所有賞池）：後台等級/獎項 CRUD、結構只在草稿可改、名稱/回收值/標籤隨時可改（留稽核）、
 * 發布前結構檢查、舊資料 migration（A..H → 1..8、大/中/小 → 1/2/3）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { db } from '../src/server/db';
import { runMigrations } from '../src/server/lib/migrations';
import { executeDraw } from '../src/server/modules/draw/draw';
import { listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { POST as createPoolRoute } from '../src/app/api/admin/pools/route';
import { GET as adminPoolGet, PATCH as adminPoolPatch } from '../src/app/api/admin/pools/[id]/route';
import { POST as levelCreate } from '../src/app/api/admin/pools/[id]/levels/route';
import { DELETE as levelDelete, PATCH as levelPatch } from '../src/app/api/admin/pools/[id]/levels/[levelNo]/route';
import { POST as itemCreate } from '../src/app/api/admin/pools/[id]/levels/[levelNo]/items/route';
import { DELETE as prizeDelete, PATCH as prizePatch } from '../src/app/api/admin/prizes/[id]/route';
import { POST as publishRequest } from '../src/app/api/admin/pools/[id]/publish-request/route';
import { approve } from '../src/server/modules/admin/approvals';
import { apiRequest, ctx, customPool, makeUser, publishPool, setupTestDb, type TestUser } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let ops: TestUser;
let k = 0;
const key = () => `lv-${process.pid}-${++k}-${Date.now()}`;
before(async () => {
  env = await setupTestDb();
  ops = await makeUser({ roles: ['OPS'] });
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
type AdminItem = { prizeId: string; name: string; qtyPerSet: number; recycleValue: number; tag: string | null; bulky: boolean; imageUrl: string | null };
type AdminPool = { id: string; status: string; structureEditable: boolean; ticketsPerSet: number; drawPacks: (number | string)[]; levels: { levelNo: number; name: string; isSmall: boolean; items: AdminItem[] }[]; lastPrize: (AdminItem & { levelName: string }) | null };
const getPool = async (id: string, token = ops.token) => j<AdminPool>(await adminPoolGet(apiRequest('GET', `/api/admin/pools/${id}`, { token }), ctx({ id })));
const patchLevel = (id: string, levelNo: number, body: unknown) => levelPatch(apiRequest('PATCH', `/api/admin/pools/${id}/levels/${levelNo}`, { token: ops.token, body }), ctx({ id, levelNo: String(levelNo) }));
const patchPrize = (id: string, body: unknown) => prizePatch(apiRequest('PATCH', `/api/admin/prizes/${id}`, { token: ops.token, body }), ctx({ id }));
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

describe('admin: levels & items while DRAFT', () => {
  it('create draft via API; add/rename/delete levels and items; defaults: isSmall for 4–8, bulky for GK or level 1', async () => {
    const draft = customPool({
      levels: [
        { levelNo: 1, name: '大獎', items: [{ name: '雕像', qtyPerSet: 1, tag: 'PVC' }] },
        { levelNo: 4, name: 'D賞', items: [{ name: '立牌', qtyPerSet: 9, tag: '其他', imageUrl: '/api/assets/00000000-0000-0000-0000-000000000000' }] },
      ],
    });
    const member = await makeUser();
    assert.equal((await createPoolRoute(apiRequest('POST', '/api/admin/pools', { token: member.token, body: draft }), none)).status, 403);
    const created = await j<{ poolId: string }>(await createPoolRoute(apiRequest('POST', '/api/admin/pools', { token: ops.token, body: draft }), none));
    assert.equal(created.status, 201);
    const id = created.body.poolId;
    assert.equal((await getPool(id, member.token)).status, 403);
    let p = (await getPool(id)).body;
    assert.equal(p.structureEditable, true);
    assert.deepEqual(p.levels.map((l) => [l.levelNo, l.name, l.isSmall]), [[1, '大獎', false], [4, 'D賞', true]]);
    assert.deepEqual(p.levels.map((l) => l.items.map((i) => [i.name, i.tag, i.bulky])), [[['雕像', 'PVC', true]], [['立牌', '其他', false]]]);
    assert.equal(p.levels[1]!.items[0]!.imageUrl, '/api/assets/00000000-0000-0000-0000-000000000000');

    // 新增等級 2（預設非小獎）與等級 6（預設小獎）
    const lv2 = await levelCreate(apiRequest('POST', `/api/admin/pools/${id}/levels`, { token: ops.token, body: { levelNo: 2, name: 'B賞', items: [{ name: 'GK 胸像', qtyPerSet: 2, tag: 'GK', recycleValue: 500 }] } }), ctx({ id }));
    assert.equal(lv2.status, 201);
    assert.equal((await levelCreate(apiRequest('POST', `/api/admin/pools/${id}/levels`, { token: ops.token, body: { levelNo: 2, name: 'dup', items: [{ name: 'x', qtyPerSet: 1 }] } }), ctx({ id }))).status, 409);
    assert.equal((await levelCreate(apiRequest('POST', `/api/admin/pools/${id}/levels`, { token: ops.token, body: { levelNo: 13, name: 'x', items: [{ name: 'y', qtyPerSet: 1 }] } }), ctx({ id }))).status, 400);
    assert.equal((await levelCreate(apiRequest('POST', `/api/admin/pools/${id}/levels`, { token: ops.token, body: { levelNo: 6, name: 'F賞', items: [{ name: '貼紙', qtyPerSet: 5 }] } }), ctx({ id }))).status, 201);
    // 新增獎項到等級 4；重名拒絕
    const it1 = await j<{ prizeId: string }>(await itemCreate(apiRequest('POST', `/api/admin/pools/${id}/levels/4/items`, { token: ops.token, body: { name: '徽章', qtyPerSet: 3, tag: '娃娃' } }), ctx({ id, levelNo: '4' })));
    assert.equal(it1.status, 201);
    assert.equal((await itemCreate(apiRequest('POST', `/api/admin/pools/${id}/levels/4/items`, { token: ops.token, body: { name: '徽章', qtyPerSet: 1 } }), ctx({ id, levelNo: '4' }))).status, 409);
    assert.equal((await itemCreate(apiRequest('POST', `/api/admin/pools/${id}/levels/5/items`, { token: ops.token, body: { name: 'z', qtyPerSet: 1 } }), ctx({ id, levelNo: '5' }))).status, 404);
    p = (await getPool(id)).body;
    assert.deepEqual(p.levels.map((l) => [l.levelNo, l.isSmall, l.items.length]), [[1, false, 1], [2, false, 1], [4, true, 2], [6, true, 1]]);
    assert.equal(p.levels[1]!.items[0]!.bulky, true, 'GK → bulky');
    assert.equal(p.ticketsPerSet, 1 + 2 + 9 + 3 + 5);

    // 草稿：等級可改名、改 isSmall；獎項可改數量、換等級；刪除
    assert.equal((await patchLevel(id, 6, { name: '參加獎', isSmall: false })).status, 200);
    const moved = await j<{ levelNo: number; qtyPerSet: number }>(await patchPrize(it1.body.prizeId, { levelNo: 6, qtyPerSet: 4 }));
    assert.deepEqual([moved.status, moved.body.levelNo, moved.body.qtyPerSet], [200, 6, 4]);
    assert.equal((await patchPrize(it1.body.prizeId, { qtyPerSet: 20_001 })).status, 400);
    const grown = await patchPrize(it1.body.prizeId, { qtyPerSet: 19_990 });
    assert.equal(grown.status, 400, 'max 20,000 tickets per set');
    assert.equal(await errCode(grown), 'VALIDATION');
    assert.equal((await prizeDelete(apiRequest('DELETE', `/api/admin/prizes/${it1.body.prizeId}`, { token: ops.token }), ctx({ id: it1.body.prizeId }))).status, 200);
    assert.equal((await levelDelete(apiRequest('DELETE', `/api/admin/pools/${id}/levels/6`, { token: ops.token }), ctx({ id, levelNo: '6' }))).status, 200);
    // 最後賞（草稿可設定）
    assert.equal((await adminPoolPatch(apiRequest('PATCH', `/api/admin/pools/${id}`, { token: ops.token, body: { lastPrize: { name: '最後賞 特別版', tag: 'GK' } } }), ctx({ id }))).status, 200);
    p = (await getPool(id)).body;
    assert.deepEqual(p.levels.map((l) => [l.levelNo, l.name, l.isSmall]), [[1, '大獎', false], [2, 'B賞', false], [4, 'D賞', true]]);
    assert.deepEqual([p.lastPrize!.name, p.lastPrize!.levelName, p.lastPrize!.bulky], ['最後賞 特別版', '最後賞', true]);

    // 空等級 → 不可申請發布
    const empty = (await getPool(id)).body.levels.find((l) => l.levelNo === 2)!.items[0]!;
    await prizeDelete(apiRequest('DELETE', `/api/admin/prizes/${empty.prizeId}`, { token: ops.token }), ctx({ id: empty.prizeId }));
    const bad = await j<{ error: { code: string; message: string } }>(await publishRequest(apiRequest('POST', `/api/admin/pools/${id}/publish-request`, { token: ops.token }), ctx({ id })));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /等級 2（B賞）沒有獎項/);
    assert.equal((await getPool(id)).body.status, 'DRAFT', 'failed request leaves the draft untouched');
    await levelDelete(apiRequest('DELETE', `/api/admin/pools/${id}/levels/2`, { token: ops.token }), ctx({ id, levelNo: '2' }));

    // 申請發布後（送審中）結構即鎖定
    const req = await j<{ approvalId: string }>(await publishRequest(apiRequest('POST', `/api/admin/pools/${id}/publish-request`, { token: ops.token }), ctx({ id })));
    assert.equal(req.status, 201);
    const locked = await patchLevel(id, 4, { isSmall: false });
    assert.deepEqual([locked.status, await errCode(locked)], [409, 'STRUCTURE_LOCKED']);
    const boss = await makeUser({ roles: ['SUPER_ADMIN'] });
    await approve(boss.principal, req.body.approvalId);
    const [rules] = await db()`SELECT rules_json FROM pool_rule_versions WHERE pool_id = ${id}`;
    const r = JSON.parse(rules!.rulesJson as string) as { schema: string; levels: { levelNo: number; name: string; isSmall: boolean; prizes: unknown[] }[] };
    assert.equal(r.schema, 'chiaki-rules-v3');
    assert.deepEqual(r.levels.map((l) => [l.levelNo, l.name, l.isSmall, l.prizes.length]), [[1, '大獎', false, 1], [4, 'D賞', true, 1]]);
  });
});

describe('admin: after publish', () => {
  it('structure is locked (even with 0 sales); names / recycle values / tags / images stay editable with audit', async () => {
    const id = await publishPool(customPool({ setCount: 2 }));
    const p = (await getPool(id)).body;
    assert.equal(p.structureEditable, false);
    const small = p.levels.find((l) => l.levelNo === 3)!.items[0]!;
    const grand = p.levels.find((l) => l.levelNo === 1)!.items[0]!;
    for (const res of [
      await patchPrize(small.prizeId, { qtyPerSet: 5 }),
      await patchPrize(small.prizeId, { levelNo: 1 }),
      await patchLevel(id, 3, { isSmall: false }),
      await levelCreate(apiRequest('POST', `/api/admin/pools/${id}/levels`, { token: ops.token, body: { levelNo: 5, name: 'E', items: [{ name: 'e', qtyPerSet: 1 }] } }), ctx({ id })),
      await levelDelete(apiRequest('DELETE', `/api/admin/pools/${id}/levels/2`, { token: ops.token }), ctx({ id, levelNo: '2' })),
      await itemCreate(apiRequest('POST', `/api/admin/pools/${id}/levels/3/items`, { token: ops.token, body: { name: 'n', qtyPerSet: 1 } }), ctx({ id, levelNo: '3' })),
      await prizeDelete(apiRequest('DELETE', `/api/admin/prizes/${small.prizeId}`, { token: ops.token }), ctx({ id: small.prizeId })),
      await adminPoolPatch(apiRequest('PATCH', `/api/admin/pools/${id}`, { token: ops.token, body: { lastPrize: null } }), ctx({ id })),
    ]) {
      assert.deepEqual([res.status, await errCode(res)], [409, 'STRUCTURE_LOCKED']);
    }
    // 先在第 2 套自訂一個回收值 → 之後的預設值變更不覆蓋它
    await db()`UPDATE set_prizes SET recycle_value = 77 WHERE prize_id = ${small.prizeId} AND set_id = (SELECT id FROM pool_sets WHERE pool_id = ${id} AND set_no = 2)`;
    const u = await makeUser({ coins: 1000 });
    const [t] = await db()<{ ticketNo: number }[]>`SELECT t.ticket_no FROM tickets t JOIN pool_sets s ON s.id = t.set_id WHERE s.pool_id = ${id} AND s.set_no = 1 AND t.prize_id = ${small.prizeId} LIMIT 1`;
    await executeDraw(u.id, key(), { poolId: id, setNo: 1, ticketNos: [t!.ticketNo] });

    // 隨時可改：等級名稱、獎項名稱、回收值、標籤、圖片
    assert.equal((await patchLevel(id, 3, { name: '幸運賞' })).status, 200);
    const upd = await j<{ name: string; recycleValue: number; tag: string; imageUrl: string; setsUpdated: number }>(
      await patchPrize(small.prizeId, { name: '壓克力立牌 v2', recycleValue: 60, tag: '其他', imageUrl: 'https://cdn.example/a.png' }),
    );
    assert.equal(upd.status, 200);
    assert.deepEqual([upd.body.name, upd.body.recycleValue, upd.body.tag, upd.body.imageUrl, upd.body.setsUpdated], ['壓克力立牌 v2', 60, '其他', 'https://cdn.example/a.png', 1]);
    const sp = await db()`SELECT s.set_no, sp.recycle_value FROM set_prizes sp JOIN pool_sets s ON s.id = sp.set_id WHERE sp.prize_id = ${small.prizeId} ORDER BY s.set_no`;
    assert.deepEqual(sp.map((r) => [r.setNo, r.recycleValue]), [[1, 60], [2, 77]], 'per-set customised value kept');
    assert.equal((await patchPrize(grand.prizeId, { imageUrl: 'javascript:alert(1)' })).status, 400);
    // 已入倉的物品保留抽出當下的等級/名稱快照；新的抽賞使用新名稱
    const [item] = await listWarehouse(db(), u.id);
    assert.deepEqual([item!.levelName, item!.prizeName, item!.recycleValue], ['小獎', '壓克力立牌', 60]);
    const [t2] = await db()<{ ticketNo: number }[]>`SELECT t.ticket_no FROM tickets t JOIN pool_sets s ON s.id = t.set_id WHERE s.pool_id = ${id} AND s.set_no = 1 AND t.prize_id = ${small.prizeId} AND t.status = 'AVAILABLE' LIMIT 1`;
    const d = (await executeDraw(u.id, key(), { poolId: id, setNo: 1, ticketNos: [t2!.ticketNo] })).response;
    assert.equal(d.results[0]!.displayName, '幸運賞 壓克力立牌 v2');
    const audits = await db()`SELECT action FROM audit_log WHERE entity_id IN (${id}, ${small.prizeId}) AND action IN ('POOL_LEVEL_UPDATED', 'PRIZE_UPDATED')`;
    assert.equal(audits.length, 2);
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'PRIZE_UPDATED' AND entity_id = ${small.prizeId}`;
    assert.match(a!.payloadJson as string, /"before":\{[^}]*"recycleValue":50/);
  });
});

describe('migration 20261029: ranks / grades → levels, categories → tags, IP categories dropped', () => {
  it('maps A..H → 1..8, GRAND/MID/SMALL → 1/2/3 (small keeps is_small), guarantee min_grade → min_level, snapshots warehouse rows', async () => {
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
    const name = `m_${randomBytes(6).toString('hex')}`;
    const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const sql = postgres(adminUrl.replace(/\/[^/]*$/, `/${name}`), { max: 1, onnotice: () => undefined, transform: postgres.camel });
    const src = join(process.cwd(), 'prisma', 'migrations');
    const dir = mkdtempSync(join(tmpdir(), 'chiaki-mig-'));
    try {
      const all = readdirSync(src).filter((n) => /^\d{14}_/.test(n)).sort();
      const target = all.indexOf('20261029000000_prize_levels_tags_quickdraw');
      assert.ok(target > 0);
      for (const n of all.slice(0, target)) cpSync(join(src, n), join(dir, n), { recursive: true });
      await runMigrations(sql as never, dir);

      const [off] = await sql<{ id: string }[]>`INSERT INTO pools (slug, title, source, play_type, price_coins, set_count) VALUES ('m-off', 'o', 'OFFICIAL', 'STANDARD', 100, 1) RETURNING id`;
      const [cus] = await sql<{ id: string }[]>`INSERT INTO pools (slug, title, source, play_type, price_coins, set_count) VALUES ('m-cus', 'c', 'CUSTOM', 'GUARANTEE', 100, 1) RETURNING id`;
      const prize = async (pool: string, kind: string, rank: string | null, grade: string, nm: string, qty: number, category: string | null = null) =>
        (await sql<{ id: string }[]>`INSERT INTO pool_prizes (pool_id, kind, rank, grade, name, qty_per_set, category) VALUES (${pool}, ${kind}, ${rank}, ${grade}, ${nm}, ${qty}, ${category}) RETURNING id`)[0]!.id;
      await prize(off!.id, 'TICKET', 'A', 'GRAND', 'A公仔', 1, 'PVC');
      await prize(off!.id, 'TICKET', 'B', 'MID', 'B色紙', 1);
      await prize(off!.id, 'TICKET', 'D', 'MID', 'D吊飾', 2, '絨毛');
      await prize(off!.id, 'TICKET', 'H', 'SMALL', 'H貼紙', 6, '3C');
      await prize(off!.id, 'LAST', 'LAST', 'GRAND', '最後賞公仔', 0, 'GK');
      await prize(cus!.id, 'TICKET', null, 'GRAND', '雕像', 1, 'GK');
      await prize(cus!.id, 'TICKET', null, 'MID', '半身像', 2, '景品');
      const smallA = await prize(cus!.id, 'TICKET', null, 'SMALL', '立牌', 5, '盒玩扭蛋');
      await prize(cus!.id, 'TICKET', null, 'SMALL', '卡片', 9);
      const res = await prize(cus!.id, 'GUARANTEE', null, 'MID', '保底半身像', 0);
      await sql`INSERT INTO pool_guarantees (pool_id, every_n, min_grade, reserve_prize_name, reserve_total, reserve_prize_id) VALUES (${cus!.id}, 5, 'MID', '保底半身像', 3, ${res})`;
      await sql`INSERT INTO products (sku, name, source, price_coins, stock, category) VALUES ('m-1', 'p', 'CUSTOM', 10, 1, '景品')`;
      await sql`INSERT INTO ips (slug, name, category) VALUES ('m-ip', '作品', '原創')`;
      const [usr] = await sql<{ id: string }[]>`INSERT INTO users (phone) VALUES ('0960000001') RETURNING id`;
      await sql`INSERT INTO warehouse_items (user_id, source, pool_id, prize_id, grade, prize_name, storage_expires_at) VALUES (${usr!.id}, 'TICKET', ${cus!.id}, ${smallA}, 'SMALL', '立牌', now() + interval '30 days')`;

      cpSync(join(src, all[target]!), join(dir, all[target]!), { recursive: true });
      assert.deepEqual(await runMigrations(sql as never, dir), ['20261029000000_prize_levels_tags_quickdraw']);

      const levels = await sql<{ slug: string; levelNo: number; name: string; isSmall: boolean }[]>`
        SELECT p.slug, l.level_no, l.name, l.is_small FROM pool_levels l JOIN pools p ON p.id = l.pool_id ORDER BY p.slug, l.level_no`;
      assert.deepEqual(levels.map((l) => [l.slug, l.levelNo, l.name, l.isSmall]), [
        ['m-cus', 1, '大獎', false], ['m-cus', 2, '中獎', false], ['m-cus', 3, '小獎', true],
        ['m-off', 1, 'A賞', false], ['m-off', 2, 'B賞', false], ['m-off', 4, 'D賞', false], ['m-off', 8, 'H賞', true],
      ]);
      const prizes = await sql<{ name: string; levelNo: number | null; tag: string | null }[]>`
        SELECT pp.name, pl.level_no, pp.tag FROM pool_prizes pp LEFT JOIN pool_levels pl ON pl.id = pp.level_id ORDER BY pp.name`;
      const byName = Object.fromEntries(prizes.map((p) => [p.name, [p.levelNo, p.tag]]));
      assert.deepEqual(byName['最後賞公仔'], [null, 'GK'], 'LAST stays outside levels');
      assert.deepEqual(byName['保底半身像'], [2, null]);
      assert.deepEqual(byName['半身像'], [2, '景品盲盒']);
      assert.deepEqual(byName['立牌'], [3, '景品盲盒']);
      assert.deepEqual(byName['D吊飾'], [4, '娃娃']);
      assert.deepEqual(byName['H貼紙'], [8, '其他']);
      assert.deepEqual(byName['A公仔'], [1, 'PVC']);
      const [g] = await sql<{ minLevel: number }[]>`SELECT min_level FROM pool_guarantees`;
      assert.equal(g!.minLevel, 2);
      const [prod] = await sql<{ tag: string }[]>`SELECT tag FROM products WHERE sku = 'm-1'`;
      assert.equal(prod!.tag, '景品盲盒');
      const [wi] = await sql<{ levelNo: number; levelName: string; isSmall: boolean }[]>`SELECT level_no, level_name, is_small FROM warehouse_items`;
      assert.deepEqual([wi!.levelNo, wi!.levelName, wi!.isSmall], [3, '小獎', true]);
      const cols = await sql<{ table: string }[]>`SELECT table_name AS table FROM information_schema.columns WHERE column_name = 'category' AND table_name IN ('ips', 'products', 'pool_prizes')`;
      assert.equal(cols.length, 0);
      const [packs] = await sql<{ drawPacks: string[] }[]>`SELECT draw_packs FROM pools WHERE slug = 'm-off'`;
      assert.deepEqual(packs!.drawPacks, ['1', '5', '10']);
    } finally {
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
