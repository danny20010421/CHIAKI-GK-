import { AppError } from '../../errors';
import type { Db } from '../../db';
import { COMMIT_SCHEME_V1, COMMIT_SCHEMES, canonicalLayout, verifyCommitment, type CommitScheme, type LayoutEntry } from './commitment';
import type { PoolRules } from './rules';
import { displayName, LAST_PRIZE_LABEL } from './levels';
import { distinctTags, type Tag } from '../catalog/tags';
import { drawPacksOut } from './admin';
import { effectiveProbabilities, PROB_SCHEME, replayProbSet } from './prob';
import { FREIGHT_COLLECT_NOTE, SHIP_METHOD_LABEL, SHIP_METHODS, type ShipMethod } from '../shipping/methods';
import { oddsAccess } from '../vip/vip';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 以 id 或 slug 找到「已公開」的賞池（草稿/待審/已刪除不對外；下架者仍可直接開啟與驗證，但不在列表中、不可抽）。 */
export async function resolvePublicPool(db: Db, idOrSlug: string): Promise<{ id: string; status: string; offline: boolean }> {
  const rows = UUID_RE.test(idOrSlug)
    ? await db<{ id: string; status: string; offline: boolean }[]>`SELECT id, status, offline FROM pools WHERE id = ${idOrSlug} AND deleted_at IS NULL`
    : await db<{ id: string; status: string; offline: boolean }[]>`SELECT id, status, offline FROM pools WHERE slug = ${idOrSlug} AND deleted_at IS NULL`;
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
  /** 標籤集合（獎項標籤的聯集；官方賞池含「一番賞」；依固定順序） */
  tags: Tag[];
  /** 快速抽包選項（1、3、5、10、20、'all'） */
  drawPacks: (number | 'all')[];
  /** 是否含大件・限宅配獎項 */
  hasBulky: boolean;
  /** 抽賞演出：KUJI（籤紙）/ VIDEO（播放抽卡影片） */
  animation: 'KUJI' | 'VIDEO';
  currentSet: { setNo: number; remaining: number; total: number } | null;
}

export async function listPools(db: Db, filter: { source?: string; playType?: string; ipId?: string; tag?: string } = {}): Promise<PoolSummary[]> {
  const rows = await db<(Omit<PoolSummary, 'currentSet' | 'hasLastPrize' | 'tags' | 'drawPacks'> & { tags: string[]; drawPacks: string[]; lastPrizeName: string | null; curSetNo: number | null; curRemaining: number | null; curTotal: number | null })[]>`
    SELECT p.id, p.slug, p.title, p.ip, p.ip_id, p.source, p.play_type, p.price_coins, p.status, p.set_count, p.last_prize_name, p.shipping_note, p.draw_packs, p.animation,
           cs.set_no AS cur_set_no, cs.remaining AS cur_remaining, cs.total_tickets AS cur_total,
           (SELECT COALESCE(array_agg(DISTINCT pp.tag) FILTER (WHERE pp.tag IS NOT NULL), '{}') FROM pool_prizes pp WHERE pp.pool_id = p.id) AS tags,
           (SELECT COALESCE(bool_or(pp.bulky), false) FROM pool_prizes pp WHERE pp.pool_id = p.id) AS has_bulky
    FROM pools p
    LEFT JOIN LATERAL (
      SELECT s.set_no, s.total_tickets,
             (SELECT count(*)::int FROM tickets t WHERE t.set_id = s.id AND t.status = 'AVAILABLE') AS remaining
      FROM pool_sets s WHERE s.pool_id = p.id AND s.status = 'ON_SALE' AND NOT s.offline AND s.deleted_at IS NULL ORDER BY s.set_no LIMIT 1
    ) cs ON true
    WHERE p.status IN ('PUBLISHED', 'ENDED') AND NOT p.offline AND p.deleted_at IS NULL
      ${filter.source ? db`AND p.source = ${filter.source}` : db``}
      ${filter.playType ? db`AND p.play_type = ${filter.playType}` : db``}
      ${filter.ipId ? db`AND p.ip_id = ${filter.ipId}` : db``}
      ${filter.tag === '一番賞' ? db`AND (p.source = 'OFFICIAL' OR EXISTS (SELECT 1 FROM pool_prizes pp WHERE pp.pool_id = p.id AND pp.tag = '一番賞'))` : filter.tag ? db`AND EXISTS (SELECT 1 FROM pool_prizes pp WHERE pp.pool_id = p.id AND pp.tag = ${filter.tag})` : db``}
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
    tags: distinctTags(r.tags, r.source),
    drawPacks: drawPacksOut(r.drawPacks),
    hasBulky: r.hasBulky,
    animation: r.animation,
    currentSet: r.curSetNo ? { setNo: r.curSetNo, remaining: r.curRemaining ?? 0, total: r.curTotal ?? 0 } : null,
  }));
}

interface PrizeRow {
  id: string;
  kind: 'TICKET' | 'LAST' | 'GUARANTEE';
  levelNo: number | null;
  levelName: string | null;
  isSmall: boolean | null;
  name: string;
  qtyPerSet: number;
  tag: Tag | null;
  bulky: boolean;
  shipMethod: ShipMethod;
  imageUrl: string | null;
}

/** 對外的獎項表示：等級號、等級名稱、是否小獎、名稱、顯示名稱、標籤、大件、寄送方式、圖片 */
export function showPrize(r: Pick<PrizeRow, 'kind' | 'levelNo' | 'levelName' | 'isSmall' | 'name' | 'tag' | 'bulky' | 'shipMethod' | 'imageUrl'> & { id?: string }) {
  const levelName = r.kind === 'LAST' ? LAST_PRIZE_LABEL : r.levelName;
  return {
    ...(r.id ? { prizeId: r.id } : {}),
    levelNo: r.levelNo,
    levelName,
    isSmall: r.isSmall ?? false,
    name: r.name,
    displayName: displayName(levelName, r.name),
    tag: r.tag,
    bulky: r.bulky,
    /** 寄送方式（上架時預設，會員不可選；運費到付） */
    shipMethod: r.shipMethod,
    shipMethodLabel: SHIP_METHOD_LABEL[r.shipMethod],
    imageUrl: r.imageUrl,
  };
}

/**
 * 賞池詳情（公開）。不含回收值（回收值只在抽賞結果與會員自己的倉庫顯示）。
 * oddsLocked / oddsUnlockLevel：即時機率（籤板 GET /api/pools/:id/sets/:no）只對 VIP 解鎖等級以上的會員顯示。
 */
export async function getPoolDetail(db: Db, idOrSlug: string, viewerId?: string | null) {
  const { id } = await resolvePublicPool(db, idOrSlug);
  const access = await oddsAccess(db, viewerId);
  const [p] = await db<{
    id: string; slug: string; title: string; ip: string; description: string; sourceNote: string; condition: string; source: string; playType: string; drawPacks: string[]; offline: boolean;
    priceCoins: number; status: string; setCount: number; lastPrizeName: string | null; merchantId: string; shippingNote: string; animation: 'KUJI' | 'VIDEO';
    ruleVersionId: string; ruleVersion: number; rulesHash: string; rulesJson: string;
  }[]>`
    SELECT p.id, p.slug, p.title, p.ip, p.description, p.source_note, p.item_condition AS condition, p.source, p.play_type, p.price_coins, p.status, p.set_count, p.draw_packs, p.offline,
           p.last_prize_name, p.merchant_id, p.shipping_note, p.animation, rv.id AS rule_version_id, rv.version AS rule_version, rv.rules_hash, rv.rules_json
    FROM pools p JOIN pool_rule_versions rv ON rv.id = p.current_rule_version_id WHERE p.id = ${id}`;
  if (!p) throw new AppError('NOT_FOUND', 'pool not found');
  const all = await db<PrizeRow[]>`
    SELECT pp.id, pp.kind, pl.level_no, pl.name AS level_name, pl.is_small, pp.name, pp.qty_per_set, pp.tag, pp.bulky, pp.ship_method, pp.image_url
    FROM pool_prizes pp LEFT JOIN pool_levels pl ON pl.id = pp.level_id
    WHERE pp.pool_id = ${id} ORDER BY pl.level_no NULLS LAST, pp.sort_order, pp.name`;
  const levels = await db<{ levelNo: number; name: string; isSmall: boolean; odds: number | null }[]>`
    SELECT level_no, name, is_small, odds FROM pool_levels WHERE pool_id = ${id} ORDER BY level_no`;
  const last = all.find((r) => r.kind === 'LAST');
  const [g] = await db<{ everyN: number; minLevel: number; reservePrizeId: string; reserveTotal: number; reserveUsed: number }[]>`
    SELECT every_n, min_level, reserve_prize_id, reserve_total, reserve_used FROM pool_guarantees WHERE pool_id = ${id}`;
  const reserve = g ? all.find((r) => r.id === g.reservePrizeId) : undefined;
  const sets = await db<{ setNo: number; displayName: string | null; offline: boolean; status: string; total: number; remaining: number; commitment: string; commitScheme: string; probSeedHash: string | null; ruleVersionId: string; lastPrizeAwarded: boolean }[]>`
    SELECT s.set_no, s.display_name, s.offline, s.status, s.total_tickets AS total, s.commitment, s.commit_scheme, s.prob_seed_hash, s.rule_version_id,
           (s.last_prize_user_id IS NOT NULL) AS last_prize_awarded,
           (SELECT count(*)::int FROM tickets t WHERE t.set_id = s.id AND t.status = 'AVAILABLE') AS remaining
    FROM pool_sets s WHERE s.pool_id = ${id} AND s.deleted_at IS NULL ORDER BY s.set_no`;
  const tickets = all.filter((r) => r.kind === 'TICKET');
  return {
    id: p.id,
    slug: p.slug,
    merchantId: p.merchantId,
    title: p.title,
    ip: p.ip,
    description: p.description,
    /** 來源說明、商品狀態、出貨時程說明（後台隨時可改） */
    sourceNote: p.sourceNote,
    condition: p.condition,
    source: p.source,
    playType: p.playType,
    priceCoins: p.priceCoins,
    status: p.status,
    /** 已下架：不在列表中、不可鎖籤或抽（既有紀錄不受影響） */
    offline: p.offline,
    setCount: p.setCount,
    shippingNote: p.shippingNote,
    drawPacks: drawPacksOut(p.drawPacks),
    /** 抽賞演出：KUJI（籤紙）/ VIDEO（播放抽卡影片，卡牌賞池） */
    animation: p.animation,
    tags: distinctTags(all.map((r) => r.tag), p.source),
    hasBulky: all.some((r) => r.bulky),
    /** 本賞池獎項用到的寄送方式 */
    shipMethods: SHIP_METHODS.filter((m) => all.some((r) => r.shipMethod === m)),
    levels: levels.map((l) => ({
      levelNo: l.levelNo,
      name: l.name,
      isSmall: l.isSmall,
      /** 機率賞：固定單抽機率（null＝平均分配剩餘機率） */
      odds: l.odds,
      items: tickets.filter((r) => r.levelNo === l.levelNo).map((r) => ({ ...showPrize(r), qtyPerSet: r.qtyPerSet })),
    })),
    prizes: tickets.map((r) => ({ ...showPrize(r), qtyPerSet: r.qtyPerSet })),
    lastPrize: last ? { ...showPrize(last), rule: '每套抽出最後一籤者獲得' } : null,
    guarantee:
      g && reserve
        ? {
            everyN: g.everyN,
            minLevel: g.minLevel,
            reservePrize: showPrize(reserve),
            reservePrizeName: reserve.name,
            reserveTotal: g.reserveTotal,
            reserveRemaining: g.reserveTotal - g.reserveUsed,
          }
        : null,
    shippingPolicy: { mode: 'FREIGHT_COLLECT', freightCollect: true, note: `${FREIGHT_COLLECT_NOTE}；寄送方式依每個獎項預設，不同寄送方式的獎品會分開出貨` },
    /** 即時機率是否對目前觀看者鎖定（VIP oddsUnlockLevel 以上解鎖）；剩餘/總數一律公開 */
    oddsLocked: access.oddsLocked,
    oddsUnlockLevel: access.oddsUnlockLevel,
    rules: { ruleVersionId: p.ruleVersionId, version: p.ruleVersion, rulesHash: p.rulesHash, content: JSON.parse(p.rulesJson) as PoolRules },
    sets,
  };
}

export type TicketState = 'AVAILABLE' | 'HELD' | 'TAKEN';

/**
 * 單套即時狀態：剩餘數、即時機率（某賞剩餘 / 總剩餘）與籤板。
 * 未抽出的籤「絕不」回傳獎項；已抽出的籤顯示賞級（與實體一番賞相同）。
 * 即時機率（probability）只在觀看者 VIP 等級 ≥ oddsUnlockLevel 時輸出，否則省略並回傳 oddsLocked: true；
 * 剩餘/總數一律公開。opts.showOdds 可明確覆寫（內部用途/測試）。回收值不在此公開。
 */
export async function getSetBoard(db: Db, idOrSlug: string, setNo: number, viewerId?: string | null, opts: { showOdds?: boolean } = {}) {
  const { id: poolId } = await resolvePublicPool(db, idOrSlug);
  const access = await oddsAccess(db, viewerId);
  const showOdds = opts.showOdds ?? !access.oddsLocked;
  const [s] = await db<{ id: string; setNo: number; displayName: string | null; offline: boolean; playType: string; probSeedHash: string | null; probNonce: number; status: string; total: number; commitment: string; commitScheme: string; rulesHash: string; ruleVersion: number; lastPrizeName: string | null; lastPrizeAwarded: boolean; soldOutAt: Date | null; source: string; shippingNote: string }[]>`
    SELECT s.id, s.set_no, s.display_name, (s.offline OR p.offline) AS offline, s.status, s.total_tickets AS total, s.commitment, s.commit_scheme, rv.rules_hash, rv.version AS rule_version,
           p.play_type, s.prob_seed_hash, s.prob_nonce,
           p.last_prize_name, (s.last_prize_user_id IS NOT NULL) AS last_prize_awarded, s.sold_out_at, p.source, p.shipping_note
    FROM pool_sets s JOIN pools p ON p.id = s.pool_id JOIN pool_rule_versions rv ON rv.id = s.rule_version_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${setNo} AND s.deleted_at IS NULL`;
  if (!s) throw new AppError('NOT_FOUND', 'set not found');

  const byPrize = await db<(PrizeRow & { total: number; remaining: number; recyclable: boolean })[]>`
    SELECT pr.id, pr.kind, pl.level_no, pl.name AS level_name, pl.is_small, pr.name, pr.qty_per_set, pr.tag, pr.bulky, pr.ship_method, pr.image_url,
           count(t.*)::int AS total, count(t.*) FILTER (WHERE t.status = 'AVAILABLE')::int AS remaining, sp.recyclable
    FROM pool_prizes pr JOIN tickets t ON t.prize_id = pr.id AND t.set_id = ${s.id}
    LEFT JOIN pool_levels pl ON pl.id = pr.level_id
    LEFT JOIN set_prizes sp ON sp.set_id = ${s.id} AND sp.prize_id = pr.id
    GROUP BY pr.id, pl.level_no, pl.name, pl.is_small, sp.recyclable
    ORDER BY pl.level_no, pr.sort_order, pr.name`;
  const [lastPrize] = await db<(PrizeRow & { recyclable: boolean | null })[]>`
    SELECT pr.id, pr.kind, NULL::int AS level_no, NULL AS level_name, false AS is_small, pr.name, pr.qty_per_set, pr.tag, pr.bulky, pr.ship_method, pr.image_url,
           sp.recyclable
    FROM pool_prizes pr LEFT JOIN set_prizes sp ON sp.set_id = ${s.id} AND sp.prize_id = pr.id
    WHERE pr.pool_id = ${poolId} AND pr.kind = 'LAST'`;
  const totalRemaining = byPrize.reduce((a, b) => a + b.remaining, 0);
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const prob = (n: number) => (totalRemaining ? round(n / totalRemaining) : 0);
  // 機率賞：目前有效機率（固定機率等級：odds × 該獎剩餘 / 等級剩餘；其他：(1 − 有效 odds 總和) × 該獎剩餘 / 其他剩餘）
  const isProb = s.playType === 'PROB';
  const oddsRows = isProb ? await db<{ levelNo: number; odds: number | null }[]>`SELECT level_no, odds FROM pool_levels WHERE pool_id = ${poolId}` : [];
  const oddsMap = new Map(oddsRows.map((o) => [o.levelNo, o.odds]));
  const effective = isProb ? effectiveProbabilities(byPrize.map((p) => ({ levelNo: p.levelNo!, remaining: p.remaining })), oddsMap) : [];
  const prizeProb = (i: number, remaining: number) => (isProb ? round(effective[i]!) : prob(remaining));

  // 大型套（> BOARD_TICKETS_MAX 籤，例如卡牌機率賞）不輸出逐張籤板（只能快速抽，前台不顯示籤板），避免每次讀取整套籤表
  const omitTickets = s.total > BOARD_TICKETS_MAX;
  const tickets = omitTickets ? [] : await db<{ ticketNo: number; status: string; heldActive: boolean; heldByMe: boolean; levelNo: number | null; levelName: string | null; name: string | null }[]>`
    SELECT t.ticket_no, t.status,
           (t.status = 'AVAILABLE' AND t.held_by IS NOT NULL AND t.held_until > now()) AS held_active,
           (t.status = 'AVAILABLE' AND t.held_by IS NOT NULL AND t.held_until > now() AND t.held_by = ${viewerId ?? null}::uuid) AS held_by_me,
           CASE WHEN t.status = 'TAKEN' THEN pl.level_no END AS level_no,
           CASE WHEN t.status = 'TAKEN' THEN pl.name END AS level_name,
           CASE WHEN t.status = 'TAKEN' THEN pr.name END AS name
    FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id LEFT JOIN pool_levels pl ON pl.id = pr.level_id
    WHERE t.set_id = ${s.id} ORDER BY t.ticket_no`;

  const levelMap = new Map<number, { levelNo: number; name: string; isSmall: boolean; total: number; remaining: number }>();
  for (const p of byPrize) {
    const l = levelMap.get(p.levelNo!) ?? { levelNo: p.levelNo!, name: p.levelName!, isSmall: p.isSmall ?? false, total: 0, remaining: 0 };
    l.total += p.total;
    l.remaining += p.remaining;
    levelMap.set(p.levelNo!, l);
  }

  return {
    poolId,
    setNo: s.setNo,
    displayName: s.displayName,
    offline: s.offline,
    status: s.status,
    total: s.total,
    remaining: totalRemaining,
    commitment: {
      scheme: s.commitScheme,
      hash: s.commitment,
      rulesHash: s.rulesHash,
      ruleVersion: s.ruleVersion,
      ...(isProb ? { prob: { scheme: PROB_SCHEME, seedHash: s.probSeedHash, draws: s.probNonce } } : {}),
    },
    playType: s.playType,
    shippingNote: s.shippingNote,
    freightCollect: true,
    /** 即時機率是否鎖定（VIP oddsUnlockLevel 以上解鎖）；鎖定時 levels/prizes 不含 probability */
    oddsLocked: !showOdds,
    oddsUnlockLevel: access.oddsUnlockLevel,
    /** 各等級剩餘（與解鎖時的即時機率） */
    levels: [...levelMap.values()]
      .sort((a, b) => a.levelNo - b.levelNo)
      .map((l) => ({
        ...l,
        ...(isProb ? { odds: oddsMap.get(l.levelNo) ?? null } : {}),
        ...(showOdds ? { probability: isProb ? round(byPrize.reduce((a, p, i) => a + (p.levelNo === l.levelNo ? effective[i]! : 0), 0)) : prob(l.remaining) } : {}),
      })),
    // 籤板不輸出 prizeId（獎項 id 只出現在賞池詳情的規則內容），避免任何籤號↔獎項的關聯線索
    prizes: byPrize.map((p, i) => ({
      ...showPrize({ ...p, id: undefined }),
      total: p.total,
      remaining: p.remaining,
      ...(showOdds ? { probability: prizeProb(i, p.remaining) } : {}),
      recyclable: p.recyclable,
    })),
    lastPrize: lastPrize ? { ...showPrize({ ...lastPrize, id: undefined }), awarded: s.lastPrizeAwarded, recyclable: lastPrize.recyclable } : null,
    tickets: tickets.map((t) => {
      const state: TicketState = t.status === 'TAKEN' ? 'TAKEN' : t.heldActive ? 'HELD' : 'AVAILABLE';
      // 已抽出的籤公開獎項（等級＋顯示名稱）；未抽出的籤絕不揭露
      const prize = state === 'TAKEN' && t.name ? { levelNo: t.levelNo, levelName: t.levelName, displayName: displayName(t.levelName, t.name) } : {};
      return { no: t.ticketNo, state, ...(t.heldByMe ? { heldByMe: true } : {}), ...prize };
    }),
    ...(omitTickets ? { ticketsOmitted: true } : {}),
    soldOutAt: s.soldOutAt,
  };
}

/** 籤板逐張輸出的上限（超過則 tickets 為空陣列並標示 ticketsOmitted） */
export const BOARD_TICKETS_MAX = 30_000;

/** 完售後才可揭露：完整籤表、salt 與重算結果。 */
export async function revealSet(db: Db, idOrSlug: string, setNo: number) {
  const { id: poolId } = await resolvePublicPool(db, idOrSlug);
  const [s] = await db<{ id: string; status: string; commitment: string; commitSalt: string; commitScheme: string; rulesHash: string; rulesJson: string; probServerSeed: string | null; probSeedHash: string | null }[]>`
    SELECT s.id, s.status, s.commitment, s.commit_salt, s.commit_scheme, rv.rules_hash, rv.rules_json, s.prob_server_seed, s.prob_seed_hash
    FROM pool_sets s JOIN pool_rule_versions rv ON rv.id = s.rule_version_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${setNo} AND s.deleted_at IS NULL`;
  if (!s) throw new AppError('NOT_FOUND', 'set not found');
  if (s.status !== 'SOLD_OUT') throw new AppError('NOT_SOLD_OUT', '本套尚未完售，籤表與 salt 於完售後公開');
  if (!(COMMIT_SCHEMES as readonly string[]).includes(s.commitScheme)) throw new AppError('INVALID_STATE', `unknown commit scheme ${s.commitScheme}`);
  const scheme = s.commitScheme as CommitScheme;
  // v2 的等級號在發布後不可變（結構只在草稿可改），因此由目前資料重建即為發布時的籤表；v1 舊套沿用賞級
  const layout =
    scheme === COMMIT_SCHEME_V1
      ? await db<LayoutEntry[]>`
          SELECT t.ticket_no, pr.rank, t.prize_id FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id
          WHERE t.set_id = ${s.id} ORDER BY t.ticket_no`
      : await db<LayoutEntry[]>`
          SELECT t.ticket_no, pl.level_no, t.prize_id FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id
          LEFT JOIN pool_levels pl ON pl.id = pr.level_id
          WHERE t.set_id = ${s.id} ORDER BY t.ticket_no`;
  const input = { scheme, poolId, setNo, rulesHash: s.rulesHash, layout };
  // 機率賞：公開 server seed 與每筆抽賞的 (nonce, clientSeed, 籤號)，並以同一演算法重算
  let prob: Record<string, unknown> | null = null;
  if (s.probServerSeed && s.probSeedHash) {
    const draws = await db<{ nonce: number; clientSeed: string; drawId: string }[]>`
      SELECT prob_nonce AS nonce, prob_client_seed AS client_seed, id AS draw_id FROM draws WHERE set_id = ${s.id} AND prob_nonce IS NOT NULL ORDER BY prob_nonce`;
    const taken = await db<{ drawId: string; ticketNo: number }[]>`SELECT draw_id, ticket_no FROM tickets WHERE set_id = ${s.id} AND status = 'TAKEN'`;
    const levels = (JSON.parse(s.rulesJson) as PoolRules).levels ?? [];
    const replay = {
      serverSeed: s.probServerSeed,
      seedHash: s.probSeedHash,
      layout: layout.map((t) => ({ ticketNo: t.ticketNo, levelNo: t.levelNo! })),
      levels: levels.map((l) => ({ levelNo: l.levelNo, odds: l.odds ?? null })),
      draws: draws.map((d) => ({ nonce: d.nonce, clientSeed: d.clientSeed, ticketNos: taken.filter((t) => t.drawId === d.drawId).map((t) => t.ticketNo).sort((a, b) => a - b) })),
    };
    prob = { scheme: PROB_SCHEME, ...replay, verified: replayProbSet(replay).ok };
  }
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
    ...(prob ? { prob } : {}),
    /** 0 銷售時被後台重新產生而取代的舊承諾（含舊 salt 與籤表，可各自驗證） */
    superseded: (
      await db<{ commitScheme: string; commitment: string; commitSalt: string; rulesHash: string; layoutJson: string; reason: string; supersededAt: Date }[]>`
        SELECT commit_scheme, commitment, commit_salt, rules_hash, layout_json, reason, superseded_at FROM pool_set_commit_history WHERE set_id = ${s.id} ORDER BY id`
    ).map(({ layoutJson, commitSalt, ...r }) => ({ ...r, salt: commitSalt, layout: JSON.parse(layoutJson) as LayoutEntry[] })),
    howToVerify: 'sha256(canonical + "\\n" + salt) === commitment；或執行 npm run verify:set -- <reveal.json>',
  };
}
