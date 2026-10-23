/** IP 目錄：固定分類、別名搜尋（不分大小寫）、排序模式（AUTO：名稱字數→中文排序；MANUAL：手動原子重排）、賞池連結與篩選 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { IP_CATEGORIES, sortIps } from '../src/server/modules/catalog/ips';
import { GET as publicIps } from '../src/app/api/ips/route';
import { GET as poolsRoute } from '../src/app/api/pools/route';
import { GET as ipsList, POST as ipCreate } from '../src/app/api/admin/ips/route';
import { DELETE as ipDelete, PATCH as ipPatch } from '../src/app/api/admin/ips/[id]/route';
import { POST as ipReorder } from '../src/app/api/admin/ips/reorder/route';
import { GET as sortGet, PUT as sortPut } from '../src/app/api/admin/ips/sort-mode/route';
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
type PublicIp = { id: string; slug: string; name: string; category: string | null; aliases: string[]; poolCount: number };
const pub = async (qs = '') => (await j<{ sortMode: string; categories: { category: string; count: number }[]; ips: PublicIp[] }>(await publicIps(apiRequest('GET', `/api/ips${qs}`), none))).body;
const createIp = async (body: Record<string, unknown>) => j<{ id: string }>(await ipCreate(apiRequest('POST', '/api/admin/ips', { token: ops.token, body }), none));
const zh = new Intl.Collator('zh-TW');

describe('IP catalog', () => {
  it('sort helper: character count via Array.from (emoji = 1), then zh-TW collation; manual uses sort_order', () => {
    const rows = [
      { name: '進擊的巨人', sortOrder: 1 },
      { name: '原神', sortOrder: 2 },
      { name: 'ONE PIECE', sortOrder: 3 },
      { name: '😺貓', sortOrder: 4 },
      { name: '鬼滅之刃', sortOrder: 5 },
      { name: '咒術迴戰', sortOrder: 6 },
    ];
    const auto = sortIps(rows, 'AUTO').map((r) => r.name);
    assert.deepEqual(auto.map((n) => Array.from(n).length), [2, 2, 4, 4, 5, 9]);
    assert.deepEqual(auto.slice(0, 2), ['原神', '😺貓'].sort(zh.compare));
    assert.deepEqual(auto.slice(2, 4), ['鬼滅之刃', '咒術迴戰'].sort(zh.compare));
    assert.equal('😺貓'.length, 3, 'UTF-16 length would mis-order this name');
    assert.deepEqual(sortIps(rows, 'MANUAL').map((r) => r.sortOrder), [1, 2, 3, 4, 5, 6]);
  });

  it('fixed categories, aliases, case-insensitive search on name or alias, category filter, hidden excluded, AUTO/MANUAL ordering', async () => {
    assert.equal((await createIp({ slug: 'bad-cat', name: 'x', category: '動畫' })).status, 400, 'old free-form categories are gone');
    const old = await j<{ error: { issues: { message: string }[] } }>(await ipCreate(apiRequest('POST', '/api/admin/ips', { token: ops.token, body: { slug: 'old-cat', name: 'y', category: '少年漫畫' } }), none));
    assert.equal(old.status, 400, 'previous 8-category values are no longer accepted');
    assert.equal(old.body.error.issues[0]!.message, 'IP 分類須為：經典少年、新世代人氣、機甲・特攝、遊戲・角色、原創');
    assert.deepEqual([...IP_CATEGORIES], ['經典少年', '新世代人氣', '機甲・特攝', '遊戲・角色', '原創']);
    await assert.rejects(db()`INSERT INTO ips (slug, name, category) VALUES ('db-old', 'z', '歐美')`, /ips_category_check/);
    assert.equal((await createIp({ slug: 'dup-alias', name: 'x', aliases: ['A', 'a'] })).status, 400);
    const member = await makeUser();
    assert.equal((await ipCreate(apiRequest('POST', '/api/admin/ips', { token: member.token, body: { slug: 'm-ip', name: 'm' } }), none)).status, 403);
    const genshin = await createIp({ slug: 'genshin', name: '原神', category: '遊戲・角色', aliases: ['Genshin Impact', 'げんしん'], coverUrl: 'https://cdn.example/g.png' });
    const op = await createIp({ slug: 'one-piece', name: 'ONE PIECE', category: '經典少年', aliases: ['航海王', '海賊王'] });
    const kimetsu = await createIp({ slug: 'kimetsu', name: '鬼滅之刃', category: '經典少年', aliases: ['Demon Slayer'] });
    const gundam = await createIp({ slug: 'gundam', name: '機動戰士鋼彈', category: '機甲・特攝', aliases: ['Gundam'] });
    const chiaki = await createIp({ slug: 'chiaki', name: 'CHIAKI', category: '原創' });
    const hidden = await createIp({ slug: 'hidden', name: '隱', category: '原創', visible: false });
    assert.ok([genshin, op, kimetsu, gundam, chiaki, hidden].every((r) => r.status === 201));

    const all = await pub();
    assert.equal(all.sortMode, 'AUTO');
    // 2 字 → 4 字 → 6 字（CHIAKI 與 機動戰士鋼彈 同為 6 字，依 zh-TW 排序）→ 9 字；隱藏者不列出
    assert.deepEqual(all.ips.map((i) => i.name), ['原神', '鬼滅之刃', ...['CHIAKI', '機動戰士鋼彈'].sort(zh.compare), 'ONE PIECE'], 'by character count, hidden excluded');
    assert.deepEqual(all.categories.map((c) => c.category), [...IP_CATEGORIES]);
    assert.equal(all.categories.find((c) => c.category === '經典少年')!.count, 2);
    assert.deepEqual(all.ips[0]!.aliases, ['Genshin Impact', 'げんしん']);
    assert.deepEqual((await pub(`?q=${encodeURIComponent('genshin')}`)).ips.map((i) => i.slug), ['genshin'], 'alias, case-insensitive');
    assert.deepEqual((await pub(`?q=${encodeURIComponent('海賊')}`)).ips.map((i) => i.slug), ['one-piece']);
    assert.deepEqual((await pub(`?q=${encodeURIComponent('one')}`)).ips.map((i) => i.slug), ['one-piece'], 'name, case-insensitive');
    assert.deepEqual((await pub(`?q=${encodeURIComponent('%')}`)).ips, [], 'LIKE wildcards are escaped');
    assert.deepEqual((await pub(`?category=${encodeURIComponent('經典少年')}`)).ips.map((i) => i.slug), ['kimetsu', 'one-piece']);
    assert.deepEqual((await pub(`?category=${encodeURIComponent('經典少年')}&q=demon`)).ips.map((i) => i.slug), ['kimetsu']);
    assert.equal((await publicIps(apiRequest('GET', `/api/ips?category=${encodeURIComponent('漫畫')}`), none)).status, 400);
    const admin = await j<{ ips: { slug: string }[] }>(await ipsList(apiRequest('GET', '/api/admin/ips', { token: ops.token }), none));
    assert.ok(admin.body.ips.some((i) => i.slug === 'hidden'));

    // 手動排序
    assert.equal((await sortPut(apiRequest('PUT', '/api/admin/ips/sort-mode', { token: member.token, body: { sortMode: 'MANUAL' } }), none)).status, 403);
    assert.equal((await sortPut(apiRequest('PUT', '/api/admin/ips/sort-mode', { token: ops.token, body: { sortMode: 'MANUAL' } }), none)).status, 200);
    assert.equal(((await (await sortGet(apiRequest('GET', '/api/admin/ips/sort-mode', { token: ops.token }), none)).json()) as { sortMode: string }).sortMode, 'MANUAL');
    const order = [op, chiaki, hidden, gundam, kimetsu, genshin].map((r) => r.body.id);
    assert.equal((await ipReorder(apiRequest('POST', '/api/admin/ips/reorder', { token: ops.token, body: { ids: order.slice(1) } }), none)).status, 400, 'must contain every IP');
    assert.equal((await ipReorder(apiRequest('POST', '/api/admin/ips/reorder', { token: ops.token, body: { ids: order } }), none)).status, 200);
    assert.deepEqual((await pub()).ips.map((i) => i.slug), ['one-piece', 'chiaki', 'gundam', 'kimetsu', 'genshin']);
    await sortPut(apiRequest('PUT', '/api/admin/ips/sort-mode', { token: ops.token, body: { sortMode: 'AUTO' } }), none);
    assert.equal((await pub()).ips[0]!.slug, 'genshin');

    // 修改別名與分類
    assert.equal((await ipPatch(apiRequest('PATCH', `/api/admin/ips/${gundam.body.id}`, { token: ops.token, body: { aliases: ['GUNDAM', '鋼彈'], category: '機甲・特攝' } }), ctx({ id: gundam.body.id }))).status, 200);
    assert.deepEqual((await pub('?q=%E9%8B%BC%E5%BD%88')).ips.map((i) => i.slug), ['gundam']);
    const [row] = await db()`SELECT aliases FROM ips WHERE id = ${gundam.body.id}`;
    assert.deepEqual(row!.aliases, ['GUNDAM', '鋼彈']);
  });

  it('pools link to an IP and filter by IP or IP category; linked IPs cannot be deleted', async () => {
    const ip = await createIp({ slug: 'sakamoto', name: '坂本日常', category: '經典少年' });
    const p1 = await publishPool(customPool({ ipId: ip.body.id }));
    const p2 = await publishPool(customPool());
    assert.equal((await poolSettings(apiRequest('PATCH', `/api/admin/pools/${p2}`, { token: ops.token, body: { ipId: ip.body.id } }), ctx({ id: p2 }))).status, 200);
    const [row] = await db()`SELECT ip, ip_id FROM pools WHERE id = ${p1}`;
    assert.deepEqual(row, { ip: '坂本日常', ipId: ip.body.id });
    const byIp = await j<{ pools: { id: string }[] }>(await poolsRoute(apiRequest('GET', `/api/pools?ipId=${ip.body.id}`), none));
    assert.deepEqual(byIp.body.pools.map((p) => p.id).sort(), [p1, p2].sort());
    const byCat = await j<{ pools: { id: string }[] }>(await poolsRoute(apiRequest('GET', `/api/pools?ipCategory=${encodeURIComponent('經典少年')}`), none));
    assert.deepEqual(byCat.body.pools.map((p) => p.id).sort(), [p1, p2].sort());
    assert.equal((await pub('?q=%E5%9D%82%E6%9C%AC')).ips[0]!.poolCount, 2);
    assert.equal((await ipDelete(apiRequest('DELETE', `/api/admin/ips/${ip.body.id}`, { token: ops.token }), ctx({ id: ip.body.id }))).status, 409);
    const audits = await db()`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'IP%'`;
    assert.ok((audits[0]!.n as number) >= 8);
  });
});
