import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { transaction, type Db, type Tx } from '../../db';
import { enforceRateLimit } from '../risk/risk';
import { resolvePublicPool } from '../pool/queries';

/** 自選籤號（鎖籤）預設關閉：網站只提供快速抽 */
export function assertTicketPickAllowed(): void {
  if (!config().ALLOW_TICKET_PICK) throw new AppError('TICKET_PICK_DISABLED', '本站僅提供快速抽，請以抽數（count）抽賞');
}

/**
 * 鎖籤（限時保留）。保留資訊直接存在 tickets 列上（held_by / held_until），
 * 以條件式 UPDATE 取得：同一張籤只有一位使用者能成功；逾時保留以 lazy 方式視為釋出（held_until <= now()）。
 * 一次請求的多張籤為全有或全無。
 */
export const TicketNosSchema = z
  .array(z.number().int().positive())
  .min(1)
  .refine((a) => new Set(a).size === a.length, 'ticket numbers must be unique');

export async function requireOnSaleSet(tx: Tx, poolId: string, setNo: number) {
  const [s] = await tx<{ id: string; status: string; poolStatus: string }[]>`
    SELECT s.id, s.status, p.status AS pool_status FROM pool_sets s JOIN pools p ON p.id = s.pool_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${setNo}`;
  if (!s) throw new AppError('NOT_FOUND', 'set not found');
  if (s.poolStatus !== 'PUBLISHED' || s.status !== 'ON_SALE') throw new AppError('SET_NOT_ON_SALE', '本套目前不開放');
  await assertSellable(tx, s.id);
  return s;
}

/** 賞池或套已下架/已刪除 → 不可鎖籤、不可抽 */
export async function assertSellable(d: Db | Tx, setId: string): Promise<void> {
  const [r] = await d<{ offline: boolean; deleted: boolean }[]>`
    SELECT (s.offline OR p.offline) AS offline, (s.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS deleted
    FROM pool_sets s JOIN pools p ON p.id = s.pool_id WHERE s.id = ${setId}`;
  if (!r || r.deleted) throw new AppError('NOT_FOUND', 'set not found');
  if (r.offline) throw new AppError('SET_NOT_ON_SALE', '本套已下架，暫停販售');
}

async function explainFailure(tx: Tx, setId: string, userId: string, nos: number[]): Promise<never> {
  const rows = await tx<{ ticketNo: number; status: string; heldByOther: boolean }[]>`
    SELECT ticket_no, status, (held_by IS NOT NULL AND held_by <> ${userId} AND held_until > now()) AS held_by_other
    FROM tickets WHERE set_id = ${setId} AND ticket_no = ANY(${nos}::int[])`;
  const found = new Set(rows.map((r) => r.ticketNo));
  const missing = nos.filter((n) => !found.has(n));
  if (missing.length) throw new AppError('TICKET_NOT_FOUND', '籤號不存在', { ticketNos: missing });
  const taken = rows.filter((r) => r.status === 'TAKEN').map((r) => r.ticketNo);
  if (taken.length) throw new AppError('TICKET_TAKEN', '籤號已被抽出', { ticketNos: taken });
  const held = rows.filter((r) => r.heldByOther).map((r) => r.ticketNo);
  throw new AppError('TICKET_HELD', '籤號正由其他玩家保留中', { ticketNos: held });
}

export async function holdTickets(
  userId: string,
  poolIdOrSlug: string,
  setNo: number,
  ticketNos: number[],
  holdSeconds = config().HOLD_SECONDS,
): Promise<{ ticketNos: number[]; heldUntil: Date }> {
  assertTicketPickAllowed();
  const nos = TicketNosSchema.parse(ticketNos);
  if (nos.length > config().MAX_TICKETS_PER_HOLD) throw new AppError('VALIDATION', `max ${config().MAX_TICKETS_PER_HOLD} tickets per hold`);
  await enforceRateLimit(userId, 'HOLD');
  return transaction(async (tx) => {
    const { id: poolId } = await resolvePublicPool(tx, poolIdOrSlug);
    const set = await requireOnSaleSet(tx, poolId, setNo);
    const [pt] = await tx<{ playType: string }[]>`SELECT play_type FROM pools WHERE id = ${poolId}`;
    if (pt!.playType === 'PROB') throw new AppError('VALIDATION', '機率賞不能鎖籤（只能快速抽）');
    const rows = await tx<{ ticketNo: number; heldUntil: Date }[]>`
      UPDATE tickets SET held_by = ${userId}, held_until = now() + make_interval(secs => ${holdSeconds})
      WHERE set_id = ${set.id} AND ticket_no = ANY(${nos}::int[]) AND status = 'AVAILABLE'
        AND (held_by IS NULL OR held_by = ${userId} OR held_until <= now())
      RETURNING ticket_no, held_until`;
    if (rows.length !== nos.length) await explainFailure(tx, set.id, userId, nos); // throws → rollback（全有或全無）
    return { ticketNos: rows.map((r) => r.ticketNo).sort((a, b) => a - b), heldUntil: rows[0]!.heldUntil };
  });
}

/** 釋出自己的保留；未指定籤號則釋出本套全部。 */
export async function releaseHolds(userId: string, poolIdOrSlug: string, setNo: number, ticketNos?: number[]): Promise<{ released: number[] }> {
  return transaction(async (tx) => {
    const { id: poolId } = await resolvePublicPool(tx, poolIdOrSlug);
    const [s] = await tx<{ id: string }[]>`SELECT id FROM pool_sets WHERE pool_id = ${poolId} AND set_no = ${setNo}`;
    if (!s) throw new AppError('NOT_FOUND', 'set not found');
    const rows = await tx<{ ticketNo: number }[]>`
      UPDATE tickets SET held_by = NULL, held_until = NULL
      WHERE set_id = ${s.id} AND held_by = ${userId} AND status = 'AVAILABLE'
        ${ticketNos?.length ? tx`AND ticket_no = ANY(${ticketNos}::int[])` : tx``}
      RETURNING ticket_no`;
    return { released: rows.map((r) => r.ticketNo).sort((a, b) => a - b) };
  });
}

export { explainFailure };
