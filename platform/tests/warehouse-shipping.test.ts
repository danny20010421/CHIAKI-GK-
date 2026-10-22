import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { recycleItems, listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { markDelivered, markShipped, requestShipment } from '../src/server/modules/shipping/shipping';
import { purchaseProduct } from '../src/server/modules/catalog/catalog';
import { reconcileWallets } from '../src/server/modules/wallet/wallet';
import { expectAppError, layoutOf, makeUser, publishPool, setupTestDb, smallPool, walletOf } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `w-${process.pid}-${++k}-${Date.now()}`;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

async function winItems(coins = 5000) {
  const poolId = await publishPool(smallPool({ setCount: 1, lastPrizeName: null }));
  const u = await makeUser({ coins });
  const layout = await layoutOf(poolId, 1);
  const pick = (rank: string) => layout.filter((t) => t.rank === rank).map((t) => t.ticketNo);
  await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [...pick('A'), ...pick('C'), ...pick('D').slice(0, 3)] });
  const items = await listWarehouse(db(), u.id);
  const of = (rank: string) => items.filter((i) => i.rank === rank).map((i) => i.id);
  return { u, of, items };
}

describe('recycle → platform points', () => {
  it('credits points per rank rate table; irreversible; non-recyclable ranks rejected atomically', async () => {
    const { u, of } = await winItems();
    const before = await walletOf(u.id);
    await expectAppError(recycleItems(u.id, [of('A')[0]!, of('D')[0]!]), 'NOT_RECYCLABLE');
    assert.equal((await listWarehouse(db(), u.id, 'STORED')).length, 6, 'nothing recycled on failure');
    const r = await recycleItems(u.id, [...of('C'), of('D')[0]!]);
    assert.equal(r.points, 300 * 2 + 150);
    assert.deepEqual(await walletOf(u.id), { coins: before.coins, points: before.points + 750 });
    await expectAppError(recycleItems(u.id, [of('C')[0]!]), 'INVALID_STATE');
    await assert.rejects(db()`UPDATE warehouse_items SET status = 'STORED' WHERE id = ${of('C')[0]!}`, /invalid warehouse transition/);
    const other = await makeUser();
    await expectAppError(recycleItems(other.id, [of('D')[1]!]), 'NOT_FOUND');
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });
});

describe('shipments', () => {
  it('merges items, charges fee from config, walks STORED→SHIP_REQUESTED→SHIPPED→DELIVERED', async () => {
    const { u, of } = await winItems();
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    const coins0 = (await walletOf(u.id)).coins;
    const s = await requestShipment(u.id, { itemIds: [of('A')[0]!, ...of('D').slice(0, 2)], method: 'CVS_711', recipientName: '王小明', recipientPhone: '0912345678', cvsStoreId: '123456', cvsStoreName: '測試門市' });
    assert.equal(s.itemCount, 3);
    assert.equal(s.feeCoins, 70);
    assert.equal((await walletOf(u.id)).coins, coins0 - 70);
    assert.equal((await listWarehouse(db(), u.id, 'SHIP_REQUESTED')).length, 3);
    await expectAppError(recycleItems(u.id, [of('D')[0]!]), 'INVALID_STATE');
    await expectAppError(markShipped(member.principal, s.shipmentId, 'TRACK1'), 'FORBIDDEN');
    await expectAppError(markDelivered(ops.principal, s.shipmentId), 'INVALID_STATE');
    await markShipped(ops.principal, s.shipmentId, 'TW123456789');
    await markDelivered(ops.principal, s.shipmentId);
    assert.equal((await listWarehouse(db(), u.id, 'DELIVERED')).length, 3);
    await assert.rejects(db()`UPDATE warehouse_items SET status = 'STORED' WHERE id = ${of('A')[0]!}`, /invalid warehouse transition/);
  });

  it('validates method requirements and ownership; fee failure rolls back', async () => {
    const { u, of } = await winItems(600); // 6 tickets × 100 = 600 → 0 coins left
    await assert.rejects(requestShipment(u.id, { itemIds: [of('D')[0]!], method: 'HOME_DELIVERY', recipientName: 'A', recipientPhone: '0912345678' }), /address/);
    await assert.rejects(requestShipment(u.id, { itemIds: [of('D')[0]!], method: 'CVS_FAMI' as const, recipientName: 'A', recipientPhone: '12345' }), /09xxxxxxxx/);
    await expectAppError(requestShipment(u.id, { itemIds: [of('D')[0]!], method: 'HOME_DELIVERY', recipientName: 'A', recipientPhone: '0912345678', address: '台北市信義區測試路 1 號' }), 'INSUFFICIENT_FUNDS');
    assert.equal((await listWarehouse(db(), u.id, 'STORED')).length, 6, 'rolled back');
    const [{ n }] = (await db()`SELECT count(*)::int AS n FROM shipments WHERE user_id = ${u.id}`) as unknown as [{ n: number }];
    assert.equal(n, 0);
  });
});

describe('direct-buy catalog', () => {
  it('fixed price purchase: stock, coins, warehouse; idempotent', async () => {
    const [p] = await db()`INSERT INTO products (sku, name, source, price_coins, stock) VALUES ('S-1', '展示盒', 'CUSTOM', 1280, 2) RETURNING id`;
    const u = await makeUser({ coins: 5000 });
    const a = await purchaseProduct(u.id, 'buy-key-0001', { productId: p!.id, qty: 2 });
    const b = await purchaseProduct(u.id, 'buy-key-0001', { productId: p!.id, qty: 2 });
    assert.equal(b.replayed, true);
    assert.equal(b.orderId, a.orderId);
    assert.equal((await walletOf(u.id)).coins, 5000 - 2560);
    await expectAppError(purchaseProduct(u.id, 'buy-key-0002', { productId: p!.id, qty: 1 }), 'CONFLICT');
    assert.equal((await listWarehouse(db(), u.id)).filter((i) => i.source === 'PURCHASE').length, 2);
  });
});
