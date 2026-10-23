import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { AddressUpdateSchema, deleteAddress, updateAddress } from '@/server/modules/member/profile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/me/addresses/:id — 修改收件資訊（isDefault: true 設為預設） */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await updateAddress(p.userId, z.string().uuid().parse(id), await body(req, AddressUpdateSchema)));
});

/** DELETE /api/me/addresses/:id — 刪除（刪除預設者時，最新的一筆自動成為預設） */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await deleteAddress(p.userId, z.string().uuid().parse(id)));
});
