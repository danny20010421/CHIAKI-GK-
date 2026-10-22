import { body, json, requirePrincipal, route } from '@/server/http';
import { createIp, IpCreateSchema, listIpsAdmin } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/ips — 全部 IP（含隱藏）與連結賞池數 */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ ips: await listIpsAdmin(p) });
});

/** POST /api/admin/ips — 新增 IP { slug, name, categoryId?, visible?, coverUrl? } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, IpCreateSchema);
  return json(await createIp(p, b), 201);
});
