/**
 * 中獎倉庫：回收 → 不可退款 CC幣；出貨：寄送方式由獎項預設（會員不可選）、不同方式拆單、運費到付；直購商品出貨。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { recycleItems, listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { markDelivered, markShipped, requestShipment } from '../src/server/modules/shipping/shipping';
import { advanceShipment } from '../src/server/modules/shipping/fulfilment';
import { createAddress } from '../src/server/modules/member/profile';
import { purchaseProduct } from '../src/server/modules/catalog/catalog';
import { reconcileWallets } from '../src/server/modules/wallet/wallet';
import { POST as shipRoute } from '../src/app/api/me/shipments/route';
import { apiRequest, expectAppError, layoutOf, ledgerOf, makeUser, publishPool, setupTestDb, smallPool, walletOf } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `w-${process.pid}-${++k}-${Date.now()}`;
const none = undefined as never;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const R = { recipientName: '王小明', recipientPhone: '0912345678' };
const HOME = { ...R, address: '台北市信義區測試路 1 號' };
const C711 = { ...R, cvsStoreId: '123456', cvsStoreName: '測試門市' };
const FAMI = { ...R, cvsStoreId: '987654' };

/**
 * A（等級 1，未指定 → 大件 → 宅配）1、B 1、C（未指定 → 7-11）2、D（指定全家）6。
 * 會員抽 A + C×2 + D×3。
 */
async function winItems(coins = 5000) {
  const poolId = await publishPool(
    smallPool({
      setCount: 1,
      lastPrizeName: null,
      prizes: [
        { rank: 'A', name: 'A賞', qtyPerSet: 1 },
        { rank: 'B', name: 'B賞', qtyPerSet: 1 },
        { rank: 'C', name: 'C賞', qtyPerSet: 2, recycleValue: 300 },
        { rank: 'D', name: 'D賞', qtyPerSet: 6, recycleValue: 150, shipMethod: 'fami' },
      ],
    }),
  );
  const u = await makeUser({ coins });
  const layout = await layoutOf(poolId, 1);
  const pick = (rank: string) => layout.filter((t) => t.levelNo === rank.charCodeAt(0) - 64).map((t) => t.ticketNo);
  await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [...pick('A'), ...pick('C'), ...pick('D').slice(0, 3)] });
  const items = await listWarehouse(db(), u.id);
  const of = (rank: string) => items.filter((i) => i.levelNo === rank.charCodeAt(0) - 64).map((i) => i.id);
  return { u, of, items, poolId };
}

describe('recycle → non-refundable CC幣', () => {
  it('credits the set-prize recycle value as non-refundable coins; irreversible; non-recyclable prizes rejected atomically', async () => {
    const { u, of } = await winItems();
    const before = await walletOf(u.id);
    await expectAppError(recycleItems(u.id, [of('A')[0]!, of('D')[0]!]), 'NOT_RECYCLABLE');
    assert.equal((await listWarehouse(db(), u.id, 'STORED')).length, 6, 'nothing recycled on failure');
    const r = await recycleItems(u.id, [...of('C'), of('D')[0]!]);
    assert.equal(r.coins, 300 * 2 + 150);
    assert.equal(r.coinsAfter, before.coins + 750);
    // 回收只入「不可退款」CC幣；運費到付 → 不再有逐件運費退還
    assert.deepEqual(await walletOf(u.id), { coins: before.coins + 750, nonRefundableCoins: before.nonRefundableCoins + 750 });
    assert.ok(!('shippingRefundCoins' in r));
    const led = (await ledgerOf(u.id)).filter((l) => l.entryType === 'RECYCLE_CREDIT');
    assert.deepEqual(led.map((l) => [l.amount, l.refundable]), [[750, false]]);
    const recycled = (await listWarehouse(db(), u.id, 'RECYCLED')).map((i) => [i.recycleReason, i.recycledCoins]);
    assert.deepEqual(recycled.sort(), [['USER', 150], ['USER', 300], ['USER', 300]]);
    await expectAppError(recycleItems(u.id, [of('C')[0]!]), 'INVALID_STATE');
    await assert.rejects(db()`UPDATE warehouse_items SET status = 'STORED' WHERE id = ${of('C')[0]!}`, /invalid warehouse transition/);
    const other = await makeUser();
    await expectAppError(recycleItems(other.id, [of('D')[1]!]), 'NOT_FOUND');
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });
});

describe('shipments — preset ship method per prize, freight collect', () => {
  it('warehouse items carry the preset method; a mixed request splits into one shipment per method with its own destination; no coins charged', async () => {
    const { u, of } = await winItems(600); // 6 籤 × 100 → 0 CC幣：運費到付，申請出貨不需任何餘額
    assert.equal((await walletOf(u.id)).coins, 0);
    const methods = Object.fromEntries((await listWarehouse(db(), u.id)).map((i) => [i.id, i.shipMethod]));
    assert.equal(methods[of('A')[0]!], 'home', 'level 1 / bulky default → home');
    assert.ok(of('C').every((id) => methods[id] === 'c711'), 'default → 7-11');
    assert.ok(of('D').every((id) => methods[id] === 'fami'), 'admin preset → 全家');

    const itemIds = [of('A')[0]!, of('C')[0]!, ...of('D').slice(0, 2)];
    const ledger0 = (await ledgerOf(u.id)).length;
    const s = await requestShipment(u.id, { itemIds, destinations: { home: HOME, c711: C711, fami: FAMI } });
    assert.deepEqual([s.itemCount, s.freightCollect, s.feeCoins, s.shipments.length], [4, true, 0, 3]);
    assert.deepEqual(
      s.shipments.map((p) => [p.shipMethod, p.method, p.itemCount, p.freightCollect, p.feeCoins]),
      [['home', 'HOME_DELIVERY', 1, true, 0], ['c711', 'CVS_711_C2C', 1, true, 0], ['fami', 'CVS_FAMI_C2C', 2, true, 0]],
    );
    const rows = await db()<{ id: string; method: string; address: string | null; cvsStoreId: string | null; feeCoins: number; freightCollect: boolean; requestId: string; itemCount: number }[]>`
      SELECT id, method, address, cvs_store_id, fee_coins, freight_collect, request_id, item_count FROM shipments WHERE user_id = ${u.id} ORDER BY method`;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.requestId === s.requestId && r.freightCollect && r.feeCoins === 0));
    assert.deepEqual(rows.map((r) => [r.method, r.address, r.cvsStoreId]), [
      ['CVS_711_C2C', null, '123456'],
      ['CVS_FAMI_C2C', null, '987654'],
      ['HOME_DELIVERY', '台北市信義區測試路 1 號', null],
    ]);
    const onShipment = await db()<{ id: string; method: string }[]>`
      SELECT wi.id, s.method FROM warehouse_items wi JOIN shipments s ON s.id = wi.shipment_id WHERE wi.id = ANY(${itemIds}::uuid[])`;
    assert.ok(onShipment.every((x) => (x.id === of('A')[0] ? x.method === 'HOME_DELIVERY' : of('C').includes(x.id) ? x.method === 'CVS_711_C2C' : x.method === 'CVS_FAMI_C2C')));
    assert.equal((await ledgerOf(u.id)).length, ledger0, 'no shipping charge at ship-request time');
    assert.equal((await listWarehouse(db(), u.id, 'SHIP_REQUESTED')).length, 4);
    await assert.rejects(db()`UPDATE shipments SET fee_coins = 70 WHERE id = ${rows[0]!.id}`, /shipments_freight_collect_no_fee/);
    await assert.rejects(
      db()`INSERT INTO shipments (user_id, method, recipient_name, recipient_phone, cvs_store_id, fee_coins, item_count, freight_collect)
           VALUES (${u.id}, 'CVS_711_C2C', 'A', '0912345678', '1234', 70, 1, false)`,
      /shipments_freight_collect_only/,
    );
  });

  it('members cannot choose a method; missing destinations are reported per method; saved addresses fill in; address method must match', async () => {
    const { u, of } = await winItems();
    // 舊格式（自選 method）→ 拒絕
    await expectAppError(requestShipment(u.id, { itemIds: [of('C')[0]!], method: 'HOME_DELIVERY', ...HOME }), 'SHIP_METHOD_PRESET');
    const viaApi = await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: { itemIds: [of('C')[0]!], method: 'HOME_DELIVERY', ...HOME } }), none);
    assert.equal(viaApi.status, 400);
    assert.equal(((await viaApi.json()) as { error: { code: string } }).error.code, 'SHIP_METHOD_PRESET');
    // C 預設 7-11：只給宅配地址 → 缺 7-11 門市
    try {
      await requestShipment(u.id, { itemIds: [of('A')[0]!, of('C')[0]!], destinations: { home: HOME } });
      assert.fail('expected SHIP_DESTINATION_REQUIRED');
    } catch (e) {
      const err = e as { code: string; details: { methods: string[]; items: Record<string, string[]> } };
      assert.equal(err.code, 'SHIP_DESTINATION_REQUIRED');
      assert.deepEqual(err.details.methods, ['c711']);
      assert.deepEqual(err.details.items.c711, [of('C')[0]!]);
    }
    assert.equal((await listWarehouse(db(), u.id, 'STORED')).length, 6, 'nothing requested on failure');
    // 驗證：宅配需地址、超商需門市、手機格式
    await expectAppError(requestShipment(u.id, { itemIds: [of('A')[0]!], destinations: { home: { ...R } } }), 'VALIDATION');
    await expectAppError(requestShipment(u.id, { itemIds: [of('C')[0]!], destinations: { c711: { ...R } } }), 'VALIDATION');
    await assert.rejects(requestShipment(u.id, { itemIds: [of('C')[0]!], destinations: { c711: { ...C711, recipientPhone: '12345' } } }), /09xxxxxxxx/);
    // 常用收件資訊：未提供的方式自動使用該方式的常用資訊（預設優先）
    const c711Addr = await createAddress(u.id, { method: 'c711', ...C711, cvsStoreId: '555555' });
    const homeAddr = await createAddress(u.id, { method: 'home', ...HOME });
    await expectAppError(requestShipment(u.id, { itemIds: [of('C')[0]!], destinations: { c711: { addressId: homeAddr.id } } }), 'VALIDATION');
    const s = await requestShipment(u.id, { itemIds: [of('A')[0]!, of('C')[0]!] });
    assert.deepEqual(s.shipments.map((p) => p.shipMethod), ['home', 'c711']);
    const rows = await db()<{ method: string; addressId: string; cvsStoreId: string | null }[]>`
      SELECT method, address_id, cvs_store_id FROM shipments WHERE request_id = ${s.requestId} ORDER BY method`;
    assert.deepEqual([...rows], [
      { method: 'CVS_711_C2C', addressId: c711Addr.id, cvsStoreId: '555555' },
      { method: 'HOME_DELIVERY', addressId: homeAddr.id, cvsStoreId: null },
    ]);
    // 全家沒有常用收件資訊 → 必須提供
    await expectAppError(requestShipment(u.id, { itemIds: [of('D')[0]!] }), 'SHIP_DESTINATION_REQUIRED');
    const other = await makeUser();
    await expectAppError(requestShipment(other.id, { itemIds: [of('D')[0]!], destinations: { fami: FAMI } }), 'NOT_FOUND');
  });

  it('a shipment walks STORED→SHIP_REQUESTED→SHIPPED→DELIVERED', async () => {
    const { u, of } = await winItems();
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    const s = await requestShipment(u.id, { itemIds: of('D').slice(0, 2), destinations: { fami: FAMI } });
    const sid = s.shipments[0]!.shipmentId;
    assert.equal((await listWarehouse(db(), u.id, 'SHIP_REQUESTED')).length, 2);
    await expectAppError(recycleItems(u.id, [of('D')[0]!]), 'INVALID_STATE');
    await expectAppError(markShipped(member.principal, sid, 'TRACK1', 'FAMI_C2C'), 'FORBIDDEN');
    await expectAppError(markDelivered(ops.principal, sid), 'INVALID_STATE');
    await expectAppError(markShipped(ops.principal, sid, 'TW123456789', 'FAMI_C2C'), 'INVALID_STATE');
    await advanceShipment(ops.principal, sid, { to: 'PICKING' });
    await advanceShipment(ops.principal, sid, { to: 'PACKING' });
    await expectAppError(markShipped(ops.principal, sid, 'TW123456789'), 'VALIDATION');
    const [carrier] = await db()<{ code: string }[]>`SELECT code FROM carriers WHERE category = 'CVS_FAMI' AND active LIMIT 1`;
    await markShipped(ops.principal, sid, 'TW123456789', carrier!.code);
    await markDelivered(ops.principal, sid);
    assert.equal((await listWarehouse(db(), u.id, 'DELIVERED')).length, 2);
    await assert.rejects(db()`UPDATE warehouse_items SET status = 'STORED' WHERE id = ${of('D')[0]!}`, /invalid warehouse transition/);
  });
});

describe('direct-buy catalog', () => {
  it('fixed price purchase: stock, coins, warehouse; idempotent; ships freight-collect by its default method', async () => {
    const [p] = await db()`INSERT INTO products (sku, name, source, price_coins, stock) VALUES ('S-1', '展示盒', 'CUSTOM', 1280, 2) RETURNING id`;
    const [big] = await db()`INSERT INTO products (sku, name, source, price_coins, stock, bulky) VALUES ('S-2', '大型雕像', 'CUSTOM', 100, 1, true) RETURNING id`;
    const u = await makeUser({ coins: 5000 });
    const a = await purchaseProduct(u.id, 'buy-key-0001', { productId: p!.id, qty: 2 });
    const b = await purchaseProduct(u.id, 'buy-key-0001', { productId: p!.id, qty: 2 });
    assert.equal(b.replayed, true);
    assert.equal(b.orderId, a.orderId);
    assert.equal((await walletOf(u.id)).coins, 5000 - 2560);
    await expectAppError(purchaseProduct(u.id, 'buy-key-0002', { productId: p!.id, qty: 1 }), 'CONFLICT');
    await purchaseProduct(u.id, 'buy-key-0003', { productId: big!.id, qty: 1 });
    const bought = (await listWarehouse(db(), u.id)).filter((i) => i.source === 'PURCHASE');
    assert.equal(bought.length, 3);
    assert.ok(bought.every((i) => i.levelNo === null && !i.isSmall && i.recyclable === false && i.storageExpiresAt instanceof Date));
    // 直購商品：大件 → 宅配，其餘 → 7-11；運費到付
    assert.deepEqual(bought.map((i) => i.shipMethod).sort(), ['c711', 'c711', 'home']);
    const coins0 = (await walletOf(u.id)).coins;
    const s = await requestShipment(u.id, { itemIds: bought.map((i) => i.id), destinations: { c711: C711, home: HOME } });
    assert.deepEqual(s.shipments.map((x) => [x.shipMethod, x.itemCount, x.feeCoins]), [['home', 1, 0], ['c711', 2, 0]]);
    assert.equal((await walletOf(u.id)).coins, coins0);
  });
});
