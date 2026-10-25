import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { convertDrawItems, ConvertRequestSchema } from '@/server/modules/draw/convert';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/me/draws/:drawId/convert — 抽賞結果畫面「轉換 UC幣」：{ itemIds: uuid[] }（DrawResponse.results[].warehouseItemId）
 * → 200 { drawId, batchId|null, converted: [{ itemId, prizeName, displayName, levelNo, coins }], alreadyConverted: uuid[], totalCoins,
 *        coins, refundableCoins, nonRefundableCoins, refundable: false }
 * 依回收值入帳不可退款 UC幣（不可逆）。已轉換的獎品略過（重送安全）；已申請出貨 409 INVALID_STATE、不可回收 422 NOT_RECYCLABLE、
 * 非本人或非本筆抽賞的獎品 404 NOT_FOUND（整筆不處理）。
 */
export const POST = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await convertDrawItems(p.userId, z.string().uuid().parse(id), await body(req, ConvertRequestSchema)));
});
