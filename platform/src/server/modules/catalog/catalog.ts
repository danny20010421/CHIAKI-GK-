import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';

/** 直購商城：固定價格、無隨機性。購得商品進入中獎倉庫（source = PURCHASE）沿用出貨流程。 */
export async function listProducts(d: Db) {
  return d`SELECT id, sku, name, ip, source, price_coins, stock, merchant_id FROM products WHERE status = 'ACTIVE' ORDER BY created_at DESC`;
}

export const PurchaseSchema = z.object({ productId: z.string().uuid(), qty: z.number().int().min(1).max(20) });

export async function purchaseProduct(userId: string, idempotencyKey: string, input: z.input<typeof PurchaseSchema>) {
  const v = PurchaseSchema.parse(input);
  return transaction(async (tx) => {
    const orderId = randomUUID();
    const ins = await tx`
      INSERT INTO purchase_orders (id, user_id, product_id, qty, unit_price, amount_coins, idempotency_key, merchant_id)
      SELECT ${orderId}, ${userId}, p.id, ${v.qty}, p.price_coins, p.price_coins * ${v.qty}, ${idempotencyKey}, p.merchant_id
      FROM products p WHERE p.id = ${v.productId}
      ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`;
    if (!ins.length) {
      const [prev] = await tx<{ id: string; productId: string; qty: number; amountCoins: number }[]>`
        SELECT id, product_id, qty, amount_coins FROM purchase_orders WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey}`;
      if (!prev) throw new AppError('NOT_FOUND', 'product not found');
      if (prev.productId !== v.productId || prev.qty !== v.qty) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
      return { orderId: prev.id, amountCoins: prev.amountCoins, replayed: true };
    }
    const [p] = await tx<{ priceCoins: number; name: string; merchantId: string }[]>`
      UPDATE products SET stock = stock - ${v.qty} WHERE id = ${v.productId} AND status = 'ACTIVE' AND stock >= ${v.qty}
      RETURNING price_coins, name, merchant_id`;
    if (!p) throw new AppError('CONFLICT', '庫存不足或商品已下架');
    const amount = p.priceCoins * v.qty;
    const { balanceAfter } = await postLedger(tx, { userId, currency: 'COINS', amount: -amount, entryType: 'PURCHASE_DEBIT', refType: 'purchase_order', refId: orderId, merchantId: p.merchantId });
    for (let i = 0; i < v.qty; i++) {
      await tx`INSERT INTO warehouse_items (merchant_id, user_id, source, product_id, purchase_id, rank, prize_name)
               VALUES (${p.merchantId}, ${userId}, 'PURCHASE', ${v.productId}, ${orderId}, 'SHOP', ${p.name})`;
    }
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'PRODUCT_PURCHASED', entityType: 'purchase_order', entityId: orderId, payload: { productId: v.productId, qty: v.qty, amount } });
    return { orderId, amountCoins: amount, coinsAfter: balanceAfter, replayed: false };
  });
}
