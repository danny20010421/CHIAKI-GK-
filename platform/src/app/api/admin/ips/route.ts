import { body, json, query, requirePrincipal, route } from '@/server/http';
import { createIp, IpCreateSchema, listIpsAdmin } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/ips?category=&q= — 全部 IP（含隱藏）、連結賞池數，依目前排序模式 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const q = query(req);
  return json(await listIpsAdmin(p, { category: (q.get('category') ?? undefined) as never, q: q.get('q') ?? undefined }));
});

/** POST /api/admin/ips — 新增 IP { slug, name, category?, aliases?, visible?, coverUrl? } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, IpCreateSchema);
  return json(await createIp(p, b), 201);
});
