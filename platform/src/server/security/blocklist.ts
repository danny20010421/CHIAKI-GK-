import { z } from 'zod';
import { config } from '../config';
import { db, transaction } from '../db';
import { AppError } from '../errors';
import { appendAudit } from '../modules/audit/audit';
import { requirePermission, type Principal } from '../modules/auth/rbac';

/**
 * IP / 裝置封鎖清單。每次請求都要比對 → 以記憶體快取（BLOCKLIST_CACHE_MS，預設 30 秒）；
 * 本程序內的新增/移除會立即使快取失效，其他實例最多延遲一個快取週期。
 */
interface Entry {
  kind: 'IP' | 'DEVICE';
  value: string;
  expiresAt: Date | null;
}

let cache: { at: number; ip: Map<string, Entry>; device: Map<string, Entry> } | null = null;

async function load(): Promise<NonNullable<typeof cache>> {
  const ttl = config().BLOCKLIST_CACHE_MS;
  if (cache && Date.now() - cache.at < ttl) return cache;
  const rows = await db()<Entry[]>`SELECT kind, value, expires_at FROM access_blocklist WHERE expires_at IS NULL OR expires_at > now()`;
  const c = { at: Date.now(), ip: new Map<string, Entry>(), device: new Map<string, Entry>() };
  for (const r of rows) (r.kind === 'IP' ? c.ip : c.device).set(r.value, r);
  cache = c;
  return c;
}

export function invalidateBlocklistCache(): void {
  cache = null;
}

export async function blockedReason(ip: string, device: string | null): Promise<'IP' | 'DEVICE' | null> {
  const c = await load();
  const now = Date.now();
  const hit = (e: Entry | undefined) => e !== undefined && (e.expiresAt === null || e.expiresAt.getTime() > now);
  if (hit(c.ip.get(ip))) return 'IP';
  if (device && hit(c.device.get(device))) return 'DEVICE';
  return null;
}

export const BlockSchema = z.object({
  kind: z.enum(['IP', 'DEVICE']),
  value: z.string().min(1).max(200),
  reason: z.string().max(500).default(''),
  expiresInMinutes: z.number().int().positive().max(60 * 24 * 365).optional(),
});

export async function addBlock(actor: Principal, input: z.input<typeof BlockSchema>) {
  requirePermission(actor, 'security.manage');
  const v = BlockSchema.parse(input);
  const r = await transaction(async (tx) => {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO access_blocklist (kind, value, reason, expires_at, created_by)
      VALUES (${v.kind}, ${v.value}, ${v.reason}, ${v.expiresInMinutes ? new Date(Date.now() + v.expiresInMinutes * 60_000) : null}, ${actor.userId})
      ON CONFLICT (kind, value) DO UPDATE SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, created_by = EXCLUDED.created_by, created_at = now()
      RETURNING id`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'BLOCKLIST_ADDED', entityType: 'access_blocklist', entityId: String(row!.id), payload: v });
    return { id: row!.id };
  });
  invalidateBlocklistCache();
  return r;
}

export async function removeBlock(actor: Principal, id: number) {
  requirePermission(actor, 'security.manage');
  const r = await transaction(async (tx) => {
    const rows = await tx<{ kind: string; value: string }[]>`DELETE FROM access_blocklist WHERE id = ${id} RETURNING kind, value`;
    if (!rows[0]) throw new AppError('NOT_FOUND', 'block entry not found');
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'BLOCKLIST_REMOVED', entityType: 'access_blocklist', entityId: String(id), payload: rows[0] });
    return { removed: true };
  });
  invalidateBlocklistCache();
  return r;
}

export async function listBlocks(actor: Principal) {
  requirePermission(actor, 'security.manage');
  return db()`SELECT id, kind, value, reason, expires_at, created_by, created_at FROM access_blocklist ORDER BY created_at DESC LIMIT 500`;
}
