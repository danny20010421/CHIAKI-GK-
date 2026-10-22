import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';

/**
 * 中獎倉庫。狀態機（資料庫 trigger 同步強制）：
 *   STORED → SHIP_REQUESTED → SHIPPED → DELIVERED
 *   STORED → RECYCLED（轉平台點數，不可逆）
 */
export type ItemStatus = 'STORED' | 'SHIP_REQUESTED' | 'SHIPPED' | 'DELIVERED' | 'RECYCLED';

export interface WarehouseItem {
  id: string;
  source: string;
  poolId: string | null;
  setId: string | null;
  ticketNo: number | null;
  rank: string;
  prizeName: string;
  status: ItemStatus;
  shipmentId: string | null;
  recycledPoints: number | null;
  createdAt: Date;
}

export async function listWarehouse(db: Db, userId: string, status?: ItemStatus): Promise<WarehouseItem[]> {
  return db<WarehouseItem[]>`
    SELECT id, source, pool_id, set_id, ticket_no, rank, prize_name, status, shipment_id, recycled_points, created_at
    FROM warehouse_items WHERE user_id = ${userId} ${status ? db`AND status = ${status}` : db``}
    ORDER BY created_at DESC, id`;
}

export const ItemIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .refine((a) => new Set(a).size === a.length, 'item ids must be unique');

/** 鎖定使用者自己的物品（依 id 排序以固定鎖順序），並要求全部為 STORED。 */
export async function lockStoredItems(tx: Tx, userId: string, itemIds: string[]) {
  const rows = await tx<{ id: string; status: ItemStatus; rank: string; merchantId: string; prizeName: string }[]>`
    SELECT id, status, rank, merchant_id, prize_name FROM warehouse_items
    WHERE id = ANY(${itemIds}::uuid[]) AND user_id = ${userId} ORDER BY id FOR UPDATE`;
  if (rows.length !== itemIds.length) throw new AppError('NOT_FOUND', 'some items not found');
  const bad = rows.filter((r) => r.status !== 'STORED');
  if (bad.length) throw new AppError('INVALID_STATE', '只有「保管中」的獎品可以操作', { items: bad.map((b) => ({ id: b.id, status: b.status })) });
  return rows;
}

/**
 * 回收換平台點數（依賞級費率表；部分賞級不可回收；不可逆）。
 * 點數性質與折算標準待法遵確認。
 */
export async function recycleItems(userId: string, itemIds: string[]): Promise<{ batchId: string; points: number; pointsAfter: number; items: { id: string; rank: string; points: number }[] }> {
  const ids = ItemIdsSchema.parse(itemIds);
  return transaction(async (tx) => {
    const items = await lockStoredItems(tx, userId, ids);
    const rates = await tx<{ merchantId: string; rank: string; points: number; recyclable: boolean }[]>`
      SELECT merchant_id, rank, points, recyclable FROM recycle_rates
      WHERE (merchant_id, rank) IN (SELECT DISTINCT merchant_id, rank FROM warehouse_items WHERE id = ANY(${ids}::uuid[]))`;
    const rateOf = new Map(rates.map((r) => [`${r.merchantId}:${r.rank}`, r]));
    const priced = items.map((i) => {
      const r = rateOf.get(`${i.merchantId}:${i.rank}`);
      if (!r || !r.recyclable) throw new AppError('NOT_RECYCLABLE', `${i.rank} 賞不可回收`, { itemId: i.id, rank: i.rank });
      return { id: i.id, rank: i.rank, points: r.points };
    });
    const total = priced.reduce((s, p) => s + p.points, 0);
    const batchId = randomUUID();
    for (const p of priced) {
      await tx`UPDATE warehouse_items SET status = 'RECYCLED', recycled_points = ${p.points}, recycled_at = now(), updated_at = now() WHERE id = ${p.id}`;
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
      payload: { items: priced, totalPoints: total },
    });
    return { batchId, points: total, pointsAfter, items: priced };
  });
}
