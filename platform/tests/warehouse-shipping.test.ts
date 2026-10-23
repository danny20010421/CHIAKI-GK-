import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { recycleItems, listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { markDelivered, markShipped, requestShipment } from '../src/server/modules/shipping/shipping';
import { advanceShipment } from '../src/server/modules/shipping/fulfilment';
import { purchaseProduct } from '../src/server/modules/catalog/catalog';
import { reconcileWallets } from '../src/server/modules/wallet/wallet';
import { expectAppError, FEE_CVS, FEE_HOME, layoutOf, makeUser, publishPool, setupTestDb, smallPool, walletOf } from './helpers';

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
  // 等級 1 預設為大件（限宅配）；此處 A賞 明確設為非大件，以便測試超商出貨流程
  const poolId = await publishPool(
    smallPool({
      setCount: 1,
      lastPrizeName: null,
      prizes: [
        { rank: 'A', name: 'A賞', qtyPerSet: 1, bulky: false },
        { rank: 'B', name: 'B賞', qtyPerSet: 1 },
        { rank: 'C', name: 'C賞', qtyPerSet: 2, recycleValue: 300 },
        { rank: 'D', name: 'D賞', qtyPerSet: 6, recycleValue: 150 },
      ],
    }),
  );
  const u = await makeUser({ coins });
  const layout = await layoutOf(poolId, 1);
  const pick = (rank: string) => layout.filter((t) => t.levelNo === rank.charCodeAt(0) - 64).map((t) => t.ticketNo);
  await executeDraw(u.id, key(), { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [...pick('A'), ...pick('C'), ...pick('D').slice(0, 3)] });
  const items = await listWarehouse(db(), u.id);
  const of = (rank: string) => items.filter((i) => i.levelNo === rank.charCodeAt(0) - 64).map((i) => i.id);
  return { u, of, items, poolId };
}

describe('recycle → platform points', () => {
  it('credits points per set-prize recycle value; irreversible; non-recyclable prizes rejected atomically', async () => {
    const { u, of } = await winItems();
    const before = await walletOf(u.id);
    await expectAppError(recycleItems(u.id, [of('A')[0]!, of('D')[0]!]), 'NOT_RECYCLABLE');
    assert.equal((await listWarehouse(db(), u.id, 'STORED')).length, 6, 'nothing recycled on failure');
    const r = await recycleItems(u.id, [...of('C'), of('D')[0]!]);
    assert.equal(r.points, 300 * 2 + 150);
    // D 賞為小獎：另逐件退還運費 floor(70 × 1 / 20) = 3 代幣（不可退款）
    assert.deepEqual(await walletOf(u.id), { coins: before.coins + 3, points: before.points + 750 });
    assert.equal(r.shippingRefundCoins, 3);
    await expectAppError(recycleItems(u.id, [of('C')[0]!]), 'INVALID_STATE');
    await assert.rejects(db()`UPDATE warehouse_items SET status = 'STORED' WHERE id = ${of('C')[0]!}`, /invalid warehouse transition/);
    const other = await makeUser();
    await expectAppError(recycleItems(other.id, [of('D')[1]!]), 'NOT_FOUND');
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });
});

describe('shipments', () => {
  it('prepaid set items ship free; merges items; walks STORED→SHIP_REQUESTED→SHIPPED→DELIVERED', async () => {
    const { u, of } = await winItems();
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    const coins0 = (await walletOf(u.id)).coins;
    assert.equal(coins0, 5000 - 600 - FEE_CVS, 'fee was prepaid at draw time');
    const s = await requestShipment(u.id, { itemIds: [of('A')[0]!, ...of('D').slice(0, 2)], method: 'CVS_711_C2C', recipientName: '王小明', recipientPhone: '0912345678', cvsStoreId: '123456', cvsStoreName: '測試門市' });
    assert.equal(s.itemCount, 3);
    assert.equal(s.prepaidItemCount, 3);
    assert.equal(s.feeCoins, 0, 'no fee for items whose set fee is prepaid');
    assert.equal((await walletOf(u.id)).coins, coins0);
    assert.equal((await listWarehouse(db(), u.id, 'SHIP_REQUESTED')).length, 3);
    await expectAppError(recycleItems(u.id, [of('D')[0]!]), 'INVALID_STATE');
    await expectAppError(markShipped(member.principal, s.shipmentId, 'TRACK1', 'SEVEN_C2C'), 'FORBIDDEN');
    await expectAppError(markDelivered(ops.principal, s.shipmentId), 'INVALID_STATE');
    // 出貨流程：申請 → 揀貨 → 包裝 → 已出貨（必填物流商＋追蹤編號）→ 已送達
    await expectAppError(markShipped(ops.principal, s.shipmentId, 'TW123456789', 'SEVEN_C2C'), 'INVALID_STATE');
    await advanceShipment(ops.principal, s.shipmentId, { to: 'PICKING' });
    await advanceShipment(ops.principal, s.shipmentId, { to: 'PACKING' });
    await expectAppError(markShipped(ops.principal, s.shipmentId, 'TW123456789'), 'VALIDATION');
    await markShipped(ops.principal, s.shipmentId, 'TW123456789', 'SEVEN_C2C');
    await markDelivered(ops.principal, s.shipmentId);
    assert.equal((await listWarehouse(db(), u.id, 'DELIVERED')).length, 3);
    await assert.rejects(db()`UPDATE warehouse_items SET status = 'STORED' WHERE id = ${of('A')[0]!}`, /invalid warehouse transition/);
  });

  it('validates method requirements and ownership; Hi-Life/OK dropped; CVS-prepaid → home delivery pays the difference; fee failure rolls back', async () => {
    const { u, of } = await winItems(600 + FEE_CVS); // 6 tickets × 100 + 預收超商運費 → 0 coins left
    assert.equal((await walletOf(u.id)).coins, 0);
    await assert.rejects(requestShipment(u.id, { itemIds: [of('D')[0]!], method: 'HOME_DELIVERY', recipientName: 'A', recipientPhone: '0912345678' }), /address/);
    await assert.rejects(requestShipment(u.id, { itemIds: [of('D')[0]!], method: 'CVS_FAMI_C2C' as const, recipientName: 'A', recipientPhone: '12345' }), /09xxxxxxxx/);
    for (const old of ['CVS_HILIFE', 'CVS_OK', 'CVS_711']) {
      await assert.rejects(requestShipment(u.id, { itemIds: [of('D')[0]!], method: old as 'CVS_711_C2C', recipientName: 'A', recipientPhone: '0912345678', cvsStoreId: '1234' }), /Invalid enum value/);
    }
    // 預收的是超商運費 → 改宅配需補差額（宅配 − 超商）
    await expectAppError(requestShipment(u.id, { itemIds: [of('D')[0]!], method: 'HOME_DELIVERY', recipientName: 'A', recipientPhone: '0912345678', address: '台北市信義區測試路 1 號' }), 'INSUFFICIENT_FUNDS');
    assert.equal((await listWarehouse(db(), u.id, 'STORED')).length, 6, 'rolled back');
    const [{ n }] = (await db()`SELECT count(*)::int AS n FROM shipments WHERE user_id = ${u.id}`) as unknown as [{ n: number }];
    assert.equal(n, 0);
    await transactionTopUp(u.id, 500);
    const home = await requestShipment(u.id, { itemIds: [of('D')[0]!, of('D')[1]!], method: 'HOME_DELIVERY', recipientName: 'A', recipientPhone: '0912345678', address: '台北市信義區測試路 1 號' });
    assert.equal(home.feeCoins, FEE_HOME - FEE_CVS);
    assert.deepEqual(home.feeBreakdown.homeUpgrades.map((x) => x.amount), [FEE_HOME - FEE_CVS]);
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
    const bought = (await listWarehouse(db(), u.id)).filter((i) => i.source === 'PURCHASE');
    assert.equal(bought.length, 2);
    assert.ok(bought.every((i) => i.levelNo === null && !i.isSmall && i.recyclable === false && i.storageExpiresAt instanceof Date));
    // 直購商品沒有預收運費 → 依物流方式運費表收費
    await transactionTopUp(u.id, 200);
    const s = await requestShipment(u.id, { itemIds: bought.map((i) => i.id), method: 'CVS_FAMI_C2C', recipientName: 'A', recipientPhone: '0912345678', cvsStoreId: '9876' });
    assert.equal(s.feeCoins, 70);
    assert.equal(s.prepaidItemCount, 0);
  });
});

async function transactionTopUp(userId: string, amount: number) {
  const { postLedger } = await import('../src/server/modules/wallet/wallet');
  const { transaction } = await import('../src/server/db');
  await transaction((tx) => postLedger(tx, { userId, currency: 'COINS', amount, entryType: 'ADMIN_ADJUST', refType: 'test', refId: 'x' }));
}
