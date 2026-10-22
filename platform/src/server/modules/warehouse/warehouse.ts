import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { displayName, type Grade } from '../pool/grades';

/**
 * 中獎倉庫。狀態機（資料庫 trigger 同步強制）：
 *   STORED → SHIP_REQUESTED → SHIPPED → DELIVERED
 *   STORED → RECYCLED（會員回收 → 平台點數；寄存到期自動轉換 → 代幣；皆不可逆）
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
  rank: string | null;
  grade: Grade | null;
  prizeName: string;
  displayName: string;
  status: ItemStatus;
  shipmentId: string | null;
  /** 目前此套此獎項的回收值（會員回收＝點數；到期自動轉換＝代幣） */
  recycleValue: number | null;
  recyclable: boolean;
  recycledPoints: number | null;
  recycledCoins: number | null;
  recycleReason: 'USER' | 'STORAGE_EXPIRY' | null;
  storageExpiresAt: Date;
  createdAt: Date;
}

export async function listWarehouse(db: Db, userId: string, status?: ItemStatus): Promise<WarehouseItem[]> {
  const rows = await db<(Omit<WarehouseItem, 'displayName' | 'recyclable'> & { poolSource: string | null; recyclable: boolean | null })[]>`
    SELECT wi.id, wi.source, wi.pool_id, wi.set_id, s.set_no, wi.ticket_no, wi.prize_id, wi.rank, wi.grade, wi.prize_name, wi.status, wi.shipment_id,
           sp.recycle_value, sp.recyclable, wi.recycled_points, wi.recycled_coins, wi.recycle_reason, wi.storage_expires_at, wi.created_at,
           p.source AS pool_source
    FROM warehouse_items wi
    LEFT JOIN pools p ON p.id = wi.pool_id
    LEFT JOIN pool_sets s ON s.id = wi.set_id
    LEFT JOIN set_prizes sp ON sp.set_id = wi.set_id AND sp.prize_id = wi.prize_id
    WHERE wi.user_id = ${userId} ${status ? db`AND wi.status = ${status}` : db``}
    ORDER BY wi.created_at DESC, wi.id`;
  return rows.map(({ poolSource, ...r }) => ({ ...r, recyclable: r.recyclable ?? false, displayName: displayName(poolSource, r.rank, r.prizeName) }));
}

export const ItemIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .refine((a) => new Set(a).size === a.length, 'item ids must be unique');

/** 鎖定使用者自己的物品（依 id 排序以固定鎖順序），並要求全部為 STORED。 */
export async function lockStoredItems(tx: Tx, userId: string, itemIds: string[]) {
  const rows = await tx<{ id: string; status: ItemStatus; rank: string | null; grade: Grade | null; merchantId: string; prizeName: string; setId: string | null; prizeId: string | null; source: string }[]>`
    SELECT id, status, rank, grade, merchant_id, prize_name, set_id, prize_id, source FROM warehouse_items
    WHERE id = ANY(${itemIds}::uuid[]) AND user_id = ${userId} ORDER BY id FOR UPDATE`;
  if (rows.length !== itemIds.length) throw new AppError('NOT_FOUND', 'some items not found');
  const bad = rows.filter((r) => r.status !== 'STORED');
  if (bad.length) throw new AppError('INVALID_STATE', '只有「保管中」的獎品可以操作', { items: bad.map((b) => ({ id: b.id, status: b.status })) });
  return rows;
}

/**
 * 會員主動回收 → 平台點數（不可逆）。回收值依「該套 × 該獎項」的後台設定（set_prizes），
 * recyclable=false 或無設定（例如直購商品）者不可回收。點數性質與折算標準待法遵確認。
 */
export async function recycleItems(userId: string, itemIds: string[]): Promise<{ batchId: string; points: number; pointsAfter: number; items: { id: string; prizeName: string; grade: Grade | null; points: number }[] }> {
  const ids = ItemIdsSchema.parse(itemIds);
  return transaction(async (tx) => {
    const items = await lockStoredItems(tx, userId, ids);
    const cfg = await tx<{ id: string; recycleValue: number; recyclable: boolean }[]>`
      SELECT wi.id, sp.recycle_value, sp.recyclable FROM warehouse_items wi
      JOIN set_prizes sp ON sp.set_id = wi.set_id AND sp.prize_id = wi.prize_id
      WHERE wi.id = ANY(${ids}::uuid[])`;
    const cfgOf = new Map(cfg.map((c) => [c.id, c]));
    const priced = items.map((i) => {
      const c = cfgOf.get(i.id);
      if (!c || !c.recyclable) throw new AppError('NOT_RECYCLABLE', `「${i.prizeName}」不可回收`, { itemId: i.id, prizeName: i.prizeName, grade: i.grade });
      return { id: i.id, prizeName: i.prizeName, grade: i.grade, points: c.recycleValue };
    });
    const total = priced.reduce((s, p) => s + p.points, 0);
    const batchId = randomUUID();
    for (const p of priced) {
      await tx`UPDATE warehouse_items SET status = 'RECYCLED', recycled_points = ${p.points}, recycle_reason = 'USER', recycled_at = now(), updated_at = now() WHERE id = ${p.id}`;
    }
    let pointsAfter: number;
    if (total > 0) {
      pointsAfter = (await postLedger(tx, { userId, currency: 'POINTS', amount: total, entryType: 'RECYCLE_CREDIT', refType: 'recycle_batch', refId: batchId })).balanceAfter;
    } else {
      pointsAfter = (await tx<{ points: number }[]>`SELECT points FROM wallets WHERE user_id = ${userId}`)[0]!.points;
    }
    await appendAudit(tx, {
      actorType: 'USER',
      actorId: userId,
      action: 'ITEMS_RECYCLED',
      entityType: 'recycle_batch',
      entityId: batchId,
      payload: { items: priced.map((p) => ({ id: p.id, grade: p.grade, points: p.points })), totalPoints: total },
    });
    return { batchId, points: total, pointsAfter, items: priced };
  });
}
