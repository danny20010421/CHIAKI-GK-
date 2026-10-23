import type { Db } from '../db';
import type { PoolDraftInput } from '../modules/pool/admin';

/**
 * 參考資料（冪等）。所有數值皆為「範例／待營運與法遵確認」：運費、回收值、綁定獎勵點數。
 * 回收值已改為「每套 × 每獎項」設定（見各賞池 levels[].items[].recycleValue，發布後可逐套調整），不再有全域賞級費率表。
 */

/**
 * 物流方式（只開放宅配、7-ELEVEN 交貨便、全家 店到店）。此處 fee_coins 只用於「未預收運費」的物品（直購商品）；
 * 賞池獎品的運費是在抽賞時按套預收（每套設定：宅配 150–300、超商 60–150）。
 */
export const SHIPPING_METHODS: { method: string; label: string; feeCoins: number }[] = [
  { method: 'HOME_DELIVERY', label: '宅配到府', feeCoins: 150 },
  { method: 'CVS_711_C2C', label: '7-ELEVEN 交貨便', feeCoins: 70 },
  { method: 'CVS_FAMI_C2C', label: '全家 店到店', feeCoins: 70 },
];

export const REWARD_TASKS: { code: string; title: string; points: number; coupon: string | null }[] = [
  { code: 'BIND_LINE_OA', title: '加入 CHIAKI LINE 官方帳號', points: 50, coupon: 'LINE-WELCOME' },
  { code: 'JOIN_LINE_COMMUNITY', title: '加入 LINE 社群', points: 30, coupon: null },
  { code: 'FOLLOW_IG', title: '追蹤 Instagram @chiaki_gk.studies', points: 30, coupon: null },
  { code: 'BIND_PHONE', title: '綁定手機號碼', points: 20, coupon: null },
];

export async function seedReferenceData(d: Db, merchantId = 'chiaki'): Promise<void> {
  for (const m of SHIPPING_METHODS) {
    await d`INSERT INTO shipping_methods (method, merchant_id, label, fee_coins) VALUES (${m.method}, ${merchantId}, ${m.label}, ${m.feeCoins})
            ON CONFLICT (method) DO NOTHING`;
  }
  for (const t of REWARD_TASKS) {
    await d`INSERT INTO reward_tasks (code, merchant_id, title, reward_points, coupon_code) VALUES (${t.code}, ${merchantId}, ${t.title}, ${t.points}, ${t.coupon})
            ON CONFLICT (code) DO NOTHING`;
  }
}

/**
 * 規格指定的範例賞池（自製 CUSTOM）：10 套 × 100 籤；數量 1,1,1,6,6,15,20,50；300 代幣/抽。
 * 等級 1–8 各一個獎項（A賞–H賞）；等級 4–8 為小獎（計入滿 20 件運費規則與逐件退還）。
 * 回收值（會員回收＝平台點數；寄存到期＝代幣）與運費皆為範例值，待業主確認。
 */
export const GK_FIRST_POOL: PoolDraftInput = {
  slug: 'chiaki-gk-01',
  title: 'CHIAKI GK 一番賞 第一彈',
  ip: 'CHIAKI ORIGINAL',
  description: '每套 100 抽・共十套（範例資料，獎品名稱待填）。',
  terms: '固定獎品清單、無放回抽取；結果由伺服器原子確定；完售後公開籤表與 salt 供驗證。運費於本套首次付費抽賞時預收。',
  source: 'CUSTOM',
  playType: 'STANDARD',
  priceCoins: 300,
  setCount: 10,
  levels: [
    { levelNo: 1, name: 'A賞', items: [{ name: 'CHIAKI 原創 GK 雕像 典藏版（名稱待填）', qtyPerSet: 1, recycleValue: 0, recyclable: false, tag: 'GK' }] },
    { levelNo: 2, name: 'B賞', items: [{ name: 'CHIAKI 原創 GK 半身像（名稱待填）', qtyPerSet: 1, recycleValue: 1500, tag: 'GK' }] },
    { levelNo: 3, name: 'C賞', items: [{ name: 'CHIAKI 原創 GK 胸像（名稱待填）', qtyPerSet: 1, recycleValue: 900, tag: 'GK' }] },
    { levelNo: 4, name: 'D賞', items: [{ name: '壓克力立牌（名稱待填）', qtyPerSet: 6, recycleValue: 150, tag: '其他' }] },
    { levelNo: 5, name: 'E賞', items: [{ name: '金屬徽章（名稱待填）', qtyPerSet: 6, recycleValue: 100, tag: '其他' }] },
    { levelNo: 6, name: 'F賞', items: [{ name: '透明收藏卡（名稱待填）', qtyPerSet: 15, recycleValue: 60, tag: '卡牌' }] },
    { levelNo: 7, name: 'G賞', items: [{ name: '貼紙組（名稱待填）', qtyPerSet: 20, recycleValue: 40, tag: '其他' }] },
    { levelNo: 8, name: 'H賞', items: [{ name: '明信片（名稱待填）', qtyPerSet: 50, recycleValue: 20, tag: '其他' }] },
  ],
  lastPrize: null,
  guarantee: null,
  drawPacks: [1, 5, 10],
  shippingFeeHome: 150,
  shippingFeeCvs: 70,
  shippingNote: '平台商品依平台公告時程',
};

/** 保底挑戰範例（自製）：每 10 抽未抽中等級 1–3 → 保底 B賞 一個（獨立保底庫存 3 個）。 */
export const GUARANTEE_SAMPLE_POOL: PoolDraftInput = {
  slug: 'chiaki-black-gold-guarantee',
  title: 'CHIAKI ORIGINAL 保底挑戰 ～黑金典藏～（範例）',
  ip: 'CHIAKI ORIGINAL',
  source: 'CUSTOM',
  playType: 'GUARANTEE',
  priceCoins: 280,
  setCount: 1,
  levels: [
    { levelNo: 1, name: 'A賞', items: [{ name: '黑金典藏 雕像（名稱待填）', qtyPerSet: 1, recycleValue: 0, recyclable: false, tag: 'GK' }] },
    { levelNo: 2, name: 'B賞', items: [{ name: '黑金 半身像（名稱待填）', qtyPerSet: 4, recycleValue: 800, tag: 'GK' }] },
    { levelNo: 3, name: 'C賞', items: [{ name: '黑金 收藏盒（名稱待填）', qtyPerSet: 10, recycleValue: 300, tag: '其他' }] },
    { levelNo: 4, name: 'D賞', items: [{ name: '黑金 壓克力立牌（名稱待填）', qtyPerSet: 25, recycleValue: 100, tag: '其他' }] },
    { levelNo: 5, name: 'E賞', items: [{ name: '黑金 收藏卡（名稱待填）', qtyPerSet: 40, recycleValue: 40, tag: '卡牌' }] },
  ],
  lastPrize: { name: '黑金 Last 特別版（名稱待填）', tag: 'GK' },
  guarantee: { everyN: 10, minLevel: 3, reserveLevelNo: 2, reservePrizeName: '黑金 半身像（保底專用庫存）', reserveTotal: 3, reserveRecycleValue: 800, reserveTag: 'GK' },
  drawPacks: [1, 3, 5, 10, 'all'],
  shippingFeeHome: 180,
  shippingFeeCvs: 80,
};

/**
 * 機率賞範例（PROB）：每套 2000 籤、每抽 40 代幣。
 * 大獎、2 獎為固定單抽機率（1/30、1/50；抽完後其機率滾入其餘獎項），其餘依剩餘籤數平均分配。
 */
export const PROB_SAMPLE_POOL: PoolDraftInput = {
  slug: 'chiaki-miyazaki-prob',
  title: '宮崎駿 機率賞（範例）',
  ip: '',
  source: 'CUSTOM',
  playType: 'PROB',
  priceCoins: 40,
  setCount: 1,
  levels: [
    { levelNo: 1, name: '大獎', odds: '1/30', items: [{ name: '神隱卡西法', qtyPerSet: 5, recycleValue: 2000 }] },
    { levelNo: 2, name: '2 獎', odds: '1/50', items: [{ name: '宮崎駿地毯', qtyPerSet: 5, recycleValue: 300 }] },
    { levelNo: 3, name: '3 獎', items: [{ name: '宮崎駿盲盒', qtyPerSet: 30, recycleValue: 100, tag: '景品盲盒' }] },
    { levelNo: 4, name: '4 獎', items: [{ name: '宮崎駿同人貼紙', qtyPerSet: 1960, recycleValue: 10, tag: '其他' }] },
  ],
  lastPrize: null,
  guarantee: null,
  drawPacks: [1, 5, 10],
  shippingFeeHome: 150,
  shippingFeeCvs: 70,
};
