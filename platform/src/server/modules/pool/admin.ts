import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { canonicalJson } from '../../lib/canonical';
import { transaction, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { COMMIT_SCHEME, computeCommitment, generateLayout, generateSalt } from './commitment';
import { defaultIsSmall, LEVEL_MAX, LevelNoSchema } from './levels';
import { rulesHash, type PoolRules } from './rules';
import { generateServerSeed, parseOdds, PROB_SCHEME, seedHash } from './prob';
import { linkPoolIp } from '../catalog/ips';
import { resolveBulky, TagSchema } from '../catalog/tags';
import { DEFAULT_SHIPPING_NOTE, resolveShipMethod, ShipMethodSchema } from '../shipping/methods';

/** 每套籤數上限（2026-10 第七批由 10,000 放寬為 20,000：雲頂終結谷每套 20,000 籤） */
export const MAX_TICKETS_PER_SET = 20_000;
export const RecycleValueSchema = z.number().int().min(0).max(10_000_000);
export const PrizeNameSchema = z.string().trim().min(1).max(200);
export const LevelNameSchema = z.string().trim().min(1, '等級名稱不可空白').max(50);
/** 獎項圖片：https:// 網址或站內路徑（例如上傳後的 /api/assets/:id） */
export const ImageUrlSchema = z.string().max(2000).regex(/^(https:\/\/|\/)\S*$/, '圖片須為 https:// 網址或站內路徑（如 /api/assets/:id）');

/** 快速抽包：1、3、5、10、20、all 的子集合（預設 1、5、10） */
export const DRAW_PACK_VALUES = ['1', '3', '5', '10', '20', 'all'] as const;
export type DrawPack = (typeof DRAW_PACK_VALUES)[number];
export const DEFAULT_DRAW_PACKS: DrawPack[] = ['1', '5', '10'];
export const DrawPacksSchema = z
  .array(z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(10), z.literal(20), z.literal('all'), z.enum(DRAW_PACK_VALUES)]))
  .min(1, '至少一個抽包選項')
  .max(6)
  .transform((a) => DRAW_PACK_VALUES.filter((v) => a.map(String).includes(v)) as DrawPack[]);
/** 對外輸出：數字 + 'all' */
export function drawPacksOut(packs: string[]): (number | 'all')[] {
  return DRAW_PACK_VALUES.filter((v) => packs.includes(v)).map((v) => (v === 'all' ? 'all' : Number(v)));
}

export const PrizeItemSchema = z.object({
  name: PrizeNameSchema,
  qtyPerSet: z.number().int().positive().max(MAX_TICKETS_PER_SET),
  recycleValue: RecycleValueSchema.default(0),
  recyclable: z.boolean().optional(), // 未填：回收值 > 0 即可回收
  tag: TagSchema.nullable().default(null),
  bulky: z.boolean().optional(), // 大件（未填：GK 標籤或等級 1 為是）
  /** 寄送方式（上架時預設，會員不可選；未填：大件 → home，其餘 → c711）；賞池一有銷售即鎖定 */
  shipMethod: ShipMethodSchema.optional(),
  imageUrl: ImageUrlSchema.nullable().default(null),
});
/** 機率賞的固定單抽機率：數字或 "1/30" 這類分數字串；0 < odds < 1 */
export const OddsSchema = z
  .union([z.number(), z.string().max(40)])
  .transform(parseOdds)
  .refine((x) => Number.isFinite(x) && x > 0 && x < 1, '機率須介於 0 與 1 之間（不含）');

export const LevelSchema = z.object({
  levelNo: LevelNoSchema,
  name: LevelNameSchema,
  isSmall: z.boolean().optional(), // 未填：等級 4–8 為小獎
  /** 機率賞（PROB）專用：固定單抽機率；未填＝依剩餘籤數平均分配剩下的機率 */
  odds: OddsSchema.nullable().optional(),
  items: z.array(PrizeItemSchema).min(1, '每個等級至少一個獎項').max(50),
});
export const LastPrizeSchema = z.object({
  name: PrizeNameSchema,
  recycleValue: RecycleValueSchema.default(0),
  recyclable: z.boolean().optional(),
  tag: TagSchema.nullable().default(null),
  bulky: z.boolean().optional(),
  shipMethod: ShipMethodSchema.optional(),
  imageUrl: ImageUrlSchema.nullable().default(null),
});

/**
 * 賞池草稿（所有來源一致：官方、自製、混合）。
 *  - levels：1–12 個等級（等級 1 最高），每級有顯示名稱（如「A賞」「大獎」）、是否小獎、1..N 個獎項。
 *  - lastPrize：最後賞（等級之外的獨立獎項，可無）。
 *  - 每個獎項的回收值/可否回收為「預設值」，發布時複製到每一套，之後可逐套調整（set_prizes）。
 *  - 每個獎項的寄送方式（shipMethod：home / c711 / fami）；運費一律到付（不再有每套運費設定）。
 */
export const PoolDraftSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    title: z.string().min(1).max(200),
    ip: z.string().max(100).default(''),
    /** 連結 IP（作品）；設定時 ip 文字會同步為 IP 名稱 */
    ipId: z.string().uuid().nullable().default(null),
    description: z.string().max(400, '說明最多 400 字').default(''),
    /** 來源說明（例：日本官方正版、平台自製） */
    sourceNote: z.string().trim().max(200).default(''),
    /** 商品狀態（例：全新未拆、外盒輕微壓痕） */
    condition: z.string().trim().max(200).default(''),
    terms: z.string().max(10000).default(''),
    source: z.enum(['OFFICIAL', 'CUSTOM', 'MIXED']),
    playType: z.enum(['STANDARD', 'GUARANTEE', 'SOLO', 'PROB']),
    priceCoins: z.number().int().positive().max(1_000_000),
    setCount: z.number().int().min(1).max(1000),
    levels: z.array(LevelSchema).min(1, '至少一個等級').max(LEVEL_MAX, `最多 ${LEVEL_MAX} 個等級`),
    lastPrize: LastPrizeSchema.nullable().default(null),
    guarantee: z
      .object({
        everyN: z.number().int().min(1).max(1000),
        /** 抽中等級號 ≤ minLevel 視為命中（計數歸零） */
        minLevel: LevelNoSchema,
        /** 保底獎項所屬等級（須為本賞池已定義的等級） */
        reserveLevelNo: LevelNoSchema,
        reservePrizeName: PrizeNameSchema,
        reserveTotal: z.number().int().min(0).max(100_000),
        reserveRecycleValue: RecycleValueSchema.default(0),
        reserveRecyclable: z.boolean().optional(),
        reserveTag: TagSchema.nullable().default(null),
        reserveBulky: z.boolean().optional(),
        reserveShipMethod: ShipMethodSchema.optional(),
        reserveImageUrl: ImageUrlSchema.nullable().default(null),
      })
      .nullable()
      .default(null),
    drawPacks: DrawPacksSchema.optional(),
    shippingNote: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    const nos = v.levels.map((l) => l.levelNo);
    if (new Set(nos).size !== nos.length) ctx.addIssue({ code: 'custom', message: '等級號不可重複', path: ['levels'] });
    const names = v.levels.flatMap((l) => l.items.map((p) => p.name));
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'prize names must be unique within a pool', path: ['levels'] });
    const total = v.levels.reduce((s, l) => s + l.items.reduce((a, p) => a + p.qtyPerSet, 0), 0);
    if (total > MAX_TICKETS_PER_SET) ctx.addIssue({ code: 'custom', message: `max ${MAX_TICKETS_PER_SET} tickets per set`, path: ['levels'] });
    if ((v.playType === 'GUARANTEE') !== (v.guarantee !== null)) {
      ctx.addIssue({ code: 'custom', message: 'guarantee config is required for (and only for) GUARANTEE pools', path: ['guarantee'] });
    }
    if (v.guarantee && !nos.includes(v.guarantee.reserveLevelNo)) {
      ctx.addIssue({ code: 'custom', message: '保底獎項的等級須為本賞池已定義的等級', path: ['guarantee', 'reserveLevelNo'] });
    }
    const withOdds = v.levels.filter((l) => l.odds != null);
    if (withOdds.length && v.playType !== 'PROB') ctx.addIssue({ code: 'custom', message: '只有機率賞（PROB）的等級可以設定固定機率 odds', path: ['levels'] });
    if (withOdds.reduce((a, l) => a + l.odds!, 0) >= 1) ctx.addIssue({ code: 'custom', message: '所有等級的固定機率總和必須小於 1', path: ['levels'] });
    if (v.playType === 'SOLO') {
      const main = v.levels.filter((l) => !(l.isSmall ?? defaultIsSmall(l.levelNo))).flatMap((l) => l.items);
      if (main.length !== 1) ctx.addIssue({ code: 'custom', message: 'SOLO pools need exactly one main prize (one item in non-small levels)', path: ['levels'] });
    }
  });
export type PoolDraftInput = z.input<typeof PoolDraftSchema>;

export async function insertPrizeItem(
  tx: Tx,
  poolId: string,
  level: { id: string; levelNo: number },
  p: z.infer<typeof PrizeItemSchema>,
  sortOrder: number,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO pool_prizes (pool_id, kind, level_id, name, qty_per_set, sort_order, recycle_value, recyclable, tag, bulky, ship_method, image_url)
    VALUES (${poolId}, 'TICKET', ${level.id}, ${p.name}, ${p.qtyPerSet}, ${sortOrder}, ${p.recycleValue}, ${p.recyclable ?? p.recycleValue > 0},
            ${p.tag}, ${resolveBulky(p.tag, p.bulky, level.levelNo)}, ${resolveShipMethod(p.shipMethod, p.tag, p.bulky, level.levelNo)}, ${p.imageUrl})
    RETURNING id`;
  return row!.id;
}

export async function insertLevel(tx: Tx, poolId: string, l: { levelNo: number; name: string; isSmall?: boolean | undefined; odds?: number | null | undefined }): Promise<{ id: string; levelNo: number }> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO pool_levels (pool_id, level_no, name, is_small, odds) VALUES (${poolId}, ${l.levelNo}, ${l.name}, ${l.isSmall ?? defaultIsSmall(l.levelNo)}, ${l.odds ?? null})
    ON CONFLICT (pool_id, level_no) DO NOTHING RETURNING id`;
  if (!row) throw new AppError('CONFLICT', `等級 ${l.levelNo} 已存在`);
  return { id: row.id, levelNo: l.levelNo };
}

export async function insertLastPrize(tx: Tx, poolId: string, lp: z.infer<typeof LastPrizeSchema>) {
  await tx`INSERT INTO pool_prizes (pool_id, kind, name, qty_per_set, sort_order, recycle_value, recyclable, tag, bulky, ship_method, image_url)
           VALUES (${poolId}, 'LAST', ${lp.name}, 0, 1000, ${lp.recycleValue}, ${lp.recyclable ?? lp.recycleValue > 0}, ${lp.tag},
                   ${resolveBulky(lp.tag, lp.bulky)}, ${resolveShipMethod(lp.shipMethod, lp.tag, lp.bulky)}, ${lp.imageUrl})`;
  await tx`UPDATE pools SET last_prize_name = ${lp.name} WHERE id = ${poolId}`;
}

export async function createPoolDraft(actor: Principal, input: PoolDraftInput): Promise<{ poolId: string }> {
  requirePermission(actor, 'pool.draft.create');
  const v = PoolDraftSchema.parse(input);
  return transaction(async (tx) => {
    const [pool] = await tx<{ id: string }[]>`
      INSERT INTO pools (slug, title, ip, description, terms, source, play_type, price_coins, set_count, created_by,
                         shipping_note, draw_packs, source_note, item_condition)
      VALUES (${v.slug}, ${v.title}, ${v.ip}, ${v.description}, ${v.terms}, ${v.source}, ${v.playType}, ${v.priceCoins}, ${v.setCount},
              ${actor.userId}, ${v.shippingNote ?? DEFAULT_SHIPPING_NOTE[v.source]},
              ${v.drawPacks ?? DEFAULT_DRAW_PACKS}::text[], ${v.sourceNote}, ${v.condition})
      RETURNING id`;
    const poolId = pool!.id;
    if (v.ipId) await linkPoolIp(tx, poolId, v.ipId);
    const levelIds = new Map<number, { id: string; levelNo: number }>();
    for (const l of [...v.levels].sort((a, b) => a.levelNo - b.levelNo)) {
      const lv = await insertLevel(tx, poolId, l);
      levelIds.set(l.levelNo, lv);
      let i = 0;
      for (const p of l.items) await insertPrizeItem(tx, poolId, lv, p, l.levelNo * 100 + i++);
    }
    if (v.lastPrize) await insertLastPrize(tx, poolId, v.lastPrize);
    if (v.guarantee) {
      const g = v.guarantee;
      const lv = levelIds.get(g.reserveLevelNo)!;
      const [rp] = await tx<{ id: string }[]>`
        INSERT INTO pool_prizes (pool_id, kind, level_id, name, qty_per_set, sort_order, recycle_value, recyclable, tag, bulky, ship_method, image_url)
        VALUES (${poolId}, 'GUARANTEE', ${lv.id}, ${g.reservePrizeName}, 0, 1001, ${g.reserveRecycleValue}, ${g.reserveRecyclable ?? g.reserveRecycleValue > 0},
                ${g.reserveTag}, ${resolveBulky(g.reserveTag, g.reserveBulky, g.reserveLevelNo)},
                ${resolveShipMethod(g.reserveShipMethod, g.reserveTag, g.reserveBulky, g.reserveLevelNo)}, ${g.reserveImageUrl})
        RETURNING id`;
      await tx`INSERT INTO pool_guarantees (pool_id, every_n, min_level, reserve_prize_name, reserve_total, reserve_prize_id)
               VALUES (${poolId}, ${g.everyN}, ${g.minLevel}, ${g.reservePrizeName}, ${g.reserveTotal}, ${rp!.id})`;
    }
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: 'POOL_DRAFT_CREATED',
      entityType: 'pool',
      entityId: poolId,
      payload: {
        slug: v.slug, playType: v.playType, source: v.source, priceCoins: v.priceCoins, setCount: v.setCount,
        levels: v.levels.map((l) => ({ levelNo: l.levelNo, name: l.name, items: l.items.length })),
        freightCollect: true,
      },
    });
    return { poolId };
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
  terms: string;
  status: string;
}

interface StructPrize {
  id: string;
  kind: 'TICKET' | 'LAST' | 'GUARANTEE';
  levelId: string | null;
  levelNo: number | null;
  name: string;
  qtyPerSet: number;
}
interface StructLevel {
  id: string;
  levelNo: number;
  name: string;
  isSmall: boolean;
  odds: number | null;
}

async function loadStructure(tx: Tx, poolId: string) {
  const levels = await tx<StructLevel[]>`SELECT id, level_no, name, is_small, odds FROM pool_levels WHERE pool_id = ${poolId} ORDER BY level_no`;
  const prizes = await tx<StructPrize[]>`
    SELECT pp.id, pp.kind, pp.level_id, pl.level_no, pp.name, pp.qty_per_set
    FROM pool_prizes pp LEFT JOIN pool_levels pl ON pl.id = pp.level_id
    WHERE pp.pool_id = ${poolId} ORDER BY pl.level_no NULLS LAST, pp.sort_order, pp.name`;
  const [g] = await tx<{ everyN: number; minLevel: number; reservePrizeName: string; reserveTotal: number; reservePrizeId: string }[]>`
    SELECT every_n, min_level, reserve_prize_name, reserve_total, reserve_prize_id FROM pool_guarantees WHERE pool_id = ${poolId}`;
  return { levels, prizes, guarantee: g ?? null };
}

/**
 * 發布前結構檢查（申請發布與核准發布時都會執行）：
 * 1–12 個等級、每級至少一個籤獎項、每套總籤數 ≤ 20,000；SOLO 須恰好一個非小獎獎項；GUARANTEE 須有保底設定。
 */
export async function assertPublishable(tx: Tx, poolId: string): Promise<void> {
  const [pool] = await tx<{ playType: string }[]>`SELECT play_type FROM pools WHERE id = ${poolId}`;
  if (!pool) throw new AppError('NOT_FOUND', 'pool not found');
  const { levels, prizes, guarantee } = await loadStructure(tx, poolId);
  const problems: string[] = [];
  if (levels.length < 1 || levels.length > LEVEL_MAX) problems.push(`賞池須有 1–${LEVEL_MAX} 個等級`);
  const tickets = prizes.filter((p) => p.kind === 'TICKET');
  for (const l of levels) if (!tickets.some((p) => p.levelId === l.id)) problems.push(`等級 ${l.levelNo}（${l.name}）沒有獎項`);
  const total = tickets.reduce((s, p) => s + p.qtyPerSet, 0);
  if (total < 1 || total > MAX_TICKETS_PER_SET) problems.push(`每套籤數須為 1–${MAX_TICKETS_PER_SET}`);
  if (pool.playType === 'SOLO') {
    const smallIds = new Set(levels.filter((l) => l.isSmall).map((l) => l.id));
    if (tickets.filter((p) => !smallIds.has(p.levelId!)).length !== 1) problems.push('SOLO 賞池須恰好一個非小獎獎項');
  }
  if ((pool.playType === 'GUARANTEE') !== (guarantee !== null)) problems.push('保底設定只適用且必須用於 GUARANTEE 賞池');
  const withOdds = levels.filter((l) => l.odds !== null);
  if (withOdds.length && pool.playType !== 'PROB') problems.push('只有機率賞（PROB）的等級可以設定固定機率 odds');
  if (withOdds.reduce((a, l) => a + l.odds!, 0) >= 1) problems.push('所有等級的固定機率總和必須小於 1');
  if (problems.length) throw new AppError('VALIDATION', problems.join('；'), { problems });
}

/** 由雙人覆核核准後執行：建立不可變規則版本、每套以 CSPRNG 洗牌並產生承諾雜湊、建立每套獎項回收設定。 */
export async function publishPool(tx: Tx, poolId: string, approverId: string): Promise<Record<string, unknown>> {
  const [pool] = await tx<PoolRow[]>`
    SELECT id, merchant_id, title, source, play_type, price_coins, set_count, terms, status
    FROM pools WHERE id = ${poolId} AND deleted_at IS NULL FOR UPDATE`;
  if (!pool) throw new AppError('NOT_FOUND', 'pool not found');
  if (pool.status !== 'PENDING_PUBLISH') throw new AppError('INVALID_STATE', `pool is ${pool.status}`);
  await assertPublishable(tx, poolId);
  const { levels, prizes: all, guarantee: g } = await loadStructure(tx, poolId);
  const prizes = all.filter((p) => p.kind === 'TICKET');
  const lastPrize = all.find((p) => p.kind === 'LAST') ?? null;
  const reserve = g ? all.find((p) => p.id === g.reservePrizeId)! : null;

  const rules: PoolRules = {
    schema: 'chiaki-rules-v3',
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
    levels: levels.map((l) => ({
      levelNo: l.levelNo,
      name: l.name,
      isSmall: l.isSmall,
      ...(pool.playType === 'PROB' ? { odds: l.odds } : {}),
      prizes: prizes.filter((p) => p.levelId === l.id).map((p) => ({ prizeId: p.id, name: p.name, qtyPerSet: p.qtyPerSet })),
    })),
    prizes: prizes.map((p) => ({ prizeId: p.id, levelNo: p.levelNo!, name: p.name, qtyPerSet: p.qtyPerSet })),
    lastPrize: lastPrize ? { prizeId: lastPrize.id, name: lastPrize.name, rule: 'AWARDED_TO_DRAWER_OF_FINAL_TICKET_OF_EACH_SET' } : null,
    guarantee: g
      ? {
          everyN: g.everyN,
          minLevel: g.minLevel,
          reservePrizeId: g.reservePrizeId,
          reserveLevelNo: reserve!.levelNo!,
          reservePrizeName: g.reservePrizeName,
          reserveTotal: g.reserveTotal,
          rule: 'EXTRA_PRIZE_FROM_SEPARATE_RESERVE_AFTER_N_CONSECUTIVE_DRAWS_BELOW_MIN_LEVEL; STOPS_WHEN_RESERVE_EXHAUSTED; TICKET_ODDS_UNCHANGED',
        }
      : null,
    shippingPolicy: {
      mode: 'FREIGHT_COLLECT',
      rule: 'NO_SHIPPING_CHARGE_AT_DRAW_OR_SHIP_REQUEST; FREIGHT_PAID_BY_RECIPIENT_ON_DELIVERY; SHIP_METHOD_PRESET_PER_PRIZE; MIXED_METHODS_SPLIT_INTO_ONE_SHIPMENT_PER_METHOD',
    },
    ...(pool.playType === 'PROB'
      ? {
          prob: {
            scheme: PROB_SCHEME,
            rule: 'EACH_TICKET: WALK_LEVELS_WITH_ODDS_IN_ORDER_SKIPPING_EXHAUSTED; U<CUMULATIVE_ODDS→UNIFORM_TICKET_OF_THAT_LEVEL; ELSE UNIFORM_TICKET_OF_LEVELS_WITHOUT_ODDS (NONE LEFT→ALL REMAINING); RNG=HMAC-SHA256(serverSeed, scheme:clientSeed:nonce:block); SERVER_SEED_HASH_PUBLISHED_BEFORE_SALE, SEED_REVEALED_WHEN_SET_SOLD_OUT',
          },
        }
      : {}),
    terms: pool.terms,
  };
  const hash = rulesHash(rules);
  const [rv] = await tx<{ id: string }[]>`
    INSERT INTO pool_rule_versions (merchant_id, pool_id, version, rules_json, rules_hash, created_by, published_at)
    VALUES (${pool.merchantId}, ${poolId}, 1, ${canonicalJson(rules)}, ${hash}, ${approverId}, now())
    RETURNING id`;

  const sets: { setNo: number; commitment: string }[] = [];
  const layoutInput = prizes.map((p) => ({ id: p.id, levelNo: p.levelNo!, qtyPerSet: p.qtyPerSet }));
  for (let setNo = 1; setNo <= pool.setCount; setNo++) {
    const layout = generateLayout(layoutInput);
    const salt = generateSalt();
    const commitment = computeCommitment({ scheme: COMMIT_SCHEME, poolId, setNo, rulesHash: hash, layout }, salt);
    const probSeed = pool.playType === 'PROB' ? generateServerSeed() : null;
    const [set] = await tx<{ id: string }[]>`
      INSERT INTO pool_sets (merchant_id, pool_id, set_no, rule_version_id, status, total_tickets, commit_scheme, commitment, commit_salt, on_sale_at,
                             prob_server_seed, prob_seed_hash)
      VALUES (${pool.merchantId}, ${poolId}, ${setNo}, ${rv!.id}, ${setNo === 1 ? 'ON_SALE' : 'QUEUED'}, ${layout.length},
              ${COMMIT_SCHEME}, ${commitment}, ${salt}, ${setNo === 1 ? new Date() : null}, ${probSeed}, ${probSeed ? seedHash(probSeed) : null})
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

export async function lockPublishedPool(tx: Tx, idOrSlug: string): Promise<{ id: string; status: string }> {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rows = UUID_RE.test(idOrSlug)
    ? await tx<{ id: string; status: string }[]>`SELECT id, status FROM pools WHERE id = ${idOrSlug} FOR UPDATE`
    : await tx<{ id: string; status: string }[]>`SELECT id, status FROM pools WHERE slug = ${idOrSlug} FOR UPDATE`;
  if (!rows[0]) throw new AppError('NOT_FOUND', 'pool not found');
  return rows[0];
}

export const PoolSettingsSchema = z
  .object({
    shippingNote: z.string().max(500).optional(),
    /** 賞池資訊（隨時可改，留稽核）：說明 ≤ 400 字、來源說明、商品狀態 */
    description: z.string().max(400, '說明最多 400 字').optional(),
    sourceNote: z.string().trim().max(200).optional(),
    condition: z.string().trim().max(200).optional(),
    ipId: z.string().uuid().nullable().optional(),
    /** 快速抽包選項（1、3、5、10、20、all 的子集合）；隨時可改 */
    drawPacks: DrawPacksSchema.optional(),
    /** 最後賞（null = 移除）：只在草稿階段可改 */
    lastPrize: LastPrizeSchema.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

/** 更新賞池營運設定：出貨時程說明（無固定 SLA）、連結 IP（作品；null = 取消連結）、快速抽包選項；草稿另可設定最後賞。 */
export async function updatePoolSettings(actor: Principal, idOrSlug: string, input: z.input<typeof PoolSettingsSchema>) {
  requirePermission(actor, 'pool.config.manage');
  const v = PoolSettingsSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPublishedPool(tx, idOrSlug);
    const [before] = await tx<{ shippingNote: string; ipId: string | null; drawPacks: string[]; lastPrizeName: string | null; description: string; sourceNote: string; condition: string }[]>`
      SELECT shipping_note, ip_id, draw_packs, last_prize_name, description, source_note, item_condition AS condition FROM pools WHERE id = ${p.id}`;
    if (v.lastPrize !== undefined) {
      if (p.status !== 'DRAFT') throw new AppError('STRUCTURE_LOCKED', '最後賞屬於賞池結構，只能在草稿階段修改（已發布賞池的籤表與規則已承諾）');
      await tx`DELETE FROM set_prizes WHERE prize_id IN (SELECT id FROM pool_prizes WHERE pool_id = ${p.id} AND kind = 'LAST')`;
      await tx`DELETE FROM pool_prizes WHERE pool_id = ${p.id} AND kind = 'LAST'`;
      await tx`UPDATE pools SET last_prize_name = NULL WHERE id = ${p.id}`;
      if (v.lastPrize) await insertLastPrize(tx, p.id, v.lastPrize);
    }
    if (v.shippingNote !== undefined) await tx`UPDATE pools SET shipping_note = ${v.shippingNote} WHERE id = ${p.id}`;
    if (v.description !== undefined) await tx`UPDATE pools SET description = ${v.description} WHERE id = ${p.id}`;
    if (v.sourceNote !== undefined) await tx`UPDATE pools SET source_note = ${v.sourceNote} WHERE id = ${p.id}`;
    if (v.condition !== undefined) await tx`UPDATE pools SET item_condition = ${v.condition} WHERE id = ${p.id}`;
    if (v.ipId !== undefined) await linkPoolIp(tx, p.id, v.ipId);
    if (v.drawPacks !== undefined) await tx`UPDATE pools SET draw_packs = ${v.drawPacks}::text[] WHERE id = ${p.id}`;
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: 'POOL_SETTINGS_UPDATED', entityType: 'pool', entityId: p.id, payload: { before, ...v } });
    const [after] = await tx<{ shippingNote: string; ipId: string | null; drawPacks: string[]; lastPrizeName: string | null; description: string; sourceNote: string; condition: string }[]>`
      SELECT shipping_note, ip_id, draw_packs, last_prize_name, description, source_note, item_condition AS condition FROM pools WHERE id = ${p.id}`;
    return {
      poolId: p.id,
      shippingNote: after!.shippingNote,
      description: after!.description,
      sourceNote: after!.sourceNote,
      condition: after!.condition,
      ipId: after!.ipId,
      drawPacks: drawPacksOut(after!.drawPacks),
      lastPrizeName: after!.lastPrizeName,
    };
  });
}

export const SetConfigSchema = z
  .object({
    prizes: z
      .array(z.object({ prizeId: z.string().uuid(), recycleValue: RecycleValueSchema.optional(), recyclable: z.boolean().optional() }))
      .min(1)
      .max(60),
  })
  .strict();

/**
 * 逐套設定：每個獎項的回收值/可否回收（運費到付後不再有每套運費設定）。
 * 回收值於「回收或到期轉換當下」讀取。
 */
export async function updateSetConfig(actor: Principal, idOrSlug: string, setNo: number, input: z.input<typeof SetConfigSchema>) {
  requirePermission(actor, 'pool.config.manage');
  const v = SetConfigSchema.parse(input);
  return transaction(async (tx) => {
    const p = await lockPublishedPool(tx, idOrSlug);
    if (p.status !== 'PUBLISHED' && p.status !== 'ENDED') throw new AppError('INVALID_STATE', 'pool is not published');
    const [s] = await tx<{ id: string }[]>`SELECT id FROM pool_sets WHERE pool_id = ${p.id} AND set_no = ${setNo} FOR UPDATE`;
    if (!s) throw new AppError('NOT_FOUND', 'set not found');
    const changed: { prizeId: string; before: { recycleValue: number; recyclable: boolean }; after: { recycleValue: number; recyclable: boolean } }[] = [];
    for (const pr of v.prizes) {
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
      payload: { poolId: p.id, setNo, prizes: changed },
    });
    return { poolId: p.id, setNo, prizes: changed.map((c) => ({ prizeId: c.prizeId, ...c.after })) };
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
