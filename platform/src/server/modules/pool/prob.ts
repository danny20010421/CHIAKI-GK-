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

/** Fenwick（樹狀陣列）：位置 0..n-1 的 0/1 可用旗標，支援 O(log n) 移除與「第 k 個可用位置」查詢 */
class Fenwick {
  private readonly tree: Int32Array;
  private readonly size: number;
  private readonly topBit: number;
  total = 0;
  constructor(available: Uint8Array) {
    const n = available.length;
    this.size = n;
    this.tree = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      if (!available[i]) continue;
      this.total++;
      this.tree[i + 1]! += 1;
    }
    for (let i = 1; i <= n; i++) {
      const j = i + (i & -i);
      if (j <= n) this.tree[j]! += this.tree[i]!;
    }
    let b = 1;
    while (b * 2 <= n) b *= 2;
    this.topBit = n ? b : 0;
  }
  remove(pos: number): void {
    for (let i = pos + 1; i <= this.size; i += i & -i) this.tree[i]! -= 1;
    this.total--;
  }
  /** 第 k 個（0 起算）可用位置 */
  kth(k: number): number {
    let pos = 0;
    let rem = k + 1;
    for (let b = this.topBit; b > 0; b >>= 1) {
      const nx = pos + b;
      if (nx <= this.size && this.tree[nx]! < rem) {
        pos = nx;
        rem -= this.tree[nx]!;
      }
    }
    return pos; // 0 起算位置 = (1 起算的 pos + 1) − 1
  }
}

/** 一個候選範圍（某等級 / 無 odds 的等級 / 全部）：依籤號排序的籤，加上可用旗標的 Fenwick */
interface Bucket {
  nos: Int32Array;
  tree: Fenwick;
}
function bucketOf(sortedNos: number[], availableOf: (no: number) => boolean): Bucket {
  const nos = Int32Array.from(sortedNos);
  const avail = new Uint8Array(nos.length);
  for (let i = 0; i < nos.length; i++) avail[i] = availableOf(nos[i]!) ? 1 : 0;
  return { nos, tree: new Fenwick(avail) };
}
function posIn(nos: Int32Array, no: number): number {
  let lo = 0;
  let hi = nos.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = nos[mid]!;
    if (v === no) return mid;
    if (v < no) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * 大型機率賞（數十萬籤）的抽選索引：與 pickTickets 完全相同的演算法與亂數用法（結果逐張一致，可驗證性不變），
 * 但每抽一張只需 O(等級數 + log N)，不必每次掃描/複製剩餘籤表。
 *   - 每個等級、「無 odds 的等級」、「全部」各一個依籤號排序的 Fenwick，第 k 張候選籤 = 第 k 個可用位置。
 *   - 建立索引 O(N)（籤表依籤號排序時）；抽出後以 remove() 同步所有相關候選範圍。
 */
export class ProbIndex {
  private readonly odds: LevelOdds;
  private readonly levelBuckets = new Map<number, Bucket>();
  private readonly rest: Bucket;
  private readonly all: Bucket;
  private readonly levelOfNo = new Map<number, number>();
  private readonly available = new Set<number>();

  /** tickets：整套籤表（含已抽出者，available=false）；odds：本賞池各等級固定機率（null＝平均分配） */
  constructor(tickets: { ticketNo: number; levelNo: number; available: boolean }[], odds: LevelOdds) {
    this.odds = odds;
    const sorted = tickets.every((t, i) => i === 0 || tickets[i - 1]!.ticketNo < t.ticketNo) ? tickets : [...tickets].sort((a, b) => a.ticketNo - b.ticketNo);
    const byLevel = new Map<number, number[]>();
    const restNos: number[] = [];
    const allNos: number[] = [];
    for (const t of sorted) {
      this.levelOfNo.set(t.ticketNo, t.levelNo);
      if (t.available) this.available.add(t.ticketNo);
      (byLevel.get(t.levelNo) ?? byLevel.set(t.levelNo, []).get(t.levelNo)!).push(t.ticketNo);
      if ((odds.get(t.levelNo) ?? null) === null) restNos.push(t.ticketNo);
      allNos.push(t.ticketNo);
    }
    const isAvail = (no: number) => this.available.has(no);
    for (const [l, nos] of byLevel) this.levelBuckets.set(l, bucketOf(nos, isAvail));
    this.rest = bucketOf(restNos, isAvail);
    this.all = bucketOf(allNos, isAvail);
  }

  /** 剩餘可抽張數 */
  get remaining(): number {
    return this.all.tree.total;
  }

  isAvailable(ticketNo: number): boolean {
    return this.available.has(ticketNo);
  }

  /** odds 設定是否與建立索引時相同（不同 → 呼叫端應重建） */
  sameOdds(odds: LevelOdds): boolean {
    if (odds.size !== this.odds.size) return false;
    for (const [k, v] of odds) if ((this.odds.get(k) ?? null) !== (v ?? null) || !this.odds.has(k)) return false;
    return true;
  }

  /** 標記某張籤已抽出（例如其他程序完成的抽賞）；回傳是否原本可抽 */
  take(ticketNo: number): boolean {
    if (!this.available.delete(ticketNo)) return false;
    const levelNo = this.levelOfNo.get(ticketNo)!;
    const lb = this.levelBuckets.get(levelNo)!;
    lb.tree.remove(posIn(lb.nos, ticketNo));
    if ((this.odds.get(levelNo) ?? null) === null) this.rest.tree.remove(posIn(this.rest.nos, ticketNo));
    this.all.tree.remove(posIn(this.all.nos, ticketNo));
    return true;
  }

  /** 依規則抽一張（與 pickTickets 的單張步驟相同）並移出剩餘 */
  pickOne(rng: Rng): ProbTicket {
    if (this.remaining <= 0) throw new Error('no tickets left');
    const counts = [...this.odds.keys()].map((levelNo) => ({ levelNo, odds: this.odds.get(levelNo) ?? null, remaining: this.levelBuckets.get(levelNo)?.tree.total ?? 0 }));
    const choice = choosePool(counts, rng.float());
    const b = choice.kind === 'LEVEL' ? this.levelBuckets.get(choice.levelNo)! : choice.kind === 'REST' ? this.rest : this.all;
    const k = rng.int(b.tree.total);
    const ticketNo = b.nos[b.tree.kth(k)]!;
    this.take(ticketNo);
    return { ticketNo, levelNo: this.levelOfNo.get(ticketNo)! };
  }

  pick(rng: Rng, n: number): ProbTicket[] {
    const out: ProbTicket[] = [];
    for (let i = 0; i < n; i++) out.push(this.pickOne(rng));
    return out;
  }
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
  // 與 pickTickets 逐張一致的索引實作（大型套也能在線性時間內重算）
  const idx = new ProbIndex(input.layout.map((t) => ({ ...t, available: true })), odds);
  const mismatches: number[] = [];
  for (const d of [...input.draws].sort((a, b) => a.nonce - b.nonce)) {
    const got = idx.pick(new ProbRng(input.serverSeed, d.clientSeed, d.nonce), d.ticketNos.length).map((t) => t.ticketNo).sort((a, b) => a - b);
    const want = [...d.ticketNos].sort((a, b) => a - b);
    if (got.join(',') !== want.join(',')) mismatches.push(d.nonce);
  }
  return { ok: seedOk && mismatches.length === 0, seedOk, mismatches };
}
