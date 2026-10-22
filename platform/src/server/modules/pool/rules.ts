import { canonicalJson, sha256Hex } from '../../lib/canonical';
import type { Grade } from './grades';

export type PoolSource = 'OFFICIAL' | 'CUSTOM' | 'MIXED';
export type PlayType = 'STANDARD' | 'GUARANTEE' | 'SOLO';

/**
 * 規則快照：發布後不可變；rulesHash 也被綁進每一套的承諾雜湊。
 * v2（業主 2026-10 規則）：獎項以等級 grade 為準、自製賞池無賞級（rank = null）、
 * 保底門檻為 minGrade、加入運費預收政策。v1 舊版快照仍可被讀取（抽賞只使用共同欄位）。
 */
export interface PoolRules {
  schema: 'chiaki-rules-v1' | 'chiaki-rules-v2';
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
  prizes: { prizeId: string; rank: string | null; grade?: Grade; tier?: number; name: string; qtyPerSet: number }[];
  lastPrize: { prizeId?: string; name: string; grade?: Grade; rule: 'AWARDED_TO_DRAWER_OF_FINAL_TICKET_OF_EACH_SET' } | null;
  guarantee: {
    everyN: number;
    minGrade?: Grade;
    minTier?: number;
    reservePrizeId?: string;
    reserveRank: string | null;
    reservePrizeName: string;
    reserveGrade?: Grade;
    reserveTotal: number;
    rule: string;
  } | null;
  shippingPolicy?: {
    mode: 'PREPAID_PER_SET';
    smallItemsPerFee: number;
    homeFeeRange: [number, number];
    cvsFeeRange: [number, number];
    rule: string;
  };
  terms: string;
}

export function rulesHash(rules: PoolRules): string {
  return sha256Hex(canonicalJson(rules));
}
