import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { deleteLevel, updateLevel, UpdateLevelSchema } from '@/server/modules/pool/structure';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LevelParam = z.coerce.number().int().min(1).max(8);

/** PATCH /api/admin/pools/:id/levels/:levelNo — { name?（隨時可改，留稽核）, isSmall?（只在草稿） } */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string; levelNo: string }>) => {
  const p = await requirePrincipal(req);
  const { id, levelNo } = await ctx.params;
  const b = await body(req, UpdateLevelSchema);
  return json(await updateLevel(p, id, LevelParam.parse(levelNo), b));
});

/** DELETE /api/admin/pools/:id/levels/:levelNo — 刪除等級與其獎項（只在草稿） */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string; levelNo: string }>) => {
  const p = await requirePrincipal(req);
  const { id, levelNo } = await ctx.params;
  return json(await deleteLevel(p, id, LevelParam.parse(levelNo)));
});
