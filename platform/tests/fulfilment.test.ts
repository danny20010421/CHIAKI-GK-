/** 出貨流程：申請 → 揀貨 → 包裝 → 已出貨（物流商＋追蹤編號）→ 已送達；退件/異常 → 重新出貨；揀貨單；會員追蹤資訊；出貨通知 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { requestShipment } from '../src/server/modules/shipping/shipping';
import { advanceShipment, trackingUrl } from '../src/server/modules/shipping/fulfilment';
import { GET as myShipments } from '../src/app/api/me/shipments/route';
import { POST as statusRoute } from '../src/app/api/admin/shipments/[id]/status/route';
import { POST as resendRoute } from '../src/app/api/admin/shipments/[id]/resend/route';
import { POST as batchRoute } from '../src/app/api/admin/shipments/batch-status/route';
import { GET as pickListRoute } from '../src/app/api/admin/shipments/pick-list/route';
import { GET as carriersRoute } from '../src/app/api/admin/carriers/route';
import { apiRequest, ctx, expectAppError, makeUser, publishPool, setupTestDb, smallPool, type TestUser } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
let k = 0;
async function shipmentFor(method: 'CVS_711_C2C' | 'HOME_DELIVERY' = 'CVS_711_C2C'): Promise<{ u: TestUser; shipmentId: string; itemIds: string[] }> {
  // 寄送方式由獎項預設：此處全部獎項設為同一方式，讓隨機籤號只產生一張出貨單
  const shipMethod = method === 'HOME_DELIVERY' ? 'home' : 'c711';
  const poolId = await publishPool(
    smallPool({
      setCount: 1,
      prizes: [
        { rank: 'A', name: 'A賞', qtyPerSet: 1, shipMethod },
        { rank: 'B', name: 'B賞', qtyPerSet: 1, shipMethod },
        { rank: 'C', name: 'C賞', qtyPerSet: 2, recycleValue: 300, shipMethod },
        { rank: 'D', name: 'D賞', qtyPerSet: 6, recycleValue: 150, shipMethod },
      ],
    }),
  );
  const u = await makeUser({ coins: 5000 });
  await executeDraw(u.id, `ful-${process.pid}-${++k}`, { poolId, setNo: 1, ticketNos: [1, 2] });
  const itemIds = (await listWarehouse(db(), u.id, 'STORED')).map((i) => i.id);
  const recipient = { recipientName: '王小明', recipientPhone: '0912345678' };
  const s = await requestShipment(u.id, {
    itemIds,
    destinations:
      method === 'HOME_DELIVERY'
        ? { home: { ...recipient, address: '台中市西屯區測試路 100 號' } }
        : { c711: { ...recipient, cvsStoreId: '123456', cvsStoreName: '測試門市' } },
  });
  assert.equal(s.shipments.length, 1);
  return { u, shipmentId: s.shipments[0]!.shipmentId, itemIds };
}
const status = (token: string, id: string, body: Record<string, unknown>) => statusRoute(apiRequest('POST', `/api/admin/shipments/${id}/status`, { token, body }), ctx({ id }));
type MyShipment = { id: string; status: string; statusLabel: string; carrier: string | null; carrierLabel: string | null; trackingNo: string | null; trackingUrl: string | null };
const mine = async (token: string) => ((await (await myShipments(apiRequest('GET', '/api/me/shipments', { token }), none)).json()) as { shipments: MyShipment[] }).shipments;

describe('fulfilment pipeline', () => {
  it('walks 申請→揀貨→包裝→已出貨→已送達; carrier + tracking required and must match the method; member sees tracking URL; notified', async () => {
    const { u, shipmentId, itemIds } = await shipmentFor();
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    assert.deepEqual((await mine(u.token)).map((s) => [s.status, s.statusLabel, s.trackingNo]), [['REQUESTED', '申請', null]]);
    assert.equal((await status(member.token, shipmentId, { to: 'PICKING' })).status, 403);
    assert.equal((await status(ops.token, shipmentId, { to: 'PACKING' })).status, 409, 'cannot skip 揀貨');
    assert.equal((await status(ops.token, shipmentId, { to: 'PICKING' })).status, 200);
    assert.equal((await status(ops.token, shipmentId, { to: 'PACKING' })).status, 200);
    assert.equal((await status(ops.token, shipmentId, { to: 'SHIPPED', trackingNo: 'F12345678' })).status, 400, 'carrier required');
    assert.equal((await status(ops.token, shipmentId, { to: 'SHIPPED', carrier: 'SEVEN_C2C' })).status, 400, 'tracking number required');
    assert.equal((await status(ops.token, shipmentId, { to: 'SHIPPED', carrier: 'TCAT', trackingNo: 'F12345678' })).status, 400, 'home carrier cannot ship a 7-11 C2C parcel');
    const shipped = await status(ops.token, shipmentId, { to: 'SHIPPED', carrier: 'SEVEN_C2C', trackingNo: 'F12345678' });
    assert.equal(shipped.status, 200);
    const [s] = await mine(u.token);
    assert.deepEqual([s!.status, s!.statusLabel, s!.carrier, s!.carrierLabel, s!.trackingNo], ['SHIPPED', '已出貨', 'SEVEN_C2C', '7-ELEVEN 交貨便', 'F12345678']);
    assert.equal(s!.trackingUrl, 'https://eservice.7-11.com.tw/e-tracking/search.aspx?shipNo=F12345678');
    assert.equal((await listWarehouse(db(), u.id, 'SHIPPED')).length, itemIds.length);
    const [n] = await db()`SELECT body, payload_json FROM notifications WHERE user_id = ${u.id} AND type = 'SHIPMENT_SHIPPED'`;
    assert.match(n!.body as string, /7-ELEVEN 交貨便.*F12345678/);
    const sms = await db()`SELECT channel, destination, status, body FROM notification_outbox WHERE user_id = ${u.id} AND event_type = 'SHIPMENT_SHIPPED' AND channel = 'SMS'`;
    assert.equal(sms.length, 1, 'SMS queued for dispatch (user has a phone)');
    assert.equal(sms[0]!.status, 'PENDING');
    assert.equal((await status(ops.token, shipmentId, { to: 'PACKING' })).status, 409);
    assert.equal((await status(ops.token, shipmentId, { to: 'DELIVERED' })).status, 200);
    assert.equal((await listWarehouse(db(), u.id, 'DELIVERED')).length, itemIds.length);
    await assert.rejects(db()`UPDATE shipments SET status = 'REQUESTED' WHERE id = ${shipmentId}`, /invalid shipment transition/);
    const audits = await db()`SELECT action FROM audit_log WHERE entity_id = ${shipmentId} ORDER BY seq`;
    assert.deepEqual(audits.map((a) => a.action), ['SHIPMENT_REQUESTED', 'SHIPMENT_PICKING', 'SHIPMENT_PACKING', 'SHIPMENT_SHIPPED', 'SHIPMENT_DELIVERED']);
  });

  it('returned / exception parcels can be re-sent (attempt + 1, new tracking, notified again)', async () => {
    const { u, shipmentId } = await shipmentFor('HOME_DELIVERY');
    const ops = await makeUser({ roles: ['OPS'] });
    for (const to of ['PICKING', 'PACKING']) await advanceShipment(ops.principal, shipmentId, { to: to as 'PICKING' });
    await advanceShipment(ops.principal, shipmentId, { to: 'SHIPPED', carrier: 'TCAT', trackingNo: '900011112222' });
    assert.equal((await resendRoute(apiRequest('POST', `/api/admin/shipments/${shipmentId}/resend`, { token: ops.token }), ctx({ id: shipmentId }))).status, 409, 'only RETURNED/EXCEPTION');
    await advanceShipment(ops.principal, shipmentId, { to: 'RETURNED', note: '查無此人' });
    assert.equal((await mine(u.token))[0]!.statusLabel, '退件');
    const r = await resendRoute(apiRequest('POST', `/api/admin/shipments/${shipmentId}/resend`, { token: ops.token, body: { note: '更正地址' } }), ctx({ id: shipmentId }));
    assert.equal(r.status, 200);
    const [row] = await db()`SELECT status, attempt, tracking_no, carrier FROM shipments WHERE id = ${shipmentId}`;
    assert.deepEqual(row, { status: 'PICKING', attempt: 2, trackingNo: null, carrier: null });
    await advanceShipment(ops.principal, shipmentId, { to: 'PACKING' });
    await advanceShipment(ops.principal, shipmentId, { to: 'SHIPPED', carrier: 'HCT', trackingNo: '5550001111' });
    const [s] = await mine(u.token);
    assert.equal(s!.trackingUrl, trackingUrl('https://www.hct.com.tw/Search/SearchGoods_n.aspx?no={no}', '5550001111'));
    const [{ c }] = (await db()`SELECT count(*)::int AS c FROM notifications WHERE user_id = ${u.id} AND type = 'SHIPMENT_SHIPPED'`) as unknown as [{ c: number }];
    assert.equal(c, 2);
    await advanceShipment(ops.principal, shipmentId, { to: 'EXCEPTION', note: '包裹破損' });
    await expectAppError(advanceShipment(ops.principal, shipmentId, { to: 'DELIVERED' }), 'INVALID_STATE');
  });

  it('pick list for batch printing; batch status change is all-or-nothing; carriers per method', async () => {
    const a = await shipmentFor();
    const b = await shipmentFor('HOME_DELIVERY');
    const ops = await makeUser({ roles: ['OPS'] });
    const pl = (await (await pickListRoute(apiRequest('GET', `/api/admin/shipments/pick-list?ids=${a.shipmentId},${b.shipmentId}`, { token: ops.token }), none)).json()) as {
      shipmentCount: number;
      itemCount: number;
      shipments: { shipmentId: string; statusLabel: string; recipient: { name: string }; items: { prizeName: string; poolTitle: string; setNo: number; ticketNo: number }[] }[];
    };
    assert.deepEqual([pl.shipmentCount, pl.itemCount], [2, 4]);
    assert.ok(pl.shipments.every((s) => s.statusLabel === '申請' && s.recipient.name === '王小明' && s.items.every((i) => i.poolTitle === '測試賞池' && i.setNo === 1 && i.ticketNo > 0)));
    const byStatus = (await (await pickListRoute(apiRequest('GET', '/api/admin/shipments/pick-list?status=REQUESTED', { token: ops.token }), none)).json()) as { shipments: { shipmentId: string }[] };
    assert.ok([a.shipmentId, b.shipmentId].every((id) => byStatus.shipments.some((s) => s.shipmentId === id)));

    await advanceShipment(ops.principal, a.shipmentId, { to: 'PICKING' });
    const bad = await batchRoute(apiRequest('POST', '/api/admin/shipments/batch-status', { token: ops.token, body: { shipmentIds: [a.shipmentId, b.shipmentId], to: 'PICKING' } }), none);
    assert.equal(bad.status, 409);
    const [bRow] = await db()`SELECT status FROM shipments WHERE id = ${b.shipmentId}`;
    assert.equal(bRow!.status, 'REQUESTED', 'rolled back');
    await advanceShipment(ops.principal, b.shipmentId, { to: 'PICKING' });
    const ok = await batchRoute(apiRequest('POST', '/api/admin/shipments/batch-status', { token: ops.token, body: { shipmentIds: [a.shipmentId, b.shipmentId], to: 'PACKING' } }), none);
    assert.equal(((await ok.json()) as { updated: number }).updated, 2);

    const home = (await (await carriersRoute(apiRequest('GET', '/api/admin/carriers?method=HOME_DELIVERY', { token: ops.token }), none)).json()) as { carriers: { code: string; label: string }[] };
    assert.deepEqual(home.carriers.map((c) => c.label), ['黑貓宅急便', '新竹物流', '中華郵政', '嘉里大榮', '宅配通']);
    const fami = (await (await carriersRoute(apiRequest('GET', '/api/admin/carriers?method=CVS_FAMI_C2C', { token: ops.token }), none)).json()) as { carriers: { label: string }[] };
    assert.deepEqual(fami.carriers.map((c) => c.label), ['全家店到店']);
  });
});
