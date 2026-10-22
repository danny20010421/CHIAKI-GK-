import { canonicalJson, sha256Hex } from '../../lib/canonical';

export type PoolSource = 'OFFICIAL' | 'CUSTOM' | 'MIXED';
export type PlayType = 'STANDARD' | 'GUARANTEE' | 'SOLO';

/** 規則快照：發布後不可變；rulesHash 也被綁進每一套的承諾雜湊。 */
export interface PoolRules {
  schema: 'chiaki-rules-v1';
  poolId: string;
  version: number;
  title: string;
  source: PoolSource;
  playType: PlayType;
  priceCoins: number;
  setCount: number;
  ticketsPerSet: number;
  drawMethod: 'FIXED_LIST_WITHOUT_REPLACEMENT';
  holdSeconds: number;
  prizes: { prizeId: string; rank: string; tier: number; name: string; qtyPerSet: number }[];
  lastPrize: { name: string; rule: 'AWARDED_TO_DRAWER_OF_FINAL_TICKET_OF_EACH_SET' } | null;
  guarantee: {
    everyN: number;
    minTier: number;
    reserveRank: string;
    reservePrizeName: string;
    reserveTotal: number;
    rule: 'EXTRA_PRIZE_FROM_SEPARATE_RESERVE_AFTER_N_CONSECUTIVE_MISSES; STOPS_WHEN_RESERVE_EXHAUSTED; TICKET_ODDS_UNCHANGED';
  } | null;
  terms: string;
}

export function rulesHash(rules: PoolRules): string {
  return sha256Hex(canonicalJson(rules));
}

/** 預設賞級 tier（與原型一致）：A=3、B=2、C=1、其他=0；LAST=4。 */
export function defaultTier(rank: string): number {
  return ({ LAST: 4, A: 3, B: 2, C: 1 } as Record<string, number>)[rank] ?? 0;
}
