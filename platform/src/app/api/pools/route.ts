import { z } from 'zod';
import { db } from '@/server/db';
import { json, query, route } from '@/server/http';
import { listPools } from '@/server/modules/pool/queries';
import { IpCategorySchema } from '@/server/modules/catalog/ips';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Filter = z.object({
  source: z.enum(['OFFICIAL', 'CUSTOM', 'MIXED']).optional(),
  playType: z.enum(['STANDARD', 'GUARANTEE', 'SOLO']).optional(),
  ipId: z.string().uuid().optional(),
  ipCategory: IpCategorySchema.optional(),
});

/** GET /api/pools — 公開賞池列表（含目前開賣中的套與剩餘數） */
export const GET = route(async (req: Request) => {
  const q = query(req);
  const f = Filter.parse({
    source: q.get('source') ?? undefined,
    playType: q.get('playType') ?? undefined,
    ipId: q.get('ipId') ?? undefined,
    ipCategory: q.get('ipCategory') ?? undefined,
  });
  return json({ pools: await listPools(db(), f) });
});
