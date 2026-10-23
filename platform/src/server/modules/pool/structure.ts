import { z } from 'zod';
import { AppError } from '../../errors';
import { transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { resolveBulky, TagSchema, type Tag } from '../catalog/tags';
import { defaultIsSmall, LAST_PRIZE_LABEL, LevelNoSchema } from './levels';
import {
  drawPacksOut,
  ImageUrlSchema,
  insertLevel,
  insertPrizeItem,
  LevelNameSchema,
  lockPublishedPool,
  MAX_TICKETS_PER_SET,
  PrizeItemSchema,
  PrizeNameSchema,
  RecycleValueSchema,
} from './admin';

/**
 * 後台：賞池「等級 / 獎項」管理。
 *
 * 結構性變更（新增/刪除等級或獎項、數量 qtyPerSet、是否小獎 isSmall、獎項換等級）只允許在草稿（DRAFT）階段：
 * 發布後每一套的籤表已以 CSPRNG 洗牌並公開承諾雜湊（籤與承諾在資料庫層不可變），即使尚未售出也不能改動，
 * 否則公開的承諾就失去意義。要改結構請另建新賞池。
 * 非結構欄位（等級名稱、獎項名稱、回收值、可否回收、標籤、大件、圖片）隨時可改，全部寫入稽核鏈。
 */

const STRUCTURE_LOCKED_MSG = '賞池已送審或已發布：等級、數量、是否小獎等結構只能在草稿階段修改（已發布的籤表與承諾不可變）';

async function lockPool(tx: Tx, idOrSlug: string) {
  const p = await lockPublishedPool(tx, idOrSlug);
  return p;
}

function requireDraft(p: { status: string }) {
  if (p.status !== 'DRAFT') throw new AppError('STRUCTURE_LOCKED', STRUCTURE_LOCKED_MSG, { status: p.status });
}

async function ticketTotal(tx: Tx, poolId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT COALESCE(sum(qty_per_set), 0)::int AS n FROM pool_prizes WHERE pool_id = ${poolId} AND kind = 'TICKET'`;
  return r!.n;
}

async function assertTicketTotal(tx: Tx, poolId: string) {
  const n = await ticketTotal(tx, poolId);
  if (n > MAX_TICKETS_PER_SET) throw new AppError('VALIDATION', `max ${MAX_TICKETS_PER_SET} tickets per set`, { total: n });
}

async function audit(tx: Tx, actor: Principal, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
  await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action, entityType, entityId, payload });
}

// ───────────── 讀取（後台檢視，含草稿） ─────────────

export async function getAdminPool(db: Db | Tx, idOrSlug: string) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rows = UUID_RE.test(idOrSlug)
    ? await db<PoolHead[]>`SELECT id, slug, title, source, play_type, status, price_coins, set_count, draw_packs, last_prize_name, offline, deleted_at, delete_reason FROM pools WHERE id = ${idOrSlug}`
    : await db<PoolHead[]>`SELECT id, slug, title, source, play_type, status, price_coins, set_count, draw_packs, last_prize_name, offline, deleted_at, delete_reason FROM pools WHERE slug = ${idOrSlug}`;
  const p = rows[0];
  if (!p) throw new AppError('NOT_FOUND', 'pool not found');
  const levels = await db<{ id: string; levelNo: number; name: string; isSmall: boolean }[]>`
    SELECT id, level_no, name, is_small FROM pool_levels WHERE pool_id = ${p.id} ORDER BY level_no`;
  const prizes = await db<AdminPrizeRow[]>`
    SELECT id, kind, level_id, name, qty_per_set, recycle_value, recyclable, tag, bulky, image_url
    FROM pool_prizes WHERE pool_id = ${p.id} ORDER BY sort_order, name`;
  const [g] = await db<{ everyN: number; minLevel: number; reservePrizeId: string; reserveTotal: number; reserveUsed: number }[]>`
    SELECT every_n, min_level, reserve_prize_id, reserve_total, reserve_used FROM pool_guarantees WHERE pool_id = ${p.id}`;
  const sets = await db<{ setNo: number; displayName: string | null; internalNote: string; status: string; offline: boolean; deletedAt: Date | null; deleteReason: string | null; total: number; remaining: number; sales: number; commitment: string }[]>`
    SELECT s.set_no, s.display_name, s.internal_note, s.status, s.offline, s.deleted_at, s.delete_reason, s.total_tickets AS total, s.commitment,
           (SELECT count(*)::int FROM tickets t WHERE t.set_id = s.id AND t.status = 'AVAILABLE') AS remaining,
           (SELECT count(*)::int FROM draws d WHERE d.set_id = s.id) AS sales
    FROM pool_sets s WHERE s.pool_id = ${p.id} ORDER BY s.set_no`;
  const item = (r: AdminPrizeRow) => ({
    prizeId: r.id, kind: r.kind, name: r.name, qtyPerSet: r.qtyPerSet, recycleValue: r.recycleValue, recyclable: r.recyclable,
    tag: r.tag, bulky: r.bulky, imageUrl: r.imageUrl,
  });
  const last = prizes.find((r) => r.kind === 'LAST');
  const reserve = g ? prizes.find((r) => r.id === g.reservePrizeId) : undefined;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    source: p.source,
    playType: p.playType,
    status: p.status,
    offline: p.offline,
    deletedAt: p.deletedAt,
    deleteReason: p.deleteReason,
    priceCoins: p.priceCoins,
    setCount: p.setCount,
    drawPacks: drawPacksOut(p.drawPacks),
    structureEditable: p.status === 'DRAFT',
    /** 各套（含已刪除、可還原者）；sales = 抽賞筆數，> 0 只能下架 */
    sets,
    ticketsPerSet: prizes.filter((r) => r.kind === 'TICKET').reduce((s, r) => s + r.qtyPerSet, 0),
    levels: levels.map((l) => ({
      levelNo: l.levelNo,
      name: l.name,
      isSmall: l.isSmall,
      items: prizes.filter((r) => r.kind === 'TICKET' && r.levelId === l.id).map(item),
    })),
    lastPrize: last ? { ...item(last), levelName: LAST_PRIZE_LABEL } : null,
    guarantee: g && reserve
      ? { everyN: g.everyN, minLevel: g.minLevel, reserveTotal: g.reserveTotal, reserveUsed: g.reserveUsed, reserveLevelNo: levels.find((l) => l.id === reserve.levelId)?.levelNo ?? null, reservePrize: item(reserve) }
      : null,
  };
}
interface PoolHead {
  id: string; slug: string; title: string; source: string; playType: string; status: string; priceCoins: number; setCount: number; drawPacks: string[]; lastPrizeName: string | null;
  offline: boolean; deletedAt: Date | null; deleteReason: string | null;
}
interface AdminPrizeRow {
  id: string; kind: 'TICKET' | 'LAST' | 'GUARANTEE'; levelId: string | null; name: string; qtyPerSet: number; recycleValue: number; recyclable: boolean;
  tag: Tag | null; bulky: boolean; imageUrl: string | null;
}

// ───────────── 等級 ─────────────

export const CreateLevelSchema = z.object({
  levelNo: LevelNoSchema,
  name: LevelNameSchema,
  isSmall: z.boolean().optional(),
  items: z.array(PrizeItemSchema).min(1, '每個等級至少一個獎項').max(50),
});

export async function createLevel(actor: Principal, idOrSlug: string, input: z.input<typeof CreateLevelSchema>) {
  requirePermission(actor, 'pool.config.manage');
  const v = CreateLevelSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    requireDraft(p);
    const [cnt] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pool_levels WHERE pool_id = ${p.id}`;
    if (cnt!.n >= 8) throw new AppError('VALIDATION', '最多 8 個等級');
    const lv = await insertLevel(tx, p.id, v);
    let i = 0;
    for (const it of v.items) await insertItemChecked(tx, p.id, lv, it, v.levelNo * 100 + i++);
    await assertTicketTotal(tx, p.id);
    await audit(tx, actor, 'POOL_LEVEL_CREATED', 'pool', p.id, { levelNo: v.levelNo, name: v.name, isSmall: v.isSmall ?? defaultIsSmall(v.levelNo), items: v.items.map((x) => x.name) });
    return getAdminPool(tx, p.id);
  });
}

export const UpdateLevelSchema = z
  .object({ name: LevelNameSchema.optional(), isSmall: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.isSmall !== undefined, 'nothing to update');

/** 等級名稱隨時可改（留稽核；已入倉/已開獎的紀錄保留當時名稱）；是否小獎屬結構（影響運費規則），只在草稿可改。 */
export async function updateLevel(actor: Principal, idOrSlug: string, levelNo: number, input: z.input<typeof UpdateLevelSchema>) {
  requirePermission(actor, 'pool.config.manage');
  const v = UpdateLevelSchema.parse(input);
  LevelNoSchema.parse(levelNo);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    const [l] = await tx<{ id: string; name: string; isSmall: boolean }[]>`
      SELECT id, name, is_small FROM pool_levels WHERE pool_id = ${p.id} AND level_no = ${levelNo} FOR UPDATE`;
    if (!l) throw new AppError('NOT_FOUND', `等級 ${levelNo} 不存在`);
    if (v.isSmall !== undefined && v.isSmall !== l.isSmall) requireDraft(p);
    const after = { name: v.name ?? l.name, isSmall: v.isSmall ?? l.isSmall };
    await tx`UPDATE pool_levels SET name = ${after.name}, is_small = ${after.isSmall}, updated_at = now() WHERE id = ${l.id}`;
    await audit(tx, actor, 'POOL_LEVEL_UPDATED', 'pool', p.id, { levelNo, before: { name: l.name, isSmall: l.isSmall }, after });
    return { poolId: p.id, levelNo, ...after };
  });
}

export async function deleteLevel(actor: Principal, idOrSlug: string, levelNo: number) {
  requirePermission(actor, 'pool.config.manage');
  LevelNoSchema.parse(levelNo);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    requireDraft(p);
    const [l] = await tx<{ id: string; name: string }[]>`SELECT id, name FROM pool_levels WHERE pool_id = ${p.id} AND level_no = ${levelNo} FOR UPDATE`;
    if (!l) throw new AppError('NOT_FOUND', `等級 ${levelNo} 不存在`);
    const [res] = await tx`SELECT 1 FROM pool_prizes WHERE level_id = ${l.id} AND kind = 'GUARANTEE'`;
    if (res) throw new AppError('CONFLICT', '此等級含保底獎項，請先調整保底設定');
    const [cnt] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pool_levels WHERE pool_id = ${p.id}`;
    if (cnt!.n <= 1) throw new AppError('VALIDATION', '賞池至少需要一個等級');
    const items = await tx<{ name: string }[]>`DELETE FROM pool_prizes WHERE level_id = ${l.id} RETURNING name`;
    await tx`DELETE FROM pool_levels WHERE id = ${l.id}`;
    await audit(tx, actor, 'POOL_LEVEL_DELETED', 'pool', p.id, { levelNo, name: l.name, items: items.map((i) => i.name) });
    return { poolId: p.id, levelNo, deleted: true };
  });
}

// ───────────── 獎項 ─────────────

async function insertItemChecked(tx: Tx, poolId: string, lv: { id: string; levelNo: number }, it: z.infer<typeof PrizeItemSchema>, sortOrder: number) {
  const [dup] = await tx`SELECT 1 FROM pool_prizes WHERE pool_id = ${poolId} AND kind = 'TICKET' AND name = ${it.name}`;
  if (dup) throw new AppError('CONFLICT', `獎項名稱「${it.name}」已存在`);
  return insertPrizeItem(tx, poolId, lv, it, sortOrder);
}

export async function createPrizeItem(actor: Principal, idOrSlug: string, levelNo: number, input: z.input<typeof PrizeItemSchema>) {
  requirePermission(actor, 'pool.config.manage');
  LevelNoSchema.parse(levelNo);
  const v = PrizeItemSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    requireDraft(p);
    const [l] = await tx<{ id: string }[]>`SELECT id FROM pool_levels WHERE pool_id = ${p.id} AND level_no = ${levelNo} FOR UPDATE`;
    if (!l) throw new AppError('NOT_FOUND', `等級 ${levelNo} 不存在`);
    const [mx] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pool_prizes WHERE level_id = ${l.id}`;
    const prizeId = await insertItemChecked(tx, p.id, { id: l.id, levelNo }, v, levelNo * 100 + mx!.n);
    await assertTicketTotal(tx, p.id);
    await audit(tx, actor, 'PRIZE_CREATED', 'pool_prize', prizeId, { poolId: p.id, levelNo, ...v });
    return { prizeId, poolId: p.id, levelNo };
  });
}

export const UpdatePrizeSchema = z
  .object({
    // 隨時可改（留稽核）
    name: PrizeNameSchema.optional(),
    recycleValue: RecycleValueSchema.optional(),
    recyclable: z.boolean().optional(),
    tag: TagSchema.nullable().optional(),
    bulky: z.boolean().optional(),
    imageUrl: ImageUrlSchema.nullable().optional(),
    // 結構（只在草稿）
    qtyPerSet: z.number().int().positive().max(MAX_TICKETS_PER_SET).optional(),
    levelNo: LevelNoSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

interface PrizeFull {
  id: string; poolId: string; kind: string; levelId: string | null; levelNo: number | null; name: string; qtyPerSet: number;
  recycleValue: number; recyclable: boolean; tag: Tag | null; bulky: boolean; imageUrl: string | null;
}

/**
 * 修改獎項。名稱/回收值/可否回收/標籤/大件/圖片隨時可改；數量與換等級只在草稿。
 * 回收值：更新賞池預設值，並同步到「仍沿用舊預設值」的每一套（已逐套自訂的套不受影響，可再用逐套設定調整）。
 * 只改標籤未指定 bulky 時，大件旗標依新標籤與等級重新套用預設（GK 或等級 1 → 是）。
 */
export async function updatePrize(actor: Principal, prizeId: string, input: z.input<typeof UpdatePrizeSchema>) {
  requirePermission(actor, 'pool.config.manage');
  const v = UpdatePrizeSchema.parse(input);
  return transaction(async (tx) => {
    const [pre] = await tx<{ poolId: string }[]>`SELECT pool_id FROM pool_prizes WHERE id = ${prizeId}`;
    if (!pre) throw new AppError('NOT_FOUND', 'prize not found');
    const p = await lockPool(tx, pre.poolId);
    const [cur] = await tx<PrizeFull[]>`
      SELECT pp.id, pp.pool_id, pp.kind, pp.level_id, pl.level_no, pp.name, pp.qty_per_set, pp.recycle_value, pp.recyclable, pp.tag, pp.bulky, pp.image_url
      FROM pool_prizes pp LEFT JOIN pool_levels pl ON pl.id = pp.level_id WHERE pp.id = ${prizeId} FOR UPDATE OF pp`;
    if (!cur) throw new AppError('NOT_FOUND', 'prize not found');
    if ((v.qtyPerSet !== undefined && v.qtyPerSet !== cur.qtyPerSet) || (v.levelNo !== undefined && v.levelNo !== cur.levelNo)) {
      requireDraft(p);
      if (cur.kind !== 'TICKET' && v.qtyPerSet !== undefined) throw new AppError('VALIDATION', '最後賞/保底獎項沒有籤數');
      if (cur.kind === 'LAST' && v.levelNo !== undefined) throw new AppError('VALIDATION', '最後賞不屬於任何等級');
    }
    let levelId = cur.levelId;
    let levelNo = cur.levelNo;
    if (v.levelNo !== undefined && v.levelNo !== cur.levelNo) {
      const [l] = await tx<{ id: string }[]>`SELECT id FROM pool_levels WHERE pool_id = ${p.id} AND level_no = ${v.levelNo}`;
      if (!l) throw new AppError('NOT_FOUND', `等級 ${v.levelNo} 不存在`);
      levelId = l.id;
      levelNo = v.levelNo;
    }
    if (v.name !== undefined && v.name !== cur.name) {
      const [dup] = await tx`SELECT 1 FROM pool_prizes WHERE pool_id = ${p.id} AND kind = ${cur.kind} AND name = ${v.name} AND id <> ${prizeId}`;
      if (dup) throw new AppError('CONFLICT', `獎項名稱「${v.name}」已存在`);
    }
    const tag = v.tag === undefined ? cur.tag : v.tag;
    const after = {
      name: v.name ?? cur.name,
      qtyPerSet: v.qtyPerSet ?? cur.qtyPerSet,
      levelNo,
      recycleValue: v.recycleValue ?? cur.recycleValue,
      recyclable: v.recyclable ?? cur.recyclable,
      tag,
      bulky: v.bulky ?? (v.tag !== undefined ? resolveBulky(tag, undefined, levelNo) : cur.bulky),
      imageUrl: v.imageUrl === undefined ? cur.imageUrl : v.imageUrl,
    };
    await tx`
      UPDATE pool_prizes SET name = ${after.name}, qty_per_set = ${after.qtyPerSet}, level_id = ${levelId}, recycle_value = ${after.recycleValue},
             recyclable = ${after.recyclable}, tag = ${after.tag}, bulky = ${after.bulky}, image_url = ${after.imageUrl}
      WHERE id = ${prizeId}`;
    if (cur.kind === 'LAST' && after.name !== cur.name) await tx`UPDATE pools SET last_prize_name = ${after.name} WHERE id = ${p.id}`;
    if (cur.kind === 'GUARANTEE' && after.name !== cur.name) await tx`UPDATE pool_guarantees SET reserve_prize_name = ${after.name} WHERE pool_id = ${p.id}`;
    let setsUpdated = 0;
    if (after.recycleValue !== cur.recycleValue || after.recyclable !== cur.recyclable) {
      const upd = await tx`
        UPDATE set_prizes SET recycle_value = ${after.recycleValue}, recyclable = ${after.recyclable}, updated_by = ${actor.userId}, updated_at = now()
        WHERE prize_id = ${prizeId} AND recycle_value = ${cur.recycleValue} AND recyclable = ${cur.recyclable}`;
      setsUpdated = upd.count;
    }
    if (v.qtyPerSet !== undefined) await assertTicketTotal(tx, p.id);
    const before = { name: cur.name, qtyPerSet: cur.qtyPerSet, levelNo: cur.levelNo, recycleValue: cur.recycleValue, recyclable: cur.recyclable, tag: cur.tag, bulky: cur.bulky, imageUrl: cur.imageUrl };
    await audit(tx, actor, 'PRIZE_UPDATED', 'pool_prize', prizeId, { poolId: p.id, kind: cur.kind, before, after, setsUpdated });
    return { prizeId, poolId: p.id, kind: cur.kind, ...after, setsUpdated };
  });
}

export async function deletePrize(actor: Principal, prizeId: string) {
  requirePermission(actor, 'pool.config.manage');
  return transaction(async (tx) => {
    const [pre] = await tx<{ poolId: string }[]>`SELECT pool_id FROM pool_prizes WHERE id = ${prizeId}`;
    if (!pre) throw new AppError('NOT_FOUND', 'prize not found');
    const p = await lockPool(tx, pre.poolId);
    requireDraft(p);
    const [cur] = await tx<{ kind: string; name: string; levelId: string | null }[]>`SELECT kind, name, level_id FROM pool_prizes WHERE id = ${prizeId} FOR UPDATE`;
    if (cur!.kind === 'GUARANTEE') throw new AppError('CONFLICT', '保底獎項由保底設定管理，不能單獨刪除');
    await tx`DELETE FROM pool_prizes WHERE id = ${prizeId}`;
    if (cur!.kind === 'LAST') await tx`UPDATE pools SET last_prize_name = NULL WHERE id = ${p.id}`;
    await audit(tx, actor, 'PRIZE_DELETED', 'pool_prize', prizeId, { poolId: p.id, kind: cur!.kind, name: cur!.name });
    return { prizeId, deleted: true };
  });
}
