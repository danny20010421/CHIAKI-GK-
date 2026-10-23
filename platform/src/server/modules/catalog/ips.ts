import { z } from 'zod';
import { AppError } from '../../errors';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';

/**
 * IP（作品）目錄（業主規則，2026-10 第三批）：
 *  - 固定分類（日系動漫為主，5 類）：經典少年、新世代人氣、機甲・特攝、遊戲・角色、原創。
 *  - 別名 aliases（例：「原神」的 Genshin、げんしん）供搜尋；GET /api/ips?category=&q= 以名稱或別名、不分大小寫的「包含」比對。
 *  - 排序模式（app_settings ip.sort_mode）：
 *      AUTO（預設）＝依名稱字數（以 Array.from 計算字元數，中英文與 emoji 皆算 1）由少到多，再依繁體中文排序（Intl.Collator zh-TW）；
 *      MANUAL＝後台手動排序（POST /api/admin/ips/reorder 一次送出全部 IP 的順序，單一交易原子更新）。
 */
export const IP_CATEGORIES = ['經典少年', '新世代人氣', '機甲・特攝', '遊戲・角色', '原創'] as const;
export type IpCategory = (typeof IP_CATEGORIES)[number];
export const IpCategorySchema = z.enum(IP_CATEGORIES, { errorMap: () => ({ message: `IP 分類須為：${IP_CATEGORIES.join('、')}` }) });
export const SORT_MODES = ['AUTO', 'MANUAL'] as const;
export type SortMode = (typeof SORT_MODES)[number];

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'slug: 小寫英數與 -');
const CoverSchema = z
  .string()
  .max(500)
  .refine((s) => s.startsWith('https://') || s.startsWith('/'), '封面需為 https:// 或站內路徑');
const AliasesSchema = z
  .array(z.string().trim().min(1).max(50))
  .max(30)
  .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, '別名不可重複');

export const IpCreateSchema = z.object({
  slug: SlugSchema,
  name: z.string().trim().min(1).max(100),
  category: IpCategorySchema.nullable().default(null),
  aliases: AliasesSchema.default([]),
  visible: z.boolean().default(true),
  coverUrl: CoverSchema.nullable().default(null),
});
export const IpUpdateSchema = z
  .object({
    slug: SlugSchema.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    category: IpCategorySchema.nullable().optional(),
    aliases: AliasesSchema.optional(),
    visible: z.boolean().optional(),
    coverUrl: CoverSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const ReorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(5000).refine((a) => new Set(a).size === a.length, 'ids must be unique'),
});
export const SortModeSchema = z.object({ sortMode: z.enum(SORT_MODES) });

export interface IpRow {
  id: string;
  slug: string;
  name: string;
  category: IpCategory | null;
  aliases: string[];
  sortOrder: number;
  visible: boolean;
  coverUrl: string | null;
  poolCount: number;
}

const collator = new Intl.Collator('zh-TW');

/** AUTO：名稱字數（Array.from）少→多，再依 zh-TW 排序；MANUAL：手動順序，再依 zh-TW 排序 */
export function sortIps<T extends { name: string; sortOrder: number }>(rows: T[], mode: SortMode): T[] {
  return [...rows].sort((a, b) =>
    mode === 'AUTO'
      ? Array.from(a.name).length - Array.from(b.name).length || collator.compare(a.name, b.name)
      : a.sortOrder - b.sortOrder || collator.compare(a.name, b.name),
  );
}

export async function getSortMode(d: Db): Promise<SortMode> {
  const [r] = await d<{ value: string }[]>`SELECT value FROM app_settings WHERE key = 'ip.sort_mode'`;
  return r?.value === 'MANUAL' ? 'MANUAL' : 'AUTO';
}

export async function setSortMode(actor: Principal, input: z.input<typeof SortModeSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = SortModeSchema.parse(input);
  return transaction(async (tx) => {
    await tx`INSERT INTO app_settings (key, value, updated_by) VALUES ('ip.sort_mode', ${v.sortMode}, ${actor.userId})
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'IP_SORT_MODE_SET', entityType: 'app_setting', entityId: 'ip.sort_mode', payload: v });
    return v;
  });
}

async function audit(tx: Tx, actor: Principal, action: string, entityId: string, payload: Record<string, unknown>) {
  await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action, entityType: 'ip', entityId, payload });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function queryIps(d: Db, f: { category?: IpCategory; q?: string; visibleOnly: boolean }): Promise<IpRow[]> {
  const pattern = f.q ? `%${escapeLike(f.q)}%` : null;
  return d<IpRow[]>`
    SELECT i.id, i.slug, i.name, i.category, i.aliases, i.sort_order, i.visible, i.cover_url,
           (SELECT count(*)::int FROM pools p WHERE p.ip_id = i.id ${f.visibleOnly ? d`AND p.status = 'PUBLISHED'` : d``}) AS pool_count
    FROM ips i
    WHERE true
      ${f.visibleOnly ? d`AND i.visible` : d``}
      ${f.category ? d`AND i.category = ${f.category}` : d``}
      ${pattern ? d`AND (i.name ILIKE ${pattern} OR EXISTS (SELECT 1 FROM unnest(i.aliases) a WHERE a ILIKE ${pattern}))` : d``}`;
}

export const PublicIpQuerySchema = z.object({
  category: IpCategorySchema.optional(),
  q: z.string().trim().max(50).optional().transform((s) => (s ? s : undefined)),
});

/** 公開：大廳篩選與搜尋（只含顯示中的 IP；附上架中賞池數與各分類數量） */
export async function publicIps(d: Db, input: z.input<typeof PublicIpQuerySchema> = {}) {
  const f = PublicIpQuerySchema.parse(input);
  const mode = await getSortMode(d);
  const rows = sortIps(await queryIps(d, { ...f, visibleOnly: true }), mode);
  const counts = await d<{ category: string; n: number }[]>`SELECT category, count(*)::int AS n FROM ips WHERE visible AND category IS NOT NULL GROUP BY category`;
  return {
    sortMode: mode,
    categories: IP_CATEGORIES.map((c) => ({ category: c, count: counts.find((x) => x.category === c)?.n ?? 0 })),
    ips: rows.map(({ sortOrder: _s, visible: _v, ...r }) => r),
  };
}

export async function listIpsAdmin(actor: Principal, f: z.input<typeof PublicIpQuerySchema> = {}) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = PublicIpQuerySchema.parse(f);
  const mode = await getSortMode(db());
  return { sortMode: mode, ips: sortIps(await queryIps(db(), { ...v, visibleOnly: false }), mode) };
}

export async function createIp(actor: Principal, input: z.input<typeof IpCreateSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = IpCreateSchema.parse(input);
  return transaction(async (tx) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO ips (slug, name, category, aliases, visible, cover_url, sort_order)
      VALUES (${v.slug}, ${v.name}, ${v.category}, ${v.aliases}, ${v.visible}, ${v.coverUrl}, (SELECT COALESCE(max(sort_order), 0) + 1 FROM ips))
      RETURNING id`;
    await audit(tx, actor, 'IP_CREATED', r!.id, v);
    return { id: r!.id };
  });
}

export async function updateIp(actor: Principal, id: string, input: z.input<typeof IpUpdateSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = IpUpdateSchema.parse(input);
  return transaction(async (tx) => {
    const [cur] = await tx<{ id: string }[]>`SELECT id FROM ips WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw new AppError('NOT_FOUND', 'ip not found');
    await tx`
      UPDATE ips SET
        slug = COALESCE(${v.slug ?? null}, slug),
        name = COALESCE(${v.name ?? null}, name),
        category = ${v.category === undefined ? tx`category` : v.category},
        aliases = ${v.aliases === undefined ? tx`aliases` : tx`${v.aliases}::text[]`},
        visible = COALESCE(${v.visible ?? null}, visible),
        cover_url = ${v.coverUrl === undefined ? tx`cover_url` : v.coverUrl},
        updated_at = now()
      WHERE id = ${id}`;
    // 舊欄位 pools.ip（文字）同步為 IP 名稱，維持相容
    if (v.name) await tx`UPDATE pools SET ip = ${v.name} WHERE ip_id = ${id}`;
    await audit(tx, actor, 'IP_UPDATED', id, v);
    return { id };
  });
}

export async function deleteIp(actor: Principal, id: string) {
  requirePermission(actor, 'catalog.ip.manage');
  return transaction(async (tx) => {
    const [used] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pools WHERE ip_id = ${id}`;
    if (used!.n > 0) throw new AppError('CONFLICT', '仍有賞池連結此 IP，請改為隱藏或先移除連結', { pools: used!.n });
    const rows = await tx`DELETE FROM ips WHERE id = ${id} RETURNING id`;
    if (!rows.length) throw new AppError('NOT_FOUND', 'ip not found');
    await audit(tx, actor, 'IP_DELETED', id, {});
    return { deleted: true };
  });
}

/** 手動排序：ids 必須恰為全部 IP（各一次），單一交易原子更新；只在 MANUAL 模式下影響列表順序 */
export async function reorderIps(actor: Principal, input: z.input<typeof ReorderSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = ReorderSchema.parse(input);
  return transaction(async (tx) => {
    const all = await tx<{ id: string }[]>`SELECT id FROM ips ORDER BY id FOR UPDATE`;
    const cur = new Set(all.map((r) => r.id));
    if (cur.size !== v.ids.length || !v.ids.every((x) => cur.has(x))) {
      throw new AppError('VALIDATION', '排序清單必須恰好包含所有 IP（各一次）', { expected: cur.size, got: v.ids.length });
    }
    await tx`UPDATE ips i SET sort_order = u.ord, updated_at = now() FROM unnest(${v.ids}::uuid[]) WITH ORDINALITY AS u(id, ord) WHERE i.id = u.id`;
    await audit(tx, actor, 'IPS_REORDERED', 'all', { ids: v.ids });
    return { order: v.ids, sortMode: await getSortMode(tx) };
  });
}

/** 賞池連結 IP（null = 取消連結）；同步舊欄位 pools.ip */
export async function linkPoolIp(tx: Tx, poolId: string, ipId: string | null): Promise<void> {
  if (ipId) {
    const [ip] = await tx<{ name: string }[]>`SELECT name FROM ips WHERE id = ${ipId}`;
    if (!ip) throw new AppError('VALIDATION', 'ip not found');
    await tx`UPDATE pools SET ip_id = ${ipId}, ip = ${ip.name} WHERE id = ${poolId}`;
  } else {
    await tx`UPDATE pools SET ip_id = NULL WHERE id = ${poolId}`;
  }
}
