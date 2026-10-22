import type { Db } from '../db';
import type { PoolDraftInput } from '../modules/pool/admin';

/**
 * 參考資料（冪等）。所有數值皆為「範例／待營運與法遵確認」：
 * 回收點數費率、運費、綁定獎勵點數。
 */
export const RECYCLE_RATES: { rank: string; points: number; recyclable: boolean }[] = [
  { rank: 'LAST', points: 0, recyclable: false },
  { rank: 'A', points: 0, recyclable: false },
  { rank: 'B', points: 0, recyclable: false },
  { rank: 'C', points: 300, recyclable: true },
  { rank: 'D', points: 150, recyclable: true },
  { rank: 'E', points: 100, recyclable: true },
  { rank: 'F', points: 60, recyclable: true },
  { rank: 'G', points: 40, recyclable: true },
  { rank: 'H', points: 20, recyclable: true },
  { rank: 'P', points: 10, recyclable: true },
  { rank: 'SHOP', points: 0, recyclable: false },
];

export const SHIPPING_METHODS: { method: string; label: string; feeCoins: number }[] = [
  { method: 'HOME_DELIVERY', label: '宅配到府', feeCoins: 150 },
  { method: 'CVS_711', label: '7-ELEVEN 取貨', feeCoins: 70 },
  { method: 'CVS_FAMI', label: '全家 取貨', feeCoins: 70 },
  { method: 'CVS_HILIFE', label: '萊爾富 取貨', feeCoins: 60 },
  { method: 'CVS_OK', label: 'OK mart 取貨', feeCoins: 60 },
];

export const REWARD_TASKS: { code: string; title: string; points: number; coupon: string | null }[] = [
  { code: 'BIND_LINE_OA', title: '加入 CHIAKI LINE 官方帳號', points: 50, coupon: 'LINE-WELCOME' },
  { code: 'JOIN_LINE_COMMUNITY', title: '加入 LINE 社群', points: 30, coupon: null },
  { code: 'FOLLOW_IG', title: '追蹤 Instagram @chiaki_gk.studies', points: 30, coupon: null },
  { code: 'BIND_PHONE', title: '綁定手機號碼', points: 20, coupon: null },
];

export async function seedReferenceData(d: Db, merchantId = 'chiaki'): Promise<void> {
  for (const r of RECYCLE_RATES) {
    await d`INSERT INTO recycle_rates (merchant_id, rank, points, recyclable) VALUES (${merchantId}, ${r.rank}, ${r.points}, ${r.recyclable})
            ON CONFLICT (merchant_id, rank) DO NOTHING`;
  }
  for (const m of SHIPPING_METHODS) {
    await d`INSERT INTO shipping_methods (method, merchant_id, label, fee_coins) VALUES (${m.method}, ${merchantId}, ${m.label}, ${m.feeCoins})
            ON CONFLICT (method) DO NOTHING`;
  }
  for (const t of REWARD_TASKS) {
    await d`INSERT INTO reward_tasks (code, merchant_id, title, reward_points, coupon_code) VALUES (${t.code}, ${merchantId}, ${t.title}, ${t.points}, ${t.coupon})
            ON CONFLICT (code) DO NOTHING`;
  }
}

/** 規格指定的範例賞池：10 套 × 100 籤；A1 B1 C1 D6 E6 F15 G20 H50；300 代幣/抽。 */
export const GK_FIRST_POOL: PoolDraftInput = {
  slug: 'chiaki-gk-01',
  title: 'CHIAKI GK 一番賞 第一彈',
  ip: 'CHIAKI ORIGINAL',
  description: '每套 100 抽・共十套・A～H 賞（範例資料，獎品名稱待填）。',
  terms: '固定獎品清單、無放回抽取；結果由伺服器原子確定；完售後公開籤表與 salt 供驗證。',
  source: 'CUSTOM',
  playType: 'STANDARD',
  priceCoins: 300,
  setCount: 10,
  lastPrizeName: null,
  prizes: [
    { rank: 'A', name: 'A賞獎品（名稱待填）', qtyPerSet: 1 },
    { rank: 'B', name: 'B賞獎品（名稱待填）', qtyPerSet: 1 },
    { rank: 'C', name: 'C賞獎品（名稱待填）', qtyPerSet: 1 },
    { rank: 'D', name: 'D賞獎品（名稱待填）', qtyPerSet: 6 },
    { rank: 'E', name: 'E賞獎品（名稱待填）', qtyPerSet: 6 },
    { rank: 'F', name: 'F賞獎品（名稱待填）', qtyPerSet: 15 },
    { rank: 'G', name: 'G賞獎品（名稱待填）', qtyPerSet: 20 },
    { rank: 'H', name: 'H賞獎品（名稱待填）', qtyPerSet: 50 },
  ],
  guarantee: null,
};

/** 保底挑戰範例（參考原型）：每 10 抽未獲 B 賞以上 → 保底 B 賞（獨立保底庫存 3 個）。 */
export const GUARANTEE_SAMPLE_POOL: PoolDraftInput = {
  slug: 'chiaki-black-gold-guarantee',
  title: 'CHIAKI ORIGINAL 保底挑戰 ～黑金典藏～（範例）',
  ip: 'CHIAKI ORIGINAL',
  source: 'CUSTOM',
  playType: 'GUARANTEE',
  priceCoins: 280,
  setCount: 1,
  lastPrizeName: 'Last賞獎品（名稱待填）',
  prizes: [
    { rank: 'A', name: 'A賞獎品（名稱待填）', qtyPerSet: 1 },
    { rank: 'B', name: 'B賞獎品（名稱待填）', qtyPerSet: 4 },
    { rank: 'C', name: 'C賞獎品（名稱待填）', qtyPerSet: 10 },
    { rank: 'D', name: 'D賞獎品（名稱待填）', qtyPerSet: 25 },
    { rank: 'E', name: 'E賞獎品（名稱待填）', qtyPerSet: 40 },
  ],
  guarantee: { everyN: 10, minTier: 2, reserveRank: 'B', reservePrizeName: 'B賞（保底專用庫存）', reserveTotal: 3 },
};
