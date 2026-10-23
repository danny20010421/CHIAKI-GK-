import { canonicalJson, sha256Hex } from '../../lib/canonical';

export type PoolSource = 'OFFICIAL' | 'CUSTOM' | 'MIXED';
export type PlayType = 'STANDARD' | 'GUARANTEE' | 'SOLO' | 'PROB';

export interface RulesPrize {
  prizeId: string;
  name: string;
  qtyPerSet: number;
  /** v3 */
  levelNo?: number;
  /** v1/v2（舊快照） */
  rank?: string | null;
  grade?: string;
  tier?: number;
}

/**
 * 規則快照：發布後不可變；rulesHash 也被綁進每一套的承諾雜湊。
 * v3（業主 2026-10 第四批）：獎項等級 1–8（levels：等級號、顯示名稱、是否小獎、獎項），保底門檻為 minLevel。
 * v1/v2 舊版快照仍可被讀取與驗證（抽賞只使用共同欄位）。
 */
export interface PoolRules {
  schema: 'chiaki-rules-v1' | 'chiaki-rules-v2' | 'chiaki-rules-v3';
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
  /** v3 */
  levels?: { levelNo: number; name: string; isSmall: boolean; odds?: number | null; prizes: { prizeId: string; name: string; qtyPerSet: number }[] }[];
  prizes: RulesPrize[];
  lastPrize: { prizeId?: string; name: string; grade?: string; rule: 'AWARDED_TO_DRAWER_OF_FINAL_TICKET_OF_EACH_SET' } | null;
  guarantee: {
    everyN: number;
    minLevel?: number;
    minGrade?: string;
    minTier?: number;
    reservePrizeId?: string;
    reserveRank?: string | null;
    reserveLevelNo?: number;
    reservePrizeName: string;
    reserveGrade?: string;
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
  /** 機率賞（PROB）：可驗證亂數方案 */
  prob?: { scheme: string; rule: string };
  terms: string;
}

export function rulesHash(rules: PoolRules): string {
  return sha256Hex(canonicalJson(rules));
}
