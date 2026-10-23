import { body, json, requirePrincipal, route } from '@/server/http';
import { ReorderSchema, reorderIps } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/ips/reorder — 手動排序：一次送出全部 IP 的順序 { ids }（原子更新；MANUAL 模式時生效） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, ReorderSchema);
  return json(await reorderIps(p, b));
});
