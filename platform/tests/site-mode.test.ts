/** 測試網站模式（金流一律拒絕）與「只提供快速抽」（自選籤號預設關閉） */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config, resetConfig } from '../src/server/config';
import { executeDraw } from '../src/server/modules/draw/draw';
import { POST as checkoutRoute } from '../src/app/api/payments/ecpay/checkout/route';
import { POST as bankRoute } from '../src/app/api/payments/bank-transfer/route';
import { POST as notifyRoute } from '../src/app/api/payments/ecpay/notify/route';
import { POST as drawRoute } from '../src/app/api/draws/route';
import { POST as quoteRoute } from '../src/app/api/draws/quote/route';
import { POST as holdRoute } from '../src/app/api/pools/[id]/sets/[no]/holds/route';
import { apiRequest, ctx, makeUser, pickTickets, publishPool, setupTestDb, smallPool } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb({ SITE_TEST_MODE: 'true', ALLOW_TICKET_PICK: 'false' });
});
after(async () => {
  await env.teardown();
});
const none = undefined as never;
const j = async <T = { error: { code: string; message: string } }>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
let k = 0;
const key = () => `site-${process.pid}-${++k}-${Date.now()}`;

describe('test-site mode (SITE_TEST_MODE)', () => {
  it('defaults to ON when unset', () => {
    const saved = process.env.SITE_TEST_MODE;
    delete process.env.SITE_TEST_MODE;
    resetConfig();
    try {
      assert.equal(config().SITE_TEST_MODE, true);
      assert.equal(config().ALLOW_TICKET_PICK, false, 'ticket picking defaults to OFF');
    } finally {
      process.env.SITE_TEST_MODE = saved;
      resetConfig();
    }
  });

  it('every payment endpoint refuses with 403 「此為測試網站，不進行商業行為」 unless PAYMENT_SANDBOX is set', async () => {
    const u = await makeUser();
    for (const res of [
      await checkoutRoute(apiRequest('POST', '/api/payments/ecpay/checkout', { token: u.token, body: { packageCode: 'P500' } }), none),
      await bankRoute(apiRequest('POST', '/api/payments/bank-transfer', { token: u.token, body: { packageCode: 'P500' } }), none),
    ]) {
      const r = await j(res);
      assert.deepEqual([r.status, r.body.error.code, r.body.error.message], [403, 'TEST_SITE', '此為測試網站，不進行商業行為']);
    }
    const n = await notifyRoute(new Request('http://localhost/api/payments/ecpay/notify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'MerchantTradeNo=X&RtnCode=1' }), none);
    assert.equal(n.status, 403);
    assert.equal(await n.text(), '0|此為測試網站，不進行商業行為');

    process.env.PAYMENT_SANDBOX = 'true';
    resetConfig();
    try {
      assert.equal((await checkoutRoute(apiRequest('POST', '/api/payments/ecpay/checkout', { token: u.token, body: { packageCode: 'P500' } }), none)).status, 201, 'sandbox flag allows ECPay stage');
    } finally {
      delete process.env.PAYMENT_SANDBOX;
      resetConfig();
    }
  });
});

describe('quick draw only', () => {
  it('choosing ticket numbers (hold or ticketNos) is refused by default; count-based purchase works', async () => {
    const poolId = await publishPool(smallPool());
    const u = await makeUser({ coins: 5000 });
    const hold = await j(await holdRoute(apiRequest('POST', `/api/pools/${poolId}/sets/1/holds`, { token: u.token, body: { ticketNos: [1] } }), ctx({ id: poolId, no: '1' })));
    assert.deepEqual([hold.status, hold.body.error.code], [403, 'TICKET_PICK_DISABLED']);
    const pick = await j(await drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, ticketNos: [1] } }), none));
    assert.deepEqual([pick.status, pick.body.error.code], [403, 'TICKET_PICK_DISABLED']);
    const quote = await quoteRoute(apiRequest('POST', '/api/draws/quote', { token: u.token, body: { poolId, setNo: 1, ticketNos: [1] } }), none);
    assert.equal(quote.status, 403);
    const ok = await drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, count: 5 } }), none);
    assert.equal(ok.status, 201);
    // 管理者可用設定重新開啟舊功能
    process.env.ALLOW_TICKET_PICK = 'true';
    resetConfig();
    try {
      const [t] = await pickTickets(poolId, 1);
      assert.deepEqual((await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: [t!] })).response.ticketNos, [t]);
    } finally {
      process.env.ALLOW_TICKET_PICK = 'false';
      resetConfig();
    }
  });
});
