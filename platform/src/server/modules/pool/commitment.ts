import { randomBytes, randomInt } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../lib/canonical';

/**
 * 事前承諾（commit–reveal）。
 *
 *   v2（現行，獎項等級 1–8）：
 *     canonical = canonicalJson({ scheme, poolId, setNo, rulesHash, tickets: [[ticketNo, levelNo, prizeId], ...] })   // 依 ticketNo 升冪
 *   v1（舊套，A–H 賞級）：tickets 為 [[ticketNo, rank, prizeId], ...]（自製賞池 rank 為 null）
 *   commitment = SHA-256( canonical + "\n" + saltHex )
 *
 * 發布時只公開 commitment 與 rulesHash；完售後公開 layout 與 salt，任何人可重算比對。
 * 本檔不依賴資料庫，供 scripts/verify-set.ts 與第三方驗證使用。
 */
export const COMMIT_SCHEME = 'chiaki-commit-v2';
export const COMMIT_SCHEME_V1 = 'chiaki-commit-v1';
export const COMMIT_SCHEMES = [COMMIT_SCHEME, COMMIT_SCHEME_V1] as const;
export type CommitScheme = (typeof COMMIT_SCHEMES)[number];

export interface LayoutEntry {
  ticketNo: number;
  /** v2：獎項等級 1–8 */
  levelNo?: number | null;
  /** v1（舊套）：賞級 */
  rank?: string | null;
  prizeId: string;
}

export interface CommitInput {
  scheme?: CommitScheme;
  poolId: string;
  setNo: number;
  rulesHash: string;
  layout: LayoutEntry[];
}

export function canonicalLayout(input: CommitInput): string {
  const scheme = input.scheme ?? COMMIT_SCHEME;
  const sorted = [...input.layout].sort((a, b) => a.ticketNo - b.ticketNo);
  const tickets =
    scheme === COMMIT_SCHEME_V1
      ? sorted.map((t) => [t.ticketNo, t.rank ?? null, t.prizeId])
      : sorted.map((t) => [t.ticketNo, t.levelNo ?? null, t.prizeId]);
  return canonicalJson({ scheme, poolId: input.poolId, setNo: input.setNo, rulesHash: input.rulesHash, tickets });
}

export function computeCommitment(input: CommitInput, saltHex: string): string {
  return sha256Hex(`${canonicalLayout(input)}\n${saltHex}`);
}

export function verifyCommitment(input: CommitInput, saltHex: string, commitment: string): boolean {
  return computeCommitment(input, saltHex) === commitment.toLowerCase();
}

export function generateSalt(): string {
  return randomBytes(32).toString('hex');
}

/** 以 CSPRNG（crypto.randomInt）做 Fisher–Yates 洗牌，產生 1..N 籤號對應的獎項。 */
export function generateLayout(prizes: { id: string; levelNo: number; qtyPerSet: number }[]): LayoutEntry[] {
  const bag: { id: string; levelNo: number }[] = [];
  for (const p of prizes) for (let i = 0; i < p.qtyPerSet; i++) bag.push({ id: p.id, levelNo: p.levelNo });
  for (let i = bag.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  return bag.map((b, i) => ({ ticketNo: i + 1, levelNo: b.levelNo, prizeId: b.id }));
}
