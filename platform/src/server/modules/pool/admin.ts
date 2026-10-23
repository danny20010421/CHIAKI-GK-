import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { canonicalJson } from '../../lib/canonical';
import { transaction, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { COMMIT_SCHEME, computeCommitment, generateLayout, generateSalt } from './commitment';
import { defaultGradeForRank, GradeSchema, type Grade } from './grades';
import { rulesHash, type PoolRules } from './rules';
import { linkPoolIp } from '../catalog/ips';
import { ProductCategorySchema, resolveBulky } from '../catalog/categories';
import { CVS_FEE_RANGE, CvsFeeSchema, DEFAULT_SHIPPING_NOTE, HOME_FEE_RANGE, HomeFeeSchema } from '../shipping/fees';

const MAX_TICKETS_PER_SET = 10_000;
const RankSchema = z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/);
const RecycleValueSchema = z.number().int().min(0).max(10_000_000);

/**
 * 賞池草稿。
 *  - 自製（CUSTOM）：沒有 A–H 賞級，不可填 rank；每個獎項以「名稱」識別，必須指定等級 grade。
 *  - 官方/混合（OFFICIAL/MIXED）：每個獎項必須有賞級 rank；grade 未填時依預設對應（LAST/A→GRAND、B/C→MID、其他→SMALL）。
 *  - 每個獎項的回收值/可否回收為「預設值」，發布時複製到每一套，之後可逐套調整（set_prizes）。
 *  - 運費：每套宅配 150–300、超商 C2C 60–150 代幣（預設值，發布後可逐套調整）。
 */
export const PoolDraftSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    title: z.string().min(1).max(200),
    ip: z.string().max(100).default(''),
    /** 連結 IP（作品）；設定時 ip 文字會同步為 IP 名稱 */
    ipId: z.string().uuid().nullable().default(null),
    description: z.string().max(5000).default(''),
    terms: z.string().max(10000).default(''),
    source: z.enum(['OFFICIAL', 'CUSTOM', 'MIXED']),
    playType: z.enum(['STANDARD', 'GUARANTEE', 'SOLO']),
    priceCoins: z.number().int().positive().max(1_000_000),
    setCount: z.number().int().min(1).max(1000),
    lastPrizeName: z.string().min(1).max(200).nullable().default(null),
    lastPrizeGrade: GradeSchema.default('GRAND'),
    lastPrizeRecycleValue: RecycleValueSchema.default(0),
    lastPrizeRecyclable: z.boolean().optional(),
    lastPrizeCategory: ProductCategorySchema.nullable().default(null),
    lastPrizeBulky: z.boolean().optional(),
    prizes: z
      .array(
        z.object({
          rank: RankSchema.optional(),
          name: z.string().min(1).max(200),
          grade: GradeSchema.optional(),
          qtyPerSet: z.number().int().positive().max(MAX_TICKETS_PER_SET),
          recycleValue: RecycleValueSchema.default(0),
          recyclable: z.boolean().optional(), // 未填：回收值 > 0 即可回收
          category: ProductCategorySchema.nullable().default(null), // 商品分類（GK、PVC…）
          bulky: z.boolean().optional(), // 大件・限宅配（未填：GK 為是）
        }),
      )
      .min(1)
      .max(50),
    guarantee: z
      .object({
        everyN: z.number().int().min(1).max(1000),
        minGrade: z.enum(['GRAND', 'MID']),
        reserveRank: RankSchema.optional(),
        reservePrizeName: z.string().min(1).max(200),
        reserveGrade: GradeSchema.optional(),
        reserveTotal: z.number().int().min(0).max(100_000),
        reserveRecycleValue: RecycleValueSchema.default(0),
        reserveRecyclable: z.boolean().optional(),
        reserveCategory: ProductCategorySchema.nullable().default(null),
        reserveBulky: z.boolean().optional(),
      })
      .nullable()
      .default(null),
    shippingFeeHome: HomeFeeSchema.default(150),
    shippingFeeCvs: CvsFeeSchema.default(70),
    shippingNote: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    const custom = v.source === 'CUSTOM';
    v.prizes.forEach((p, i) => {
      if (custom && p.rank) ctx.addIssue({ code: 'custom', path: ['prizes', i, 'rank'], message: '自製賞池沒有賞級（A–H），請以獎項名稱識別' });
      if (custom && !p.grade) ctx.addIssue({ code: 'custom', path: ['prizes', i, 'grade'], message: '自製賞池每個獎項都必須設定等級 grade（GRAND/MID/SMALL）' });
      if (!custom && !p.rank) ctx.addIssue({ code: 'custom', path: ['prizes', i, 'rank'], message: '官方/混合賞池的獎項必須有賞級 rank' });
    });
    const ranks = v.prizes.flatMap((p) => (p.rank ? [p.rank] : []));
    if (new Set(ranks).size !== ranks.length) ctx.addIssue({ code: 'custom', message: 'prize ranks must be unique', path: ['prizes'] });
    if (ranks.includes('LAST')) ctx.addIssue({ code: 'custom', message: 'LAST is reserved; use lastPrizeName', path: ['prizes'] });
    const names = v.prizes.map((p) => p.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'prize names must be unique within a pool', path: ['prizes'] });
    const total = v.prizes.reduce((s, p) => s + p.qtyPerSet, 0);
    if (total > MAX_TICKETS_PER_SET) ctx.addIssue({ code: 'custom', message: `max ${MAX_TICKETS_PER_SET} tickets per set`, path: ['prizes'] });
    if ((v.playType === 'GUARANTEE') !== (v.guarantee !== null)) {
      ctx.addIssue({ code: 'custom', message: 'guarantee config is required for (and only for) GUARANTEE pools', path: ['guarantee'] });
    }
    if (v.guarantee) {
      if (custom && v.guarantee.reserveRank) ctx.addIssue({ code: 'custom', path: ['guarantee', 'reserveRank'], message: '自製賞池沒有賞級' });
      if (!v.guarantee.reserveGrade && !v.guarantee.reserveRank) {
        ctx.addIssue({ code: 'custom', path: ['guarantee', 'reserveGrade'], message: 'reserveGrade is required (no rank to derive it from)' });
      }
    }
    if (v.playType === 'SOLO') {
      const main = v.prizes.filter((p) => resolvedGrade(p) !== 'SMALL');
      if (main.length !== 1) ctx.addIssue({ code: 'custom', message: 'SOLO pools need exactly one main prize (grade GRAND or MID)', path: ['prizes'] });
    }
  });
export type PoolDraftInput = z.input<typeof PoolDraftSchema>;

function resolvedGrade(p: { rank?: string | undefined; grade?: Grade | undefined }): Grade {
  return p.grade ?? (p.rank ? defaultGradeForRank(p.rank) : 'SMALL');
}

export async function createPoolDraft(actor: Principal, input: PoolDraftInput): Promise<{ poolId: string }> {
  requirePermission(actor, 'pool.draft.create');
  const v = PoolDraftSchema.parse(input);
  return transaction(async (tx) => {
    const [pool] = await tx<{ id: string }[]>`
      INSERT INTO pools (slug, title, ip, description, terms, source, play_type, price_coins, set_count, last_prize_name, created_by,
                         shipping_note, ship_fee_home, ship_fee_cvs)
      VALUES (${v.slug}, ${v.title}, ${v.ip}, ${v.description}, ${v.terms}, ${v.source}, ${v.playType}, ${v.priceCoins}, ${v.setCount},
              ${v.lastPrizeName}, ${actor.userId}, ${v.shippingNote ?? DEFAULT_SHIPPING_NOTE[v.source]}, ${v.shippingFeeHome}, ${v.shippingFeeCvs})
      RETURNING id`;
    if (v.ipId) await linkPoolIp(tx, pool!.id, v.ipId);
    const custom = v.source === 'CUSTOM';
    let i = 0;
    for (const p of v.prizes) {
      await tx`INSERT INTO pool_prizes (pool_id, kind, rank, grade, name, qty_per_set, sort_order, recycle_value, recyclable, category, bulky)
               VALUES (${pool!.id}, 'TICKET', ${custom ? null : p.rank!}, ${resolvedGrade(p)}, ${p.name}, ${p.qtyPerSet}, ${i++},
                       ${p.recycleValue}, ${p.recyclable ?? p.recycleValue > 0}, ${p.category}, ${resolveBulky(p.category, p.bulky)})`;
    }
    if (v.lastPrizeName) {
      await tx`INSERT INTO pool_prizes (pool_id, kind, rank, grade, name, qty_per_set, sort_order, recycle_value, recyclable, category, bulky)
               VALUES (${pool!.id}, 'LAST', ${custom ? null : 'LAST'}, ${v.lastPrizeGrade}, ${v.lastPrizeName}, 0, 1000,
                       ${v.lastPrizeRecycleValue}, ${v.lastPrizeRecyclable ?? v.lastPrizeRecycleValue > 0}, ${v.lastPrizeCategory}, ${resolveBulky(v.lastPrizeCategory, v.lastPrizeBulky)})`;
    }
    if (v.guarantee) {
      const g = v.guarantee;
      const [rp] = await tx<{ id: string }[]>`
        INSERT INTO pool_prizes (pool_id, kind, rank, grade, name, qty_per_set, sort_order, recycle_value, recyclable, category, bulky)
        VALUES (${pool!.id}, 'GUARANTEE', ${custom ? null : (g.reserveRank ?? null)}, ${resolvedGrade({ rank: g.reserveRank, grade: g.reserveGrade })},
                ${g.reservePrizeName}, 0, 1001, ${g.reserveRecycleValue}, ${g.reserveRecyclable ?? g.reserveRecycleValue > 0},
                ${g.reserveCategory}, ${resolveBulky(g.reserveCategory, g.reserveBulky)})
        RETURNING id`;
      await tx`INSERT INTO pool_guarantees (pool_id, every_n, min_grade, reserve_rank, reserve_prize_name, reserve_total, reserve_prize_id)
               VALUES (${pool!.id}, ${g.everyN}, ${g.minGrade}, ${custom ? null : (g.reserveRank ?? null)}, ${g.reservePrizeName}, ${g.reserveTotal}, ${rp!.id})`;
    }
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: 'POOL_DRAFT_CREATED',
      entityType: 'pool',
      entityId: pool!.id,
      payload: { slug: v.slug, playType: v.playType, source: v.source, priceCoins: v.priceCoins, setCount: v.setCount, shippingFeeHome: v.shippingFeeHome, shippingFeeCvs: v.shippingFeeCvs },
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
  shipFeeHome: number;
  shipFeeCvs: number;
}

interface PrizeRow {
  id: string;
  kind: 'TICKET' | 'LAST' | 'GUARANTEE';
  rank: string | null;
  grade: Grade;
  name: string;
  qtyPerSet: number;
}

/** 由雙人覆核核准後執行：建立不可變規則版本、每套以 CSPRNG 洗牌並產生承諾雜湊、建立每套運費與每套獎項回收設定。 */
export async function publishPool(tx: Tx, poolId: string, approverId: string): Promise<Record<string, unknown>> {
  const [pool] = await tx<PoolRow[]>`
    SELECT id, merchant_id, title, source, play_type, price_coins, set_count, last_prize_name, terms, status, ship_fee_home, ship_fee_cvs
    FROM pools WHERE id = ${poolId} FOR UPDATE`;
  if (!pool) throw new AppError('NOT_FOUND', 'pool not found');
  if (pool.status !== 'PENDING_PUBLISH') throw new AppError('INVALID_STATE', `pool is ${pool.status}`);
  const all = await tx<PrizeRow[]>`
    SELECT id, kind, rank, grade, name, qty_per_set FROM pool_prizes WHERE pool_id = ${poolId} ORDER BY sort_order, name`;
  const prizes = all.filter((p) => p.kind === 'TICKET');
  const lastPrize = all.find((p) => p.kind === 'LAST') ?? null;
  const [g] = await tx<{ everyN: number; minGrade: Grade; reserveRank: string | null; reservePrizeName: string; reserveTotal: number; reservePrizeId: string }[]>`
    SELECT every_n, min_grade, reserve_rank, reserve_prize_name, reserve_total, reserve_prize_id FROM pool_guarantees WHERE pool_id = ${poolId}`;
  const reserve = g ? all.find((p) => p.id === g.reservePrizeId)! : null;
  const perFee = config().SHIPPING_SMALL_ITEMS_PER_FEE;

  const rules: PoolRules = {
    schema: 'chiaki-rules-v2',
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
    prizes: prizes.map((p) => ({ prizeId: p.id, rank: p.rank, grade: p.grade, name: p.name, qtyPerSet: p.qtyPerSet })),
    lastPrize: lastPrize ? { prizeId: lastPrize.id, name: lastPrize.name, grade: lastPrize.grade, rule: 'AWARDED_TO_DRAWER_OF_FINAL_TICKET_OF_EACH_SET' } : null,
    guarantee: g
      ? {
          everyN: g.everyN,
          minGrade: g.minGrade,
          reservePrizeId: g.reservePrizeId,
          reserveRank: g.reserveRank,
          reservePrizeName: g.reservePrizeName,
          reserveGrade: reserve!.grade,
          reserveTotal: g.reserveTotal,
          rule: 'EXTRA_PRIZE_FROM_SEPARATE_RESERVE_AFTER_N_CONSECUTIVE_DRAWS_BELOW_MIN_GRADE; STOPS_WHEN_RESERVE_EXHAUSTED; TICKET_ODDS_UNCHANGED',
        }
      : null,
    shippingPolicy: {
      mode: 'PREPAID_PER_SET',
      smallItemsPerFee: perFee,
      homeFeeRange: HOME_FEE_RANGE,
      cvsFeeRange: CVS_FEE_RANGE,
      rule: `SHIPPING_FEE_CHARGED_AT_FIRST_PAID_DRAW_PER_SET; ONE_FEE_COVERS_${perFee}_SMALL_GRADE_PRIZES_PER_USER_PER_SET; EXTRA_FEE_WHEN_HELD_SMALL_PLUS_TICKETS_EXCEEDS_COVERAGE`,
    },
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
      INSERT INTO pool_sets (merchant_id, pool_id, set_no, rule_version_id, status, total_tickets, commit_scheme, commitment, commit_salt, on_sale_at,
                             ship_fee_home, ship_fee_cvs, ship_refund_div)
      VALUES (${pool.merchantId}, ${poolId}, ${setNo}, ${rv!.id}, ${setNo === 1 ? 'ON_SALE' : 'QUEUED'}, ${layout.length},
              ${COMMIT_SCHEME}, ${commitment}, ${salt}, ${setNo === 1 ? new Date() : null}, ${pool.shipFeeHome}, ${pool.shipFeeCvs},
              ${config().SHIPPING_REFUND_DIV})
      RETURNING id`;
    await tx`
      INSERT INTO tickets (set_id, ticket_no, prize_id)
      SELECT ${set!.id}::uuid, u.n, u.p
      FROM unnest(${layout.map((l) => l.ticketNo)}::int[], ${layout.map((l) => l.prizeId)}::uuid[]) AS u(n, p)`;
    await tx`
      INSERT INTO set_prizes (set_id, prize_id, recycle_value, recyclable)
      SELECT ${set!.id}::uuid, id, recycle_value, recyclable FROM pool_prizes WHERE pool_id = ${poolId}`;
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

// ───────────── 發布後的營運設定（不影響承諾與規則雜湊） ─────────────

async function lockPublishedPool(tx: Tx, idOrSlug: string): Promise<{ id: string; status: string }> {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rows = UUID_RE.test(idOrSlug)
    ? await tx<{ id: string; status: string }[]>`SELECT id, status FROM pools WHERE id = ${idOrSlug} FOR UPDATE`
    : await tx<{ id: string; status: string }[]>`SELECT id, status FROM pools WHERE slug = ${idOrSlug} FOR UPDATE`;
  if (!rows[0]) throw new AppError('NOT_FOUND', 'pool not found');
  return rows[0];
}

export const PoolSettingsSchema = z
  .object({ shippingNote: z.string().max(500).optional(), ipId: z.string().uuid().nullable().optional() })
  .refine((v) => v.shippingNote !== undefined || v.ipId !== undefined, 'nothing to update');

/** 更新賞池營運設定：出貨時程說明（無固定 SLA）、連結 IP（作品；null = 取消連結）。 */
export async function updatePoolSettings(actor: Principal, idOrSlug: string, input: z.input<typeof PoolSettingsSchema>) {
  requirePermission(actor, 'pool.config.manage');
  const v = PoolSettingsSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPublishedPool(tx, idOrSlug);
    const [before] = await tx<{ shippingNote: string; ipId: string | null }[]>`SELECT shipping_note, ip_id FROM pools WHERE id = ${p.id}`;
    if (v.shippingNote !== undefined) await tx`UPDATE pools SET shipping_note = ${v.shippingNote} WHERE id = ${p.id}`;
    if (v.ipId !== undefined) await linkPoolIp(tx, p.id, v.ipId);
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'POOL_SETTINGS_UPDATED', entityType: 'pool', entityId: p.id, payload: { before, ...v } });
    const [after] = await tx<{ shippingNote: string; ipId: string | null }[]>`SELECT shipping_note, ip_id FROM pools WHERE id = ${p.id}`;
    return { poolId: p.id, shippingNote: after!.shippingNote, ipId: after!.ipId };
  });
}

export const SetConfigSchema = z
  .object({
    shippingFeeHome: HomeFeeSchema.optional(),
    shippingFeeCvs: CvsFeeSchema.optional(),
    /** 逐件運費退還除數 N（每回收一件小獎退 運費 ÷ N）；已開始退還的會員沿用當時鎖定的 N */
    shipRefundDiv: z.number().int().min(1).max(1000).optional(),
    prizes: z
      .array(z.object({ prizeId: z.string().uuid(), recycleValue: RecycleValueSchema.optional(), recyclable: z.boolean().optional() }))
      .max(60)
      .optional(),
  })
  .refine((v) => v.shippingFeeHome !== undefined || v.shippingFeeCvs !== undefined || v.shipRefundDiv !== undefined || (v.prizes?.length ?? 0) > 0, 'nothing to update');

/**
 * 逐套設定：運費（宅配 150–300、超商 C2C 60–150）與每個獎項的回收值/可否回收。
 * 新運費只影響之後的預收；回收值於「回收或到期轉換當下」讀取。
 */
export async function updateSetConfig(actor: Principal, idOrSlug: string, setNo: number, input: z.input<typeof SetConfigSchema>) {
  requirePermission(actor, 'pool.config.manage');
  const v = SetConfigSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPublishedPool(tx, idOrSlug);
    if (p.status !== 'PUBLISHED' && p.status !== 'ENDED') throw new AppError('INVALID_STATE', 'pool is not published');
    const [s] = await tx<{ id: string; shipFeeHome: number; shipFeeCvs: number; shipRefundDiv: number }[]>`
      SELECT id, ship_fee_home, ship_fee_cvs, ship_refund_div FROM pool_sets WHERE pool_id = ${p.id} AND set_no = ${setNo} FOR UPDATE`;
    if (!s) throw new AppError('NOT_FOUND', 'set not found');
    const home = v.shippingFeeHome ?? s.shipFeeHome;
    const cvs = v.shippingFeeCvs ?? s.shipFeeCvs;
    const div = v.shipRefundDiv ?? s.shipRefundDiv;
    if (home !== s.shipFeeHome || cvs !== s.shipFeeCvs || div !== s.shipRefundDiv) {
      await tx`UPDATE pool_sets SET ship_fee_home = ${home}, ship_fee_cvs = ${cvs}, ship_refund_div = ${div} WHERE id = ${s.id}`;
    }
    const changed: { prizeId: string; before: { recycleValue: number; recyclable: boolean }; after: { recycleValue: number; recyclable: boolean } }[] = [];
    for (const pr of v.prizes ?? []) {
      const [cur] = await tx<{ recycleValue: number; recyclable: boolean }[]>`
        SELECT recycle_value, recyclable FROM set_prizes WHERE set_id = ${s.id} AND prize_id = ${pr.prizeId} FOR UPDATE`;
      if (!cur) throw new AppError('NOT_FOUND', 'prize not found in this set', { prizeId: pr.prizeId });
      const after = { recycleValue: pr.recycleValue ?? cur.recycleValue, recyclable: pr.recyclable ?? cur.recyclable };
      await tx`UPDATE set_prizes SET recycle_value = ${after.recycleValue}, recyclable = ${after.recyclable}, updated_by = ${actor.userId}, updated_at = now()
               WHERE set_id = ${s.id} AND prize_id = ${pr.prizeId}`;
      changed.push({ prizeId: pr.prizeId, before: { recycleValue: cur.recycleValue, recyclable: cur.recyclable }, after });
    }
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: 'SET_CONFIG_UPDATED',
      entityType: 'pool_set',
      entityId: s.id,
      payload: { poolId: p.id, setNo, shippingFees: { before: { home: s.shipFeeHome, cvs: s.shipFeeCvs }, after: { home, cvs } }, shipRefundDiv: { before: s.shipRefundDiv, after: div }, prizes: changed },
    });
    return { poolId: p.id, setNo, shippingFees: { home, cvs }, shipRefundDiv: div, prizes: changed.map((c) => ({ prizeId: c.prizeId, ...c.after })) };
  });
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

export const PrizeAttributesSchema = z
  .object({ category: ProductCategorySchema.nullable().optional(), bulky: z.boolean().optional() })
  .refine((v) => v.category !== undefined || v.bulky !== undefined, 'nothing to update');

/**
 * 獎項屬性（商品分類、大件・限宅配）：不影響籤表承諾與機率，發布後仍可修改（留稽核）。
 * 只改分類未指定 bulky 時，大件旗標依新分類的預設值（GK → 是）。
 */
export async function updatePrizeAttributes(actor: Principal, prizeId: string, input: z.input<typeof PrizeAttributesSchema>) {
  requirePermission(actor, 'pool.config.manage');
  const v = PrizeAttributesSchema.parse(input);
  return transaction(async (tx) => {
    const [cur] = await tx<{ category: string | null; bulky: boolean; poolId: string }[]>`SELECT category, bulky, pool_id FROM pool_prizes WHERE id = ${prizeId} FOR UPDATE`;
    if (!cur) throw new AppError('NOT_FOUND', 'prize not found');
    const category = v.category === undefined ? (cur.category as z.infer<typeof ProductCategorySchema> | null) : v.category;
    const bulky = v.bulky ?? (v.category !== undefined ? resolveBulky(category, undefined) : cur.bulky);
    await tx`UPDATE pool_prizes SET category = ${category}, bulky = ${bulky} WHERE id = ${prizeId}`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'PRIZE_ATTRIBUTES_UPDATED', entityType: 'pool_prize', entityId: prizeId, payload: { poolId: cur.poolId, before: { category: cur.category, bulky: cur.bulky }, after: { category, bulky } } });
    return { prizeId, category, bulky };
  });
}
