import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { config } from '../src/server/config';
import { computeCheckMacValue, ecpayUrlEncode, formatTradeDate, generateMerchantTradeNo, verifyCheckMacValue } from '../src/server/modules/payment/ecpay';
import { createEcpayCheckout } from '../src/server/modules/payment/payments';
import { POST as notifyRoute } from '../src/app/api/payments/ecpay/notify/route';
import { POST as checkoutRoute } from '../src/app/api/payments/ecpay/checkout/route';
import { reconcileWallets } from '../src/server/modules/wallet/wallet';
import { apiRequest, makeUser, setupTestDb, walletOf } from './helpers';

const KEY = 'pwFHCqoQZGmho4w6';
const IV = 'EkRm7iFT261dpevs';

describe('ECPay CheckMacValue (pure)', () => {
  it('matches the official documented example vector', () => {
    // 綠界技術文件「檢查碼機制」範例（MerchantID 3002607）；亦以官方 Python SDK 演算法交叉驗證
    const params = {
      TradeDesc: '促銷方案',
      PaymentType: 'aio',
      MerchantTradeDate: '2023/03/12 15:30:23',
      MerchantTradeNo: 'ecpay20230312153023',
      MerchantID: '3002607',
      ReturnURL: 'https://www.ecpay.com.tw/receive.php',
      ItemName: 'Apple iphone 15',
      TotalAmount: '30000',
      ChoosePayment: 'ALL',
      EncryptType: '1',
    };
    assert.equal(computeCheckMacValue(params, KEY, IV), '6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840');
  });

  it('.NET-style URL encoding rules', () => {
    assert.equal(ecpayUrlEncode('a b'), 'a+b');
    assert.equal(ecpayUrlEncode("-_.!*()"), '-_.!*()');
    assert.equal(ecpayUrlEncode("'~"), '%27%7E');
    assert.equal(ecpayUrlEncode('&=/:?'), '%26%3D%2F%3A%3F');
    assert.equal(ecpayUrlEncode('代幣'), '%E4%BB%A3%E5%B9%A3');
  });

  it('ignores an existing CheckMacValue, sorts keys case-insensitively, verifies case-insensitively', () => {
    const p = { b: '1', A: '2', c: 'x y' };
    const mac = computeCheckMacValue(p, KEY, IV);
    assert.equal(computeCheckMacValue({ ...p, CheckMacValue: 'junk' }, KEY, IV), mac);
    assert.equal(verifyCheckMacValue({ ...p, CheckMacValue: mac.toLowerCase() }, KEY, IV), true);
    assert.equal(verifyCheckMacValue({ ...p, c: 'x  y', CheckMacValue: mac }, KEY, IV), false);
    assert.equal(verifyCheckMacValue({ ...p }, KEY, IV), false);
  });

  it('MerchantTradeNo ≤ 20 alnum; trade date in Asia/Taipei', () => {
    const no = generateMerchantTradeNo(new Date('2026-10-23T00:00:00Z'));
    assert.match(no, /^CK261023080000[A-Z0-9]{6}$/);
    assert.equal(formatTradeDate(new Date('2026-10-23T16:05:09Z')), '2026/10/24 00:05:09');
  });
});

describe('ECPay checkout + ReturnURL notify (DB)', () => {
  let env: Awaited<ReturnType<typeof setupTestDb>>;
  before(async () => {
    env = await setupTestDb();
  });
  after(async () => {
    await env.teardown();
  });

  function notifyBody(tradeNo: string, amount: number, extra: Record<string, string> = {}, key = KEY, iv = IV) {
    const p: Record<string, string> = {
      MerchantID: '3002607',
      MerchantTradeNo: tradeNo,
      StoreID: '',
      RtnCode: '1',
      RtnMsg: '交易成功',
      TradeNo: '2310231234567890',
      TradeAmt: String(amount),
      PaymentDate: '2026/10/23 12:00:00',
      PaymentType: 'Credit_CreditCard',
      PaymentTypeChargeFee: '25',
      TradeDate: '2026/10/23 11:59:00',
      SimulatePaid: '0',
      CustomField1: '',
      CustomField2: '',
      CustomField3: '',
      CustomField4: '',
      ...extra,
    };
    p.CheckMacValue = computeCheckMacValue(p, key, iv);
    return new URLSearchParams(p).toString();
  }
  const post = (raw: string) => notifyRoute(apiRequest('POST', '/api/payments/ecpay/notify', { rawBody: raw, headers: { 'content-type': 'application/x-www-form-urlencoded' } }));

  it('checkout returns stage form params with a valid CheckMacValue', async () => {
    const u = await makeUser();
    const res = await checkoutRoute(apiRequest('POST', '/api/payments/ecpay/checkout', { token: u.token, body: { packageCode: 'P1000' } }), undefined as never);
    assert.equal(res.status, 201);
    const c = (await res.json()) as { action: string; params: Record<string, string> };
    assert.equal(c.action, 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5');
    assert.equal(c.params.MerchantID, '3002607');
    assert.equal(c.params.TotalAmount, '1000');
    assert.equal(c.params.EncryptType, '1');
    assert.equal(c.params.ReturnURL, `${config().APP_BASE_URL}/api/payments/ecpay/notify`);
    assert.ok(verifyCheckMacValue(c.params, KEY, IV));
  });

  it('valid notify credits coins exactly once (sequential + concurrent duplicates) and replies 1|OK', async () => {
    const u = await makeUser();
    const co = await createEcpayCheckout(u.id, { packageCode: 'P3000' });
    const raw = notifyBody(co.merchantTradeNo, 3000);
    const first = await post(raw);
    assert.equal(first.status, 200);
    assert.equal(await first.text(), '1|OK');
    const again = await Promise.all(Array.from({ length: 8 }, () => post(raw)));
    for (const r of again) assert.equal(await r.text(), '1|OK');
    assert.equal((await walletOf(u.id)).coins, 3000);
    const led = await db()`SELECT amount FROM wallet_ledger WHERE user_id = ${u.id} AND entry_type = 'TOPUP'`;
    assert.equal(led.length, 1);
    const [o] = await db()`SELECT status, provider_trade_no FROM payment_orders WHERE id = ${co.orderId}`;
    assert.deepEqual(o, { status: 'PAID', providerTradeNo: '2310231234567890' });
    const logs = await db()`SELECT outcome FROM payment_notifications WHERE merchant_trade_no = ${co.merchantTradeNo}`;
    assert.equal(logs.filter((l) => l.outcome === 'CREDITED').length, 1);
    assert.equal(logs.filter((l) => l.outcome === 'DUPLICATE').length, 8);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });

  it('concurrent first deliveries still credit once', async () => {
    const u = await makeUser();
    const co = await createEcpayCheckout(u.id, { packageCode: 'P500' });
    const raw = notifyBody(co.merchantTradeNo, 500);
    const rs = await Promise.all(Array.from({ length: 10 }, () => post(raw)));
    for (const r of rs) assert.equal(await r.text(), '1|OK');
    assert.equal((await walletOf(u.id)).coins, 500);
  });

  it('rejects bad CheckMacValue, wrong amount, unknown order; ignores failed & simulated payments', async () => {
    const u = await makeUser();
    const co = await createEcpayCheckout(u.id, { packageCode: 'P1000' });
    const bad = await post(notifyBody(co.merchantTradeNo, 1000, {}, 'wrongKey12345678', IV));
    assert.equal(bad.status, 400);
    assert.equal(await bad.text(), '0|CheckMacValue Error');
    const tampered = notifyBody(co.merchantTradeNo, 1000).replace('TradeAmt=1000', 'TradeAmt=9000');
    assert.equal(await (await post(tampered)).text(), '0|CheckMacValue Error');
    assert.equal(await (await post(notifyBody(co.merchantTradeNo, 999))).text(), '0|TradeAmt Error');
    assert.equal(await (await post(notifyBody('CKNOTEXIST0000000000', 1000))).text(), '0|Order Not Found');
    assert.equal(await (await post(notifyBody(co.merchantTradeNo, 1000, { SimulatePaid: '1' }))).text(), '1|OK');
    assert.equal((await walletOf(u.id)).coins, 0, 'simulated payment must not credit by default');
    const co2 = await createEcpayCheckout(u.id, { packageCode: 'P500' });
    assert.equal(await (await post(notifyBody(co2.merchantTradeNo, 500, { RtnCode: '10100058', RtnMsg: 'fail' }))).text(), '1|OK');
    const [o2] = await db()`SELECT status FROM payment_orders WHERE id = ${co2.orderId}`;
    assert.equal(o2!.status, 'FAILED');
    assert.equal((await walletOf(u.id)).coins, 0);
    const risk = await db()`SELECT type FROM risk_events WHERE user_id = ${u.id}`;
    assert.ok(risk.some((r) => r.type === 'PAYMENT_MISMATCH'));
  });

  it('large top-up is flagged for review (still credited)', async () => {
    const u = await makeUser();
    const co = await createEcpayCheckout(u.id, { packageCode: 'P30000' });
    assert.equal(await (await post(notifyBody(co.merchantTradeNo, 30000))).text(), '1|OK');
    assert.equal((await walletOf(u.id)).coins, 30000);
    const risk = await db()`SELECT type FROM risk_events WHERE user_id = ${u.id}`;
    assert.deepEqual(risk.map((r) => r.type), ['LARGE_TOPUP']);
  });
});
