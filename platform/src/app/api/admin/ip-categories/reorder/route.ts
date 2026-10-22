import { body, json, requirePrincipal, route } from '@/server/http';
import { ReorderSchema, reorderCategories } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/ip-categories/reorder — 原子重排全部分類 { ids } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, ReorderSchema);
  return json(await reorderCategories(p, b));
});
