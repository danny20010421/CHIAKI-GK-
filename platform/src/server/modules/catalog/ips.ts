import { z } from 'zod';
import { AppError } from '../../errors';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';

/**
 * IP（動畫/遊戲/漫畫/原創作品）管理：分類（可排序、可隱藏）、IP（名稱、分類、排序、顯示、封面）、賞池連結 IP。
 * 排序以 sort_order 表示；reorder 端點一次送出完整順序，於單一交易內原子更新（全有或全無）。
 * 前台大廳篩選：GET /api/ips 依分類分組、依排序輸出（只含顯示中的分類與 IP，附上架中賞池數）。
 */
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'slug: 小寫英數與 -');
const CoverSchema = z
  .string()
  .max(500)
  .refine((s) => s.startsWith('https://') || s.startsWith('/'), '封面需為 https:// 或站內路徑');

export const CategoryCreateSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,30}$/),
  name: z.string().trim().min(1).max(50),
  visible: z.boolean().default(true),
});
export const CategoryUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(50).optional(), visible: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const IpCreateSchema = z.object({
  slug: SlugSchema,
  name: z.string().trim().min(1).max(100),
  categoryId: z.string().uuid().nullable().default(null),
  visible: z.boolean().default(true),
  coverUrl: CoverSchema.nullable().default(null),
});
export const IpUpdateSchema = z
  .object({
    slug: SlugSchema.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    visible: z.boolean().optional(),
    coverUrl: CoverSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const ReorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000).refine((a) => new Set(a).size === a.length, 'ids must be unique'),
});

async function audit(tx: Tx, actor: Principal, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
  await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action, entityType, entityId, payload });
}

// ───────────── 分類 ─────────────

export async function listCategories(actor: Principal) {
  requirePermission(actor, 'catalog.ip.manage');
  return db()`SELECT id, code, name, sort_order, visible FROM ip_categories ORDER BY sort_order, name`;
}

export async function createCategory(actor: Principal, input: z.input<typeof CategoryCreateSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = CategoryCreateSchema.parse(input);
  return transaction(async (tx) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO ip_categories (code, name, visible, sort_order)
      VALUES (${v.code}, ${v.name}, ${v.visible}, (SELECT COALESCE(max(sort_order), 0) + 1 FROM ip_categories))
      RETURNING id`;
    await audit(tx, actor, 'IP_CATEGORY_CREATED', 'ip_category', r!.id, v);
    return { id: r!.id };
  });
}

export async function updateCategory(actor: Principal, id: string, input: z.input<typeof CategoryUpdateSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = CategoryUpdateSchema.parse(input);
  return transaction(async (tx) => {
    const rows = await tx`
      UPDATE ip_categories SET name = COALESCE(${v.name ?? null}, name), visible = COALESCE(${v.visible ?? null}, visible)
      WHERE id = ${id} RETURNING id`;
    if (!rows.length) throw new AppError('NOT_FOUND', 'category not found');
    await audit(tx, actor, 'IP_CATEGORY_UPDATED', 'ip_category', id, v);
    return { id };
  });
}

export async function deleteCategory(actor: Principal, id: string) {
  requirePermission(actor, 'catalog.ip.manage');
  return transaction(async (tx) => {
    const [used] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ips WHERE category_id = ${id}`;
    if (used!.n > 0) throw new AppError('CONFLICT', '分類下仍有 IP，請先移動或刪除', { ips: used!.n });
    const rows = await tx`DELETE FROM ip_categories WHERE id = ${id} RETURNING id`;
    if (!rows.length) throw new AppError('NOT_FOUND', 'category not found');
    await audit(tx, actor, 'IP_CATEGORY_DELETED', 'ip_category', id, {});
    return { deleted: true };
  });
}

/** 原子重排：ids 必須恰為全部分類 */
export async function reorderCategories(actor: Principal, input: z.input<typeof ReorderSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = ReorderSchema.parse(input);
  return transaction(async (tx) => {
    const all = await tx<{ id: string }[]>`SELECT id FROM ip_categories ORDER BY id FOR UPDATE`;
    assertSameSet(all.map((r) => r.id), v.ids);
    await tx`UPDATE ip_categories c SET sort_order = u.ord FROM unnest(${v.ids}::uuid[]) WITH ORDINALITY AS u(id, ord) WHERE c.id = u.id`;
    await audit(tx, actor, 'IP_CATEGORIES_REORDERED', 'ip_category', 'all', { ids: v.ids });
    return { order: v.ids };
  });
}

function assertSameSet(current: string[], given: string[]) {
  const a = new Set(current);
  if (a.size !== given.length || !given.every((x) => a.has(x))) {
    throw new AppError('VALIDATION', '排序清單必須恰好包含所有項目（各一次）', { expected: current.length, got: given.length });
  }
}

// ───────────── IP ─────────────

export async function listIpsAdmin(actor: Principal) {
  requirePermission(actor, 'catalog.ip.manage');
  return db()`
    SELECT i.id, i.slug, i.name, i.category_id, c.name AS category_name, i.sort_order, i.visible, i.cover_url,
           (SELECT count(*)::int FROM pools p WHERE p.ip_id = i.id) AS pool_count
    FROM ips i LEFT JOIN ip_categories c ON c.id = i.category_id
    ORDER BY c.sort_order NULLS LAST, i.sort_order, i.name`;
}

export async function createIp(actor: Principal, input: z.input<typeof IpCreateSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = IpCreateSchema.parse(input);
  return transaction(async (tx) => {
    if (v.categoryId) await requireCategory(tx, v.categoryId);
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO ips (slug, name, category_id, visible, cover_url, sort_order)
      VALUES (${v.slug}, ${v.name}, ${v.categoryId}, ${v.visible}, ${v.coverUrl},
              (SELECT COALESCE(max(sort_order), 0) + 1 FROM ips WHERE category_id IS NOT DISTINCT FROM ${v.categoryId}::uuid))
      RETURNING id`;
    await audit(tx, actor, 'IP_CREATED', 'ip', r!.id, v);
    return { id: r!.id };
  });
}

async function requireCategory(tx: Tx, id: string) {
  const [c] = await tx`SELECT 1 FROM ip_categories WHERE id = ${id}`;
  if (!c) throw new AppError('VALIDATION', 'category not found');
}

export async function updateIp(actor: Principal, id: string, input: z.input<typeof IpUpdateSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = IpUpdateSchema.parse(input);
  return transaction(async (tx) => {
    const [cur] = await tx<{ id: string }[]>`SELECT id FROM ips WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw new AppError('NOT_FOUND', 'ip not found');
    if (v.categoryId) await requireCategory(tx, v.categoryId);
    await tx`
      UPDATE ips SET
        slug = COALESCE(${v.slug ?? null}, slug),
        name = COALESCE(${v.name ?? null}, name),
        category_id = ${v.categoryId === undefined ? tx`category_id` : v.categoryId},
        visible = COALESCE(${v.visible ?? null}, visible),
        cover_url = ${v.coverUrl === undefined ? tx`cover_url` : v.coverUrl},
        updated_at = now()
      WHERE id = ${id}`;
    // 舊欄位 pools.ip（文字）同步為 IP 名稱，維持相容
    if (v.name) await tx`UPDATE pools SET ip = ${v.name} WHERE ip_id = ${id}`;
    await audit(tx, actor, 'IP_UPDATED', 'ip', id, v);
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
    await audit(tx, actor, 'IP_DELETED', 'ip', id, {});
    return { deleted: true };
  });
}

/** 原子重排：ids 必須恰為某分類（categoryId；null = 未分類）下的全部 IP */
export const IpReorderSchema = ReorderSchema.extend({ categoryId: z.string().uuid().nullable() });

export async function reorderIps(actor: Principal, input: z.input<typeof IpReorderSchema>) {
  requirePermission(actor, 'catalog.ip.manage');
  const v = IpReorderSchema.parse(input);
  return transaction(async (tx) => {
    const all = await tx<{ id: string }[]>`SELECT id FROM ips WHERE category_id IS NOT DISTINCT FROM ${v.categoryId}::uuid ORDER BY id FOR UPDATE`;
    assertSameSet(all.map((r) => r.id), v.ids);
    await tx`UPDATE ips i SET sort_order = u.ord, updated_at = now() FROM unnest(${v.ids}::uuid[]) WITH ORDINALITY AS u(id, ord) WHERE i.id = u.id`;
    await audit(tx, actor, 'IPS_REORDERED', 'ip_category', v.categoryId ?? 'uncategorized', { ids: v.ids });
    return { categoryId: v.categoryId, order: v.ids };
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

/** 公開：大廳篩選用的 IP 清單（顯示中、依分類分組、依排序；附上架中賞池數） */
export async function publicIpDirectory(d: Db) {
  const rows = await d<{ categoryId: string | null; categoryCode: string | null; categoryName: string | null; id: string; slug: string; name: string; coverUrl: string | null; poolCount: number }[]>`
    SELECT c.id AS category_id, c.code AS category_code, c.name AS category_name, i.id, i.slug, i.name, i.cover_url,
           (SELECT count(*)::int FROM pools p WHERE p.ip_id = i.id AND p.status = 'PUBLISHED') AS pool_count
    FROM ips i LEFT JOIN ip_categories c ON c.id = i.category_id
    WHERE i.visible AND (c.id IS NULL OR c.visible)
    ORDER BY c.sort_order NULLS LAST, i.sort_order, i.name`;
  const groups: { categoryId: string | null; code: string | null; name: string; ips: { id: string; slug: string; name: string; coverUrl: string | null; poolCount: number }[] }[] = [];
  for (const r of rows) {
    let g = groups.find((x) => x.categoryId === r.categoryId);
    if (!g) {
      g = { categoryId: r.categoryId, code: r.categoryCode, name: r.categoryName ?? '未分類', ips: [] };
      groups.push(g);
    }
    g.ips.push({ id: r.id, slug: r.slug, name: r.name, coverUrl: r.coverUrl, poolCount: r.poolCount });
  }
  return { categories: groups };
}
