/** 標籤（7 個：GK、PVC、一番賞、景品盲盒、卡牌、娃娃、其他）與「大件」：獎項/商品屬性、賞池標籤集合與篩選、大件預設宅配（寄送方式逐件預設） */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { createPoolDraft } from '../src/server/modules/pool/admin';
import { listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { purchaseProduct } from '../src/server/modules/catalog/catalog';
import { TAGS } from '../src/server/modules/catalog/tags';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { GET as poolsRoute } from '../src/app/api/pools/route';
import { GET as productsRoute } from '../src/app/api/products/route';
import { POST as shipRoute } from '../src/app/api/me/shipments/route';
import { PATCH as prizePatch } from '../src/app/api/admin/prizes/[id]/route';
import { PATCH as productPatch } from '../src/app/api/admin/products/[id]/route';
import { apiRequest, ctx, customPool, layoutOf, makeUser, publishPool, setupTestDb, smallPool } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
const tagged = () =>
  customPool({
    levels: [
      { levelNo: 1, name: '大獎', items: [{ name: '原創雕像', qtyPerSet: 1, tag: 'PVC' }] },
      { levelNo: 2, name: '中獎', items: [{ name: '角色公仔', qtyPerSet: 2, tag: 'PVC', recycleValue: 400 }] },
      { levelNo: 4, name: '小獎', items: [{ name: '大型抱枕', qtyPerSet: 2, tag: '娃娃', bulky: true }, { name: '收藏卡', qtyPerSet: 35, tag: '卡牌', recycleValue: 50 }] },
    ],
  });
const R = { recipientName: '王小明', recipientPhone: '0912345678' };
const C711 = { c711: { ...R, cvsStoreId: '123456' } };
const HOME = { home: { ...R, address: '台中市西屯區測試路 100 號' } };
const ship = (itemIds: string[], destinations: Record<string, unknown>) => ({ itemIds, destinations });

describe('tags', () => {
  it('exactly 7 tags; items carry tag + bulky (GK or level 1 → bulky by default); pools expose the distinct set', async () => {
    assert.deepEqual([...TAGS], ['GK', 'PVC', '一番賞', '景品盲盒', '卡牌', '娃娃', '其他']);
    const ops = await makeUser({ roles: ['OPS'] });
    await assert.rejects(createPoolDraft(ops.principal, customPool({ levels: [{ levelNo: 1, name: 'A', items: [{ name: 'x', qtyPerSet: 1, tag: '3C' as never }] }] })), /標籤須為/);
    const poolId = await publishPool(tagged());
    const d = await j<{ tags: string[]; hasBulky: boolean; prizes: { name: string; tag: string | null; bulky: boolean }[] }>(await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId })));
    assert.deepEqual(d.body.tags, ['PVC', '卡牌', '娃娃'], 'distinct, in the fixed order');
    assert.equal(d.body.hasBulky, true);
    assert.deepEqual(d.body.prizes.map((p) => [p.name, p.tag, p.bulky]), [['原創雕像', 'PVC', true], ['角色公仔', 'PVC', false], ['大型抱枕', '娃娃', true], ['收藏卡', '卡牌', false]], 'level-1 item is bulky by default');
    const list = await j<{ pools: { id: string; tags: string[] }[] }>(await poolsRoute(apiRequest('GET', '/api/pools'), none));
    assert.deepEqual(list.body.pools.find((p) => p.id === poolId)!.tags, ['PVC', '卡牌', '娃娃']);
    await assert.rejects(db()`UPDATE pool_prizes SET tag = '公仔' WHERE pool_id = ${poolId}`, /check constraint/);
    const [cols] = await db()`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('pool_prizes', 'products') AND column_name = 'category'`;
    assert.equal(cols!.n, 0, 'old category columns dropped');
  });

  it('official-source pools always expose 一番賞; GET /api/pools?tag= filters', async () => {
    const official = await publishPool(smallPool({ prizes: [{ rank: 'A', name: 'A賞', qtyPerSet: 1, tag: 'GK' }, { rank: 'D', name: 'D賞', qtyPerSet: 4 }] }));
    const custom = await publishPool(tagged());
    const d = await j<{ tags: string[]; prizes: { bulky: boolean }[] }>(await poolRoute(apiRequest('GET', `/api/pools/${official}`), ctx({ id: official })));
    assert.deepEqual(d.body.tags, ['GK', '一番賞']);
    const ids = async (tag: string) => (await j<{ pools: { id: string }[] }>(await poolsRoute(apiRequest('GET', `/api/pools?tag=${encodeURIComponent(tag)}`), none))).body.pools.map((p) => p.id);
    assert.ok((await ids('一番賞')).includes(official) && !(await ids('一番賞')).includes(custom));
    assert.ok((await ids('娃娃')).includes(custom) && !(await ids('娃娃')).includes(official));
    assert.equal((await poolsRoute(apiRequest('GET', '/api/pools?tag=3C'), none)).status, 400);
  });

  it('admin can change an item tag/bulky anytime (audited); changing to GK makes it bulky unless overridden', async () => {
    const poolId = await publishPool(tagged());
    const [card] = await db()<{ id: string }[]>`SELECT id FROM pool_prizes WHERE pool_id = ${poolId} AND name = '收藏卡'`;
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    assert.equal((await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${card!.id}`, { token: member.token, body: { tag: 'GK' } }), ctx({ id: card!.id }))).status, 403);
    const r1 = await j<{ tag: string; bulky: boolean }>(await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${card!.id}`, { token: ops.token, body: { tag: 'GK' } }), ctx({ id: card!.id })));
    assert.deepEqual([r1.status, r1.body.tag, r1.body.bulky], [200, 'GK', true]);
    const r2 = await j<{ tag: string; bulky: boolean }>(await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${card!.id}`, { token: ops.token, body: { bulky: false } }), ctx({ id: card!.id })));
    assert.deepEqual([r2.body.tag, r2.body.bulky], ['GK', false]);
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'PRIZE_UPDATED' ORDER BY seq DESC LIMIT 1`;
    assert.match(a!.payloadJson as string, /"bulky":false/);
  });
});

describe('bulky items (大件) default to home delivery', () => {
  it('bulky prizes default to 宅配, others to 7-11; a mixed request splits by method; a missing destination is a Chinese 400 (nothing changed)', async () => {
    const poolId = await publishPool(tagged());
    const u = await makeUser({ coins: 5000 });
    const layout = await layoutOf(poolId, 1);
    const no = (name: string) => layout.find((t) => t.name === name)!.ticketNo;
    await executeDraw(u.id, `tag-${process.pid}-1`, { poolId, setNo: 1, ticketNos: [no('原創雕像'), no('大型抱枕'), no('收藏卡')] });
    const items = await listWarehouse(db(), u.id, 'STORED');
    const id = (name: string) => items.find((i) => i.prizeName === name)!.id;
    assert.deepEqual(items.map((i) => [i.prizeName, i.tag, i.bulky, i.shipMethod]).sort(), [
      ['原創雕像', 'PVC', true, 'home'],
      ['大型抱枕', '娃娃', true, 'home'],
      ['收藏卡', '卡牌', false, 'c711'],
    ]);
    const all = [id('原創雕像'), id('大型抱枕'), id('收藏卡')];
    const res = await j<{ error: { code: string; message: string; details: { methods: string[] } } }>(await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: ship(all, C711) }), none));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'SHIP_DESTINATION_REQUIRED');
    assert.match(res.body.error.message, /宅配到府/);
    assert.deepEqual(res.body.error.details.methods, ['home']);
    assert.equal((await listWarehouse(db(), u.id, 'STORED')).length, 3, 'nothing requested');
    const ok = await j<{ shipments: { shipMethod: string; itemCount: number }[] }>(await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: ship(all, { ...C711, ...HOME }) }), none));
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.shipments.map((x) => [x.shipMethod, x.itemCount]), [['home', 2], ['c711', 1]]);
  });

  it('shop products: admin sets tag/bulky (GK → bulky by default); bulky products ship by home delivery', async () => {
    const [p] = await db()<{ id: string }[]>`INSERT INTO products (sku, name, source, price_coins, stock) VALUES ('TAG-GK', '限定 GK', 'CUSTOM', 100, 5) RETURNING id`;
    const ops = await makeUser({ roles: ['OPS'] });
    const r = await j<{ tag: string; bulky: boolean }>(await productPatch(apiRequest('PATCH', `/api/admin/products/${p!.id}`, { token: ops.token, body: { tag: 'GK' } }), ctx({ id: p!.id })));
    assert.deepEqual([r.status, r.body.tag, r.body.bulky], [200, 'GK', true]);
    assert.equal((await productPatch(apiRequest('PATCH', `/api/admin/products/${p!.id}`, { token: ops.token, body: { tag: '3C' } }), ctx({ id: p!.id }))).status, 400);
    const listed = await j<{ products: { id: string; tag: string; bulky: boolean }[] }>(await productsRoute(apiRequest('GET', '/api/products'), none));
    assert.deepEqual(listed.body.products.filter((x) => x.id === p!.id).map((x) => [x.tag, x.bulky]), [['GK', true]]);
    const u = await makeUser({ coins: 1000 });
    await purchaseProduct(u.id, 'tag-buy-0001', { productId: p!.id, qty: 1 });
    const [item] = await listWarehouse(db(), u.id, 'STORED');
    assert.equal(item!.shipMethod, 'home');
    assert.equal((await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: ship([item!.id], C711) }), none)).status, 400);
    assert.equal((await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: ship([item!.id], HOME) }), none)).status, 201);
  });
});
