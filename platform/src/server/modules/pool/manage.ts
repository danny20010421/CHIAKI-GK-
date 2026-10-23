import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { canonicalJson } from '../../lib/canonical';
import { transaction, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { COMMIT_SCHEME, COMMIT_SCHEME_V1, computeCommitment, generateLayout, generateSalt, type LayoutEntry } from './commitment';

/**
 * 後台管理賞池與套（修正錯誤用；業主 2026-10 第四批追加）。
 *
 *  - 下架 / 重新上架（offline）：賞池或單一套。下架者不出現在公開列表、不可鎖籤或抽（既有保留立即釋出），
 *    既有抽賞紀錄與中獎倉庫完全不受影響。
 *  - 編輯套：顯示名稱、內部備註；只有 0 銷售的套才可重新產生籤表＋新承諾雜湊（舊承諾、salt、籤表存入
 *    pool_set_commit_history 並可公開驗證 —— 沒有任何人抽過，公開舊籤表不會洩漏資訊）。
 *  - 新增套：依賞池目前的等級/獎項產生新的一套（新承諾）。
 *  - 刪除：只限 0 銷售。軟刪除（deleted_at），30 天內可還原；超過 30 天由排程硬刪除（purgeDeleted）。
 *    賞池至少保留一套：刪除最後一套＝刪除整個賞池（需 SUPER_ADMIN）。
 *  - 已有銷售的套：刪除或重新產生籤表 → 409「已有銷售紀錄，只能下架」。
 *  - 每個動作都必須填寫原因 reason，並寫入稽核雜湊鏈。權限：pool.manage（OPS/SUPER_ADMIN）；刪除/還原整個賞池需 pool.delete（SUPER_ADMIN）。
 *
 * 鎖順序：pool → sets（依 set_no）→ audit_head。抽賞交易先鎖 set，鎖到後再讀 pool/set 的下架與刪除狀態，因此不會與本模組競態。
 */

export const RESTORE_WINDOW_DAYS = 30;
const HAS_SALES_MSG = '已有銷售紀錄，只能下架';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ReasonSchema = z.string().trim().min(1, '請填寫原因').max(500);
export const OfflineSchema = z.object({ offline: z.boolean(), reason: ReasonSchema });
export const ReasonOnlySchema = z.object({ reason: ReasonSchema });
export const EditSetSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).nullable().optional(),
    internalNote: z.string().max(2000).optional(),
    /** 重新產生籤表與承諾雜湊（只限 0 銷售） */
    regenerate: z.boolean().optional(),
    reason: ReasonSchema,
  })
  .refine((v) => v.displayName !== undefined || v.internalNote !== undefined || v.regenerate === true, 'nothing to update');
export const AddSetSchema = z.object({ displayName: z.string().trim().min(1).max(100).nullable().optional(), reason: ReasonSchema });

interface PoolLock {
  id: string;
  merchantId: string;
  status: string;
  offline: boolean;
  deletedAt: Date | null;
  currentRuleVersionId: string | null;
  setCount: number;
  shipFeeHome: number;
  shipFeeCvs: number;
}
interface SetLock {
  id: string;
  setNo: number;
  status: string;
  offline: boolean;
  deletedAt: Date | null;
  displayName: string | null;
  internalNote: string;
  commitScheme: string;
  commitment: string;
  commitSalt: string;
  ruleVersionId: string;
  totalTickets: number;
}

async function lockPool(tx: Tx, idOrSlug: string, opts: { allowDeleted?: boolean } = {}): Promise<PoolLock> {
  const rows = UUID_RE.test(idOrSlug)
    ? await tx<PoolLock[]>`SELECT id, merchant_id, status, offline, deleted_at, current_rule_version_id, set_count, ship_fee_home, ship_fee_cvs FROM pools WHERE id = ${idOrSlug} FOR UPDATE`
    : await tx<PoolLock[]>`SELECT id, merchant_id, status, offline, deleted_at, current_rule_version_id, set_count, ship_fee_home, ship_fee_cvs FROM pools WHERE slug = ${idOrSlug} FOR UPDATE`;
  const p = rows[0];
  if (!p || (p.deletedAt && !opts.allowDeleted)) throw new AppError('NOT_FOUND', 'pool not found');
  return p;
}

async function lockSets(tx: Tx, poolId: string): Promise<SetLock[]> {
  return tx<SetLock[]>`
    SELECT id, set_no, status, offline, deleted_at, display_name, internal_note, commit_scheme, commitment, commit_salt, rule_version_id, total_tickets
    FROM pool_sets WHERE pool_id = ${poolId} ORDER BY set_no FOR UPDATE`;
}

async function lockSet(tx: Tx, poolId: string, setNo: number, opts: { allowDeleted?: boolean } = {}): Promise<SetLock> {
  const [s] = await tx<SetLock[]>`
    SELECT id, set_no, status, offline, deleted_at, display_name, internal_note, commit_scheme, commitment, commit_salt, rule_version_id, total_tickets
    FROM pool_sets WHERE pool_id = ${poolId} AND set_no = ${setNo} FOR UPDATE`;
  if (!s || (s.deletedAt && !opts.allowDeleted)) throw new AppError('NOT_FOUND', 'set not found');
  return s;
}

async function setSales(tx: Tx, setId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM draws WHERE set_id = ${setId}`;
  return r!.n;
}

async function poolSales(tx: Tx, poolId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM draws WHERE pool_id = ${poolId}`;
  return r!.n;
}

function hasSales(details: Record<string, unknown>): never {
  throw new AppError('HAS_SALES', HAS_SALES_MSG, details);
}

async function releaseSetHolds(tx: Tx, setIds: string[]): Promise<number> {
  if (!setIds.length) return 0;
  const r = await tx`UPDATE tickets SET held_by = NULL, held_until = NULL WHERE set_id = ANY(${setIds}::uuid[]) AND status = 'AVAILABLE' AND held_by IS NOT NULL`;
  return r.count;
}

/** 沒有「未刪除且開賣中」的套時，開賣下一個排隊中（未刪除、未下架）的套；全部沒了則賞池結束 */
async function ensureCurrentSet(tx: Tx, poolId: string): Promise<number | null> {
  const [p] = await tx<{ status: string }[]>`SELECT status FROM pools WHERE id = ${poolId}`;
  if (p!.status !== 'PUBLISHED' && p!.status !== 'ENDED') return null;
  const [cur] = await tx<{ setNo: number }[]>`SELECT set_no FROM pool_sets WHERE pool_id = ${poolId} AND status = 'ON_SALE' AND deleted_at IS NULL ORDER BY set_no LIMIT 1`;
  if (cur) return cur.setNo;
  const [next] = await tx<{ setNo: number }[]>`
    UPDATE pool_sets SET status = 'ON_SALE', on_sale_at = now()
    WHERE id = (SELECT id FROM pool_sets WHERE pool_id = ${poolId} AND status = 'QUEUED' AND deleted_at IS NULL AND NOT offline ORDER BY set_no LIMIT 1)
    RETURNING set_no`;
  if (next) {
    if (p!.status === 'ENDED') await tx`UPDATE pools SET status = 'PUBLISHED' WHERE id = ${poolId}`;
    return next.setNo;
  }
  return null;
}

async function audit(tx: Tx, actor: Principal, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
  await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action, entityType, entityId, payload });
}

async function ticketPrizes(tx: Tx, poolId: string) {
  return tx<{ id: string; levelNo: number; qtyPerSet: number }[]>`
    SELECT pp.id, pl.level_no, pp.qty_per_set FROM pool_prizes pp JOIN pool_levels pl ON pl.id = pp.level_id
    WHERE pp.pool_id = ${poolId} AND pp.kind = 'TICKET' ORDER BY pl.level_no, pp.sort_order, pp.name`;
}

// ───────────── 下架 / 重新上架 ─────────────

export async function setPoolOffline(actor: Principal, idOrSlug: string, input: z.input<typeof OfflineSchema>) {
  requirePermission(actor, 'pool.manage');
  const v = OfflineSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    const sets = await lockSets(tx, p.id);
    await tx`UPDATE pools SET offline = ${v.offline} WHERE id = ${p.id}`;
    const released = v.offline ? await releaseSetHolds(tx, sets.map((s) => s.id)) : 0;
    await audit(tx, actor, v.offline ? 'POOL_TAKEN_OFFLINE' : 'POOL_BACK_ONLINE', 'pool', p.id, { before: p.offline, after: v.offline, reason: v.reason, holdsReleased: released });
    return { poolId: p.id, offline: v.offline, holdsReleased: released };
  });
}

export async function setSetOffline(actor: Principal, idOrSlug: string, setNo: number, input: z.input<typeof OfflineSchema>) {
  requirePermission(actor, 'pool.manage');
  const v = OfflineSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    const s = await lockSet(tx, p.id, setNo);
    await tx`UPDATE pool_sets SET offline = ${v.offline} WHERE id = ${s.id}`;
    const released = v.offline ? await releaseSetHolds(tx, [s.id]) : 0;
    // 重新上架一個排隊中的套：若目前沒有開賣中的套，讓它開賣
    const current = v.offline ? null : await ensureCurrentSet(tx, p.id);
    await audit(tx, actor, v.offline ? 'SET_TAKEN_OFFLINE' : 'SET_BACK_ONLINE', 'pool_set', s.id, { poolId: p.id, setNo, before: s.offline, after: v.offline, reason: v.reason, holdsReleased: released });
    return { poolId: p.id, setNo, offline: v.offline, holdsReleased: released, currentSetNo: current };
  });
}

// ───────────── 編輯套 / 重新產生籤表 ─────────────

export async function editSet(actor: Principal, idOrSlug: string, setNo: number, input: z.input<typeof EditSetSchema>) {
  requirePermission(actor, 'pool.manage');
  const v = EditSetSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    const s = await lockSet(tx, p.id, setNo);
    let regenerated: { oldCommitment: string; newCommitment: string } | null = null;
    if (v.regenerate) {
      const sales = await setSales(tx, s.id);
      if (sales > 0) hasSales({ poolId: p.id, setNo, draws: sales });
      regenerated = await regenerateLayout(tx, actor, p, s, v.reason);
    }
    const displayName = v.displayName === undefined ? s.displayName : v.displayName;
    const internalNote = v.internalNote ?? s.internalNote;
    await tx`UPDATE pool_sets SET display_name = ${displayName}, internal_note = ${internalNote} WHERE id = ${s.id}`;
    await audit(tx, actor, 'SET_EDITED', 'pool_set', s.id, {
      poolId: p.id,
      setNo,
      reason: v.reason,
      before: { displayName: s.displayName, internalNote: s.internalNote },
      after: { displayName, internalNote },
      ...(regenerated ? { regenerated } : {}),
    });
    return { poolId: p.id, setNo, displayName, internalNote, regenerated: regenerated !== null, commitment: regenerated?.newCommitment ?? s.commitment };
  });
}

async function regenerateLayout(tx: Tx, actor: Principal, p: PoolLock, s: SetLock, reason: string) {
  if (s.status === 'SOLD_OUT') throw new AppError('INVALID_STATE', '已完售的套不能重新產生籤表');
  const old = await tx<LayoutEntry[]>`
    SELECT t.ticket_no, pl.level_no, pr.rank, t.prize_id FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id
    LEFT JOIN pool_levels pl ON pl.id = pr.level_id WHERE t.set_id = ${s.id} ORDER BY t.ticket_no`;
  const oldLayout = old.map((t) => (s.commitScheme === COMMIT_SCHEME_V1 ? { ticketNo: t.ticketNo, rank: t.rank ?? null, prizeId: t.prizeId } : { ticketNo: t.ticketNo, levelNo: t.levelNo ?? null, prizeId: t.prizeId }));
  const [rv] = await tx<{ rulesHash: string }[]>`SELECT rules_hash FROM pool_rule_versions WHERE id = ${s.ruleVersionId}`;
  await tx`
    INSERT INTO pool_set_commit_history (pool_id, set_id, set_no, commit_scheme, commitment, commit_salt, rules_hash, layout_json, reason, superseded_by)
    VALUES (${p.id}, ${s.id}, ${s.setNo}, ${s.commitScheme}, ${s.commitment}, ${s.commitSalt}, ${rv!.rulesHash}, ${canonicalJson(oldLayout)}, ${reason}, ${actor.userId})`;
  const layout = generateLayout(await ticketPrizes(tx, p.id));
  if (layout.length !== s.totalTickets) throw new AppError('INVALID_STATE', '籤數與原套不一致，無法重新產生', { expected: s.totalTickets, got: layout.length });
  const salt = generateSalt();
  const commitment = computeCommitment({ scheme: COMMIT_SCHEME, poolId: p.id, setNo: s.setNo, rulesHash: rv!.rulesHash, layout }, salt);
  await tx`SELECT set_config('chiaki.relayout', 'on', true)`;
  await tx`
    UPDATE tickets t SET prize_id = u.p, held_by = NULL, held_until = NULL
    FROM unnest(${layout.map((l) => l.ticketNo)}::int[], ${layout.map((l) => l.prizeId)}::uuid[]) AS u(n, p)
    WHERE t.set_id = ${s.id} AND t.ticket_no = u.n`;
  await tx`UPDATE pool_sets SET commitment = ${commitment}, commit_salt = ${salt}, commit_scheme = ${COMMIT_SCHEME} WHERE id = ${s.id}`;
  await tx`SELECT set_config('chiaki.relayout', 'off', true)`;
  return { oldCommitment: s.commitment, oldSalt: s.commitSalt, newCommitment: commitment };
}

// ───────────── 新增套 ─────────────

export async function addSet(actor: Principal, idOrSlug: string, input: z.input<typeof AddSetSchema>) {
  requirePermission(actor, 'pool.manage');
  const v = AddSetSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    if ((p.status !== 'PUBLISHED' && p.status !== 'ENDED') || !p.currentRuleVersionId) {
      throw new AppError('INVALID_STATE', '只有已發布的賞池可以新增套（草稿請直接修改套數）');
    }
    await lockSets(tx, p.id);
    const [mx] = await tx<{ n: number }[]>`SELECT COALESCE(max(set_no), 0)::int AS n FROM pool_sets WHERE pool_id = ${p.id}`;
    const setNo = mx!.n + 1;
    if (p.setCount >= 1000) throw new AppError('VALIDATION', '每個賞池最多 1000 套');
    const [rv] = await tx<{ rulesHash: string }[]>`SELECT rules_hash FROM pool_rule_versions WHERE id = ${p.currentRuleVersionId}`;
    const layout = generateLayout(await ticketPrizes(tx, p.id));
    const salt = generateSalt();
    const commitment = computeCommitment({ scheme: COMMIT_SCHEME, poolId: p.id, setNo, rulesHash: rv!.rulesHash, layout }, salt);
    const [set] = await tx<{ id: string }[]>`
      INSERT INTO pool_sets (merchant_id, pool_id, set_no, rule_version_id, status, total_tickets, commit_scheme, commitment, commit_salt,
                             ship_fee_home, ship_fee_cvs, ship_refund_div, display_name)
      VALUES (${p.merchantId}, ${p.id}, ${setNo}, ${p.currentRuleVersionId}, 'QUEUED', ${layout.length}, ${COMMIT_SCHEME}, ${commitment}, ${salt},
              ${p.shipFeeHome}, ${p.shipFeeCvs}, ${config().SHIPPING_REFUND_DIV}, ${v.displayName ?? null})
      RETURNING id`;
    await tx`
      INSERT INTO tickets (set_id, ticket_no, prize_id)
      SELECT ${set!.id}::uuid, u.n, u.p FROM unnest(${layout.map((l) => l.ticketNo)}::int[], ${layout.map((l) => l.prizeId)}::uuid[]) AS u(n, p)`;
    await tx`INSERT INTO set_prizes (set_id, prize_id, recycle_value, recyclable) SELECT ${set!.id}::uuid, id, recycle_value, recyclable FROM pool_prizes WHERE pool_id = ${p.id}`;
    await tx`UPDATE pools SET set_count = set_count + 1 WHERE id = ${p.id}`;
    const current = await ensureCurrentSet(tx, p.id);
    await audit(tx, actor, 'SET_ADDED', 'pool_set', set!.id, { poolId: p.id, setNo, commitment, rulesHash: rv!.rulesHash, reason: v.reason });
    return { poolId: p.id, setNo, commitment, status: current === setNo ? 'ON_SALE' : 'QUEUED' };
  });
}

// ───────────── 刪除 / 還原 ─────────────

export async function deleteSet(actor: Principal, idOrSlug: string, setNo: number, input: z.input<typeof ReasonOnlySchema>) {
  requirePermission(actor, 'pool.manage');
  const v = ReasonOnlySchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    const sets = await lockSets(tx, p.id);
    const s = sets.find((x) => x.setNo === setNo && !x.deletedAt);
    if (!s) throw new AppError('NOT_FOUND', 'set not found');
    const sales = await setSales(tx, s.id);
    if (sales > 0) hasSales({ poolId: p.id, setNo, draws: sales });
    const alive = sets.filter((x) => !x.deletedAt);
    if (alive.length === 1) {
      // 賞池至少保留一套：刪除最後一套＝刪除整個賞池
      requirePermission(actor, 'pool.delete');
      return softDeletePool(tx, actor, p, sets, v.reason, { viaLastSet: setNo });
    }
    await tx`UPDATE pool_sets SET deleted_at = now(), delete_reason = ${v.reason} WHERE id = ${s.id}`;
    const released = await releaseSetHolds(tx, [s.id]);
    const current = await ensureCurrentSet(tx, p.id);
    await audit(tx, actor, 'SET_DELETED', 'pool_set', s.id, { poolId: p.id, setNo, reason: v.reason, holdsReleased: released, restorableDays: RESTORE_WINDOW_DAYS });
    return { poolId: p.id, setNo, deleted: true, poolDeleted: false, currentSetNo: current, restorableUntil: new Date(Date.now() + RESTORE_WINDOW_DAYS * 86_400_000) };
  });
}

export async function restoreSet(actor: Principal, idOrSlug: string, setNo: number, input: z.input<typeof ReasonOnlySchema>) {
  requirePermission(actor, 'pool.manage');
  const v = ReasonOnlySchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    await lockSets(tx, p.id);
    const s = await lockSet(tx, p.id, setNo, { allowDeleted: true });
    if (!s.deletedAt) throw new AppError('INVALID_STATE', '此套未被刪除');
    if (s.deletedAt.getTime() < Date.now() - RESTORE_WINDOW_DAYS * 86_400_000) throw new AppError('INVALID_STATE', `已超過 ${RESTORE_WINDOW_DAYS} 天還原期限`);
    // 還原時若已有其他開賣中的套，這一套改為排隊
    const [other] = await tx`SELECT 1 FROM pool_sets WHERE pool_id = ${p.id} AND status = 'ON_SALE' AND deleted_at IS NULL AND id <> ${s.id}`;
    const status = s.status === 'ON_SALE' && other ? 'QUEUED' : s.status;
    await tx`UPDATE pool_sets SET deleted_at = NULL, delete_reason = NULL, status = ${status} WHERE id = ${s.id}`;
    const current = await ensureCurrentSet(tx, p.id);
    await audit(tx, actor, 'SET_RESTORED', 'pool_set', s.id, { poolId: p.id, setNo, reason: v.reason, deletedAt: s.deletedAt.toISOString() });
    return { poolId: p.id, setNo, restored: true, currentSetNo: current };
  });
}

async function softDeletePool(tx: Tx, actor: Principal, p: PoolLock, sets: SetLock[], reason: string, extra: Record<string, unknown> = {}) {
  const sales = await poolSales(tx, p.id);
  if (sales > 0) hasSales({ poolId: p.id, draws: sales });
  await tx`UPDATE pools SET deleted_at = now(), delete_reason = ${reason} WHERE id = ${p.id}`;
  const released = await releaseSetHolds(tx, sets.map((s) => s.id));
  await audit(tx, actor, 'POOL_DELETED', 'pool', p.id, { reason, status: p.status, holdsReleased: released, restorableDays: RESTORE_WINDOW_DAYS, ...extra });
  return { poolId: p.id, deleted: true, poolDeleted: true, restorableUntil: new Date(Date.now() + RESTORE_WINDOW_DAYS * 86_400_000) };
}

export async function deletePool(actor: Principal, idOrSlug: string, input: z.input<typeof ReasonOnlySchema>) {
  requirePermission(actor, 'pool.delete');
  const v = ReasonOnlySchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug);
    const sets = await lockSets(tx, p.id);
    return softDeletePool(tx, actor, p, sets, v.reason);
  });
}

export async function restorePool(actor: Principal, idOrSlug: string, input: z.input<typeof ReasonOnlySchema>) {
  requirePermission(actor, 'pool.delete');
  const v = ReasonOnlySchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPool(tx, idOrSlug, { allowDeleted: true });
    if (!p.deletedAt) throw new AppError('INVALID_STATE', '此賞池未被刪除');
    if (p.deletedAt.getTime() < Date.now() - RESTORE_WINDOW_DAYS * 86_400_000) throw new AppError('INVALID_STATE', `已超過 ${RESTORE_WINDOW_DAYS} 天還原期限`);
    await tx`UPDATE pools SET deleted_at = NULL, delete_reason = NULL WHERE id = ${p.id}`;
    await audit(tx, actor, 'POOL_RESTORED', 'pool', p.id, { reason: v.reason, deletedAt: p.deletedAt.toISOString() });
    return { poolId: p.id, restored: true };
  });
}

// ───────────── 30 天後硬刪除（排程） ─────────────

/**
 * 硬刪除超過還原期限的軟刪除賞池/套（建議每日執行 `npm run job:purge-deleted`；冪等）。
 * 只會刪到 0 銷售的資料（資料庫觸發器在 chiaki.purge 下仍會拒絕任何有 draws 的套或規則版本）。
 */
export async function purgeDeleted(now: Date = new Date()): Promise<{ poolsPurged: number; setsPurged: number }> {
  const cutoff = new Date(now.getTime() - RESTORE_WINDOW_DAYS * 86_400_000);
  let poolsPurged = 0;
  let setsPurged = 0;
  const pools = await transaction((tx) => tx<{ id: string }[]>`SELECT id FROM pools WHERE deleted_at IS NOT NULL AND deleted_at <= ${cutoff} ORDER BY deleted_at`);
  for (const { id } of pools) {
    const done = await transaction(async (tx) => {
      const [p] = await tx<{ id: string; slug: string }[]>`SELECT id, slug FROM pools WHERE id = ${id} AND deleted_at IS NOT NULL AND deleted_at <= ${cutoff} FOR UPDATE`;
      if (!p) return false;
      if ((await poolSales(tx, id)) > 0) return false;
      await tx`SELECT set_config('chiaki.purge', 'on', true)`;
      const sets = await tx<{ id: string }[]>`SELECT id FROM pool_sets WHERE pool_id = ${id} ORDER BY set_no FOR UPDATE`;
      for (const s of sets) await purgeSetRows(tx, s.id);
      await tx`UPDATE pools SET current_rule_version_id = NULL WHERE id = ${id}`;
      await tx`DELETE FROM pool_rule_versions WHERE pool_id = ${id}`;
      await tx`DELETE FROM guarantee_counters WHERE pool_id = ${id}`;
      await tx`DELETE FROM pool_guarantees WHERE pool_id = ${id}`;
      await tx`DELETE FROM pool_prizes WHERE pool_id = ${id}`;
      await tx`DELETE FROM pools WHERE id = ${id}`;
      await tx`SELECT set_config('chiaki.purge', 'off', true)`;
      await appendAudit(tx, { actorType: 'SYSTEM', actorId: 'purge-deleted', action: 'POOL_PURGED', entityType: 'pool', entityId: id, payload: { slug: p.slug, sets: sets.length, olderThanDays: RESTORE_WINDOW_DAYS } });
      return true;
    });
    if (done) poolsPurged++;
  }
  const sets = await transaction((tx) => tx<{ id: string }[]>`SELECT id FROM pool_sets WHERE deleted_at IS NOT NULL AND deleted_at <= ${cutoff} ORDER BY deleted_at`);
  for (const { id } of sets) {
    const done = await transaction(async (tx) => {
      const [s] = await tx<{ id: string; poolId: string; setNo: number }[]>`
        SELECT id, pool_id, set_no FROM pool_sets WHERE id = ${id} AND deleted_at IS NOT NULL AND deleted_at <= ${cutoff} FOR UPDATE`;
      if (!s) return false;
      if ((await setSales(tx, id)) > 0) return false;
      await tx`SELECT set_config('chiaki.purge', 'on', true)`;
      await purgeSetRows(tx, id);
      await tx`SELECT set_config('chiaki.purge', 'off', true)`;
      await tx`UPDATE pools SET set_count = GREATEST(set_count - 1, 1) WHERE id = ${s.poolId}`;
      await appendAudit(tx, { actorType: 'SYSTEM', actorId: 'purge-deleted', action: 'SET_PURGED', entityType: 'pool_set', entityId: id, payload: { poolId: s.poolId, setNo: s.setNo, olderThanDays: RESTORE_WINDOW_DAYS } });
      return true;
    });
    if (done) setsPurged++;
  }
  return { poolsPurged, setsPurged };
}

async function purgeSetRows(tx: Tx, setId: string) {
  await tx`DELETE FROM tickets WHERE set_id = ${setId}`;
  await tx`DELETE FROM set_prizes WHERE set_id = ${setId}`;
  await tx`DELETE FROM pool_sets WHERE id = ${setId}`;
}
