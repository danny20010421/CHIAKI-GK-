import { randomUUID } from 'node:crypto';
import { config } from '../../config';
import { db, transaction } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { notifyEvent } from '../notifications/outbox';
import { lockUserSetShipping, refundRecycledSmallItems } from '../shipping/prepaid';

/**
 * 寄存期限掃描（排程工作；可重複執行、可並行執行 → 結果冪等）。
 *
 * 規則（業主 2026-10）：
 *  - 獎品自入庫起免費寄存 STORAGE_FREE_DAYS（預設 30）天（到期時間於入庫時寫入 storage_expires_at）。
 *  - 到期前 STORAGE_WARN_DAYS_BEFORE（預設 7）天、以及到期當日（以台灣日期計）各發一次站內通知。
 *  - 到期後仍為「保管中」的獎品，依「該套 × 該獎項」回收值自動回收，並以「代幣 COINS」入帳
 *    （帳本類型 EXPIRY_AUTO_CONVERT，另寫稽核紀錄與通知）。
 *  - 後台設定為「不可回收」的獎品（或沒有回收設定的直購商品）不自動轉換：標記並通知，留待客服處理。
 *
 * 業主規則：到期轉換的代幣一律「不可退款・無法轉換」（wallet_ledger.refundable = false，不計入可退款餘額；
 *   舊的 EXPIRY_COINS_REFUNDABLE 開關已移除）。以可退款代幣支付獎品價值會讓獎品可經由退款兌換現金，
 *   可能使付費抽賞被認定為賭博或違法有獎銷售。
 * 轉換的可回收小獎每件另退還 運費 ÷ N 代幣（不可退款；見 shipping/prepaid.ts refundRecycledSmallItems）。
 *
 * 冪等性：每一步都以「條件式更新 + 列鎖」完成（狀態必須仍為 STORED、通知標記必須仍為 NULL），
 * 第二次（或同時）執行不會重複入帳或重複通知；通知另有 dedupe_key 唯一索引。
 */
export interface StorageSweepResult {
  autoConverted: number;
  coinsCredited: number;
  expiredHeld: number;
  warnedToday: number;
  warned7d: number;
  notifications: number;
  /** 逐件運費退還（每件小獎 運費 ÷ N）合計代幣 */
  shippingRefundCoins: number;
}

const TZ = 'Asia/Taipei';

export async function runStorageSweep(now: Date = new Date()): Promise<StorageSweepResult> {
  const c = config();
  const result: StorageSweepResult = { autoConverted: 0, coinsCredited: 0, expiredHeld: 0, warnedToday: 0, warned7d: 0, notifications: 0, shippingRefundCoins: 0 };

  // ── 1. 到期：自動轉代幣（可回收者）或標記保留（不可回收者）。每位會員一個交易。
  const users = await db()<{ userId: string }[]>`
    SELECT DISTINCT wi.user_id FROM warehouse_items wi
    LEFT JOIN set_prizes sp ON sp.set_id = wi.set_id AND sp.prize_id = wi.prize_id
    WHERE wi.status = 'STORED' AND wi.storage_expires_at <= ${now}
      AND (wi.storage_expired_hold_at IS NULL OR sp.recyclable)`;
  for (const { userId } of users) {
    const r = await transaction(async (tx) => {
      // 鎖定順序與會員回收/出貨相同：物品（依 id）→ 錢包 → 稽核
      const items = await tx<{ id: string; merchantId: string; prizeName: string; isSmall: boolean; levelNo: number | null; setId: string | null; recycleValue: number | null; recyclable: boolean | null; heldAt: Date | null; expiresAt: Date }[]>`
        SELECT wi.id, wi.merchant_id, wi.prize_name, wi.is_small, wi.level_no, wi.set_id, sp.recycle_value, sp.recyclable,
               wi.storage_expired_hold_at AS held_at, wi.storage_expires_at AS expires_at
        FROM warehouse_items wi
        LEFT JOIN set_prizes sp ON sp.set_id = wi.set_id AND sp.prize_id = wi.prize_id
        WHERE wi.user_id = ${userId} AND wi.status = 'STORED' AND wi.storage_expires_at <= ${now}
        ORDER BY wi.id
        FOR UPDATE OF wi`;
      const convert = items.filter((i) => i.recyclable === true);
      const hold = items.filter((i) => i.recyclable !== true && i.heldAt === null);
      const out = { converted: 0, coins: 0, held: 0, notifications: 0, refundCoins: 0 };

      if (convert.length) {
        const batchId = randomUUID();
        // 鎖順序：物品 → 運費 advisory lock（依 setId 排序）→ 錢包 → 稽核（與抽賞的 set → advisory → wallet 一致，避免死結）
        const smallSets = [...new Set(convert.filter((i) => i.isSmall && i.setId).map((i) => i.setId!))].sort();
        for (const sid of smallSets) await lockUserSetShipping(tx, userId, sid);
        for (const i of convert) {
          await tx`UPDATE warehouse_items SET status = 'RECYCLED', recycled_coins = ${i.recycleValue!}, recycle_reason = 'STORAGE_EXPIRY',
                          recycled_at = ${now}, updated_at = now()
                   WHERE id = ${i.id}`;
        }
        const total = convert.reduce((s, i) => s + i.recycleValue!, 0);
        let coinsAfter: number | null = null;
        if (total > 0) {
          coinsAfter = (
            await postLedger(tx, {
              userId,
              currency: 'COINS',
              amount: total,
              entryType: 'EXPIRY_AUTO_CONVERT',
              refType: 'storage_expiry_batch',
              refId: batchId,
              merchantId: convert[0]!.merchantId,
              // 業主規則：一律不可退款（postLedger 對 EXPIRY_AUTO_CONVERT 強制 refundable=false）
              memo: `寄存到期自動轉換 ${convert.length} 件`,
            })
          ).balanceAfter;
        }
        const payloadItems = convert.map((i) => ({ id: i.id, prizeName: i.prizeName, levelNo: i.levelNo, coins: i.recycleValue! }));
        if (
          (
            await notifyEvent(tx, {
              userId,
              event: 'STORAGE_AUTO_CONVERTED',
              data: { count: convert.length, totalCoins: total },
              payload: { batchId, items: payloadItems, totalCoins: total, refundable: false },
              dedupeOn: { batch: convert.map((i) => i.id).sort() },
            })
          ).inApp
        ) out.notifications++;
        // 到期轉換的可回收小獎同樣逐件退還運費（運費 ÷ N，不可退款代幣）
        const unitsBySet = new Map<string, number>();
        for (const i of convert) if (i.isSmall && i.setId) unitsBySet.set(i.setId, (unitsBySet.get(i.setId) ?? 0) + 1);
        const fr = await refundRecycledSmallItems(tx, userId, unitsBySet, { type: 'STORAGE_EXPIRY', id: batchId });
        out.refundCoins = fr.refunds.reduce((a, r) => a + r.amount, 0);
        if (out.refundCoins > 0) {
          coinsAfter = fr.coinsAfter ?? coinsAfter;
          await notifyEvent(tx, {
            userId,
            event: 'SHIPPING_FEE_REFUND',
            data: { count: fr.refunds.reduce((a, r) => a + r.units, 0), coins: out.refundCoins },
            payload: { refunds: fr.refunds },
            dedupeOn: { expiryBatch: batchId },
          });
        }
        await appendAudit(tx, {
          actorType: 'SYSTEM',
          actorId: 'storage-sweep',
          action: 'STORAGE_EXPIRY_AUTO_CONVERT',
          entityType: 'storage_expiry_batch',
          entityId: batchId,
          merchantId: convert[0]!.merchantId,
          payload: { userId, items: payloadItems.map(({ id, coins }) => ({ id, coins })), totalCoins: total, currency: 'COINS', refundable: false, shippingRefundCoins: out.refundCoins, coinsAfter, sweepAt: now.toISOString() },
        });
        out.converted = convert.length;
        out.coins = total;
      }

      if (hold.length) {
        await tx`UPDATE warehouse_items SET storage_expired_hold_at = ${now}, updated_at = now() WHERE id = ANY(${hold.map((i) => i.id)}::uuid[])`;
        if (
          (
            await notifyEvent(tx, {
              userId,
              event: 'STORAGE_EXPIRED_HOLD',
              data: { count: hold.length },
              payload: { items: hold.map((i) => ({ id: i.id, prizeName: i.prizeName, levelNo: i.levelNo })) },
              dedupeOn: { hold: hold.map((i) => i.id).sort() },
            })
          ).inApp
        ) out.notifications++;
        await appendAudit(tx, {
          actorType: 'SYSTEM',
          actorId: 'storage-sweep',
          action: 'STORAGE_EXPIRED_HOLD',
          entityType: 'user',
          entityId: userId,
          payload: { itemIds: hold.map((i) => i.id).sort(), sweepAt: now.toISOString() },
        });
        out.held = hold.length;
      }
      return out;
    });
    result.autoConverted += r.converted;
    result.coinsCredited += r.coins;
    result.expiredHeld += r.held;
    result.notifications += r.notifications;
    result.shippingRefundCoins += r.refundCoins;
  }

  // ── 2. 到期當日通知（台灣日期）；同時視為已發過 7 天前通知（避免補發過時提醒）
  // ── 3. 到期前 N 天通知
  for (const kind of ['TODAY', '7D'] as const) {
    const r = await transaction(async (tx) => {
      const rows =
        kind === 'TODAY'
          ? await tx<{ id: string; userId: string; merchantId: string; prizeName: string; expiresAt: Date }[]>`
              UPDATE warehouse_items SET storage_warned_day_at = ${now}, storage_warned_7d_at = COALESCE(storage_warned_7d_at, ${now})
              WHERE id IN (
                SELECT id FROM warehouse_items
                WHERE status = 'STORED' AND storage_warned_day_at IS NULL AND storage_expires_at > ${now}
                  AND (${now}::timestamptz AT TIME ZONE ${TZ})::date >= (storage_expires_at AT TIME ZONE ${TZ})::date
                ORDER BY id FOR UPDATE SKIP LOCKED)
                AND status = 'STORED' AND storage_warned_day_at IS NULL
              RETURNING id, user_id, merchant_id, prize_name, storage_expires_at AS expires_at`
          : await tx<{ id: string; userId: string; merchantId: string; prizeName: string; expiresAt: Date }[]>`
              UPDATE warehouse_items SET storage_warned_7d_at = ${now}
              WHERE id IN (
                SELECT id FROM warehouse_items
                WHERE status = 'STORED' AND storage_warned_7d_at IS NULL AND storage_expires_at > ${now}
                  AND (${now}::timestamptz AT TIME ZONE ${TZ})::date >= (storage_expires_at AT TIME ZONE ${TZ})::date - ${c.STORAGE_WARN_DAYS_BEFORE}::int
                ORDER BY id FOR UPDATE SKIP LOCKED)
                AND status = 'STORED' AND storage_warned_7d_at IS NULL
              RETURNING id, user_id, merchant_id, prize_name, storage_expires_at AS expires_at`;
      const byUser = new Map<string, (typeof rows)[number][]>();
      for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
      let sent = 0;
      for (const [userId, list] of byUser) {
        const earliest = list.reduce((a, b) => (a.expiresAt < b.expiresAt ? a : b)).expiresAt;
        const day = new Date(earliest.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
        const { inApp } = await notifyEvent(tx, {
          userId,
          merchantId: list[0]!.merchantId,
          event: kind === 'TODAY' ? 'STORAGE_EXPIRY_TODAY' : 'STORAGE_EXPIRY_7D',
          data: { count: list.length, day, warnDays: c.STORAGE_WARN_DAYS_BEFORE },
          payload: { items: list.map((i) => ({ id: i.id, prizeName: i.prizeName, expiresAt: i.expiresAt.toISOString() })) },
          dedupeOn: { items: list.map((i) => i.id).sort() },
        });
        if (inApp) sent++;
      }
      return { items: rows.length, sent };
    });
    if (kind === 'TODAY') result.warnedToday += r.items;
    else result.warned7d += r.items;
    result.notifications += r.sent;
  }
  return result;
}
