import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction } from '../../db';
import { appendAudit } from '../audit/audit';
import { displayName } from '../pool/levels';
import { getWallet, postLedger } from '../wallet/wallet';

/**
 * 抽賞結果「轉換 UC幣」（抽完當下在結果畫面勾選獎品 → 依回收值換成不可退款 UC幣）。
 *
 *  - 只能轉換「本人、本筆抽賞、保管中（STORED）、可回收」的獎品；回收值依「該套 × 該獎項」設定（set_prizes）。
 *  - 冪等（逐件）：已轉換／已回收（RECYCLED）的獎品略過並列於 alreadyConverted，不重複入帳；重送同一請求 → 200、totalCoins 0。
 *    已申請出貨／已出貨 → 409 INVALID_STATE；不可回收 → 422 NOT_RECYCLABLE；不屬於本人或不屬於本筆抽賞 → 404 NOT_FOUND
 *    （任一件不符 → 整筆不處理）。
 *  - 一次請求只寫一筆帳本（RECYCLE_CREDIT，ref_type draw_convert，不可退款）；並發重送以物品列鎖序列化（後到者讀到 RECYCLED → 略過）。
 *  - 鎖順序：抽賞 → 物品（依 id）→ 錢包 → 稽核，與一般回收一致。
 */
export const ConvertRequestSchema = z.object({
  itemIds: z
    .array(z.string().uuid())
    .min(1)
    .max(300)
    .refine((a) => new Set(a).size === a.length, 'item ids must be unique'),
});

export interface ConvertResult {
  drawId: string;
  batchId: string | null;
  converted: { itemId: string; prizeName: string; displayName: string; levelNo: number | null; coins: number }[];
  /** 先前已轉換／回收的獎品（本次未入帳） */
  alreadyConverted: string[];
  /** 本次入帳的不可退款 UC幣 */
  totalCoins: number;
  coins: number;
  refundableCoins: number;
  nonRefundableCoins: number;
  refundable: false;
}

export async function convertDrawItems(userId: string, drawId: string, input: z.input<typeof ConvertRequestSchema>): Promise<ConvertResult> {
  const { itemIds } = ConvertRequestSchema.parse(input);
  return transaction(async (tx) => {
    const [d] = await tx<{ id: string; merchantId: string }[]>`SELECT id, merchant_id FROM draws WHERE id = ${drawId} AND user_id = ${userId}`;
    if (!d) throw new AppError('NOT_FOUND', 'draw not found');
    const items = await tx<{ id: string; status: string; levelNo: number | null; levelName: string | null; isSmall: boolean; prizeName: string; recycleValue: number | null; recyclable: boolean | null }[]>`
      SELECT wi.id, wi.status, wi.level_no, wi.level_name, wi.is_small, wi.prize_name, sp.recycle_value, sp.recyclable
      FROM warehouse_items wi LEFT JOIN set_prizes sp ON sp.set_id = wi.set_id AND sp.prize_id = wi.prize_id
      WHERE wi.id = ANY(${itemIds}::uuid[]) AND wi.user_id = ${userId} AND wi.draw_id = ${drawId}
      ORDER BY wi.id FOR UPDATE OF wi`;
    if (items.length !== itemIds.length) {
      const found = new Set(items.map((i) => i.id));
      throw new AppError('NOT_FOUND', '找不到這筆抽賞的部分獎品', { itemIds: itemIds.filter((x) => !found.has(x)) });
    }
    const already = items.filter((i) => i.status === 'RECYCLED').map((i) => i.id);
    const pending = items.filter((i) => i.status !== 'RECYCLED');
    const shipped = pending.filter((i) => i.status !== 'STORED');
    if (shipped.length) throw new AppError('INVALID_STATE', '已申請出貨的獎品不能轉換', { items: shipped.map((i) => ({ id: i.id, status: i.status })) });
    const bad = pending.filter((i) => !i.recyclable);
    if (bad.length) throw new AppError('NOT_RECYCLABLE', `「${bad[0]!.prizeName}」不可轉換`, { itemIds: bad.map((i) => i.id) });

    const converted = pending.map((i) => ({ itemId: i.id, prizeName: i.prizeName, displayName: displayName(i.levelName, i.prizeName), levelNo: i.levelNo, coins: i.recycleValue ?? 0 }));
    const total = converted.reduce((a, c) => a + c.coins, 0);
    const batchId = converted.length ? randomUUID() : null;
    if (converted.length) {
      await tx`
        UPDATE warehouse_items wi SET status = 'RECYCLED', recycled_coins = u.coins, recycle_reason = 'USER', recycled_at = now(), updated_at = now()
        FROM unnest(${converted.map((c) => c.itemId)}::uuid[], ${converted.map((c) => c.coins)}::int[]) AS u(id, coins)
        WHERE wi.id = u.id AND wi.status = 'STORED'`;
    }
    if (total > 0) {
      await postLedger(tx, {
        userId,
        amount: total,
        entryType: 'RECYCLE_CREDIT',
        refType: 'draw_convert',
        refId: batchId!,
        merchantId: d.merchantId,
        memo: `抽賞結果轉換 ${converted.length} 件 → ${total} UC幣（不可退款）`,
      });
    }
    if (batchId) {
      await appendAudit(tx, {
        actorType: 'USER',
        actorId: userId,
        action: 'ITEMS_RECYCLED',
        entityType: 'recycle_batch',
        entityId: batchId,
        merchantId: d.merchantId,
        payload: { via: 'DRAW_RESULT', drawId, items: converted.map((c) => ({ id: c.itemId, levelNo: c.levelNo, coins: c.coins })), totalCoins: total, currency: 'COINS', refundable: false },
      });
    }
    const w = await getWallet(tx, userId);
    return { drawId, batchId, converted, alreadyConverted: already, totalCoins: total, coins: w.coins, refundableCoins: w.refundableCoins, nonRefundableCoins: w.nonRefundableCoins, refundable: false };
  });
}
