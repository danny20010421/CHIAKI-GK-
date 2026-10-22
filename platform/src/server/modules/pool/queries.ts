import { AppError } from '../../errors';
import type { Db } from '../../db';
import { COMMIT_SCHEME, canonicalLayout, verifyCommitment, type LayoutEntry } from './commitment';
import type { PoolRules } from './rules';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 以 id 或 slug 找到「已公開」的賞池（草稿/待審不對外）。 */
export async function resolvePublicPool(db: Db, idOrSlug: string): Promise<{ id: string; status: string }> {
  const rows = UUID_RE.test(idOrSlug)
    ? await db<{ id: string; status: string }[]>`SELECT id, status FROM pools WHERE id = ${idOrSlug}`
    : await db<{ id: string; status: string }[]>`SELECT id, status FROM pools WHERE slug = ${idOrSlug}`;
  const p = rows[0];
  if (!p || (p.status !== 'PUBLISHED' && p.status !== 'ENDED')) throw new AppError('NOT_FOUND', 'pool not found');
  return p;
}

export interface PoolSummary {
  id: string;
  slug: string;
  title: string;
  ip: string;
  source: string;
  playType: string;
  priceCoins: number;
  status: string;
  setCount: number;
  hasLastPrize: boolean;
  currentSet: { setNo: number; remaining: number; total: number } | null;
}

export async function listPools(db: Db, filter: { source?: string; playType?: string } = {}): Promise<PoolSummary[]> {
  const rows = await db<(Omit<PoolSummary, 'currentSet' | 'hasLastPrize'> & { lastPrizeName: string | null; curSetNo: number | null; curRemaining: number | null; curTotal: number | null })[]>`
    SELECT p.id, p.slug, p.title, p.ip, p.source, p.play_type, p.price_coins, p.status, p.set_count, p.last_prize_name,
           cs.set_no AS cur_set_no, cs.remaining AS cur_remaining, cs.total_tickets AS cur_total
    FROM pools p
    LEFT JOIN LATERAL (
      SELECT s.set_no, s.total_tickets,
             (SELECT count(*)::int FROM tickets t WHERE t.set_id = s.id AND t.status = 'AVAILABLE') AS remaining
      FROM pool_sets s WHERE s.pool_id = p.id AND s.status = 'ON_SALE' ORDER BY s.set_no LIMIT 1
    ) cs ON true
    WHERE p.status IN ('PUBLISHED', 'ENDED')
      ${filter.source ? db`AND p.source = ${filter.source}` : db``}
      ${filter.playType ? db`AND p.play_type = ${filter.playType}` : db``}
    ORDER BY p.published_at DESC NULLS LAST`;
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    ip: r.ip,
    source: r.source,
    playType: r.playType,
    priceCoins: r.priceCoins,
    status: r.status,
    setCount: r.setCount,
    hasLastPrize: r.lastPrizeName !== null,
    currentSet: r.curSetNo ? { setNo: r.curSetNo, remaining: r.curRemaining ?? 0, total: r.curTotal ?? 0 } : null,
  }));
}

export async function getPoolDetail(db: Db, idOrSlug: string) {
  const { id } = await resolvePublicPool(db, idOrSlug);
  const [p] = await db<{
    id: string; slug: string; title: string; ip: string; description: string; source: string; playType: string;
    priceCoins: number; status: string; setCount: number; lastPrizeName: string | null; merchantId: string;
    ruleVersionId: string; ruleVersion: number; rulesHash: string; rulesJson: string;
  }[]>`
    SELECT p.id, p.slug, p.title, p.ip, p.description, p.source, p.play_type, p.price_coins, p.status, p.set_count,
           p.last_prize_name, p.merchant_id, rv.id AS rule_version_id, rv.version AS rule_version, rv.rules_hash, rv.rules_json
    FROM pools p JOIN pool_rule_versions rv ON rv.id = p.current_rule_version_id WHERE p.id = ${id}`;
  if (!p) throw new AppError('NOT_FOUND', 'pool not found');
  const prizes = await db<{ rank: string; tier: number; name: string; qtyPerSet: number }[]>`
    SELECT rank, tier, name, qty_per_set FROM pool_prizes WHERE pool_id = ${id} ORDER BY sort_order, rank`;
  const [g] = await db<{ everyN: number; minTier: number; reserveRank: string; reservePrizeName: string; reserveTotal: number; reserveUsed: number }[]>`
    SELECT every_n, min_tier, reserve_rank, reserve_prize_name, reserve_total, reserve_used FROM pool_guarantees WHERE pool_id = ${id}`;
  const sets = await db<{ setNo: number; status: string; total: number; remaining: number; commitment: string; commitScheme: string; ruleVersionId: string; lastPrizeAwarded: boolean }[]>`
    SELECT s.set_no, s.status, s.total_tickets AS total, s.commitment, s.commit_scheme, s.rule_version_id,
           (s.last_prize_user_id IS NOT NULL) AS last_prize_awarded,
           (SELECT count(*)::int FROM tickets t WHERE t.set_id = s.id AND t.status = 'AVAILABLE') AS remaining
    FROM pool_sets s WHERE s.pool_id = ${id} ORDER BY s.set_no`;
  return {
    id: p.id,
    slug: p.slug,
    merchantId: p.merchantId,
    title: p.title,
    ip: p.ip,
    description: p.description,
    source: p.source,
    playType: p.playType,
    priceCoins: p.priceCoins,
    status: p.status,
    setCount: p.setCount,
    prizes,
    lastPrize: p.lastPrizeName ? { name: p.lastPrizeName, rule: '每套抽出最後一籤者獲得' } : null,
    guarantee: g
      ? { everyN: g.everyN, minTier: g.minTier, reserveRank: g.reserveRank, reservePrizeName: g.reservePrizeName, reserveTotal: g.reserveTotal, reserveRemaining: g.reserveTotal - g.reserveUsed }
      : null,
    rules: { ruleVersionId: p.ruleVersionId, version: p.ruleVersion, rulesHash: p.rulesHash, content: JSON.parse(p.rulesJson) as PoolRules },
    sets,
  };
}

export type TicketState = 'AVAILABLE' | 'HELD' | 'TAKEN';

/**
 * 單套即時狀態：剩餘數、即時機率（某賞剩餘 / 總剩餘）與籤板。
 * 未抽出的籤「絕不」回傳獎項；已抽出的籤顯示賞級（與實體一番賞相同）。
 */
export async function getSetBoard(db: Db, idOrSlug: string, setNo: number, viewerId?: string | null) {
  const { id: poolId } = await resolvePublicPool(db, idOrSlug);
  const [s] = await db<{ id: string; setNo: number; status: string; total: number; commitment: string; commitScheme: string; rulesHash: string; ruleVersion: number; lastPrizeName: string | null; lastPrizeAwarded: boolean; soldOutAt: Date | null }[]>`
    SELECT s.id, s.set_no, s.status, s.total_tickets AS total, s.commitment, s.commit_scheme, rv.rules_hash, rv.version AS rule_version,
           p.last_prize_name, (s.last_prize_user_id IS NOT NULL) AS last_prize_awarded, s.sold_out_at
    FROM pool_sets s JOIN pools p ON p.id = s.pool_id JOIN pool_rule_versions rv ON rv.id = s.rule_version_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${setNo}`;
  if (!s) throw new AppError('NOT_FOUND', 'set not found');

  const byPrize = await db<{ rank: string; tier: number; name: string; total: number; remaining: number }[]>`
    SELECT pr.rank, pr.tier, pr.name, count(t.*)::int AS total,
           count(t.*) FILTER (WHERE t.status = 'AVAILABLE')::int AS remaining
    FROM pool_prizes pr JOIN tickets t ON t.prize_id = pr.id AND t.set_id = ${s.id}
    GROUP BY pr.rank, pr.tier, pr.name, pr.sort_order ORDER BY pr.sort_order, pr.rank`;
  const totalRemaining = byPrize.reduce((a, b) => a + b.remaining, 0);

  const tickets = await db<{ ticketNo: number; status: string; heldActive: boolean; heldByMe: boolean; rank: string | null }[]>`
    SELECT t.ticket_no, t.status,
           (t.status = 'AVAILABLE' AND t.held_by IS NOT NULL AND t.held_until > now()) AS held_active,
           (t.status = 'AVAILABLE' AND t.held_by IS NOT NULL AND t.held_until > now() AND t.held_by = ${viewerId ?? null}::uuid) AS held_by_me,
           CASE WHEN t.status = 'TAKEN' THEN pr.rank END AS rank
    FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id
    WHERE t.set_id = ${s.id} ORDER BY t.ticket_no`;

  return {
    poolId,
    setNo: s.setNo,
    status: s.status,
    total: s.total,
    remaining: totalRemaining,
    commitment: { scheme: s.commitScheme, hash: s.commitment, rulesHash: s.rulesHash, ruleVersion: s.ruleVersion },
    prizes: byPrize.map((p) => ({
      rank: p.rank,
      tier: p.tier,
      name: p.name,
      total: p.total,
      remaining: p.remaining,
      probability: totalRemaining ? Math.round((p.remaining / totalRemaining) * 1e6) / 1e6 : 0,
    })),
    lastPrize: s.lastPrizeName ? { name: s.lastPrizeName, awarded: s.lastPrizeAwarded } : null,
    tickets: tickets.map((t) => {
      const state: TicketState = t.status === 'TAKEN' ? 'TAKEN' : t.heldActive ? 'HELD' : 'AVAILABLE';
      return { no: t.ticketNo, state, ...(t.heldByMe ? { heldByMe: true } : {}), ...(t.rank ? { rank: t.rank } : {}) };
    }),
    soldOutAt: s.soldOutAt,
  };
}

/** 完售後才可揭露：完整籤表、salt 與重算結果。 */
export async function revealSet(db: Db, idOrSlug: string, setNo: number) {
  const { id: poolId } = await resolvePublicPool(db, idOrSlug);
  const [s] = await db<{ id: string; status: string; commitment: string; commitSalt: string; commitScheme: string; rulesHash: string; rulesJson: string }[]>`
    SELECT s.id, s.status, s.commitment, s.commit_salt, s.commit_scheme, rv.rules_hash, rv.rules_json
    FROM pool_sets s JOIN pool_rule_versions rv ON rv.id = s.rule_version_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${setNo}`;
  if (!s) throw new AppError('NOT_FOUND', 'set not found');
  if (s.status !== 'SOLD_OUT') throw new AppError('NOT_SOLD_OUT', '本套尚未完售，籤表與 salt 於完售後公開');
  if (s.commitScheme !== COMMIT_SCHEME) throw new AppError('INVALID_STATE', `unknown commit scheme ${s.commitScheme}`);
  const layout = await db<LayoutEntry[]>`
    SELECT t.ticket_no, pr.rank, t.prize_id FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id
    WHERE t.set_id = ${s.id} ORDER BY t.ticket_no`;
  const input = { poolId, setNo, rulesHash: s.rulesHash, layout };
  return {
    scheme: s.commitScheme,
    poolId,
    setNo,
    rulesHash: s.rulesHash,
    rules: JSON.parse(s.rulesJson) as PoolRules,
    commitment: s.commitment,
    salt: s.commitSalt,
    layout,
    canonical: canonicalLayout(input),
    verified: verifyCommitment(input, s.commitSalt, s.commitment),
    howToVerify: 'sha256(canonical + "\\n" + salt) === commitment；或執行 npm run verify:set -- <reveal.json>',
  };
}
