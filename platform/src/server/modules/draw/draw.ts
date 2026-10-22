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
import { defaultTier, type PoolRules } from '../pool/rules';
import { TicketNosSchema } from './holds';

export const DrawRequestSchema = z
  .object({
    poolId: z.string().min(1).max(100), // id 或 slug
    setNo: z.number().int().positive(),
    ticketNos: TicketNosSchema.optional(),
    count: z.number().int().positive().optional(), // 由伺服器以 CSPRNG 代選
  })
  .refine((v) => (v.ticketNos ? 1 : 0) + (v.count ? 1 : 0) === 1, 'provide exactly one of ticketNos or count');
export type DrawRequest = z.infer<typeof DrawRequestSchema>;

export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/, 'Idempotency-Key must be 8-128 chars [A-Za-z0-9_-:.]');

export type AwardKind = 'TICKET' | 'GUARANTEE' | 'LAST';
export interface DrawResultItem {
  seq: number;
  kind: AwardKind;
  ticketNo: number | null;
  rank: string;
  tier: number;
  prizeName: string;
  warehouseItemId: string;
}
export interface DrawResponse {
  drawId: string;
  poolId: string;
  setNo: number;
  ticketNos: number[];
  unitPrice: number;
  amountCoins: number;
  coinsAfter: number;
  results: DrawResultItem[];
  setSoldOut: boolean;
  nextSetNo: number | null;
  guarantee: { misses: number; everyN: number; reserveRemaining: number } | null;
  createdAt: string;
}

interface Award {
  kind: AwardKind;
  ticketNo: number | null;
  prizeId: string | null;
  rank: string;
  tier: number;
  prizeName: string;
}

const SCOPE = 'draw';

/**
 * 抽賞＝單一資料庫交易（READ COMMITTED + 明確列鎖）：
 *  1. 冪等鍵登記（同鍵並發請求會在唯一索引上等待，先完成者提交後，後者讀到同一結果重播）
 *  2. 驗證會員狀態/年齡驗證
 *  3. 鎖定「套」(pool_sets FOR UPDATE)：同套抽賞序列化，確保最後一籤/完售判定正確
 *  4. 鎖定籤 (tickets FOR UPDATE)，檢查未被抽出、未被他人保留
 *  5. 扣代幣（條件式 UPDATE + 帳本）
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
    const [set] = await tx<{ id: string; status: string; merchantId: string; ruleVersionId: string; poolStatus: string; rulesJson: string }[]>`
      SELECT s.id, s.status, s.merchant_id, s.rule_version_id, p.status AS pool_status, rv.rules_json
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
    const tickets = await tx<{ ticketNo: number; prizeId: string; status: string; heldByOther: boolean; rank: string; tier: number; name: string }[]>`
      SELECT t.ticket_no, t.prize_id, t.status,
             (t.held_by IS NOT NULL AND t.held_by <> ${userId} AND t.held_until > now()) AS held_by_other,
             pr.rank, pr.tier, pr.name
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

    // 5. 扣款（不足則整筆 rollback，不會留下任何扣款或籤狀態）
    const unitPrice = rules.priceCoins;
    const amount = unitPrice * nos.length;
    if (!Number.isSafeInteger(amount)) throw new AppError('VALIDATION', 'amount overflow');
    const drawId = randomUUID();
    await tx`
      INSERT INTO draws (id, merchant_id, user_id, pool_id, set_id, rule_version_id, idempotency_key, ticket_count, unit_price, amount_coins)
      VALUES (${drawId}, ${set.merchantId}, ${userId}, ${poolId}, ${set.id}, ${set.ruleVersionId}, ${key}, ${nos.length}, ${unitPrice}, ${amount})`;
    const { balanceAfter } = await postLedger(tx, {
      userId,
      currency: 'COINS',
      amount: -amount,
      entryType: 'DRAW_DEBIT',
      refType: 'draw',
      refId: drawId,
      merchantId: set.merchantId,
    });

    // 6. 標記已抽
    const upd = await tx`
      UPDATE tickets SET status = 'TAKEN', taken_by = ${userId}, draw_id = ${drawId}, taken_at = now(), held_by = NULL, held_until = NULL
      WHERE set_id = ${set.id} AND ticket_no = ANY(${nos}::int[]) AND status = 'AVAILABLE'
      RETURNING ticket_no`;
    if (upd.length !== nos.length) throw new Error('invariant violated: ticket state changed under lock');

    // 7a. 籤的結果 + 保底
    const awards: Award[] = [];
    let guaranteeState: DrawResponse['guarantee'] = null;
    if (rules.guarantee) {
      const [g] = await tx<{ everyN: number; minTier: number; reserveRank: string; reservePrizeName: string; reserveTotal: number; reserveUsed: number }[]>`
        SELECT every_n, min_tier, reserve_rank, reserve_prize_name, reserve_total, reserve_used
        FROM pool_guarantees WHERE pool_id = ${poolId} FOR UPDATE`;
      if (!g) throw new Error('guarantee config missing');
      await tx`INSERT INTO guarantee_counters (user_id, pool_id) VALUES (${userId}, ${poolId}) ON CONFLICT DO NOTHING`;
      const [c] = await tx<{ misses: number }[]>`
        SELECT misses FROM guarantee_counters WHERE user_id = ${userId} AND pool_id = ${poolId} FOR UPDATE`;
      let misses = c!.misses;
      let used = g.reserveUsed;
      const reserveTier = rules.prizes.find((p) => p.rank === g.reserveRank)?.tier ?? g.minTier;
      for (const t of tickets) {
        awards.push({ kind: 'TICKET', ticketNo: t.ticketNo, prizeId: t.prizeId, rank: t.rank, tier: t.tier, prizeName: t.name });
        if (t.tier >= g.minTier) {
          misses = 0; // 抽中門檻以上 → 計數歸零
        } else {
          misses++;
          if (misses >= g.everyN && used < g.reserveTotal) {
            used++;
            misses = 0;
            awards.push({ kind: 'GUARANTEE', ticketNo: null, prizeId: null, rank: g.reserveRank, tier: reserveTier, prizeName: g.reservePrizeName });
          }
        }
      }
      await tx`UPDATE guarantee_counters SET misses = ${misses}, updated_at = now() WHERE user_id = ${userId} AND pool_id = ${poolId}`;
      if (used !== g.reserveUsed) await tx`UPDATE pool_guarantees SET reserve_used = ${used} WHERE pool_id = ${poolId}`;
      guaranteeState = { misses, everyN: g.everyN, reserveRemaining: g.reserveTotal - used };
    } else {
      for (const t of tickets) awards.push({ kind: 'TICKET', ticketNo: t.ticketNo, prizeId: t.prizeId, rank: t.rank, tier: t.tier, prizeName: t.name });
    }

    // 7b. 完售 → 最後賞、下一套開賣
    const [cnt] = await tx<{ remaining: number }[]>`
      SELECT count(*)::int AS remaining FROM tickets WHERE set_id = ${set.id} AND status = 'AVAILABLE'`;
    const remaining = cnt!.remaining;
    let nextSetNo: number | null = null;
    if (remaining === 0) {
      if (rules.lastPrize) {
        awards.push({ kind: 'LAST', ticketNo: null, prizeId: null, rank: 'LAST', tier: defaultTier('LAST'), prizeName: rules.lastPrize.name });
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
    const items = awards.map((a, i) => ({ ...a, seq: i + 1, id: randomUUID() }));
    await tx`
      INSERT INTO warehouse_items (id, merchant_id, user_id, source, pool_id, set_id, draw_id, ticket_no, prize_id, rank, prize_name)
      SELECT u.id, ${set.merchantId}, ${userId}, u.source, ${poolId}, ${set.id}, ${drawId}, u.ticket_no, u.prize_id, u.rank, u.prize_name
      FROM unnest(${items.map((i) => i.id)}::uuid[], ${items.map((i) => i.kind)}::text[], ${items.map((i) => i.ticketNo)}::int[],
                  ${items.map((i) => i.prizeId)}::uuid[], ${items.map((i) => i.rank)}::text[], ${items.map((i) => i.prizeName)}::text[])
           AS u(id, source, ticket_no, prize_id, rank, prize_name)`;
    await tx`
      INSERT INTO draw_results (draw_id, seq, kind, ticket_no, prize_id, rank, tier, prize_name, warehouse_item_id)
      SELECT ${drawId}, u.seq, u.kind, u.ticket_no, u.prize_id, u.rank, u.tier, u.prize_name, u.item_id
      FROM unnest(${items.map((i) => i.seq)}::int[], ${items.map((i) => i.kind)}::text[], ${items.map((i) => i.ticketNo)}::int[],
                  ${items.map((i) => i.prizeId)}::uuid[], ${items.map((i) => i.rank)}::text[], ${items.map((i) => i.tier)}::int[],
                  ${items.map((i) => i.prizeName)}::text[], ${items.map((i) => i.id)}::uuid[])
           AS u(seq, kind, ticket_no, prize_id, rank, tier, prize_name, item_id)`;

    const response: DrawResponse = {
      drawId,
      poolId,
      setNo: req.setNo,
      ticketNos: nos,
      unitPrice,
      amountCoins: amount,
      coinsAfter: balanceAfter,
      results: items.map((i) => ({ seq: i.seq, kind: i.kind, ticketNo: i.ticketNo, rank: i.rank, tier: i.tier, prizeName: i.prizeName, warehouseItemId: i.id })),
      setSoldOut: remaining === 0,
      nextSetNo,
      guarantee: guaranteeState,
      createdAt: new Date().toISOString(),
    };

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
        coinsAfter: balanceAfter,
        results: items.map((i) => ({ kind: i.kind, ticketNo: i.ticketNo, rank: i.rank })),
      },
    });
    await tx`UPDATE idempotency_keys SET response_json = ${JSON.stringify(response)} WHERE user_id = ${userId} AND scope = ${SCOPE} AND key = ${key}`;
    return { response, replayed: false };
  });
}

export async function getDraw(userId: string, drawId: string) {
  const [d] = await db()<{ id: string }[]>`SELECT id FROM draws WHERE id = ${drawId} AND user_id = ${userId}`;
  if (!d) throw new AppError('NOT_FOUND', 'draw not found');
  const results = await db()`
    SELECT seq, kind, ticket_no, rank, tier, prize_name, warehouse_item_id FROM draw_results WHERE draw_id = ${drawId} ORDER BY seq`;
  return { drawId, results };
}
