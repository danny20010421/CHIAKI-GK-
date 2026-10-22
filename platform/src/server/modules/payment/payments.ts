import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit, type ActorType } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { flagLargeTopup, recordRiskEvent } from '../risk/risk';
import { buildAioCheckoutParams, generateMerchantTradeNo, verifyCheckMacValue } from './ecpay';
import { ipInList } from '../../security/ip';
import { recordSecurityEvent } from '../../security/events';

export const CheckoutSchema = z.object({
  packageCode: z.string().min(1).max(20),
  choosePayment: z.enum(['ALL', 'Credit', 'ATM']).default('ALL'),
});

function findPackage(code: string) {
  const p = config().topupPackages.find((x) => x.code === code);
  if (!p) throw new AppError('VALIDATION', 'unknown top-up package');
  return p;
}

/** 建立綠界訂單（PENDING）並回傳前端需自動 POST 到綠界的表單參數（含 CheckMacValue）。 */
export async function createEcpayCheckout(userId: string, input: z.input<typeof CheckoutSchema>) {
  const v = CheckoutSchema.parse(input);
  const pkg = findPackage(v.packageCode);
  const c = config();
  const merchantTradeNo = generateMerchantTradeNo();
  const now = new Date();
  const [order] = await db()<{ id: string }[]>`
    INSERT INTO payment_orders (user_id, provider, merchant_trade_no, package_code, amount_twd, coins, bonus_points)
    VALUES (${userId}, 'ECPAY', ${merchantTradeNo}, ${pkg.code}, ${pkg.amountTwd}, ${pkg.coins}, ${pkg.bonusPoints})
    RETURNING id`;
  const params = buildAioCheckoutParams({
    merchantId: c.ECPAY_MERCHANT_ID,
    hashKey: c.ECPAY_HASH_KEY,
    hashIV: c.ECPAY_HASH_IV,
    merchantTradeNo,
    tradeDate: now,
    totalAmount: pkg.amountTwd,
    itemName: `CHIAKI 儲值代幣 ${pkg.coins} 枚`,
    tradeDesc: 'CHIAKI 代幣儲值',
    returnUrl: `${c.APP_BASE_URL}/api/payments/ecpay/notify`,
    clientBackUrl: `${c.APP_BASE_URL}/wallet`,
    choosePayment: v.choosePayment,
  });
  return { orderId: order!.id, merchantTradeNo, action: c.ECPAY_AIO_URL, method: 'POST' as const, params };
}

interface OrderRow {
  id: string;
  userId: string;
  merchantId: string;
  provider: string;
  merchantTradeNo: string;
  amountTwd: number;
  coins: number;
  bonusPoints: number;
  status: string;
}

/** 訂單入帳（綠界通知與銀行轉帳人工對帳共用）。條件式 PENDING→PAID 保證只入帳一次。 */
export async function creditPaidOrder(
  tx: Tx,
  order: OrderRow,
  meta: { providerTradeNo?: string | null; paymentType?: string | null; actorType: ActorType; actorId: string | null },
): Promise<{ credited: boolean; coinsAfter?: number }> {
  const upd = await tx`
    UPDATE payment_orders SET status = 'PAID', provider_trade_no = ${meta.providerTradeNo ?? null},
           payment_type = ${meta.paymentType ?? null}, paid_at = now(), updated_at = now()
    WHERE id = ${order.id} AND status = 'PENDING' RETURNING id`;
  if (upd.length === 0) return { credited: false };
  const { balanceAfter } = await postLedger(tx, {
    userId: order.userId,
    currency: 'COINS',
    amount: order.coins,
    entryType: 'TOPUP',
    refType: 'payment_order',
    refId: order.id,
    merchantId: order.merchantId,
    createdBy: meta.actorType === 'ADMIN' ? meta.actorId : null,
  });
  if (order.bonusPoints > 0) {
    await postLedger(tx, { userId: order.userId, currency: 'POINTS', amount: order.bonusPoints, entryType: 'TOPUP_BONUS', refType: 'payment_order', refId: order.id, merchantId: order.merchantId });
  }
  await flagLargeTopup(tx, order.userId, order.amountTwd, order.id);
  await appendAudit(tx, {
    actorType: meta.actorType,
    actorId: meta.actorId,
    action: 'TOPUP_CREDITED',
    entityType: 'payment_order',
    entityId: order.id,
    merchantId: order.merchantId,
    payload: { provider: order.provider, merchantTradeNo: order.merchantTradeNo, amountTwd: order.amountTwd, coins: order.coins, providerTradeNo: meta.providerTradeNo ?? null },
  });
  return { credited: true, coinsAfter: balanceAfter };
}

export type NotifyOutcome =
  | 'CREDITED'
  | 'DUPLICATE'
  | 'BAD_MAC'
  | 'BAD_MERCHANT'
  | 'UNKNOWN_ORDER'
  | 'AMOUNT_MISMATCH'
  | 'NOT_PAID'
  | 'SIMULATED_IGNORED'
  | 'IP_NOT_ALLOWED'
  | 'STALE'
  | 'REPLAY_MISMATCH';

/** 綠界日期格式 yyyy/MM/dd HH:mm:ss（台灣時間）→ Date */
function parseEcpayDate(s: string | undefined): Date | null {
  const m = s && /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! - 8, +m[5]!, +m[6]!));
}

/**
 * 綠界 ReturnURL 付款結果通知（server-to-server, application/x-www-form-urlencoded）。
 * 防護：來源 IP 允許清單（ECPAY_NOTIFY_IP_ALLOWLIST，選用）→ CheckMacValue（timing-safe）→ 商店代號 →
 *   通知時間新鮮度（ECPAY_NOTIFY_MAX_AGE_HOURS，選用）→ 金額 → 每個 MerchantTradeNo 只入帳一次。
 * 重放防護：同一份已簽章的通知重送 → 冪等（訂單已 PAID → 1|OK 不再入帳）；已入帳訂單收到「不同 TradeNo」的通知
 *   （以舊簽章資料拼湊/重放）→ 拒絕並記錄風控事件。綠界在未收到 1|OK 時會重送，因此重複的合法通知一律回 1|OK。
 */
export async function handleEcpayNotify(rawBody: string, meta: { ip?: string } = {}): Promise<{ body: string; status: number; outcome: NotifyOutcome }> {
  const c = config();
  const params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>;
  const tradeNo = params.MerchantTradeNo ?? null;
  const ip = meta.ip ?? 'unknown';
  if (c.ECPAY_NOTIFY_IP_ALLOWLIST && !ipInList(ip, c.ECPAY_NOTIFY_IP_ALLOWLIST)) {
    await recordSecurityEvent('ECPAY_NOTIFY_REJECTED', { ip, severity: 'HIGH', details: { reason: 'ip_not_allowed', merchantTradeNo: tradeNo } });
    await db()`INSERT INTO payment_notifications (provider, merchant_trade_no, raw_body, mac_valid, outcome)
               VALUES ('ECPAY', ${tradeNo}, ${rawBody.slice(0, 10_000)}, false, 'IP_NOT_ALLOWED')`;
    return { body: '0|Forbidden', status: 403, outcome: 'IP_NOT_ALLOWED' };
  }
  const macValid = verifyCheckMacValue(params, c.ECPAY_HASH_KEY, c.ECPAY_HASH_IV);
  const paidAt = parseEcpayDate(params.PaymentDate);
  const stale = c.ECPAY_NOTIFY_MAX_AGE_HOURS > 0 && (!paidAt || Date.now() - paidAt.getTime() > c.ECPAY_NOTIFY_MAX_AGE_HOURS * 3600_000);

  let result: { body: string; status: number; outcome: NotifyOutcome };
  if (!macValid) {
    await recordSecurityEvent('ECPAY_NOTIFY_REJECTED', { ip, details: { reason: 'bad_mac', merchantTradeNo: tradeNo } });
    result = { body: '0|CheckMacValue Error', status: 400, outcome: 'BAD_MAC' };
  } else if (params.MerchantID !== c.ECPAY_MERCHANT_ID) {
    result = { body: '0|MerchantID Error', status: 400, outcome: 'BAD_MERCHANT' };
  } else if (stale) {
    await recordSecurityEvent('ECPAY_NOTIFY_REJECTED', { ip, details: { reason: 'stale', merchantTradeNo: tradeNo, paymentDate: params.PaymentDate ?? null } });
    result = { body: '0|Stale Notification', status: 400, outcome: 'STALE' };
  } else {
    result = await transaction(async (tx) => {
      const [order] = await tx<OrderRow[]>`
        SELECT id, user_id, merchant_id, provider, merchant_trade_no, amount_twd, coins, bonus_points, status
        FROM payment_orders WHERE merchant_trade_no = ${tradeNo} AND provider = 'ECPAY' FOR UPDATE`;
      if (!order) return { body: '0|Order Not Found', status: 404, outcome: 'UNKNOWN_ORDER' as const };
      if (Number(params.TradeAmt) !== order.amountTwd) {
        await recordRiskEvent(tx, { userId: order.userId, type: 'PAYMENT_MISMATCH', severity: 'HIGH', details: { orderId: order.id, expected: order.amountTwd, got: params.TradeAmt ?? null } });
        return { body: '0|TradeAmt Error', status: 400, outcome: 'AMOUNT_MISMATCH' as const };
      }
      if (order.status === 'PAID') {
        const [o] = await tx<{ providerTradeNo: string | null }[]>`SELECT provider_trade_no FROM payment_orders WHERE id = ${order.id}`;
        if (o?.providerTradeNo && params.TradeNo && o.providerTradeNo !== params.TradeNo) {
          await recordRiskEvent(tx, { userId: order.userId, type: 'PAYMENT_MISMATCH', severity: 'HIGH', details: { orderId: order.id, reason: 'trade_no_mismatch_on_paid_order', got: params.TradeNo } });
          return { body: '0|TradeNo Mismatch', status: 400, outcome: 'REPLAY_MISMATCH' as const };
        }
        return { body: '1|OK', status: 200, outcome: 'DUPLICATE' as const };
      }
      if (params.RtnCode !== '1') {
        await tx`UPDATE payment_orders SET status = 'FAILED', updated_at = now() WHERE id = ${order.id} AND status = 'PENDING'`;
        return { body: '1|OK', status: 200, outcome: 'NOT_PAID' as const };
      }
      if (params.SimulatePaid === '1' && !c.ECPAY_ACCEPT_SIMULATED) {
        return { body: '1|OK', status: 200, outcome: 'SIMULATED_IGNORED' as const };
      }
      const r = await creditPaidOrder(tx, order, { providerTradeNo: params.TradeNo ?? null, paymentType: params.PaymentType ?? null, actorType: 'PROVIDER', actorId: 'ecpay' });
      return { body: '1|OK', status: 200, outcome: r.credited ? ('CREDITED' as const) : ('DUPLICATE' as const) };
    });
  }
  await db()`INSERT INTO payment_notifications (provider, merchant_trade_no, raw_body, mac_valid, outcome)
             VALUES ('ECPAY', ${tradeNo}, ${rawBody}, ${macValid}, ${result.outcome})`;
  return result;
}

/** 銀行轉帳：建立待人工對帳訂單（財務確認入帳需雙人覆核）。 */
export async function createBankTransferOrder(userId: string, input: { packageCode: string; bankLast5?: string }) {
  const pkg = findPackage(input.packageCode);
  if (input.bankLast5 && !/^\d{5}$/.test(input.bankLast5)) throw new AppError('VALIDATION', 'bankLast5 must be 5 digits');
  const tradeNo = generateMerchantTradeNo().replace(/^CK/, 'BT');
  const [o] = await db()<{ id: string }[]>`
    INSERT INTO payment_orders (user_id, provider, merchant_trade_no, package_code, amount_twd, coins, bonus_points, bank_last5)
    VALUES (${userId}, 'BANK_TRANSFER', ${tradeNo}, ${pkg.code}, ${pkg.amountTwd}, ${pkg.coins}, ${pkg.bonusPoints}, ${input.bankLast5 ?? null})
    RETURNING id`;
  return { orderId: o!.id, merchantTradeNo: tradeNo, amountTwd: pkg.amountTwd, status: 'PENDING' as const };
}

/** 由雙人覆核執行：確認銀行轉帳已入帳。 */
export async function executeBankTransferConfirm(tx: Tx, orderId: string, approverId: string): Promise<Record<string, unknown>> {
  const [order] = await tx<OrderRow[]>`
    SELECT id, user_id, merchant_id, provider, merchant_trade_no, amount_twd, coins, bonus_points, status
    FROM payment_orders WHERE id = ${orderId} FOR UPDATE`;
  if (!order) throw new AppError('NOT_FOUND', 'order not found');
  if (order.provider !== 'BANK_TRANSFER') throw new AppError('INVALID_STATE', 'not a bank transfer order');
  if (order.status !== 'PENDING') throw new AppError('INVALID_STATE', `order is ${order.status}`);
  const r = await creditPaidOrder(tx, order, { actorType: 'ADMIN', actorId: approverId, paymentType: 'BANK_TRANSFER' });
  return { orderId, ...r };
}

export async function listPaymentOrders(d: Db, userId: string) {
  return d`SELECT id, provider, merchant_trade_no, package_code, amount_twd, coins, status, created_at, paid_at
           FROM payment_orders WHERE user_id = ${userId} ORDER BY created_at DESC`;
}
