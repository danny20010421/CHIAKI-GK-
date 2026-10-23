import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { config } from '../../config';
import { requirePermission, type Principal } from '../auth/rbac';
import { ProductCategorySchema, resolveBulky, type ProductCategory } from './categories';

/** 直購商城：固定價格、無隨機性。購得商品進入中獎倉庫（source = PURCHASE）沿用出貨流程。 */
export async function listProducts(d: Db) {
  return d`SELECT id, sku, name, ip, source, price_coins, stock, merchant_id, category, bulky FROM products WHERE status = 'ACTIVE' ORDER BY created_at DESC`;
}

export const ProductAttributesSchema = z
  .object({ category: ProductCategorySchema.nullable().optional(), bulky: z.boolean().optional() })
  .refine((v) => v.category !== undefined || v.bulky !== undefined, 'nothing to update');

/** 商城商品屬性：商品分類、大件・限宅配（只改分類時大件依分類預設：GK → 是） */
export async function updateProductAttributes(actor: Principal, productId: string, input: z.input<typeof ProductAttributesSchema>) {
  requirePermission(actor, 'catalog.product.manage');
  const v = ProductAttributesSchema.parse(input);
  return transaction(async (tx) => {
    const [cur] = await tx<{ category: ProductCategory | null; bulky: boolean }[]>`SELECT category, bulky FROM products WHERE id = ${productId} FOR UPDATE`;
    if (!cur) throw new AppError('NOT_FOUND', 'product not found');
    const category = v.category === undefined ? cur.category : v.category;
    const bulky = v.bulky ?? (v.category !== undefined ? resolveBulky(category, undefined) : cur.bulky);
    await tx`UPDATE products SET category = ${category}, bulky = ${bulky} WHERE id = ${productId}`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'PRODUCT_ATTRIBUTES_UPDATED', entityType: 'product', entityId: productId, payload: { before: cur, after: { category, bulky } } });
    return { productId, category, bulky };
  });
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
      await tx`INSERT INTO warehouse_items (merchant_id, user_id, source, product_id, purchase_id, rank, prize_name, storage_expires_at)
               VALUES (${p.merchantId}, ${userId}, 'PURCHASE', ${v.productId}, ${orderId}, NULL, ${p.name},
                       now() + make_interval(days => ${config().STORAGE_FREE_DAYS}))`;
    }
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'PRODUCT_PURCHASED', entityType: 'purchase_order', entityId: orderId, payload: { productId: v.productId, qty: v.qty, amount } });
    return { orderId, amountCoins: amount, coinsAfter: balanceAfter, replayed: false };
  });
}
