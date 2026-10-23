import { z } from 'zod';
import { db } from '@/server/db';
import { json, query, route } from '@/server/http';
import { listPools } from '@/server/modules/pool/queries';
import { TagSchema } from '@/server/modules/catalog/tags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Filter = z.object({
  source: z.enum(['OFFICIAL', 'CUSTOM', 'MIXED']).optional(),
  playType: z.enum(['STANDARD', 'GUARANTEE', 'SOLO']).optional(),
  ipId: z.string().uuid().optional(),
  tag: TagSchema.optional(),
});

/** GET /api/pools?source=&playType=&ipId=&tag= — 公開賞池列表（含目前開賣中的套與剩餘數、標籤、快速抽包選項） */
export const GET = route(async (req: Request) => {
  const q = query(req);
  const f = Filter.parse({
    source: q.get('source') ?? undefined,
    playType: q.get('playType') ?? undefined,
    ipId: q.get('ipId') ?? undefined,
    tag: q.get('tag') ?? undefined,
  });
  return json({ pools: await listPools(db(), f) });
});
