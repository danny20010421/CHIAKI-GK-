import { z } from 'zod';
import { body, json, requirePrincipal, route, type RouteContext } from '@/server/http';
import { deleteIp, updateIp, IpUpdateSchema } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** PATCH /api/admin/ips/:id — 修改 IP { slug?, name?, category?, aliases?, visible?, coverUrl? } */
export const PATCH = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  const b = await body(req, IpUpdateSchema);
  return json(await updateIp(p, z.string().uuid().parse(id), b));
});

/** DELETE /api/admin/ips/:id — 刪除 IP（仍有賞池連結 → 409，請改為隱藏） */
export const DELETE = route(async (req: Request, ctx: RouteContext<{ id: string }>) => {
  const p = await requirePrincipal(req);
  const { id } = await ctx.params;
  return json(await deleteIp(p, z.string().uuid().parse(id)));
});
