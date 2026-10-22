import { body, json, requirePrincipal, route } from '@/server/http';
import { createPoolDraft, PoolDraftSchema } from '@/server/modules/pool/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/admin/pools — 建立賞池草稿（獎項、套數、最後賞、保底設定） */
export const POST = route(async (req: Request) => {
  const p = await requirePrincipal(req);
  const b = await body(req, PoolDraftSchema);
  return json(await createPoolDraft(p, b), 201);
});
