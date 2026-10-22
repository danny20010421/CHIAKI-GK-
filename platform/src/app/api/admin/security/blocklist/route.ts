import { body, json, requirePrincipal, route } from '@/server/http';
import { addBlock, BlockSchema, listBlocks } from '@/server/security/blocklist';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/admin/security/blocklist — 封鎖清單（IP / 裝置指紋） */
export const GET = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  return json({ entries: await listBlocks(p) });
});

/** POST /api/admin/security/blocklist — 新增封鎖 { kind: IP|DEVICE, value, reason?, expiresInMinutes? } */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, BlockSchema);
  return json(await addBlock(p, b), 201);
});
