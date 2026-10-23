import { AppError } from '../../errors';
import type { Db } from '../../db';
import { COMMIT_SCHEME, canonicalLayout, verifyCommitment, type LayoutEntry } from './commitment';
import type { PoolRules } from './rules';
import { displayName, type Grade } from './grades';
import { distinctCategories, type ProductCategory } from '../catalog/categories';

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
  ipId: string | null;
  source: string;
  playType: string;
  priceCoins: number;
  status: string;
  setCount: number;
  hasLastPrize: boolean;
  /** 出貨時程說明（無固定 SLA） */
  shippingNote: string;
  /** 獎項的商品分類集合（GK、PVC…，依固定順序） */
  categories: ProductCategory[];
  /** 是否含大件・限宅配獎項 */
  hasBulky: boolean;
  currentSet: { setNo: number; remaining: number; total: number } | null;
}

export async function listPools(db: Db, filter: { source?: string; playType?: string; ipId?: string; ipCategory?: string } = {}): Promise<PoolSummary[]> {
  const rows = await db<(Omit<PoolSummary, 'currentSet' | 'hasLastPrize' | 'categories'> & { categories: string[]; lastPrizeName: string | null; curSetNo: number | null; curRemaining: number | null; curTotal: number | null })[]>`
    SELECT p.id, p.slug, p.title, p.ip, p.ip_id, p.source, p.play_type, p.price_coins, p.status, p.set_count, p.last_prize_name, p.shipping_note,
           cs.set_no AS cur_set_no, cs.remaining AS cur_remaining, cs.total_tickets AS cur_total,
           (SELECT COALESCE(array_agg(DISTINCT pp.category) FILTER (WHERE pp.category IS NOT NULL), '{}') FROM pool_prizes pp WHERE pp.pool_id = p.id) AS categories,
           (SELECT COALESCE(bool_or(pp.bulky), false) FROM pool_prizes pp WHERE pp.pool_id = p.id) AS has_bulky
    FROM pools p
    LEFT JOIN LATERAL (
      SELECT s.set_no, s.total_tickets,
             (SELECT count(*)::int FROM tickets t WHERE t.set_id = s.id AND t.status = 'AVAILABLE') AS remaining
      FROM pool_sets s WHERE s.pool_id = p.id AND s.status = 'ON_SALE' ORDER BY s.set_no LIMIT 1
    ) cs ON true
    WHERE p.status IN ('PUBLISHED', 'ENDED')
      ${filter.source ? db`AND p.source = ${filter.source}` : db``}
      ${filter.playType ? db`AND p.play_type = ${filter.playType}` : db``}
      ${filter.ipId ? db`AND p.ip_id = ${filter.ipId}` : db``}
      ${filter.ipCategory ? db`AND p.ip_id IN (SELECT id FROM ips WHERE category = ${filter.ipCategory})` : db``}
    ORDER BY p.published_at DESC NULLS LAST`;
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    ip: r.ip,
    ipId: r.ipId,
    source: r.source,
    playType: r.playType,
    priceCoins: r.priceCoins,
    status: r.status,
    setCount: r.setCount,
    hasLastPrize: r.lastPrizeName !== null,
    shippingNote: r.shippingNote,
    categories: distinctCategories(r.categories),
    hasBulky: r.hasBulky,
    currentSet: r.curSetNo ? { setNo: r.curSetNo, remaining: r.curRemaining ?? 0, total: r.curTotal ?? 0 } : null,
  }));
}

interface PrizeRow {
  id: string;
  kind: 'TICKET' | 'LAST' | 'GUARANTEE';
  rank: string | null;
  grade: Grade;
  name: string;
  qtyPerSet: number;
  category: ProductCategory | null;
  bulky: boolean;
}

export async function getPoolDetail(db: Db, idOrSlug: string) {
  const { id } = await resolvePublicPool(db, idOrSlug);
  const [p] = await db<{
    id: string; slug: string; title: string; ip: string; description: string; source: string; playType: string;
    priceCoins: number; status: string; setCount: number; lastPrizeName: string | null; merchantId: string; shippingNote: string;
    ruleVersionId: string; ruleVersion: number; rulesHash: string; rulesJson: string;
  }[]>`
    SELECT p.id, p.slug, p.title, p.ip, p.description, p.source, p.play_type, p.price_coins, p.status, p.set_count,
           p.last_prize_name, p.merchant_id, p.shipping_note, rv.id AS rule_version_id, rv.version AS rule_version, rv.rules_hash, rv.rules_json
    FROM pools p JOIN pool_rule_versions rv ON rv.id = p.current_rule_version_id WHERE p.id = ${id}`;
  if (!p) throw new AppError('NOT_FOUND', 'pool not found');
  const all = await db<PrizeRow[]>`
    SELECT id, kind, rank, grade, name, qty_per_set, category, bulky FROM pool_prizes WHERE pool_id = ${id} ORDER BY sort_order, name`;
  const show = (r: PrizeRow) => ({ prizeId: r.id, rank: r.rank, grade: r.grade, name: r.name, displayName: displayName(p.source, r.rank, r.name), category: r.category, bulky: r.bulky });
  const last = all.find((r) => r.kind === 'LAST');
  const [g] = await db<{ everyN: number; minGrade: Grade; reservePrizeId: string; reserveTotal: number; reserveUsed: number }[]>`
    SELECT every_n, min_grade, reserve_prize_id, reserve_total, reserve_used FROM pool_guarantees WHERE pool_id = ${id}`;
  const reserve = g ? all.find((r) => r.id === g.reservePrizeId) : undefined;
  const sets = await db<{ setNo: number; status: string; total: number; remaining: number; commitment: string; commitScheme: string; ruleVersionId: string; lastPrizeAwarded: boolean; shipFeeHome: number; shipFeeCvs: number }[]>`
    SELECT s.set_no, s.status, s.total_tickets AS total, s.commitment, s.commit_scheme, s.rule_version_id,
           (s.last_prize_user_id IS NOT NULL) AS last_prize_awarded, s.ship_fee_home, s.ship_fee_cvs,
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
    shippingNote: p.shippingNote,
    categories: distinctCategories(all.map((r) => r.category)),
    hasBulky: all.some((r) => r.bulky),
    prizes: all.filter((r) => r.kind === 'TICKET').map((r) => ({ ...show(r), qtyPerSet: r.qtyPerSet })),
    lastPrize: last ? { ...show(last), rule: '每套抽出最後一籤者獲得' } : null,
    guarantee:
      g && reserve
        ? {
            everyN: g.everyN,
            minGrade: g.minGrade,
            reservePrize: show(reserve),
            reservePrizeName: reserve.name,
            reserveGrade: reserve.grade,
            reserveTotal: g.reserveTotal,
            reserveRemaining: g.reserveTotal - g.reserveUsed,
          }
        : null,
    shippingPolicy: { mode: 'PREPAID_PER_SET', note: '運費於本套首次付費抽賞時預收；需要份數 = floor((本套抽到過的全部小獎 + 本次籤數) / 20) + 1（滿 20 件即再收一份；大獎/中獎不計入，已回收的小獎仍計入）；回收小獎每件退還 運費 ÷ N 代幣（不可退款）', rules: (JSON.parse(p.rulesJson) as PoolRules).shippingPolicy ?? null },
    rules: { ruleVersionId: p.ruleVersionId, version: p.ruleVersion, rulesHash: p.rulesHash, content: JSON.parse(p.rulesJson) as PoolRules },
    sets: sets.map(({ shipFeeHome, shipFeeCvs, ...s }) => ({ ...s, shippingFees: { HOME_DELIVERY: shipFeeHome, CVS_711_C2C: shipFeeCvs, CVS_FAMI_C2C: shipFeeCvs } })),
  };
}

export type TicketState = 'AVAILABLE' | 'HELD' | 'TAKEN';

/**
 * 單套即時狀態：剩餘數、即時機率（某賞剩餘 / 總剩餘）與籤板。
 * 未抽出的籤「絕不」回傳獎項；已抽出的籤顯示賞級（與實體一番賞相同）。
 */
export async function getSetBoard(db: Db, idOrSlug: string, setNo: number, viewerId?: string | null) {
  const { id: poolId } = await resolvePublicPool(db, idOrSlug);
  const [s] = await db<{ id: string; setNo: number; status: string; total: number; commitment: string; commitScheme: string; rulesHash: string; ruleVersion: number; lastPrizeName: string | null; lastPrizeAwarded: boolean; soldOutAt: Date | null; source: string; shippingNote: string; shipFeeHome: number; shipFeeCvs: number }[]>`
    SELECT s.id, s.set_no, s.status, s.total_tickets AS total, s.commitment, s.commit_scheme, rv.rules_hash, rv.version AS rule_version,
           p.last_prize_name, (s.last_prize_user_id IS NOT NULL) AS last_prize_awarded, s.sold_out_at, p.source, p.shipping_note,
           s.ship_fee_home, s.ship_fee_cvs
    FROM pool_sets s JOIN pools p ON p.id = s.pool_id JOIN pool_rule_versions rv ON rv.id = s.rule_version_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${setNo}`;
  if (!s) throw new AppError('NOT_FOUND', 'set not found');

  const byPrize = await db<{ prizeId: string; rank: string | null; grade: Grade; name: string; total: number; remaining: number; recycleValue: number; recyclable: boolean }[]>`
    SELECT pr.id AS prize_id, pr.rank, pr.grade, pr.name, count(t.*)::int AS total,
           count(t.*) FILTER (WHERE t.status = 'AVAILABLE')::int AS remaining, sp.recycle_value, sp.recyclable
    FROM pool_prizes pr JOIN tickets t ON t.prize_id = pr.id AND t.set_id = ${s.id}
    LEFT JOIN set_prizes sp ON sp.set_id = ${s.id} AND sp.prize_id = pr.id
    GROUP BY pr.id, pr.rank, pr.grade, pr.name, pr.sort_order, sp.recycle_value, sp.recyclable ORDER BY pr.sort_order, pr.name`;
  const [lastPrize] = await db<{ prizeId: string; rank: string | null; grade: Grade; name: string; recycleValue: number | null; recyclable: boolean | null }[]>`
    SELECT pr.id AS prize_id, pr.rank, pr.grade, pr.name, sp.recycle_value, sp.recyclable
    FROM pool_prizes pr LEFT JOIN set_prizes sp ON sp.set_id = ${s.id} AND sp.prize_id = pr.id
    WHERE pr.pool_id = ${poolId} AND pr.kind = 'LAST'`;
  const totalRemaining = byPrize.reduce((a, b) => a + b.remaining, 0);

  const tickets = await db<{ ticketNo: number; status: string; heldActive: boolean; heldByMe: boolean; rank: string | null; grade: Grade | null; name: string | null }[]>`
    SELECT t.ticket_no, t.status,
           (t.status = 'AVAILABLE' AND t.held_by IS NOT NULL AND t.held_until > now()) AS held_active,
           (t.status = 'AVAILABLE' AND t.held_by IS NOT NULL AND t.held_until > now() AND t.held_by = ${viewerId ?? null}::uuid) AS held_by_me,
           CASE WHEN t.status = 'TAKEN' THEN pr.rank END AS rank,
           CASE WHEN t.status = 'TAKEN' THEN pr.grade END AS grade,
           CASE WHEN t.status = 'TAKEN' THEN pr.name END AS name
    FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id
    WHERE t.set_id = ${s.id} ORDER BY t.ticket_no`;

  return {
    poolId,
    setNo: s.setNo,
    status: s.status,
    total: s.total,
    remaining: totalRemaining,
    commitment: { scheme: s.commitScheme, hash: s.commitment, rulesHash: s.rulesHash, ruleVersion: s.ruleVersion },
    shippingNote: s.shippingNote,
    shippingFees: { HOME_DELIVERY: s.shipFeeHome, CVS_711_C2C: s.shipFeeCvs, CVS_FAMI_C2C: s.shipFeeCvs },
    // 籤板不輸出 prizeId（獎項 id 只出現在賞池詳情的規則內容），避免任何籤號↔獎項的關聯線索
    prizes: byPrize.map((p) => ({
      rank: p.rank,
      grade: p.grade,
      name: p.name,
      displayName: displayName(s.source, p.rank, p.name),
      total: p.total,
      remaining: p.remaining,
      probability: totalRemaining ? Math.round((p.remaining / totalRemaining) * 1e6) / 1e6 : 0,
      recycleValue: p.recycleValue,
      recyclable: p.recyclable,
    })),
    lastPrize: lastPrize
      ? { rank: lastPrize.rank, grade: lastPrize.grade, name: lastPrize.name, displayName: displayName(s.source, lastPrize.rank, lastPrize.name), awarded: s.lastPrizeAwarded, recycleValue: lastPrize.recycleValue, recyclable: lastPrize.recyclable }
      : null,
    tickets: tickets.map((t) => {
      const state: TicketState = t.status === 'TAKEN' ? 'TAKEN' : t.heldActive ? 'HELD' : 'AVAILABLE';
      // 已抽出的籤公開獎項（等級＋顯示名稱）；未抽出的籤絕不揭露
      const prize = state === 'TAKEN' && t.grade && t.name ? { grade: t.grade, displayName: displayName(s.source, t.rank, t.name), ...(t.rank ? { rank: t.rank } : {}) } : {};
      return { no: t.ticketNo, state, ...(t.heldByMe ? { heldByMe: true } : {}), ...prize };
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
