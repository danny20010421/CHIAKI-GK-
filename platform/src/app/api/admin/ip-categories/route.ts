import { body, json, requirePrincipal, route } from '@/server/http';
import { CategoryCreateSchema, createCategory, listCategories } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/ip-categories — IP 分類（動畫/遊戲/漫畫/原創…） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ categories: await listCategories(p) });
});

/** POST /api/admin/ip-categories — 新增分類 { code, name, visible? } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, CategoryCreateSchema);
  return json(await createCategory(p, b), 201);
});
