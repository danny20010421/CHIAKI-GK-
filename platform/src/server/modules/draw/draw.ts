import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { canonicalJson, sha256Hex } from '../../lib/canonical';
import { db, transaction, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { postLedger } from '../wallet/wallet';
import { enforceRateLimit } from '../risk/risk';
import { resolvePublicPool } from '../pool/queries';
import type { PoolRules } from '../pool/rules';
import { displayName, gradeAtLeast, type Grade } from '../pool/grades';
import { ShippingMethodSchema } from '../shipping/fees';
import { computeShippingCharge, lockUserSetShipping, type ShippingCharge } from '../shipping/prepaid';
import { notifyEvent } from '../notifications/outbox';
import { getWallet } from '../wallet/wallet';
import { TicketNosSchema } from './holds';

export const DrawRequestSchema = z
  .object({
    poolId: z.string().min(1).max(100), // id 或 slug
    setNo: z.number().int().positive(),
    ticketNos: TicketNosSchema.optional(),
    count: z.number().int().positive().optional(), // 由伺服器以 CSPRNG 代選
    // 運費按套預收：本次需收運費且此套尚無預收紀錄時必填；之後未填則沿用此套上次的方式
    shippingMethod: ShippingMethodSchema.optional(),
  })
  .refine((v) => (v.ticketNos ? 1 : 0) + (v.count ? 1 : 0) === 1, 'provide exactly one of ticketNos or count');
export type DrawRequest = z.infer<typeof DrawRequestSchema>;

export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/, 'Idempotency-Key must be 8-128 chars [A-Za-z0-9_-:.]');

export type AwardKind = 'TICKET' | 'GUARANTEE' | 'LAST';
export interface DrawResultItem {
  seq: number;
  kind: AwardKind;
  ticketNo: number | null;
  prizeId: string;
  /** 賞級；自製（CUSTOM）賞池為 null */
  rank: string | null;
  /** 等級：決定開獎特效、保底資格、運費計數 */
  grade: Grade;
  prizeName: string;
  /** 對外顯示名稱：自製＝獎項名稱；官方/混合＝賞級 + 名稱 */
  displayName: string;
  warehouseItemId: string;
}

export type DrawShipping = Omit<ShippingCharge, 'methodRequired' | 'options'> & { prepaymentIds: string[] };
export interface DrawResponse {
  drawId: string;
  poolId: string;
  setNo: number;
  ticketNos: number[];
  unitPrice: number;
  amountCoins: number;
  /** 本次一併扣除的預收運費 */
  shipping: DrawShipping;
  totalCoins: number;
  coinsAfter: number;
  results: DrawResultItem[];
  setSoldOut: boolean;
  nextSetNo: number | null;
  guarantee: { misses: number; everyN: number; minGrade: Grade; reserveRemaining: number } | null;
  createdAt: string;
}

interface Award {
  kind: AwardKind;
  ticketNo: number | null;
  prizeId: string;
  rank: string | null;
  grade: Grade;
  prizeName: string;
}

const SCOPE = 'draw';

/**
 * 抽賞＝單一資料庫交易（READ COMMITTED + 明確列鎖）：
 *  1. 冪等鍵登記（同鍵並發請求會在唯一索引上等待，先完成者提交後，後者讀到同一結果重播）
 *  2. 驗證會員狀態/年齡驗證
 *  3. 鎖定「套」(pool_sets FOR UPDATE)：同套抽賞序列化，確保最後一籤/完售判定正確
 *  4. 鎖定籤 (tickets FOR UPDATE)，檢查未被抽出、未被他人保留
 *  5. 扣代幣（條件式 UPDATE + 帳本）＋ 按套預收運費（SHIPPING_PREPAID，同一交易）
 *  6. 標記籤已抽、寫入 draw / draw_results、入中獎倉庫
 *  7. 保底計數（獨立保底庫存，不改變籤的機率）、最後賞、完售與下一套開賣
 *  8. 稽核鏈（最後取得的鎖）＋ 儲存冪等回應
 * 鎖順序固定：set → tickets → wallet → pool_guarantees → guarantee_counters → audit_head，避免死結。
 */
export async function executeDraw(
  userId: string,
  idempotencyKey: string | null | undefined,
  body: unknown,
): Promise<{ response: DrawResponse; replayed: boolean }> {
  if (!idempotencyKey) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  const key = IdempotencyKeySchema.parse(idempotencyKey);
  const req = DrawRequestSchema.parse(body);
  const n = req.ticketNos?.length ?? req.count!;
  if (n > config().MAX_TICKETS_PER_DRAW) throw new AppError('VALIDATION', `max ${config().MAX_TICKETS_PER_DRAW} tickets per draw`);
  const requestHash = sha256Hex(canonicalJson(req));

  // 快速路徑：已完成的請求直接重播（不計入限流、不再進交易）
  const prior = await db()<{ requestHash: string; responseJson: string | null }[]>`
    SELECT request_hash, response_json FROM idempotency_keys WHERE user_id = ${userId} AND scope = ${SCOPE} AND key = ${key}`;
  if (prior[0]?.responseJson) {
    if (prior[0].requestHash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
    return { response: JSON.parse(prior[0].responseJson) as DrawResponse, replayed: true };
  }

  await enforceRateLimit(userId, 'DRAW');

  return transaction(async (tx) => {
    // 1. 冪等鍵
    const ins = await tx`
      INSERT INTO idempotency_keys (user_id, scope, key, request_hash) VALUES (${userId}, ${SCOPE}, ${key}, ${requestHash})
      ON CONFLICT DO NOTHING RETURNING key`;
    if (ins.length === 0) {
      const [row] = await tx<{ requestHash: string; responseJson: string | null }[]>`
        SELECT request_hash, response_json FROM idempotency_keys WHERE user_id = ${userId} AND scope = ${SCOPE} AND key = ${key}`;
      if (!row || row.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
      if (!row.responseJson) throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'request with this key is still in progress');
      return { response: JSON.parse(row.responseJson) as DrawResponse, replayed: true };
    }

    // 2. 會員
    const [u] = await tx<{ status: string; ageVerifiedAt: Date | null }[]>`SELECT status, age_verified_at FROM users WHERE id = ${userId}`;
    if (!u) throw new AppError('UNAUTHENTICATED', 'user not found');
    if (u.status !== 'ACTIVE') throw new AppError('FORBIDDEN', 'account suspended');
    if (!u.ageVerifiedAt) throw new AppError('AGE_VERIFICATION_REQUIRED', '首次付費抽賞前須完成年齡/身分驗證');

    // 3. 鎖定套
    const { id: poolId } = await resolvePublicPool(tx, req.poolId);
    const [set] = await tx<{ id: string; status: string; merchantId: string; ruleVersionId: string; poolStatus: string; poolTitle: string; rulesJson: string; shipFeeHome: number; shipFeeCvs: number }[]>`
      SELECT s.id, s.status, s.merchant_id, s.rule_version_id, p.status AS pool_status, p.title AS pool_title, rv.rules_json, s.ship_fee_home, s.ship_fee_cvs
      FROM pool_sets s JOIN pools p ON p.id = s.pool_id JOIN pool_rule_versions rv ON rv.id = s.rule_version_id
      WHERE s.pool_id = ${poolId} AND s.set_no = ${req.setNo}
      FOR UPDATE OF s`;
    if (!set) throw new AppError('NOT_FOUND', 'set not found');
    if (set.poolStatus !== 'PUBLISHED' || set.status !== 'ON_SALE') throw new AppError('SET_NOT_ON_SALE', '本套目前不開放抽賞');
    const rules = JSON.parse(set.rulesJson) as PoolRules; // 價格等以「該套綁定的不可變規則版本」為準

    // 4. 選籤 + 鎖籤
    let nos: number[];
    if (req.ticketNos) {
      nos = [...req.ticketNos].sort((a, b) => a - b);
    } else {
      const avail = await tx<{ ticketNo: number }[]>`
        SELECT ticket_no FROM tickets WHERE set_id = ${set.id} AND status = 'AVAILABLE'
          AND (held_by IS NULL OR held_by = ${userId} OR held_until <= now()) ORDER BY ticket_no`;
      if (avail.length < n) throw new AppError('NOT_ENOUGH_TICKETS', '可選籤數不足', { available: avail.length });
      const pool = avail.map((a) => a.ticketNo);
      for (let i = 0; i < n; i++) {
        const j = i + randomInt(pool.length - i);
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      nos = pool.slice(0, n).sort((a, b) => a - b);
    }
    const tickets = await tx<{ ticketNo: number; prizeId: string; status: string; heldByOther: boolean; rank: string | null; grade: Grade; name: string }[]>`
      SELECT t.ticket_no, t.prize_id, t.status,
             (t.held_by IS NOT NULL AND t.held_by <> ${userId} AND t.held_until > now()) AS held_by_other,
             pr.rank, pr.grade, pr.name
      FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id
      WHERE t.set_id = ${set.id} AND t.ticket_no = ANY(${nos}::int[])
      ORDER BY t.ticket_no
      FOR UPDATE OF t`;
    if (tickets.length !== nos.length) {
      const found = new Set(tickets.map((t) => t.ticketNo));
      throw new AppError('TICKET_NOT_FOUND', '籤號不存在', { ticketNos: nos.filter((x) => !found.has(x)) });
    }
    const taken = tickets.filter((t) => t.status !== 'AVAILABLE').map((t) => t.ticketNo);
    if (taken.length) throw new AppError('TICKET_TAKEN', '籤號已被抽出', { ticketNos: taken });
    const held = tickets.filter((t) => t.heldByOther).map((t) => t.ticketNo);
    if (held.length) throw new AppError('TICKET_HELD', '籤號正由其他玩家保留中', { ticketNos: held });

    // 5. 扣款（不足則整筆 rollback，不會留下任何扣款或籤狀態）＋ 按套預收運費（同一交易）
    const unitPrice = rules.priceCoins;
    const amount = unitPrice * nos.length;
    if (!Number.isSafeInteger(amount)) throw new AppError('VALIDATION', 'amount overflow');
    // 同一會員同一套的運費計算與回收退還序列化（鎖順序：set → tickets → advisory → wallet）
    await lockUserSetShipping(tx, userId, set.id);
    const ship = await computeShippingCharge(tx, {
      userId,
      set,
      ticketCount: nos.length,
      requestedMethod: req.shippingMethod ?? null,
      smallItemsPerFee: smallItemsPerFee(rules),
    });
    if (ship.methodRequired) {
      throw new AppError('SHIPPING_METHOD_REQUIRED', '本套首次抽賞須選擇物流方式（運費按套預收）', { options: ship.options });
    }
    const drawId = randomUUID();
    await tx`
      INSERT INTO draws (id, merchant_id, user_id, pool_id, set_id, rule_version_id, idempotency_key, ticket_count, unit_price, amount_coins, shipping_coins)
      VALUES (${drawId}, ${set.merchantId}, ${userId}, ${poolId}, ${set.id}, ${set.ruleVersionId}, ${key}, ${nos.length}, ${unitPrice}, ${amount}, ${ship.amount})`;
    let { balanceAfter } = await postLedger(tx, {
      userId,
      currency: 'COINS',
      amount: -amount,
      entryType: 'DRAW_DEBIT',
      refType: 'draw',
      refId: drawId,
      merchantId: set.merchantId,
    });
    const prepaymentIds: string[] = [];
    for (let i = 0; i < ship.feesToCharge; i++) {
      const id = randomUUID();
      await tx`
        INSERT INTO shipping_prepayments (id, merchant_id, user_id, pool_id, set_id, draw_id, seq, method, fee_coins, small_items_covered)
        VALUES (${id}, ${set.merchantId}, ${userId}, ${poolId}, ${set.id}, ${drawId}, ${ship.nextSeq + i}, ${ship.method!}, ${ship.unitFee}, ${ship.smallItemsPerFee})`;
      ({ balanceAfter } = await postLedger(tx, {
        userId,
        currency: 'COINS',
        amount: -ship.unitFee,
        entryType: 'SHIPPING_PREPAID',
        refType: 'shipping_prepayment',
        refId: id,
        merchantId: set.merchantId,
        memo: `第 ${req.setNo} 套運費預收（${ship.method}）`,
      }));
      prepaymentIds.push(id);
    }

    // 6. 標記已抽
    const upd = await tx`
      UPDATE tickets SET status = 'TAKEN', taken_by = ${userId}, draw_id = ${drawId}, taken_at = now(), held_by = NULL, held_until = NULL
      WHERE set_id = ${set.id} AND ticket_no = ANY(${nos}::int[]) AND status = 'AVAILABLE'
      RETURNING ticket_no`;
    if (upd.length !== nos.length) throw new Error('invariant violated: ticket state changed under lock');

    // 7a. 籤的結果 + 保底（以「等級」判定：min_grade 以上視為命中）
    const awards: Award[] = [];
    const ticketAward = (t: (typeof tickets)[number]): Award => ({ kind: 'TICKET', ticketNo: t.ticketNo, prizeId: t.prizeId, rank: t.rank, grade: t.grade, prizeName: t.name });
    let guaranteeState: DrawResponse['guarantee'] = null;
    if (rules.guarantee) {
      const [g] = await tx<{ everyN: number; minGrade: Grade; reserveTotal: number; reserveUsed: number; reservePrizeId: string; reserveRank: string | null; reserveGrade: Grade; reserveName: string }[]>`
        SELECT g.every_n, g.min_grade, g.reserve_total, g.reserve_used, g.reserve_prize_id,
               pr.rank AS reserve_rank, pr.grade AS reserve_grade, pr.name AS reserve_name
        FROM pool_guarantees g JOIN pool_prizes pr ON pr.id = g.reserve_prize_id
        WHERE g.pool_id = ${poolId} FOR UPDATE OF g`;
      if (!g) throw new Error('guarantee config missing');
      await tx`INSERT INTO guarantee_counters (user_id, pool_id) VALUES (${userId}, ${poolId}) ON CONFLICT DO NOTHING`;
      const [c] = await tx<{ misses: number }[]>`
        SELECT misses FROM guarantee_counters WHERE user_id = ${userId} AND pool_id = ${poolId} FOR UPDATE`;
      let misses = c!.misses;
      let used = g.reserveUsed;
      for (const t of tickets) {
        awards.push(ticketAward(t));
        if (gradeAtLeast(t.grade, g.minGrade)) {
          misses = 0; // 抽中門檻等級以上 → 計數歸零
        } else {
          misses++;
          if (misses >= g.everyN && used < g.reserveTotal) {
            used++;
            misses = 0;
            awards.push({ kind: 'GUARANTEE', ticketNo: null, prizeId: g.reservePrizeId, rank: g.reserveRank, grade: g.reserveGrade, prizeName: g.reserveName });
          }
        }
      }
      await tx`UPDATE guarantee_counters SET misses = ${misses}, updated_at = now() WHERE user_id = ${userId} AND pool_id = ${poolId}`;
      if (used !== g.reserveUsed) await tx`UPDATE pool_guarantees SET reserve_used = ${used} WHERE pool_id = ${poolId}`;
      guaranteeState = { misses, everyN: g.everyN, minGrade: g.minGrade, reserveRemaining: g.reserveTotal - used };
    } else {
      for (const t of tickets) awards.push(ticketAward(t));
    }

    // 7b. 完售 → 最後賞、下一套開賣
    const [cnt] = await tx<{ remaining: number }[]>`
      SELECT count(*)::int AS remaining FROM tickets WHERE set_id = ${set.id} AND status = 'AVAILABLE'`;
    const remaining = cnt!.remaining;
    let nextSetNo: number | null = null;
    if (remaining === 0) {
      if (rules.lastPrize) {
        const [lp] = await tx<{ id: string; rank: string | null; grade: Grade; name: string }[]>`
          SELECT id, rank, grade, name FROM pool_prizes WHERE pool_id = ${poolId} AND kind = 'LAST'`;
        if (!lp) throw new Error('last prize row missing');
        awards.push({ kind: 'LAST', ticketNo: null, prizeId: lp.id, rank: lp.rank, grade: lp.grade, prizeName: lp.name });
      }
      await tx`UPDATE pool_sets SET status = 'SOLD_OUT', sold_out_at = now(), last_prize_user_id = ${rules.lastPrize ? userId : null} WHERE id = ${set.id}`;
      const [next] = await tx<{ setNo: number }[]>`
        UPDATE pool_sets SET status = 'ON_SALE', on_sale_at = now()
        WHERE id = (SELECT id FROM pool_sets WHERE pool_id = ${poolId} AND status = 'QUEUED' ORDER BY set_no LIMIT 1)
        RETURNING set_no`;
      if (next) nextSetNo = next.setNo;
      else await tx`UPDATE pools SET status = 'ENDED' WHERE id = ${poolId}`;
    }

    // 7c. 中獎倉庫 + 結果列
    // 寄存期限：自入庫起 STORAGE_FREE_DAYS 天（寫入當下的設定，之後改設定不追溯）
    const items = awards.map((a, i) => ({ ...a, seq: i + 1, id: randomUUID() }));
    await tx`
      INSERT INTO warehouse_items (id, merchant_id, user_id, source, pool_id, set_id, draw_id, ticket_no, prize_id, rank, grade, prize_name, storage_expires_at)
      SELECT u.id, ${set.merchantId}, ${userId}, u.source, ${poolId}, ${set.id}, ${drawId}, u.ticket_no, u.prize_id, u.rank, u.grade, u.prize_name,
             now() + make_interval(days => ${config().STORAGE_FREE_DAYS})
      FROM unnest(${items.map((i) => i.id)}::uuid[], ${items.map((i) => i.kind)}::text[], ${items.map((i) => i.ticketNo)}::int[],
                  ${items.map((i) => i.prizeId)}::uuid[], ${items.map((i) => i.rank)}::text[], ${items.map((i) => i.grade)}::text[],
                  ${items.map((i) => i.prizeName)}::text[])
           AS u(id, source, ticket_no, prize_id, rank, grade, prize_name)`;
    await tx`
      INSERT INTO draw_results (draw_id, seq, kind, ticket_no, prize_id, rank, grade, prize_name, warehouse_item_id)
      SELECT ${drawId}, u.seq, u.kind, u.ticket_no, u.prize_id, u.rank, u.grade, u.prize_name, u.item_id
      FROM unnest(${items.map((i) => i.seq)}::int[], ${items.map((i) => i.kind)}::text[], ${items.map((i) => i.ticketNo)}::int[],
                  ${items.map((i) => i.prizeId)}::uuid[], ${items.map((i) => i.rank)}::text[], ${items.map((i) => i.grade)}::text[],
                  ${items.map((i) => i.prizeName)}::text[], ${items.map((i) => i.id)}::uuid[])
           AS u(seq, kind, ticket_no, prize_id, rank, grade, prize_name, item_id)`;

    const response: DrawResponse = {
      drawId,
      poolId,
      setNo: req.setNo,
      ticketNos: nos,
      unitPrice,
      amountCoins: amount,
      shipping: shippingSummary(ship, prepaymentIds),
      totalCoins: amount + ship.amount,
      coinsAfter: balanceAfter,
      results: items.map((i) => ({
        seq: i.seq,
        kind: i.kind,
        ticketNo: i.ticketNo,
        prizeId: i.prizeId,
        rank: i.rank,
        grade: i.grade,
        prizeName: i.prizeName,
        displayName: displayName(rules.source, i.rank, i.prizeName),
        warehouseItemId: i.id,
      })),
      setSoldOut: remaining === 0,
      nextSetNo,
      guarantee: guaranteeState,
      createdAt: new Date().toISOString(),
    };

    // 7d. 通知（預設只走 Web Push；站內/其他管道依會員偏好）
    const gradeOrder: Record<Grade, number> = { GRAND: 0, MID: 1, SMALL: 2 };
    const best = [...response.results].sort((a, b) => gradeOrder[a.grade] - gradeOrder[b.grade])[0]!;
    await notifyEvent(tx, {
      userId,
      merchantId: set.merchantId,
      event: 'DRAW_RESULT',
      data: { drawId, poolTitle: set.poolTitle, setNo: req.setNo, count: nos.length, summary: response.results.length > 1 ? `${best.displayName} 等 ${response.results.length} 件` : best.displayName },
      payload: { drawId, poolId, setNo: req.setNo },
      dedupeOn: { drawId },
    });

    // 8. 稽核 + 冪等回應
    await appendAudit(tx, {
      actorType: 'USER',
      actorId: userId,
      action: 'DRAW',
      entityType: 'draw',
      entityId: drawId,
      merchantId: set.merchantId,
      payload: {
        poolId,
        setNo: req.setNo,
        ruleVersionId: set.ruleVersionId,
        ticketNos: nos,
        amountCoins: amount,
        shippingPrepaid: { method: ship.method, fees: ship.feesToCharge, unitFee: ship.unitFee, amount: ship.amount, feesPaidAfter: ship.feesPaidAfter },
        coinsAfter: balanceAfter,
        results: items.map((i) => ({ kind: i.kind, ticketNo: i.ticketNo, prizeId: i.prizeId, grade: i.grade })),
      },
    });
    await tx`UPDATE idempotency_keys SET response_json = ${JSON.stringify(response)} WHERE user_id = ${userId} AND scope = ${SCOPE} AND key = ${key}`;
    return { response, replayed: false };
  });
}

function smallItemsPerFee(rules: PoolRules): number {
  return rules.shippingPolicy?.smallItemsPerFee ?? config().SHIPPING_SMALL_ITEMS_PER_FEE;
}

function shippingSummary(c: ShippingCharge, prepaymentIds: string[]): DrawShipping {
  const { methodRequired: _m, options: _o, ...rest } = c;
  return { ...rest, prepaymentIds };
}

/**
 * 抽賞前試算（POST /api/draws/quote）：籤價、預收運費明細（含各物流方式金額）、總額與餘額是否足夠。
 * 唯讀、不鎖定；實際扣款以抽賞交易內（已鎖定該套）重新計算的結果為準（同一函式，結果一致，除非期間狀態改變）。
 */
export async function quoteDraw(userId: string, body: unknown) {
  const req = DrawRequestSchema.parse(body);
  const n = req.ticketNos?.length ?? req.count!;
  if (n > config().MAX_TICKETS_PER_DRAW) throw new AppError('VALIDATION', `max ${config().MAX_TICKETS_PER_DRAW} tickets per draw`);
  const d = db();
  const { id: poolId } = await resolvePublicPool(d, req.poolId);
  const [set] = await d<{ id: string; status: string; poolStatus: string; rulesJson: string; shipFeeHome: number; shipFeeCvs: number }[]>`
    SELECT s.id, s.status, p.status AS pool_status, rv.rules_json, s.ship_fee_home, s.ship_fee_cvs
    FROM pool_sets s JOIN pools p ON p.id = s.pool_id JOIN pool_rule_versions rv ON rv.id = s.rule_version_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${req.setNo}`;
  if (!set) throw new AppError('NOT_FOUND', 'set not found');
  if (set.poolStatus !== 'PUBLISHED' || set.status !== 'ON_SALE') throw new AppError('SET_NOT_ON_SALE', '本套目前不開放抽賞');
  const rules = JSON.parse(set.rulesJson) as PoolRules;
  const ship = await computeShippingCharge(d, { userId, set, ticketCount: n, requestedMethod: req.shippingMethod ?? null, smallItemsPerFee: smallItemsPerFee(rules) });
  const wallet = await getWallet(d, userId);
  const drawCoins = rules.priceCoins * n;
  const totalCoins = drawCoins + ship.amount;
  return {
    poolId,
    setNo: req.setNo,
    ticketCount: n,
    unitPrice: rules.priceCoins,
    drawCoins,
    shipping: {
      ...ship,
      setFees: { HOME_DELIVERY: set.shipFeeHome, CVS_711_C2C: set.shipFeeCvs, CVS_FAMI_C2C: set.shipFeeCvs },
      rule: `運費按套預收：本套首次付費抽賞時收取一份；需要份數 = floor((本套抽到過的全部小獎 + 本次籤數) / ${ship.smallItemsPerFee}) + 1（滿 ${ship.smallItemsPerFee} 件即再收一份；大獎/中獎不計；已回收、已出貨的小獎仍計入）。回收小獎時每件退還 運費 ÷ N 代幣（不可退款）。`,
    },
    totalCoins,
    coinsBalance: wallet.coins,
    sufficientFunds: !ship.methodRequired && wallet.coins >= totalCoins,
  };
}

export async function getDraw(userId: string, drawId: string) {
  const [d] = await db()<{ id: string; source: string }[]>`
    SELECT d.id, p.source FROM draws d JOIN pools p ON p.id = d.pool_id WHERE d.id = ${drawId} AND d.user_id = ${userId}`;
  if (!d) throw new AppError('NOT_FOUND', 'draw not found');
  const results = await db()<{ seq: number; kind: string; ticketNo: number | null; rank: string | null; grade: Grade; prizeName: string; warehouseItemId: string }[]>`
    SELECT seq, kind, ticket_no, rank, grade, prize_name, warehouse_item_id FROM draw_results WHERE draw_id = ${drawId} ORDER BY seq`;
  return { drawId, results: results.map((r) => ({ ...r, displayName: displayName(d.source, r.rank, r.prizeName) })) };
}
