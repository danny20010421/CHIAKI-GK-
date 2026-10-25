import { randomUUID } from 'node:crypto';
import { mediaUrl } from '../../lib/media';
import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { displayName } from '../pool/levels';
import type { Tag } from '../catalog/tags';
import type { ShipMethod } from '../shipping/methods';
import { canonicalJson, sha256Hex } from '../../lib/canonical';
import { requirePermission, type Principal } from '../auth/rbac';

/**
 * 中獎倉庫。狀態機（資料庫 trigger 同步強制）：
 *   STORED → SHIP_REQUESTED → SHIPPED → DELIVERED
 *   STORED → RECYCLED（會員回收、寄存到期自動轉換 → 不可退款 UC幣；皆不可逆）
 * 寄存：自入庫起免費保管 STORAGE_FREE_DAYS（預設 30）天，見 storage.ts。
 */
export type ItemStatus = 'STORED' | 'SHIP_REQUESTED' | 'SHIPPED' | 'DELIVERED' | 'RECYCLED';

export interface WarehouseItem {
  id: string;
  source: string;
  poolId: string | null;
  setId: string | null;
  setNo: number | null;
  ticketNo: number | null;
  prizeId: string | null;
  /** 等級 1–12（抽出當下）；最後賞與商城商品為 null */
  levelNo: number | null;
  levelName: string | null;
  /** 是否小獎（等級屬性） */
  isSmall: boolean;
  prizeName: string;
  displayName: string;
  tag: Tag | null;
  bulky: boolean;
  /** 寄送方式（上架時預設，會員不可選擇；直購商品：大件 → 宅配，其餘 → 7-11） */
  shipMethod: ShipMethod;
  imageUrl: string | null;
  status: ItemStatus;
  shipmentId: string | null;
  /** 目前此套此獎項的回收值（UC幣，不可退款） */
  recycleValue: number | null;
  recyclable: boolean;
  recycledCoins: number | null;
  recycleReason: 'USER' | 'STORAGE_EXPIRY' | null;
  storageExpiresAt: Date;
  createdAt: Date;
}

export async function listWarehouse(db: Db, userId: string, status?: ItemStatus): Promise<WarehouseItem[]> {
  const rows = await db<(Omit<WarehouseItem, 'displayName' | 'recyclable'> & { recyclable: boolean | null })[]>`
    SELECT wi.id, wi.source, wi.pool_id, wi.set_id, s.set_no, wi.ticket_no, wi.prize_id, wi.level_no, wi.level_name, wi.is_small, wi.prize_name, wi.status, wi.shipment_id,
           sp.recycle_value, sp.recyclable, wi.recycled_coins, wi.recycle_reason, wi.storage_expires_at, wi.created_at,
           COALESCE(pp.tag, pr.tag) AS tag, COALESCE(pp.bulky, pr.bulky, false) AS bulky, pp.image_url,
           ${ITEM_SHIP_METHOD_SQL(db)} AS ship_method
    FROM warehouse_items wi
    LEFT JOIN pool_prizes pp ON pp.id = wi.prize_id
    LEFT JOIN products pr ON pr.id = wi.product_id
    LEFT JOIN pool_sets s ON s.id = wi.set_id
    LEFT JOIN set_prizes sp ON sp.set_id = wi.set_id AND sp.prize_id = wi.prize_id
    WHERE wi.user_id = ${userId} ${status ? db`AND wi.status = ${status}` : db``}
    ORDER BY wi.created_at DESC, wi.id`;
  return rows.map((r) => ({ ...r, imageUrl: mediaUrl(r.imageUrl), recyclable: r.recyclable ?? false, displayName: displayName(r.levelName, r.prizeName) }));
}

/**
 * 物品的寄送方式（SQL 片段；需 JOIN pool_prizes pp、products pr）：獎項 → 上架時設定；直購商品 → 大件宅配、其餘 7-11。
 * 賞池一有銷售，獎項的寄送方式即鎖定（資料庫 trigger），因此抽到的物品讀到的永遠是抽出當下的設定。
 */
export const ITEM_SHIP_METHOD_SQL = (d: Db | Tx) => d`COALESCE(pp.ship_method, CASE WHEN pr.bulky THEN 'home' ELSE 'c711' END)`;

export const ItemIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .refine((a) => new Set(a).size === a.length, 'item ids must be unique');

/** 鎖定使用者自己的物品（依 id 排序以固定鎖順序），並要求全部為 STORED。 */
export async function lockStoredItems(tx: Tx, userId: string, itemIds: string[]) {
  const rows = await tx<{ id: string; status: ItemStatus; levelNo: number | null; isSmall: boolean; merchantId: string; prizeName: string; setId: string | null; prizeId: string | null; source: string }[]>`
    SELECT id, status, level_no, is_small, merchant_id, prize_name, set_id, prize_id, source FROM warehouse_items
    WHERE id = ANY(${itemIds}::uuid[]) AND user_id = ${userId} ORDER BY id FOR UPDATE`;
  if (rows.length !== itemIds.length) throw new AppError('NOT_FOUND', 'some items not found');
  const bad = rows.filter((r) => r.status !== 'STORED');
  if (bad.length) throw new AppError('INVALID_STATE', '只有「保管中」的獎品可以操作', { items: bad.map((b) => ({ id: b.id, status: b.status })) });
  return rows;
}

export interface RecycleResult {
  batchId: string;
  /** 本次回收入帳的 UC幣（不可退款） */
  coins: number;
  coinsAfter: number;
  items: { id: string; prizeName: string; levelNo: number | null; isSmall: boolean; coins: number }[];
}

const RECYCLE_SCOPE = 'recycle';

/**
 * 會員主動回收 → 不可退款 UC幣（帳本 RECYCLE_CREDIT，不可逆）。回收值依「該套 × 該獎項」的後台設定（set_prizes），
 * recyclable=false 或無設定（例如直購商品）者不可回收。運費到付，回收不涉及任何運費退還。
 * 冪等：可帶 Idempotency-Key（同鍵同內容重送 → 回傳同一結果、不重複入帳）；未帶鍵時，物品狀態機也保證同一件只能回收一次。
 */
export async function recycleItems(userId: string, itemIds: string[], opts: { idempotencyKey?: string | null } = {}): Promise<RecycleResult & { replayed: boolean }> {
  const ids = ItemIdsSchema.parse(itemIds);
  const key = opts.idempotencyKey ?? null;
  const requestHash = sha256Hex(canonicalJson([...ids].sort()));
  return transaction(async (tx) => {
    if (key) {
      const ins = await tx`INSERT INTO idempotency_keys (user_id, scope, key, request_hash) VALUES (${userId}, ${RECYCLE_SCOPE}, ${key}, ${requestHash})
                           ON CONFLICT DO NOTHING RETURNING key`;
      if (!ins.length) {
        const [row] = await tx<{ requestHash: string; responseJson: string | null }[]>`
          SELECT request_hash, response_json FROM idempotency_keys WHERE user_id = ${userId} AND scope = ${RECYCLE_SCOPE} AND key = ${key}`;
        if (!row || row.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
        if (!row.responseJson) throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'request with this key is still in progress');
        return { ...(JSON.parse(row.responseJson) as RecycleResult), replayed: true };
      }
    }
    // 鎖順序：物品 → 錢包 → 稽核
    const items = await lockStoredItems(tx, userId, ids);
    const cfg = await tx<{ id: string; recycleValue: number; recyclable: boolean }[]>`
      SELECT wi.id, sp.recycle_value, sp.recyclable FROM warehouse_items wi
      JOIN set_prizes sp ON sp.set_id = wi.set_id AND sp.prize_id = wi.prize_id
      WHERE wi.id = ANY(${ids}::uuid[])`;
    const cfgOf = new Map(cfg.map((c) => [c.id, c]));
    const priced = items.map((i) => {
      const c = cfgOf.get(i.id);
      if (!c || !c.recyclable) throw new AppError('NOT_RECYCLABLE', `「${i.prizeName}」不可回收`, { itemId: i.id, prizeName: i.prizeName, levelNo: i.levelNo });
      return { id: i.id, prizeName: i.prizeName, levelNo: i.levelNo, isSmall: i.isSmall, coins: c.recycleValue };
    });
    const total = priced.reduce((s, p) => s + p.coins, 0);
    const batchId = randomUUID();
    for (const p of priced) {
      await tx`UPDATE warehouse_items SET status = 'RECYCLED', recycled_coins = ${p.coins}, recycle_reason = 'USER', recycled_at = now(), updated_at = now() WHERE id = ${p.id}`;
    }
    let coinsAfter: number;
    if (total > 0) {
      coinsAfter = (
        await postLedger(tx, { userId, amount: total, entryType: 'RECYCLE_CREDIT', refType: 'recycle_batch', refId: batchId, memo: `回收 ${priced.length} 件（不可退款 UC幣）` })
      ).balanceAfter;
    } else {
      coinsAfter = (await tx<{ coins: number }[]>`SELECT coins FROM wallets WHERE user_id = ${userId}`)[0]!.coins;
    }
    const result: RecycleResult = { batchId, coins: total, coinsAfter, items: priced };
    await appendAudit(tx, {
      actorType: 'USER',
      actorId: userId,
      action: 'ITEMS_RECYCLED',
      entityType: 'recycle_batch',
      entityId: batchId,
      payload: {
        items: priced.map((p) => ({ id: p.id, levelNo: p.levelNo, isSmall: p.isSmall, coins: p.coins })),
        totalCoins: total,
        currency: 'COINS',
        refundable: false,
      },
    });
    if (key) await tx`UPDATE idempotency_keys SET response_json = ${JSON.stringify(result)} WHERE user_id = ${userId} AND scope = ${RECYCLE_SCOPE} AND key = ${key}`;
    return { ...result, replayed: false };
  });
}

export const ExtendStorageSchema = z.object({
  userId: z.string().uuid(),
  days: z.number().int().min(1).max(90),
  itemIds: ItemIdsSchema.optional(),
  reason: z.string().max(500).default(''),
});

/**
 * 延長寄存期限（客服一鍵動作）：會員「保管中」的獎品（或指定物品）到期日延後 N 天，
 * 並重設到期提醒標記與「到期保留」標記，讓新期限仍會收到 7 天前／當日通知。
 */
export async function extendStorage(actor: Principal, input: z.input<typeof ExtendStorageSchema>) {
  requirePermission(actor, 'storage.extend');
  const v = ExtendStorageSchema.parse(input);
  return transaction(async (tx) => {
    const rows = await tx<{ id: string; storageExpiresAt: Date }[]>`
      UPDATE warehouse_items SET storage_expires_at = storage_expires_at + make_interval(days => ${v.days}),
             storage_warned_7d_at = NULL, storage_warned_day_at = NULL, storage_expired_hold_at = NULL, updated_at = now()
      WHERE user_id = ${v.userId} AND status = 'STORED' ${v.itemIds ? tx`AND id = ANY(${v.itemIds}::uuid[])` : tx``}
      RETURNING id, storage_expires_at`;
    if (!rows.length) throw new AppError('INVALID_STATE', '沒有可延長的保管中獎品');
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: 'STORAGE_EXTENDED',
      entityType: 'user',
      entityId: v.userId,
      payload: { days: v.days, itemIds: rows.map((r) => r.id).sort(), reason: v.reason },
    });
    return { userId: v.userId, days: v.days, items: rows.map((r) => ({ id: r.id, storageExpiresAt: r.storageExpiresAt })) };
  });
}
