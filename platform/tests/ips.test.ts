/** IP（作品）管理：分類 CRUD＋排序、IP CRUD＋原子重排、賞池連結 IP、公開大廳篩選 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { GET as publicIps } from '../src/app/api/ips/route';
import { GET as poolsRoute } from '../src/app/api/pools/route';
import { GET as ipsList, POST as ipCreate } from '../src/app/api/admin/ips/route';
import { DELETE as ipDelete, PATCH as ipPatch } from '../src/app/api/admin/ips/[id]/route';
import { POST as ipReorder } from '../src/app/api/admin/ips/reorder/route';
import { GET as catList, POST as catCreate } from '../src/app/api/admin/ip-categories/route';
import { DELETE as catDelete, PATCH as catPatch } from '../src/app/api/admin/ip-categories/[id]/route';
import { POST as catReorder } from '../src/app/api/admin/ip-categories/reorder/route';
import { PATCH as poolSettings } from '../src/app/api/admin/pools/[id]/route';
import { apiRequest, ctx, customPool, makeUser, publishPool, setupTestDb, type TestUser } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let ops: TestUser;
before(async () => {
  env = await setupTestDb();
  ops = await makeUser({ roles: ['OPS'] });
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
type Cat = { id: string; code: string; name: string; sortOrder: number; visible: boolean };
const cats = async () => (await j<{ categories: Cat[] }>(await catList(apiRequest('GET', '/api/admin/ip-categories', { token: ops.token }), none))).body.categories;
const createIp = async (body: Record<string, unknown>) => j<{ id: string }>(await ipCreate(apiRequest('POST', '/api/admin/ips', { token: ops.token, body }), none));

describe('IP categories', () => {
  it('seeded 動畫/遊戲/漫畫/原創; create, rename/hide, atomic reorder, delete guard', async () => {
    const seeded = await cats();
    assert.deepEqual(seeded.map((c) => c.name), ['動畫', '遊戲', '漫畫', '原創']);
    const member = await makeUser();
    assert.equal((await catCreate(apiRequest('POST', '/api/admin/ip-categories', { token: member.token, body: { code: 'VTUBER', name: 'VTuber' } }), none)).status, 403);
    const vt = await j<{ id: string }>(await catCreate(apiRequest('POST', '/api/admin/ip-categories', { token: ops.token, body: { code: 'VTUBER', name: 'VTuber' } }), none));
    assert.equal(vt.status, 201);
    assert.equal((await catCreate(apiRequest('POST', '/api/admin/ip-categories', { token: ops.token, body: { code: 'VTUBER', name: '重複' } }), none)).status, 409);
    assert.equal((await catPatch(apiRequest('PATCH', `/api/admin/ip-categories/${vt.body.id}`, { token: ops.token, body: { name: '虛擬主播' } }), ctx({ id: vt.body.id }))).status, 200);
    const all = await cats();
    const ids = all.map((c) => c.id);
    const newOrder = [vt.body.id, ...ids.filter((x) => x !== vt.body.id)];
    assert.equal((await catReorder(apiRequest('POST', '/api/admin/ip-categories/reorder', { token: ops.token, body: { ids: newOrder.slice(1) } }), none)).status, 400, 'partial list rejected');
    assert.deepEqual((await cats()).map((c) => c.id), ids, 'unchanged after rejected reorder');
    assert.equal((await catReorder(apiRequest('POST', '/api/admin/ip-categories/reorder', { token: ops.token, body: { ids: newOrder } }), none)).status, 200);
    assert.deepEqual((await cats()).map((c) => c.name), ['虛擬主播', '動畫', '遊戲', '漫畫', '原創']);
    const anime = all.find((c) => c.code === 'ANIME')!;
    await createIp({ slug: 'cat-guard-ip', name: '分類刪除保護', categoryId: anime.id });
    assert.equal((await catDelete(apiRequest('DELETE', `/api/admin/ip-categories/${anime.id}`, { token: ops.token }), ctx({ id: anime.id }))).status, 409);
    assert.equal((await catDelete(apiRequest('DELETE', `/api/admin/ip-categories/${vt.body.id}`, { token: ops.token }), ctx({ id: vt.body.id }))).status, 200);
  });
});

describe('IPs, pool links and the public lobby directory', () => {
  it('CRUD, atomic reorder within a category, link pools, filter pools by IP / category, hidden ones excluded', async () => {
    const c = await cats();
    const game = c.find((x) => x.code === 'GAME')!;
    const original = c.find((x) => x.code === 'ORIGINAL')!;
    assert.equal((await createIp({ slug: 'Bad Slug', name: 'x' })).status, 400);
    assert.equal((await createIp({ slug: 'cover-bad', name: 'x', coverUrl: 'http://insecure/img.png' })).status, 400);
    const a = await createIp({ slug: 'genshin', name: '原神', categoryId: game.id, coverUrl: 'https://cdn.example/genshin.png' });
    const b = await createIp({ slug: 'blue-archive', name: '蔚藍檔案', categoryId: game.id });
    const ch = await createIp({ slug: 'chiaki-original', name: 'CHIAKI 原創', categoryId: original.id });
    assert.equal((await createIp({ slug: 'genshin-2', name: '原神' })).status, 409, 'names unique');

    // 原子重排：只能包含該分類下全部 IP
    assert.equal((await ipReorder(apiRequest('POST', '/api/admin/ips/reorder', { token: ops.token, body: { categoryId: game.id, ids: [b.body.id, a.body.id, ch.body.id] } }), none)).status, 400);
    assert.equal((await ipReorder(apiRequest('POST', '/api/admin/ips/reorder', { token: ops.token, body: { categoryId: game.id, ids: [b.body.id, a.body.id] } }), none)).status, 200);

    // 賞池連結：草稿時指定 ipId；發布後可改
    const p1 = await publishPool(customPool({ ipId: a.body.id }));
    const p2 = await publishPool(customPool());
    const [row] = await db()`SELECT ip, ip_id FROM pools WHERE id = ${p1}`;
    assert.deepEqual(row, { ip: '原神', ipId: a.body.id });
    assert.equal((await poolSettings(apiRequest('PATCH', `/api/admin/pools/${p2}`, { token: ops.token, body: { ipId: ch.body.id } }), ctx({ id: p2 }))).status, 200);
    assert.equal((await poolSettings(apiRequest('PATCH', `/api/admin/pools/${p2}`, { token: ops.token, body: { ipId: '00000000-0000-4000-8000-000000000000' } }), ctx({ id: p2 }))).status, 400);
    const byIp = await j<{ pools: { id: string; ipId: string }[] }>(await poolsRoute(apiRequest('GET', `/api/pools?ipId=${a.body.id}`), none));
    assert.deepEqual(byIp.body.pools.map((p) => p.id), [p1]);
    const byCat = await j<{ pools: { id: string }[] }>(await poolsRoute(apiRequest('GET', `/api/pools?ipCategoryId=${original.id}`), none));
    assert.deepEqual(byCat.body.pools.map((p) => p.id), [p2]);

    // 改名同步賞池舊欄位；隱藏後不出現在公開清單；有賞池連結不可刪除
    assert.equal((await ipPatch(apiRequest('PATCH', `/api/admin/ips/${a.body.id}`, { token: ops.token, body: { name: '原神 Genshin' } }), ctx({ id: a.body.id }))).status, 200);
    assert.equal(((await db()`SELECT ip FROM pools WHERE id = ${p1}`)[0]!.ip as string), '原神 Genshin');
    assert.equal((await ipDelete(apiRequest('DELETE', `/api/admin/ips/${a.body.id}`, { token: ops.token }), ctx({ id: a.body.id }))).status, 409);
    const hidden = await createIp({ slug: 'hidden-ip', name: '下架作品', categoryId: game.id, visible: false });
    const dir = await j<{ categories: { code: string | null; name: string; ips: { slug: string; name: string; poolCount: number; coverUrl: string | null }[] }[] }>(await publicIps(apiRequest('GET', '/api/ips'), none));
    const gameGroup = dir.body.categories.find((g) => g.code === 'GAME')!;
    assert.deepEqual(gameGroup.ips.map((i) => [i.slug, i.poolCount]), [['blue-archive', 0], ['genshin', 1]], 'ordered by sort_order, hidden excluded');
    assert.equal(gameGroup.ips[1]!.coverUrl, 'https://cdn.example/genshin.png');
    const order = dir.body.categories.map((g) => g.name);
    assert.ok(order.indexOf('遊戲') < order.indexOf('原創'), 'categories in their sort order');
    assert.ok(!JSON.stringify(dir.body).includes('hidden-ip'));
    assert.equal((await ipDelete(apiRequest('DELETE', `/api/admin/ips/${hidden.body.id}`, { token: ops.token }), ctx({ id: hidden.body.id }))).status, 200);
    const admin = await j<{ ips: { slug: string; poolCount: number }[] }>(await ipsList(apiRequest('GET', '/api/admin/ips', { token: ops.token }), none));
    assert.equal(admin.body.ips.find((i) => i.slug === 'genshin')!.poolCount, 1);
    const audits = await db()`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'IP%'`;
    assert.ok((audits[0]!.n as number) >= 8);
  });
});
