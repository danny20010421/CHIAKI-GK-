import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { canonicalJson } from '../../lib/canonical';
import { transaction, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { COMMIT_SCHEME, computeCommitment, generateLayout, generateSalt } from './commitment';
import { defaultTier, rulesHash, type PoolRules } from './rules';

const MAX_TICKETS_PER_SET = 10_000;

export const PoolDraftSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    title: z.string().min(1).max(200),
    ip: z.string().max(100).default(''),
    description: z.string().max(5000).default(''),
    terms: z.string().max(10000).default(''),
    source: z.enum(['OFFICIAL', 'CUSTOM', 'MIXED']),
    playType: z.enum(['STANDARD', 'GUARANTEE', 'SOLO']),
    priceCoins: z.number().int().positive().max(1_000_000),
    setCount: z.number().int().min(1).max(1000),
    lastPrizeName: z.string().min(1).max(200).nullable().default(null),
    prizes: z
      .array(
        z.object({
          rank: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/),
          tier: z.number().int().min(0).max(9).optional(),
          name: z.string().min(1).max(200),
          qtyPerSet: z.number().int().positive().max(MAX_TICKETS_PER_SET),
        }),
      )
      .min(1)
      .max(50),
    guarantee: z
      .object({
        everyN: z.number().int().min(1).max(1000),
        minTier: z.number().int().min(0).max(9),
        reserveRank: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/),
        reservePrizeName: z.string().min(1).max(200),
        reserveTotal: z.number().int().min(0).max(100_000),
      })
      .nullable()
      .default(null),
  })
  .superRefine((v, ctx) => {
    const ranks = v.prizes.map((p) => p.rank);
    if (new Set(ranks).size !== ranks.length) ctx.addIssue({ code: 'custom', message: 'prize ranks must be unique', path: ['prizes'] });
    if (ranks.includes('LAST')) ctx.addIssue({ code: 'custom', message: 'LAST is reserved; use lastPrizeName', path: ['prizes'] });
    const total = v.prizes.reduce((s, p) => s + p.qtyPerSet, 0);
    if (total > MAX_TICKETS_PER_SET) ctx.addIssue({ code: 'custom', message: `max ${MAX_TICKETS_PER_SET} tickets per set`, path: ['prizes'] });
    if ((v.playType === 'GUARANTEE') !== (v.guarantee !== null)) {
      ctx.addIssue({ code: 'custom', message: 'guarantee config is required for (and only for) GUARANTEE pools', path: ['guarantee'] });
    }
    if (v.playType === 'SOLO') {
      const main = v.prizes.filter((p) => (p.tier ?? defaultTier(p.rank)) > 0);
      if (main.length !== 1) ctx.addIssue({ code: 'custom', message: 'SOLO pools need exactly one main prize (tier > 0)', path: ['prizes'] });
    }
  });
export type PoolDraftInput = z.input<typeof PoolDraftSchema>;

export async function createPoolDraft(actor: Principal, input: PoolDraftInput): Promise<{ poolId: string }> {
  requirePermission(actor, 'pool.draft.create');
  const v = PoolDraftSchema.parse(input);
  return transaction(async (tx) => {
    const [pool] = await tx<{ id: string }[]>`
      INSERT INTO pools (slug, title, ip, description, terms, source, play_type, price_coins, set_count, last_prize_name, created_by)
      VALUES (${v.slug}, ${v.title}, ${v.ip}, ${v.description}, ${v.terms}, ${v.source}, ${v.playType}, ${v.priceCoins}, ${v.setCount},
              ${v.lastPrizeName}, ${actor.userId})
      RETURNING id`;
    let i = 0;
    for (const p of v.prizes) {
      await tx`INSERT INTO pool_prizes (pool_id, rank, tier, name, qty_per_set, sort_order)
               VALUES (${pool!.id}, ${p.rank}, ${p.tier ?? defaultTier(p.rank)}, ${p.name}, ${p.qtyPerSet}, ${i++})`;
    }
    if (v.guarantee) {
      const g = v.guarantee;
      await tx`INSERT INTO pool_guarantees (pool_id, every_n, min_tier, reserve_rank, reserve_prize_name, reserve_total)
               VALUES (${pool!.id}, ${g.everyN}, ${g.minTier}, ${g.reserveRank}, ${g.reservePrizeName}, ${g.reserveTotal})`;
    }
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: 'POOL_DRAFT_CREATED',
      entityType: 'pool',
      entityId: pool!.id,
      payload: { slug: v.slug, playType: v.playType, source: v.source, priceCoins: v.priceCoins, setCount: v.setCount },
    });
    return { poolId: pool!.id };
  });
}

interface PoolRow {
  id: string;
  merchantId: string;
  title: string;
  source: PoolRules['source'];
  playType: PoolRules['playType'];
  priceCoins: number;
  setCount: number;
  lastPrizeName: string | null;
  terms: string;
  status: string;
}

/** 由雙人覆核核准後執行：建立不可變規則版本、每套以 CSPRNG 洗牌並產生承諾雜湊。 */
export async function publishPool(tx: Tx, poolId: string, approverId: string): Promise<Record<string, unknown>> {
  const [pool] = await tx<PoolRow[]>`
    SELECT id, merchant_id, title, source, play_type, price_coins, set_count, last_prize_name, terms, status
    FROM pools WHERE id = ${poolId} FOR UPDATE`;
  if (!pool) throw new AppError('NOT_FOUND', 'pool not found');
  if (pool.status !== 'PENDING_PUBLISH') throw new AppError('INVALID_STATE', `pool is ${pool.status}`);
  const prizes = await tx<{ id: string; rank: string; tier: number; name: string; qtyPerSet: number }[]>`
    SELECT id, rank, tier, name, qty_per_set FROM pool_prizes WHERE pool_id = ${poolId} ORDER BY sort_order, rank`;
  const [g] = await tx<{ everyN: number; minTier: number; reserveRank: string; reservePrizeName: string; reserveTotal: number }[]>`
    SELECT every_n, min_tier, reserve_rank, reserve_prize_name, reserve_total FROM pool_guarantees WHERE pool_id = ${poolId}`;

  const rules: PoolRules = {
    schema: 'chiaki-rules-v1',
    poolId,
    version: 1,
    title: pool.title,
    source: pool.source,
    playType: pool.playType,
    priceCoins: pool.priceCoins,
    setCount: pool.setCount,
    ticketsPerSet: prizes.reduce((s, p) => s + p.qtyPerSet, 0),
    drawMethod: 'FIXED_LIST_WITHOUT_REPLACEMENT',
    holdSeconds: config().HOLD_SECONDS,
    prizes: prizes.map((p) => ({ prizeId: p.id, rank: p.rank, tier: p.tier, name: p.name, qtyPerSet: p.qtyPerSet })),
    lastPrize: pool.lastPrizeName ? { name: pool.lastPrizeName, rule: 'AWARDED_TO_DRAWER_OF_FINAL_TICKET_OF_EACH_SET' } : null,
    guarantee: g
      ? {
          everyN: g.everyN,
          minTier: g.minTier,
          reserveRank: g.reserveRank,
          reservePrizeName: g.reservePrizeName,
          reserveTotal: g.reserveTotal,
          rule: 'EXTRA_PRIZE_FROM_SEPARATE_RESERVE_AFTER_N_CONSECUTIVE_MISSES; STOPS_WHEN_RESERVE_EXHAUSTED; TICKET_ODDS_UNCHANGED',
        }
      : null,
    terms: pool.terms,
  };
  const hash = rulesHash(rules);
  const [rv] = await tx<{ id: string }[]>`
    INSERT INTO pool_rule_versions (merchant_id, pool_id, version, rules_json, rules_hash, created_by, published_at)
    VALUES (${pool.merchantId}, ${poolId}, 1, ${canonicalJson(rules)}, ${hash}, ${approverId}, now())
    RETURNING id`;

  const sets: { setNo: number; commitment: string }[] = [];
  for (let setNo = 1; setNo <= pool.setCount; setNo++) {
    const layout = generateLayout(prizes);
    const salt = generateSalt();
    const commitment = computeCommitment({ poolId, setNo, rulesHash: hash, layout }, salt);
    const [set] = await tx<{ id: string }[]>`
      INSERT INTO pool_sets (merchant_id, pool_id, set_no, rule_version_id, status, total_tickets, commit_scheme, commitment, commit_salt, on_sale_at)
      VALUES (${pool.merchantId}, ${poolId}, ${setNo}, ${rv!.id}, ${setNo === 1 ? 'ON_SALE' : 'QUEUED'}, ${layout.length},
              ${COMMIT_SCHEME}, ${commitment}, ${salt}, ${setNo === 1 ? new Date() : null})
      RETURNING id`;
    await tx`
      INSERT INTO tickets (set_id, ticket_no, prize_id)
      SELECT ${set!.id}::uuid, u.n, u.p
      FROM unnest(${layout.map((l) => l.ticketNo)}::int[], ${layout.map((l) => l.prizeId)}::uuid[]) AS u(n, p)`;
    sets.push({ setNo, commitment });
  }
  await tx`UPDATE pools SET status = 'PUBLISHED', current_rule_version_id = ${rv!.id}, published_at = now() WHERE id = ${poolId}`;
  await appendAudit(tx, {
    actorType: 'ADMIN',
    actorId: approverId,
    action: 'POOL_PUBLISHED',
    entityType: 'pool',
    entityId: poolId,
    payload: { ruleVersionId: rv!.id, rulesHash: hash, sets },
  });
  return { poolId, ruleVersionId: rv!.id, rulesHash: hash, sets };
}

/**
 * 已發布規則不可修改：修改條款/說明會建立「新版本」（未發布），經雙人覆核後才生效。
 * 價格、獎項、套數等經濟條件已綁進各套承諾，不允許在同一賞池修改。
 */
export const RuleAmendmentSchema = z.object({ terms: z.string().max(10000) });

export async function createRuleVersionDraft(actor: Principal, poolId: string, input: z.input<typeof RuleAmendmentSchema>) {
  requirePermission(actor, 'pool.publish.request');
  const v = RuleAmendmentSchema.parse(input);
  return transaction(async (tx) => {
    const [cur] = await tx<{ rulesJson: string; version: number; merchantId: string }[]>`
      SELECT rv.rules_json, rv.version, rv.merchant_id FROM pools p
      JOIN pool_rule_versions rv ON rv.id = p.current_rule_version_id
      WHERE p.id = ${poolId} FOR UPDATE OF p`;
    if (!cur) throw new AppError('INVALID_STATE', 'pool has no published rules');
    const [mx] = await tx<{ max: number }[]>`SELECT max(version)::int AS max FROM pool_rule_versions WHERE pool_id = ${poolId}`;
    const max = mx!.max;
    const rules = JSON.parse(cur.rulesJson) as PoolRules;
    const next: PoolRules = { ...rules, version: max + 1, terms: v.terms };
    const [rv] = await tx<{ id: string }[]>`
      INSERT INTO pool_rule_versions (merchant_id, pool_id, version, rules_json, rules_hash, created_by)
      VALUES (${cur.merchantId}, ${poolId}, ${next.version}, ${canonicalJson(next)}, ${rulesHash(next)}, ${actor.userId})
      RETURNING id`;
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: 'RULE_VERSION_DRAFTED',
      entityType: 'pool_rule_version',
      entityId: rv!.id,
      payload: { poolId, version: next.version },
    });
    return { ruleVersionId: rv!.id, version: next.version };
  });
}

export async function publishRuleVersion(tx: Tx, ruleVersionId: string, approverId: string): Promise<Record<string, unknown>> {
  const [rv] = await tx<{ id: string; poolId: string; version: number; publishedAt: Date | null; rulesHash: string }[]>`
    SELECT id, pool_id, version, published_at, rules_hash FROM pool_rule_versions WHERE id = ${ruleVersionId} FOR UPDATE`;
  if (!rv) throw new AppError('NOT_FOUND', 'rule version not found');
  if (rv.publishedAt) throw new AppError('INVALID_STATE', 'already published');
  await tx`UPDATE pool_rule_versions SET published_at = now() WHERE id = ${rv.id}`;
  const rules = JSON.parse((await tx<{ rulesJson: string }[]>`SELECT rules_json FROM pool_rule_versions WHERE id = ${rv.id}`)[0]!.rulesJson) as PoolRules;
  await tx`UPDATE pools SET current_rule_version_id = ${rv.id}, terms = ${rules.terms} WHERE id = ${rv.poolId}`;
  await appendAudit(tx, {
    actorType: 'ADMIN',
    actorId: approverId,
    action: 'RULE_VERSION_PUBLISHED',
    entityType: 'pool_rule_version',
    entityId: rv.id,
    payload: { poolId: rv.poolId, version: rv.version, rulesHash: rv.rulesHash },
  });
  return { ruleVersionId: rv.id, poolId: rv.poolId, version: rv.version };
}
