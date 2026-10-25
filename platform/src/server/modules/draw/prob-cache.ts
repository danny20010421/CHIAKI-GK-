import type { Tx } from '../../db';
import { ProbIndex, type LevelOdds } from '../pool/prob';

/**
 * 機率賞抽選索引的程序內快取（大型套，例如「世界之王」每套 200,010 籤）。
 *
 * 正確性：
 *  - 只在「已鎖定該套（pool_sets FOR UPDATE）」的抽賞交易內使用；每套的機率抽賞 nonce 嚴格遞增（draws_prob_nonce_uniq）。
 *  - 取出（checkout）時把快取項目移出 Map；交易提交後才以新的 nonce 放回（release）。交易失敗（rollback）→ 丟棄，
 *    下次重建，因此快取永遠只反映「已提交」的狀態。
 *  - 快取 nonce < 資料庫 nonce（其他程序 / 實例完成的抽賞）→ 只補讀這段 nonce 區間的已抽籤號（draws + draw_results，皆有索引）；
 *    區間過大、套的承諾（籤表）或 odds 不同、快取 nonce 較新 → 由資料庫重建（一次讀取整套籤表）。
 *  - 抽賞交易仍以 FOR UPDATE 鎖定抽中的籤並檢查 AVAILABLE；若不一致（理論上不會發生）由呼叫端重建後重抽。
 */
interface Entry {
  setId: string;
  commitment: string;
  nonce: number;
  idx: ProbIndex;
}

const cache = new Map<string, Entry>();
/** 超過這麼多筆「其他程序完成的抽賞」就直接重建 */
const MAX_DELTA_DRAWS = 2000;
/** 最多快取幾套（大型套約 10 MB 記憶體） */
const MAX_ENTRIES = 16;

export const probIndexStats = { builds: 0, hits: 0, deltas: 0 };

export function resetProbIndexCache(): void {
  cache.clear();
  probIndexStats.builds = probIndexStats.hits = probIndexStats.deltas = 0;
}

export interface ProbCheckout {
  setId: string;
  commitment: string;
  idx: ProbIndex;
}

export async function buildProbIndex(tx: Tx, setId: string, odds: LevelOdds): Promise<ProbIndex> {
  probIndexStats.builds++;
  const rows = await tx<{ ticketNo: number; levelNo: number; available: boolean }[]>`
    SELECT t.ticket_no, pl.level_no, (t.status = 'AVAILABLE') AS available
    FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id JOIN pool_levels pl ON pl.id = pr.level_id
    WHERE t.set_id = ${setId} ORDER BY t.ticket_no`;
  return new ProbIndex(rows, odds);
}

/** 取出某套目前（資料庫 nonce = dbNonce 時）的抽選索引；呼叫端須已鎖定該套 */
export async function checkoutProbIndex(tx: Tx, s: { setId: string; commitment: string; nonce: number; odds: LevelOdds }): Promise<ProbCheckout> {
  const e = cache.get(s.setId);
  cache.delete(s.setId);
  if (e && e.commitment === s.commitment && e.nonce <= s.nonce && e.idx.sameOdds(s.odds)) {
    if (e.nonce === s.nonce) {
      probIndexStats.hits++;
      return { setId: s.setId, commitment: s.commitment, idx: e.idx };
    }
    if (s.nonce - e.nonce <= MAX_DELTA_DRAWS) {
      const taken = await tx<{ ticketNo: number }[]>`
        SELECT dr.ticket_no FROM draws d JOIN draw_results dr ON dr.draw_id = d.id
        WHERE d.set_id = ${s.setId} AND d.prob_nonce > ${e.nonce} AND d.prob_nonce <= ${s.nonce} AND dr.kind = 'TICKET'`;
      if (taken.every((t) => e.idx.take(t.ticketNo))) {
        probIndexStats.deltas++;
        return { setId: s.setId, commitment: s.commitment, idx: e.idx };
      }
    }
  }
  return { setId: s.setId, commitment: s.commitment, idx: await buildProbIndex(tx, s.setId, s.odds) };
}

/** 交易提交後放回（nonce = 本筆抽賞後的資料庫 nonce） */
export function releaseProbIndex(c: ProbCheckout, nonce: number): void {
  const cur = cache.get(c.setId);
  if (cur && cur.nonce >= nonce) return;
  if (!cur && cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(c.setId, { setId: c.setId, commitment: c.commitment, nonce, idx: c.idx });
}
