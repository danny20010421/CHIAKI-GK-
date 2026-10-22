import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors';
import { db, transaction, type Db } from '../../db';
import { canonicalJson, sha256Hex } from '../../lib/canonical';
import { appendAudit } from '../audit/audit';
import { displayName, type Grade } from '../pool/grades';

/**
 * 抽賞紀錄保存與會員可見範圍（業主規則：會員只能看到近 3 個月）。
 *
 * ⚠ 決策：不刪除任何抽賞/帳務資料。台灣商業會計法要求會計憑證與帳簿保存多年（憑證 5 年、帳簿與報表 10 年），
 *   抽賞爭議與消保申訴也需要原始紀錄作證據；draws / draw_results / wallet_ledger / audit_log 均為 append-only。
 *   做法：
 *    - 會員 API 一律只查 member_draw_history（近 90 天且未封存的 view），超過即「看不到」（最舊的最先消失）。
 *    - 封存工作 runDrawArchive 把 90 天以前的抽賞「標記封存」（draw_archive 新增一列，append-only），原始列不動，
 *      稽核雜湊鏈不受影響；封存批次本身也寫一筆稽核（含封存 id 清單雜湊）。後台/稽核仍可查完整紀錄。
 */
export const MEMBER_VISIBLE_DAYS = 90;

export async function runDrawArchive(now: Date = new Date(), batchLimit = 5000): Promise<{ archived: number; batchId: string | null }> {
  return transaction(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      SELECT d.id FROM draws d
      WHERE d.created_at <= ${now}::timestamptz - make_interval(days => ${MEMBER_VISIBLE_DAYS})
        AND NOT EXISTS (SELECT 1 FROM draw_archive a WHERE a.draw_id = d.id)
      ORDER BY d.created_at, d.id LIMIT ${batchLimit}
      FOR UPDATE OF d SKIP LOCKED`;
    if (!rows.length) return { archived: 0, batchId: null };
    const batchId = randomUUID();
    const ins = await tx`
      INSERT INTO draw_archive (draw_id, user_id, batch_id, draw_created_at)
      SELECT d.id, d.user_id, ${batchId}, d.created_at FROM draws d WHERE d.id = ANY(${rows.map((r) => r.id)}::uuid[])
      ON CONFLICT (draw_id) DO NOTHING RETURNING draw_id`;
    const ids = ins.map((r) => r.drawId as string).sort();
    await appendAudit(tx, {
      actorType: 'SYSTEM',
      actorId: 'draw-archive',
      action: 'DRAW_HISTORY_ARCHIVED',
      entityType: 'draw_archive_batch',
      entityId: batchId,
      payload: { count: ids.length, idsHash: sha256Hex(canonicalJson(ids)), olderThanDays: MEMBER_VISIBLE_DAYS, runAt: now.toISOString() },
    });
    return { archived: ids.length, batchId };
  });
}

export interface MemberDrawRow {
  drawId: string;
  poolId: string;
  poolTitle: string;
  setNo: number;
  ticketCount: number;
  amountCoins: number;
  shippingCoins: number;
  createdAt: Date;
  results: { seq: number; kind: string; ticketNo: number | null; grade: Grade; displayName: string }[];
}

/** 會員：近 3 個月的抽賞紀錄（新到舊、分頁） */
export async function listMemberDraws(d: Db, userId: string, opts: { limit?: number; before?: Date; drawId?: string } = {}): Promise<{ visibleDays: number; draws: MemberDrawRow[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const draws = await d<{ id: string; poolId: string; poolTitle: string; source: string; setNo: number; ticketCount: number; amountCoins: number; shippingCoins: number; createdAt: Date }[]>`
    SELECT h.id, h.pool_id, p.title AS pool_title, p.source, s.set_no, h.ticket_count, h.amount_coins, h.shipping_coins, h.created_at
    FROM member_draw_history h JOIN pools p ON p.id = h.pool_id JOIN pool_sets s ON s.id = h.set_id
    WHERE h.user_id = ${userId} ${opts.before ? d`AND h.created_at < ${opts.before}` : d``} ${opts.drawId ? d`AND h.id = ${opts.drawId}` : d``}
    ORDER BY h.created_at DESC, h.id LIMIT ${limit}`;
  const results = draws.length
    ? await d<{ drawId: string; seq: number; kind: string; ticketNo: number | null; rank: string | null; grade: Grade; prizeName: string }[]>`
        SELECT draw_id, seq, kind, ticket_no, rank, grade, prize_name FROM draw_results WHERE draw_id = ANY(${draws.map((x) => x.id)}::uuid[]) ORDER BY draw_id, seq`
    : [];
  return {
    visibleDays: MEMBER_VISIBLE_DAYS,
    draws: draws.map((x) => ({
      drawId: x.id,
      poolId: x.poolId,
      poolTitle: x.poolTitle,
      setNo: x.setNo,
      ticketCount: x.ticketCount,
      amountCoins: x.amountCoins,
      shippingCoins: x.shippingCoins,
      createdAt: x.createdAt,
      results: results.filter((r) => r.drawId === x.id).map((r) => ({ seq: r.seq, kind: r.kind, ticketNo: r.ticketNo, grade: r.grade, displayName: displayName(x.source, r.rank, r.prizeName) })),
    })),
  };
}

/** 會員：單筆抽賞（超過可見範圍 → 404，與不存在相同） */
export async function getMemberDraw(d: Db, userId: string, drawId: string): Promise<MemberDrawRow> {
  const page = await listMemberDraws(d, userId, { limit: 1, drawId });
  if (!page.draws[0]) throw new AppError('NOT_FOUND', 'draw not found');
  return page.draws[0];
}
