import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { POST as otpVerify } from '../src/app/api/auth/otp/verify/route';
import { POST as ageVerify } from '../src/app/api/me/age-verification/route';
import { POST as holdRoute, DELETE as releaseRoute } from '../src/app/api/pools/[id]/sets/[no]/holds/route';
import { GET as setRoute } from '../src/app/api/pools/[id]/sets/[no]/route';
import { POST as drawRoute } from '../src/app/api/draws/route';
import { GET as walletRoute } from '../src/app/api/me/wallet/route';
import { GET as warehouseRoute } from '../src/app/api/me/warehouse/route';
import { POST as shipRoute } from '../src/app/api/me/shipments/route';
import { POST as recycleRoute } from '../src/app/api/me/recycle/route';
import { GET as rewardsList, POST as rewardsClaim } from '../src/app/api/me/rewards/route';
import { POST as refundRoute } from '../src/app/api/me/refund-requests/route';
import { POST as checkoutRoute } from '../src/app/api/payments/ecpay/checkout/route';
import { POST as notifyRoute } from '../src/app/api/payments/ecpay/notify/route';
import { GET as auditVerify } from '../src/app/api/admin/audit/verify/route';
import { GET as reconcileRoute } from '../src/app/api/admin/wallets/reconcile/route';
import { computeCheckMacValue } from '../src/server/modules/payment/ecpay';
import { apiRequest, ctx, makeUser, publishPool, setupTestDb, smallPool } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
const none = undefined as never;

describe('member journey over HTTP route handlers', () => {
  it('login → top-up (ECPay) → age verify → hold → draw (idempotent) → warehouse → ship / recycle → rewards → refund', async () => {
    const poolId = await publishPool(smallPool({ slug: 'flow-pool' }));
    // 未登入
    assert.equal((await drawRoute(apiRequest('POST', '/api/draws', { body: {} }), none)).status, 401);

    const login = await j<{ token: string; userId: string; isNew: boolean }>(await otpVerify(apiRequest('POST', '/api/auth/otp/verify', { body: { phone: '0987654321', code: '000000' }, headers: { 'x-device-fingerprint': 'fp-flow-0001' } }), none));
    assert.equal(login.status, 200);
    assert.equal(login.body.isNew, true);
    const token = login.body.token;

    // 儲值：checkout → 模擬綠界通知
    const co = await j<{ merchantTradeNo: string; params: Record<string, string> }>(await checkoutRoute(apiRequest('POST', '/api/payments/ecpay/checkout', { token, body: { packageCode: 'P1000' } }), none));
    const n: Record<string, string> = { MerchantID: '3002607', MerchantTradeNo: co.body.merchantTradeNo, RtnCode: '1', RtnMsg: 'Succeeded', TradeNo: '9999', TradeAmt: '1000', PaymentDate: '2026/10/23 10:00:00', PaymentType: 'Credit_CreditCard', PaymentTypeChargeFee: '0', TradeDate: '2026/10/23 09:59:00', SimulatePaid: '0' };
    n.CheckMacValue = computeCheckMacValue(n, 'pwFHCqoQZGmho4w6', 'EkRm7iFT261dpevs');
    assert.equal(await (await notifyRoute(apiRequest('POST', '/api/payments/ecpay/notify', { rawBody: new URLSearchParams(n).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }))).text(), '1|OK');

    // 未年齡驗證不得抽
    const blocked = await j<{ error: { code: string } }>(await drawRoute(apiRequest('POST', '/api/draws', { token, headers: { 'idempotency-key': 'flow-key-0001' }, body: { poolId: 'flow-pool', shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1] } }), none));
    assert.equal(blocked.body.error.code, 'AGE_VERIFICATION_REQUIRED');
    const minor = await ageVerify(apiRequest('POST', '/api/me/age-verification', { token, body: { birthDate: '2015-01-01' } }), none);
    assert.equal(minor.status, 403);
    assert.equal((await ageVerify(apiRequest('POST', '/api/me/age-verification', { token, body: { birthDate: '1995-05-05' } }), none)).status, 200);

    // 鎖籤 → 抽（slug 也可）
    const hold = await j<{ ticketNos: number[] }>(await holdRoute(apiRequest('POST', '/api/pools/flow-pool/sets/1/holds', { token, body: { ticketNos: [1, 2, 3] } }), ctx({ id: 'flow-pool', no: '1' })));
    assert.deepEqual(hold.body.ticketNos, [1, 2, 3]);
    const rel = await j<{ released: number[] }>(await releaseRoute(apiRequest('DELETE', '/api/pools/flow-pool/sets/1/holds', { token, body: { ticketNos: [3] } }), ctx({ id: 'flow-pool', no: '1' })));
    assert.deepEqual(rel.body.released, [3]);
    const noKey = await drawRoute(apiRequest('POST', '/api/draws', { token, body: { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1, 2] } }), none);
    assert.equal(noKey.status, 400);
    const bad = await drawRoute(apiRequest('POST', '/api/draws', { token, headers: { 'idempotency-key': 'flow-key-0002' }, body: { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1, 1] } }), none);
    assert.equal(bad.status, 400);
    const d1 = await j<{ drawId: string; coinsAfter: number; results: { warehouseItemId: string; rank: string }[] }>(await drawRoute(apiRequest('POST', '/api/draws', { token, headers: { 'idempotency-key': 'flow-key-0003' }, body: { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1, 2] } }), none));
    assert.equal(d1.status, 201);
    assert.equal(d1.body.coinsAfter, 800 - 70, 'draw + prepaid CVS shipping fee');
    const replay = await drawRoute(apiRequest('POST', '/api/draws', { token, headers: { 'idempotency-key': 'flow-key-0003' }, body: { poolId, shippingMethod: 'CVS_711_C2C', setNo: 1, ticketNos: [1, 2] } }), none);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(((await replay.json()) as { drawId: string }).drawId, d1.body.drawId);

    const board = await j<{ remaining: number; tickets: { no: number; state: string; rank?: string }[] }>(await setRoute(apiRequest('GET', `/api/pools/${poolId}/sets/1`), ctx({ id: poolId, no: '1' })));
    assert.equal(board.body.remaining, 8);
    assert.equal(board.body.tickets.find((t) => t.no === 1)!.state, 'TAKEN');

    const wallet = await j<{ coins: number; points: number; ledger: { entryType: string }[] }>(await walletRoute(apiRequest('GET', '/api/me/wallet', { token }), none));
    assert.equal(wallet.body.coins, 800 - 70);
    assert.deepEqual(wallet.body.ledger.map((l) => l.entryType), ['SHIPPING_PREPAID', 'DRAW_DEBIT', 'TOPUP']);

    const wh = await j<{ items: { id: string; rank: string; status: string }[] }>(await warehouseRoute(apiRequest('GET', '/api/me/warehouse?status=STORED', { token }), none));
    assert.equal(wh.body.items.length, 2);
    const recyclable = wh.body.items.filter((i) => ['C', 'D'].includes(i.rank));
    const keep = wh.body.items.filter((i) => !recyclable.includes(i));
    if (recyclable.length) {
      const rc = await recycleRoute(apiRequest('POST', '/api/me/recycle', { token, body: { itemIds: recyclable.map((i) => i.id) } }), none);
      assert.equal(rc.status, 200);
    }
    if (keep.length) {
      const sh = await shipRoute(apiRequest('POST', '/api/me/shipments', { token, body: { itemIds: keep.map((i) => i.id), method: 'HOME_DELIVERY', recipientName: '測試', recipientPhone: '0987654321', address: '台中市西屯區測試路 100 號' } }), none);
      assert.equal(sh.status, 201);
    }

    const rw = await j<{ tasks: { code: string; claimed: boolean }[] }>(await rewardsList(apiRequest('GET', '/api/me/rewards', { token }), none));
    assert.equal(rw.body.tasks.length, 4);
    assert.equal((await rewardsClaim(apiRequest('POST', '/api/me/rewards', { token, body: { taskCode: 'BIND_PHONE' } }), none)).status, 201);
    assert.equal((await rewardsClaim(apiRequest('POST', '/api/me/rewards', { token, body: { taskCode: 'BIND_PHONE' } }), none)).status, 409);

    const rf = await refundRoute(apiRequest('POST', '/api/me/refund-requests', { token, body: { amountCoins: 100, reason: 'test' } }), none);
    assert.equal(rf.status, 201);

    // 後台檢查
    const fin = await makeUser({ roles: ['FINANCE'] });
    const audit = await j<{ ok: boolean; count: number }>(await auditVerify(apiRequest('GET', '/api/admin/audit/verify', { token: fin.token }), none));
    assert.equal(audit.body.ok, true);
    const rec = await j<{ ok: boolean }>(await reconcileRoute(apiRequest('GET', '/api/admin/wallets/reconcile', { token: fin.token }), none));
    assert.equal(rec.body.ok, true);
    assert.equal((await auditVerify(apiRequest('GET', '/api/admin/audit/verify', { token }), none)).status, 403);
  });
});
