import { randomBytes, randomInt } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../lib/canonical';

/**
 * 事前承諾（commit–reveal）。
 *
 *   canonical = canonicalJson({ scheme, poolId, setNo, rulesHash, tickets: [[ticketNo, rank, prizeId], ...] })   // 依 ticketNo 升冪
 *   commitment = SHA-256( canonical + "\n" + saltHex )
 *
 * 發布時只公開 commitment 與 rulesHash；完售後公開 layout 與 salt，任何人可重算比對。
 * 本檔不依賴資料庫，供 scripts/verify-set.ts 與第三方驗證使用。
 */
export const COMMIT_SCHEME = 'chiaki-commit-v1';

export interface LayoutEntry {
  ticketNo: number;
  rank: string;
  prizeId: string;
}

export interface CommitInput {
  poolId: string;
  setNo: number;
  rulesHash: string;
  layout: LayoutEntry[];
}

export function canonicalLayout(input: CommitInput): string {
  const tickets = [...input.layout].sort((a, b) => a.ticketNo - b.ticketNo).map((t) => [t.ticketNo, t.rank, t.prizeId]);
  return canonicalJson({ scheme: COMMIT_SCHEME, poolId: input.poolId, setNo: input.setNo, rulesHash: input.rulesHash, tickets });
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
export function generateLayout(prizes: { id: string; rank: string; qtyPerSet: number }[]): LayoutEntry[] {
  const bag: { id: string; rank: string }[] = [];
  for (const p of prizes) for (let i = 0; i < p.qtyPerSet; i++) bag.push({ id: p.id, rank: p.rank });
  for (let i = bag.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  return bag.map((b, i) => ({ ticketNo: i + 1, rank: b.rank, prizeId: b.id }));
}
