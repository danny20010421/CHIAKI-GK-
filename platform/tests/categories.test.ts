/** 商品分類（GK、PVC、景品…）與「大件・限宅配」：獎項/商品屬性、賞池分類集合、超商出貨拒絕大件 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { createPoolDraft } from '../src/server/modules/pool/admin';
import { listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { purchaseProduct } from '../src/server/modules/catalog/catalog';
import { PRODUCT_CATEGORIES } from '../src/server/modules/catalog/categories';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { GET as poolsRoute } from '../src/app/api/pools/route';
import { GET as productsRoute } from '../src/app/api/products/route';
import { POST as shipRoute } from '../src/app/api/me/shipments/route';
import { PATCH as prizePatch } from '../src/app/api/admin/prizes/[id]/route';
import { PATCH as productPatch } from '../src/app/api/admin/products/[id]/route';
import { apiRequest, ctx, customPool, layoutOf, makeUser, publishPool, setupTestDb } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
const categorized = () =>
  customPool({
    prizes: [
      { name: '原創雕像', grade: 'GRAND', qtyPerSet: 1, category: 'GK' },
      { name: '角色公仔', grade: 'MID', qtyPerSet: 2, category: 'PVC', recycleValue: 400 },
      { name: '藍牙喇叭', grade: 'SMALL', qtyPerSet: 2, category: '3C', bulky: true },
      { name: '收藏卡', grade: 'SMALL', qtyPerSet: 35, category: '卡牌', recycleValue: 50 },
    ],
  });
const cvs = (itemIds: string[]) => ({ itemIds, method: 'CVS_711_C2C', recipientName: '王小明', recipientPhone: '0912345678', cvsStoreId: '123456' });
const home = (itemIds: string[]) => ({ itemIds, method: 'HOME_DELIVERY', recipientName: '王小明', recipientPhone: '0912345678', address: '台中市西屯區測試路 100 號' });

describe('product categories', () => {
  it('11 fixed categories; prizes carry category + bulky (GK defaults to bulky); pools expose the distinct set', async () => {
    assert.deepEqual([...PRODUCT_CATEGORIES], ['GK', 'PVC', '景品', '精品', '模型', '盒玩扭蛋', '絨毛', '周邊', '卡牌', '戰鬥陀螺', '3C']);
    const ops = await makeUser({ roles: ['OPS'] });
    await assert.rejects(createPoolDraft(ops.principal, customPool({ prizes: [{ name: 'x', grade: 'SMALL', qtyPerSet: 1, category: '公仔' as never }] })), /Invalid enum value/);
    const poolId = await publishPool(categorized());
    const d = await j<{ categories: string[]; hasBulky: boolean; prizes: { name: string; category: string | null; bulky: boolean }[] }>(await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId })));
    assert.deepEqual(d.body.categories, ['GK', 'PVC', '卡牌', '3C'], 'distinct, in the fixed order');
    assert.equal(d.body.hasBulky, true);
    assert.deepEqual(d.body.prizes.map((p) => [p.name, p.category, p.bulky]), [['原創雕像', 'GK', true], ['角色公仔', 'PVC', false], ['藍牙喇叭', '3C', true], ['收藏卡', '卡牌', false]]);
    const list = await j<{ pools: { id: string; categories: string[]; hasBulky: boolean }[] }>(await poolsRoute(apiRequest('GET', '/api/pools'), none));
    assert.deepEqual(list.body.pools.find((p) => p.id === poolId)!.categories, ['GK', 'PVC', '卡牌', '3C']);
    await assert.rejects(db()`UPDATE pool_prizes SET category = '公仔' WHERE pool_id = ${poolId}`, /check constraint/);
  });

  it('admin can change a prize category/bulky; changing to GK makes it bulky unless overridden', async () => {
    const poolId = await publishPool(categorized());
    const [card] = await db()<{ id: string }[]>`SELECT id FROM pool_prizes WHERE pool_id = ${poolId} AND name = '收藏卡'`;
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    assert.equal((await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${card!.id}`, { token: member.token, body: { category: 'GK' } }), ctx({ id: card!.id }))).status, 403);
    const r1 = await j<{ category: string; bulky: boolean }>(await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${card!.id}`, { token: ops.token, body: { category: 'GK' } }), ctx({ id: card!.id })));
    assert.deepEqual([r1.body.category, r1.body.bulky], ['GK', true]);
    const r2 = await j<{ category: string; bulky: boolean }>(await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${card!.id}`, { token: ops.token, body: { bulky: false } }), ctx({ id: card!.id })));
    assert.deepEqual([r2.body.category, r2.body.bulky], ['GK', false]);
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'PRIZE_ATTRIBUTES_UPDATED' ORDER BY seq DESC LIMIT 1`;
    assert.match(a!.payloadJson as string, /"bulky":false/);
  });
});

describe('bulky items (大件・限宅配)', () => {
  it('a shipment containing a bulky prize cannot use convenience-store pickup (Chinese error, nothing changed); home delivery works', async () => {
    const poolId = await publishPool(categorized());
    const u = await makeUser({ coins: 5000 });
    const layout = await layoutOf(poolId, 1);
    const no = (name: string) => layout.find((t) => t.name === name)!.ticketNo;
    await executeDraw(u.id, `cat-${process.pid}-1`, { poolId, setNo: 1, ticketNos: [no('原創雕像'), no('藍牙喇叭'), no('收藏卡')], shippingMethod: 'HOME_DELIVERY' });
    const items = await listWarehouse(db(), u.id, 'STORED');
    const id = (name: string) => items.find((i) => i.prizeName === name)!.id;
    const res = await j<{ error: { code: string; message: string; details: { items: { prizeName: string; category: string }[] } } }>(
      await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: cvs([id('原創雕像'), id('藍牙喇叭'), id('收藏卡')]) }), none),
    );
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'BULKY_HOME_DELIVERY_ONLY');
    assert.match(res.body.error.message, /為大件商品（限宅配），無法使用超商取貨/);
    assert.deepEqual(res.body.error.details.items.map((i) => [i.prizeName, i.category]).sort(), [['原創雕像', 'GK'], ['藍牙喇叭', '3C']]);
    assert.equal((await listWarehouse(db(), u.id, 'STORED')).length, 3, 'nothing requested');
    assert.equal((await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: cvs([id('收藏卡')]) }), none)).status, 201, 'non-bulky item ships by CVS');
    assert.equal((await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: home([id('原創雕像'), id('藍牙喇叭')]) }), none)).status, 201);
  });

  it('shop products: admin sets category/bulky; bulky products also require home delivery', async () => {
    const [p] = await db()<{ id: string }[]>`INSERT INTO products (sku, name, source, price_coins, stock) VALUES ('CAT-SPK', '大型藍牙音響', 'CUSTOM', 100, 5) RETURNING id`;
    const ops = await makeUser({ roles: ['OPS'] });
    const r = await j<{ category: string; bulky: boolean }>(await productPatch(apiRequest('PATCH', `/api/admin/products/${p!.id}`, { token: ops.token, body: { category: '3C', bulky: true } }), ctx({ id: p!.id })));
    assert.deepEqual([r.status, r.body.category, r.body.bulky], [200, '3C', true]);
    assert.equal((await productPatch(apiRequest('PATCH', `/api/admin/products/${p!.id}`, { token: ops.token, body: { category: '手機' } }), ctx({ id: p!.id }))).status, 400);
    const listed = await j<{ products: { id: string; category: string; bulky: boolean }[] }>(await productsRoute(apiRequest('GET', '/api/products'), none));
    assert.deepEqual(listed.body.products.filter((x) => x.id === p!.id).map((x) => [x.category, x.bulky]), [['3C', true]]);
    const u = await makeUser({ coins: 1000 });
    await purchaseProduct(u.id, 'cat-buy-0001', { productId: p!.id, qty: 1 });
    const [item] = await listWarehouse(db(), u.id, 'STORED');
    assert.equal((await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: cvs([item!.id]) }), none)).status, 422);
    assert.equal((await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: home([item!.id]) }), none)).status, 201);
  });
});
