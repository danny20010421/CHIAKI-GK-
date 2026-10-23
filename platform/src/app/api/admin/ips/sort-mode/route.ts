import { db } from '@/server/db';
import { body, json, requirePrincipal, route } from '@/server/http';
import { requirePermission } from '@/server/modules/auth/rbac';
import { getSortMode, setSortMode, SortModeSchema } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/ips/sort-mode — 目前 IP 排序模式（AUTO：依名稱字數再依中文排序；MANUAL：手動） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  requirePermission(p, 'catalog.ip.manage');
  return json({ sortMode: await getSortMode(db()) });
});

/** PUT /api/admin/ips/sort-mode — { sortMode: AUTO | MANUAL } */
export const PUT = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, SortModeSchema);
  return json(await setSortMode(p, b));
});
