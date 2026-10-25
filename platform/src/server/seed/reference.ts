import type { Db } from '../db';
import type { PoolDraftInput } from '../modules/pool/admin';
import type { VipTier } from '../modules/vip/vip';
import { canonicalJson } from '../lib/canonical';
import { taipeiDayStart } from '../lib/taipei';

/**
 * 參考資料（冪等）。所有數值皆為「範例／待營運與法遵確認」：回收值、綁定獎勵 UC幣。
 * 回收值為「每套 × 每獎項」設定（見各賞池 levels[].items[].recycleValue，發布後可逐套調整）。
 * 運費一律到付（2026-10 第七批）：物流方式不再有運費；寄送方式由每個獎項預設（shipMethod）。
 */

/** 物流方式（只開放宅配、7-ELEVEN 交貨便、全家 店到店）；運費到付 */
export const SHIPPING_METHODS: { method: string; label: string }[] = [
  { method: 'HOME_DELIVERY', label: '宅配到府' },
  { method: 'CVS_711_C2C', label: '7-ELEVEN 交貨便' },
  { method: 'CVS_FAMI_C2C', label: '全家 店到店' },
];

/** 綁定/任務獎勵（coins = 不可退款 UC幣；資料表欄位 reward_points 沿用舊名） */
export const REWARD_TASKS: { code: string; title: string; coins: number; coupon: string | null }[] = [
  { code: 'BIND_LINE_OA', title: '加入 CHIAKI LINE 官方帳號', coins: 50, coupon: 'LINE-WELCOME' },
  { code: 'JOIN_LINE_COMMUNITY', title: '加入 LINE 社群', coins: 30, coupon: null },
  { code: 'FOLLOW_IG', title: '追蹤 Instagram @chiaki_gk.studies', coins: 30, coupon: null },
  { code: 'BIND_PHONE', title: '綁定手機號碼', coins: 20, coupon: null },
];

export async function seedReferenceData(d: Db, merchantId = 'chiaki'): Promise<void> {
  for (const m of SHIPPING_METHODS) {
    await d`INSERT INTO shipping_methods (method, merchant_id, label) VALUES (${m.method}, ${merchantId}, ${m.label})
            ON CONFLICT (method) DO NOTHING`;
  }
  for (const t of REWARD_TASKS) {
    await d`INSERT INTO reward_tasks (code, merchant_id, title, reward_points, coupon_code) VALUES (${t.code}, ${merchantId}, ${t.title}, ${t.coins}, ${t.coupon})
            ON CONFLICT (code) DO NOTHING`;
  }
  for (const t of VIP_TIER_DEFAULTS) {
    await d`INSERT INTO vip_tiers (level, name, spend_threshold, upgrade_gift_coins, birthday_gift_coins, monthly_coupons_json, extra_storage_days, perks_json)
            VALUES (${t.level}, ${t.name}, ${t.spendThreshold}, ${t.upgradeGiftCoins}, ${t.birthdayGiftCoins}, ${canonicalJson(t.monthlyCoupons)}, ${t.extraStorageDays}, ${canonicalJson(t.perks)})
            ON CONFLICT (level) DO NOTHING`;
  }
}

/**
 * 已停用的種子賞池（舊的佔位/範例賞池）。scripts/seed.ts 會把既有開發資料庫中的這些賞池移除：
 * 無銷售 → 軟刪除；已有銷售 → 下架（既有紀錄不受影響）。
 */
export const RETIRED_SEED_POOL_SLUGS = ['chiaki-gk-01', 'chiaki-black-gold-guarantee'] as const;

/**
 * 「超萌宮崎駿」機率賞（前台 id: gb；自製、PROB）：每套 2000 籤、每抽 40 UC幣。
 * 大獎、2 獎為固定單抽機率（1/30、1/50；抽完後其機率滾入其餘獎項），其餘依剩餘籤數平均分配。
 * 寄送方式：未指定 → 大獎（等級 1，大件）宅配，其餘 7-11。
 */
export const PROB_SAMPLE_POOL: PoolDraftInput = {
  slug: 'chiaki-miyazaki-prob',
  title: '超萌宮崎駿 ～100% 中獎 通通帶回家～',
  ip: '宮崎駿・吉卜力',
  source: 'CUSTOM',
  playType: 'PROB',
  priceCoins: 40,
  setCount: 1,
  levels: [
    { levelNo: 1, name: '大獎', odds: '1/30', items: [{ name: '神隱卡西法', qtyPerSet: 5, recycleValue: 2000, tag: 'PVC' }] },
    { levelNo: 2, name: '2 獎', odds: '1/50', items: [{ name: '宮崎駿地毯', qtyPerSet: 5, recycleValue: 300, tag: '其他' }] },
    { levelNo: 3, name: '3 獎', items: [{ name: '宮崎駿盲盒', qtyPerSet: 30, recycleValue: 100, tag: '景品盲盒' }] },
    { levelNo: 4, name: '4 獎', items: [{ name: '宮崎駿同人貼紙', qtyPerSet: 1960, recycleValue: 10, tag: '其他' }] },
  ],
  lastPrize: null,
  guarantee: null,
  drawPacks: [1, 5, 10],
};

/**
 * 「雲頂終結谷」機率賞（前台 id: nr；自製、PROB、IP 火影忍者）：每套 20,300 籤、每抽 200 UC幣。
 * 4 獎「火影墨影霓亂徽章」固定單抽機率 70%（抽完後滾入其餘獎項），其餘依剩餘籤數平均分配。
 * 等級：大獎=1、2 獎=2、3 獎=3（火影盲盒隨機款，2026-10 第八批新增）、4 獎=4（非小獎）、5 獎=5。
 */
export const NR_POOL: PoolDraftInput = {
  slug: 'nr-valley-of-the-end',
  title: '雲頂終結谷',
  ip: '火影忍者',
  description: '鳴人 vs 佐助 終結谷決戰雙雕像。70% 機率直接獲得 4 獎「火影墨影霓亂徽章」（回收值 250），大獎佐助回收值高達 40,000。',
  source: 'CUSTOM',
  playType: 'PROB',
  priceCoins: 200,
  setCount: 1,
  levels: [
    { levelNo: 1, name: '大獎', items: [{ name: '雲頂終結谷 佐助', qtyPerSet: 1, recycleValue: 40000, tag: 'GK', shipMethod: 'home' }] },
    { levelNo: 2, name: '2 獎', items: [{ name: '雲頂終結谷 鳴人', qtyPerSet: 1, recycleValue: 18000, tag: 'GK', shipMethod: 'home' }] },
    {
      levelNo: 3,
      name: '3 獎',
      isSmall: false,
      items: [{ name: '火影盲盒隨機款', qtyPerSet: 300, recycleValue: 500, tag: '景品盲盒', shipMethod: 'c711' }],
    },
    {
      levelNo: 4,
      name: '4 獎',
      isSmall: false,
      odds: 0.7,
      items: [{ name: '火影墨影霓亂徽章（一枚）', qtyPerSet: 500, recycleValue: 250, tag: '其他', shipMethod: 'c711' }],
    },
    {
      levelNo: 5,
      name: '5 獎',
      items: [
        { name: '火影同人貼紙', qtyPerSet: 9498, recycleValue: 10, tag: '其他', shipMethod: 'c711' },
        { name: '隨機一番賞小獎', qtyPerSet: 10000, recycleValue: 100, tag: '一番賞', shipMethod: 'c711' },
      ],
    },
  ],
  lastPrize: null,
  guarantee: null,
  drawPacks: [1, 5, 10],
};

type OfficialItem = { grade: string; name: string; qty: number; tag: NonNullable<PoolDraftInput['levels'][number]['items'][number]['tag']>; ship: 'home' | 'c711' | 'fami' };

/** 官方一番賞：A–I 九個等級（等級 1–9）＋最後賞；所有獎品不可回收（回收值 0）。 */
function officialLevels(items: OfficialItem[]): PoolDraftInput['levels'] {
  return items.map((it, i) => ({
    levelNo: i + 1,
    name: `${it.grade}賞`,
    items: [{ name: it.name, qtyPerSet: it.qty, recycleValue: 0, recyclable: false, tag: it.tag, shipMethod: it.ship }],
  }));
}

/** 「宿命的雙極」官方一番賞（前台 id: bk；IP 烙印勇士）：每抽 420 UC幣，每套 80 籤；A–E 宅配、F–I 7-11。 */
export const BK_POOL: PoolDraftInput = {
  slug: 'bk-berserk-dual-poles',
  title: '宿命的雙極',
  ip: '烙印勇士',
  source: 'OFFICIAL',
  playType: 'STANDARD',
  priceCoins: 420,
  setCount: 1,
  levels: officialLevels([
    { grade: 'A', name: '複製原畫', qty: 1, tag: '其他', ship: 'home' },
    { grade: 'B', name: '凱茲（雙版本隨機）', qty: 2, tag: 'PVC', ship: 'home' },
    { grade: 'C', name: '斬龍劍', qty: 1, tag: '其他', ship: 'home' },
    { grade: 'D', name: '夢之獸', qty: 1, tag: 'PVC', ship: 'home' },
    { grade: 'E', name: '索特', qty: 1, tag: 'PVC', ship: 'home' },
    { grade: 'F', name: '100cm 大型緹花毛巾', qty: 2, tag: '其他', ship: 'c711' },
    { grade: 'G', name: '頭像磁鐵（全 6 種隨機）', qty: 20, tag: '其他', ship: 'c711' },
    { grade: 'H', name: '緹花毛巾（全 8 種隨機）', qty: 24, tag: '其他', ship: 'c711' },
    { grade: 'I', name: '畫布風格展示板（全 25 種隨機）', qty: 28, tag: '其他', ship: 'c711' },
  ]),
  // 最後賞寄送方式未指定：與 E 賞「索特」同為立體商品 → 宅配
  lastPrize: { name: '索特（人類姿態）', recycleValue: 0, recyclable: false, tag: 'PVC', shipMethod: 'home' },
  guarantee: null,
};

/** 「神樂鉢」官方一番賞（前台 id: kg；IP 神樂鉢）：每抽 420 UC幣，每套 80 籤；A–C 宅配，其餘（含最後賞）7-11。 */
export const KG_POOL: PoolDraftInput = {
  slug: 'kg-kagurabachi',
  title: '神樂鉢',
  ip: '神樂鉢',
  source: 'OFFICIAL',
  playType: 'STANDARD',
  priceCoins: 420,
  setCount: 1,
  levels: officialLevels([
    { grade: 'A', name: '連載三周年紀念書本造型展示板', qty: 3, tag: '其他', ship: 'home' },
    { grade: 'B', name: '六平千鑛', qty: 1, tag: 'PVC', ship: 'home' },
    { grade: 'C', name: '漣伯理', qty: 2, tag: 'PVC', ship: 'home' },
    { grade: 'D', name: '大毛巾（全兩款）', qty: 2, tag: '其他', ship: 'c711' },
    { grade: 'E', name: '網布收納袋', qty: 4, tag: '其他', ship: 'c711' },
    { grade: 'F', name: '透明海報', qty: 20, tag: '其他', ship: 'c711' },
    { grade: 'G', name: '壓克力立牌', qty: 16, tag: '其他', ship: 'c711' },
    { grade: 'H', name: '壓克力吊飾', qty: 14, tag: '其他', ship: 'c711' },
    { grade: 'I', name: '透明資料夾＆貼紙組', qty: 18, tag: '其他', ship: 'c711' },
  ]),
  lastPrize: { name: '六平千鑛', recycleValue: 0, recyclable: false, tag: 'PVC', shipMethod: 'home' },
  guarantee: null,
};

/**
 * VIP 等級預設值（業主 2026-10 第十批；migration 20261105000000 已更新 vip_tiers；VIP1 生日禮 0 見 20261106000000；後台可改）。seedReferenceData 只補缺漏的等級，不覆蓋後台設定。
 * monthlyCoupons.discountPct：5 = 95折、10 = 9折、15 = 85折、20 = 8折。perks 為該等級「新增」的權益（較高等級自動包含）。
 * extraStorageDays 為該等級的「總」加碼寄存天數（不累加）。
 */
export const VIP_TIER_DEFAULTS: VipTier[] = [
  { level: 0, name: '新手籤', spendThreshold: 0, upgradeGiftCoins: 0, birthdayGiftCoins: 0, monthlyCoupons: [], extraStorageDays: 0, perks: [] },
  // 銅籤無生日禮（業主 2026-10-25；migration 20261106000000）
  { level: 1, name: '銅籤', spendThreshold: 3_000, upgradeGiftCoins: 50, birthdayGiftCoins: 0, monthlyCoupons: [{ discountPct: 5, qty: 1 }], extraStorageDays: 0, perks: [] },
  { level: 2, name: '銀籤', spendThreshold: 30_000, upgradeGiftCoins: 100, birthdayGiftCoins: 100, monthlyCoupons: [{ discountPct: 5, qty: 2 }], extraStorageDays: 0, perks: [{ code: 'BIRTHDAY_GIFT', label: '生日禮' }] },
  { level: 3, name: '金籤', spendThreshold: 200_000, upgradeGiftCoins: 500, birthdayGiftCoins: 500, monthlyCoupons: [{ discountPct: 5, qty: 2 }], extraStorageDays: 0, perks: [{ code: 'LIVE_ODDS', label: '賞池頁即時機率顯示' }] },
  { level: 4, name: '白金籤', spendThreshold: 500_000, upgradeGiftCoins: 1_000, birthdayGiftCoins: 2_000, monthlyCoupons: [{ discountPct: 10, qty: 3 }], extraStorageDays: 7, perks: [{ code: 'FREE_STORAGE_PLUS_7', label: '免費保管期限 +7 天' }] },
  {
    level: 5,
    name: '鑽石籤',
    spendThreshold: 1_000_000,
    upgradeGiftCoins: 2_500,
    birthdayGiftCoins: 5_000,
    monthlyCoupons: [{ discountPct: 15, qty: 3 }, { discountPct: 20, qty: 1 }],
    extraStorageDays: 14,
    perks: [{ code: 'DEDICATED_CS', label: '專屬客服' }],
  },
  { level: 6, name: '黑金籤', spendThreshold: 2_000_000, upgradeGiftCoins: 5_000, birthdayGiftCoins: 10_000, monthlyCoupons: [{ discountPct: 20, qty: 3 }], extraStorageDays: 14, perks: [{ code: 'EXCLUSIVE_EVENTS', label: '專屬活動與限定賞池' }] },
];

/**
 * 「世界之王」卡牌機率賞（前台 id: wk；自製、PROB、IP 航海王、全部獎項標籤「卡牌」）：每抽 200 UC幣，每套 200,010 籤，抽包 1 / 10 / 100。
 * 4 獎「隨機 SR 卡」固定單抽機率 50%（抽完後滾入其餘獎項），其餘依剩餘籤數平均分配；抽賞演出為影片（VIDEO）。
 * 寄送方式：大獎、2 獎（PSA10 鑑定卡）宅配，其餘 7-11。
 */
export const WK_POOL: PoolDraftInput = {
  slug: 'wk-world-king',
  title: '世界之王',
  ip: '航海王',
  description: 'PSA10 鑑定漫畫卡大獎：尼卡（回收值 300,000）、洛克斯（160,000），2 獎女帝、紅髮。50% 機率直接獲得 4 獎「隨機 SR 卡」。',
  source: 'CUSTOM',
  playType: 'PROB',
  priceCoins: 200,
  setCount: 1,
  levels: [
    {
      levelNo: 1,
      name: '大獎',
      items: [
        { name: 'PSA10 漫畫尼卡', qtyPerSet: 1, recycleValue: 300_000, tag: '卡牌', shipMethod: 'home' },
        { name: 'PSA10 漫畫洛克斯', qtyPerSet: 1, recycleValue: 160_000, tag: '卡牌', shipMethod: 'home' },
      ],
    },
    {
      levelNo: 2,
      name: '2 獎',
      items: [
        { name: 'PSA10 漫畫女帝', qtyPerSet: 1, recycleValue: 50_000, tag: '卡牌', shipMethod: 'home' },
        { name: 'PSA10 漫畫紅髮', qtyPerSet: 1, recycleValue: 50_000, tag: '卡牌', shipMethod: 'home' },
      ],
    },
    { levelNo: 3, name: '3 獎', items: [{ name: '隨機未開封卡盒', qtyPerSet: 1, recycleValue: 3_000, tag: '卡牌', shipMethod: 'c711' }] },
    { levelNo: 4, name: '4 獎', isSmall: false, odds: 0.5, items: [{ name: '隨機 SR 卡', qtyPerSet: 100_005, recycleValue: 250, tag: '卡牌', shipMethod: 'c711' }] },
    { levelNo: 5, name: '5 獎', items: [{ name: '隨機普卡', qtyPerSet: 100_000, recycleValue: 100, tag: '卡牌', shipMethod: 'c711' }] },
  ],
  lastPrize: null,
  guarantee: null,
  drawPacks: [1, 10, 100],
  animation: 'VIDEO',
  /** 抽卡影片（前台隨機播放一支）；behavior 依最高獎項決定演出（與 prototype 17_cards.js 的 GACHA_VIDS 相同） */
  videos: [
    { url: '/media/video/gacha1.mp4', behavior: { kind: 'beam', beamAt: 7.4 } },
    { url: '/media/video/gacha2.mp4', behavior: { kind: 'kills', stop: { low: 13.9, mid: 15.6 } } },
    { url: '/media/video/gacha3.mp4', behavior: { kind: 'plain' } },
  ],
};

/** 首頁橫幅（種子；上架期間以台灣日期計，結束日當天仍上架）。圖片暫用站內路徑，正式圖請於後台上傳素材後替換。 */
export const HOME_BANNERS: { title: string; linkUrl: string; openInNewTab: boolean; sortOrder: number; startDate: string; endDate: string; desktopImageUrl: string }[] = [
  { title: 'CHIAKI 萬聖百鬼夜', linkUrl: '/lobby', openInNewTab: false, sortOrder: 1, startDate: '2026-10-23', endDate: '2026-12-31', desktopImageUrl: '/media/banners/halloween.jpg' },
  {
    title: '品牌好友強力推薦・追蹤按讚抽 1000 UC幣',
    linkUrl: 'https://www.instagram.com/chiaki_gk.studies/',
    openInNewTab: true,
    sortOrder: 2,
    startDate: '2026-10-23',
    endDate: '2026-12-31',
    desktopImageUrl: '/media/banners/friends-ig.jpg',
  },
];

/** 首頁橫幅種子（冪等：同標題已存在則略過，不覆蓋後台修改） */
export async function seedHomeBanners(d: Db, merchantId = 'chiaki'): Promise<string[]> {
  const out: string[] = [];
  for (const b of HOME_BANNERS) {
    const rows = await d`
      INSERT INTO banners (merchant_id, title, alt_text, link_url, open_in_new_tab, starts_at, ends_at, enabled, sort_order, desktop_image_url)
      SELECT ${merchantId}, ${b.title}, ${b.title}, ${b.linkUrl}, ${b.openInNewTab}, ${taipeiDayStart(b.startDate)}, ${taipeiDayStart(b.endDate, 1)}, true, ${b.sortOrder}, ${b.desktopImageUrl}
      WHERE NOT EXISTS (SELECT 1 FROM banners WHERE title = ${b.title})
      RETURNING id`;
    out.push(`${b.title}: ${rows.length ? 'created' : 'exists'}`);
  }
  return out;
}

/** 開發/展示用種子賞池（scripts/seed.ts 依序建立並經雙人覆核發布） */
export const SEED_POOLS: readonly PoolDraftInput[] = [PROB_SAMPLE_POOL, NR_POOL, WK_POOL, BK_POOL, KG_POOL];
