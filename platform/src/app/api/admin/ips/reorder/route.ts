import { body, json, requirePrincipal, route } from '@/server/http';
import { IpReorderSchema, reorderIps } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/ips/reorder — 原子重排某分類下全部 IP { categoryId | null, ids } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, IpReorderSchema);
  return json(await reorderIps(p, b));
});
