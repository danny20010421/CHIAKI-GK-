import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * 機率賞（playType = 'PROB'）的抽選演算法與可驗證亂數（本檔不依賴資料庫，供伺服器、驗證工具與第三方共用）。
 *
 * 規則（每抽一張）：
 *   1. 依等級號由小到大走訪「有設定 odds 且仍有剩餘」的等級（odds 用完＝剩餘 0 的等級直接跳過，其機率滾入其餘）；
 *      取 u ∈ [0,1)，累加 odds，第一個使 u < 累計 的等級即為抽中等級 → 在該等級剩餘的籤中均勻取一張。
 *   2. 否則在「沒有 odds 的等級」的剩餘籤中均勻取一張；若這些都已抽完，則在全部剩餘籤中均勻取一張。
 *   庫存仍是有限的籤，整套抽完即結束（最後賞照常）。
 *
 * 目前有效機率（公開 API）：S = Σ odds（有剩餘的固定機率等級）、R = 無 odds 等級的剩餘籤數、T = 全部剩餘籤數
 *   - 固定機率等級 L 的獎項：odds_L × 該獎剩餘 / L 剩餘（＋ R = 0 時 (1 − S) × 該獎剩餘 / T）
 *   - 其他獎項：(1 − S) × 該獎剩餘 / R
 *
 * 可驗證亂數（scheme chiaki-prob-v1）：
 *   - 每套發布時以 CSPRNG 產生 32 bytes server seed；只公開 seedHash = SHA-256(seed bytes)（hex）。
 *   - 每筆抽賞記錄 clientSeed（會員可自訂，未給則用冪等鍵）與 nonce（該套第幾筆機率抽賞，從 1 開始）。
 *   - 位元串流：block_j = HMAC-SHA256(key = seed bytes, msg = `chiaki-prob-v1:${clientSeed}:${nonce}:${j}`)，j = 0,1,2…
 *     依序切成 big-endian uint32。
 *       float() = (a >>> 5) × 2^26 + (b >>> 6) 再除以 2^53（取兩個 uint32）
 *       int(n)  = 拒絕取樣：x < floor(2^32 / n) × n 時回傳 x mod n
 *   - 一筆抽 N 張：依序抽 N 次，每次先 float() 決定等級，再 int(候選籤數) 在「依籤號排序」的候選籤中取一張，並移出剩餘。
 *   - 完售後公開 seed、每筆抽賞的 (nonce, clientSeed, 張數, 籤號)，任何人可由初始籤表依 nonce 順序重算（replayProbSet）。
 */
export const PROB_SCHEME = 'chiaki-prob-v1';

export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function seedHash(seedHex: string): string {
  return createHash('sha256').update(Buffer.from(seedHex, 'hex')).digest('hex');
}

export interface Rng {
  float(): number;
  int(n: number): number;
}

/** chiaki-prob-v1 的確定性位元串流 */
export class ProbRng implements Rng {
  private readonly key: Buffer;
  private block = Buffer.alloc(0);
  private offset = 0;
  private j = 0;
  constructor(
    seedHex: string,
    private readonly clientSeed: string,
    private readonly nonce: number,
  ) {
    this.key = Buffer.from(seedHex, 'hex');
  }
  uint32(): number {
    if (this.offset + 4 > this.block.length) {
      this.block = createHmac('sha256', this.key).update(`${PROB_SCHEME}:${this.clientSeed}:${this.nonce}:${this.j++}`).digest();
      this.offset = 0;
    }
    const v = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  float(): number {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new Error('int(n) needs n > 0');
    const limit = Math.floor(4294967296 / n) * n;
    for (;;) {
      const x = this.uint32();
      if (x < limit) return x % n;
    }
  }
}

export type LevelOdds = Map<number, number | null>;

/** 依剩餘數決定這一抽的候選範圍：某個固定機率等級、無 odds 的等級（REST），或全部剩餘（ALL） */
export function choosePool(levels: { levelNo: number; odds: number | null; remaining: number }[], u: number): { kind: 'LEVEL'; levelNo: number } | { kind: 'REST' } | { kind: 'ALL' } {
  let cum = 0;
  for (const l of [...levels].sort((a, b) => a.levelNo - b.levelNo)) {
    if (l.odds === null || l.remaining <= 0) continue;
    cum += l.odds;
    if (u < cum) return { kind: 'LEVEL', levelNo: l.levelNo };
  }
  const rest = levels.some((l) => l.odds === null && l.remaining > 0);
  return rest ? { kind: 'REST' } : { kind: 'ALL' };
}

function inPool(pool: ReturnType<typeof choosePool>, levelNo: number, odds: LevelOdds): boolean {
  if (pool.kind === 'LEVEL') return levelNo === pool.levelNo;
  if (pool.kind === 'REST') return (odds.get(levelNo) ?? null) === null;
  return true;
}

function levelRemaining<T extends { levelNo: number }>(items: (T & { remaining: number })[], odds: LevelOdds) {
  const m = new Map<number, number>();
  for (const it of items) m.set(it.levelNo, (m.get(it.levelNo) ?? 0) + it.remaining);
  return [...odds.keys()].map((levelNo) => ({ levelNo, odds: odds.get(levelNo) ?? null, remaining: m.get(levelNo) ?? 0 }));
}

export interface ProbTicket {
  ticketNo: number;
  levelNo: number;
}

/** 從剩餘的籤中依規則抽出 n 張（會從 remaining 移除），回傳抽中的籤（依抽出順序） */
export function pickTickets<T extends ProbTicket>(remaining: T[], odds: LevelOdds, rng: Rng, n: number): T[] {
  const pool = [...remaining].sort((a, b) => a.ticketNo - b.ticketNo);
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    if (!pool.length) throw new Error('no tickets left');
    const counts = levelRemaining(
      pool.map((t) => ({ levelNo: t.levelNo, remaining: 1 })),
      odds,
    );
    const choice = choosePool(counts, rng.float());
    const idx: number[] = [];
    pool.forEach((t, k) => {
      if (inPool(choice, t.levelNo, odds)) idx.push(k);
    });
    const k = idx[rng.int(idx.length)]!;
    out.push(pool[k]!);
    pool.splice(k, 1);
  }
  const taken = new Set(out.map((t) => t.ticketNo));
  for (let i = remaining.length - 1; i >= 0; i--) if (taken.has(remaining[i]!.ticketNo)) remaining.splice(i, 1);
  return out;
}

/** 以「各獎項剩餘數」抽一次（同一規則；免費試玩與統計測試用，不需展開成逐張籤）。會將抽中獎項的 remaining 減 1。 */
export function pickFromCounts<T extends { levelNo: number; remaining: number }>(items: T[], odds: LevelOdds, rng: Rng): T {
  const choice = choosePool(levelRemaining(items, odds), rng.float());
  const cands = items.filter((it) => it.remaining > 0 && inPool(choice, it.levelNo, odds));
  const total = cands.reduce((s, it) => s + it.remaining, 0);
  let r = rng.int(total);
  for (const it of cands) {
    if (r < it.remaining) {
      it.remaining--;
      return it;
    }
    r -= it.remaining;
  }
  throw new Error('unreachable');
}

/** 目前有效機率（每個獎項；總和 = 1，全部抽完時皆為 0） */
export function effectiveProbabilities<T extends { levelNo: number; remaining: number }>(items: T[], odds: LevelOdds): number[] {
  const levels = levelRemaining(items, odds);
  const total = items.reduce((s, it) => s + it.remaining, 0);
  if (total === 0) return items.map(() => 0);
  const active = levels.filter((l) => l.odds !== null && l.remaining > 0);
  const s = active.reduce((a, l) => a + l.odds!, 0);
  const rest = levels.filter((l) => l.odds === null).reduce((a, l) => a + l.remaining, 0);
  const byLevel = new Map(levels.map((l) => [l.levelNo, l]));
  return items.map((it) => {
    if (it.remaining <= 0) return 0;
    const l = byLevel.get(it.levelNo)!;
    if (l.odds !== null) return l.odds * (it.remaining / l.remaining) + (rest === 0 ? (1 - s) * (it.remaining / total) : 0);
    return (1 - s) * (it.remaining / rest);
  });
}

/** 解析 odds：數字或 "a/b" 分數字串 */
export function parseOdds(v: number | string): number {
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
  return m ? Number(m[1]) / Number(m[2]) : Number(v);
}

export interface ProbReplayInput {
  serverSeed: string;
  seedHash: string;
  /** 初始籤表（籤號 → 等級） */
  layout: ProbTicket[];
  levels: { levelNo: number; odds: number | null }[];
  draws: { nonce: number; clientSeed: string; ticketNos: number[] }[];
}

/** 重算整套的每一筆機率抽賞，確認每筆抽出的籤號與公開紀錄一致 */
export function replayProbSet(input: ProbReplayInput): { ok: boolean; seedOk: boolean; mismatches: number[] } {
  const seedOk = seedHash(input.serverSeed) === input.seedHash;
  const odds: LevelOdds = new Map(input.levels.map((l) => [l.levelNo, l.odds]));
  const remaining = input.layout.map((t) => ({ ...t }));
  const mismatches: number[] = [];
  for (const d of [...input.draws].sort((a, b) => a.nonce - b.nonce)) {
    const got = pickTickets(remaining, odds, new ProbRng(input.serverSeed, d.clientSeed, d.nonce), d.ticketNos.length).map((t) => t.ticketNo).sort((a, b) => a - b);
    const want = [...d.ticketNos].sort((a, b) => a - b);
    if (got.join(',') !== want.join(',')) mismatches.push(d.nonce);
  }
  return { ok: seedOk && mismatches.length === 0, seedOk, mismatches };
}
