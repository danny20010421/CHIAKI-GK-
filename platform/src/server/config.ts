import { z } from 'zod';

/**
 * 集中設定。所有數值（鎖籤秒數、門檻、儲值方案）皆可由環境變數覆寫；
 * 未定案的商業/法遵數值（年齡門檻、大額儲值門檻等）標示為「待確認」。
 */
const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().default('postgres://postgres@127.0.0.1:55432/chiaki'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  DEFAULT_MERCHANT_ID: z.string().default('chiaki'),

  HOLD_SECONDS: z.coerce.number().int().positive().default(180),
  MAX_TICKETS_PER_DRAW: z.coerce.number().int().positive().default(100),
  MAX_TICKETS_PER_HOLD: z.coerce.number().int().positive().default(100),

  // 法遵待確認：年齡門檻（業主確認維持 18）
  AGE_MIN: z.coerce.number().int().positive().default(18),

  // 寄存：自入庫起免費保管天數、到期前幾天通知
  STORAGE_FREE_DAYS: z.coerce.number().int().positive().default(30),
  STORAGE_WARN_DAYS_BEFORE: z.coerce.number().int().positive().default(7),
  // 寄存到期自動轉換的「代幣」是否可退款。預設 false（不可退款）：
  // 若可退款，獎品 → 代幣 → 退款即形成「獎品可兌換現金」，恐涉賭博/有獎銷售疑慮（待法務確認）。
  EXPIRY_COINS_REFUNDABLE: bool,
  // 運費按套預收：一份運費涵蓋同一會員在同一套的「小獎」件數上限（發布時寫入規則快照）
  SHIPPING_SMALL_ITEMS_PER_FEE: z.coerce.number().int().positive().default(20),

  // 綠界 ECPay（預設為官方公開 STAGE 測試商店）
  ECPAY_MERCHANT_ID: z.string().default('3002607'),
  ECPAY_HASH_KEY: z.string().default('pwFHCqoQZGmho4w6'),
  ECPAY_HASH_IV: z.string().default('EkRm7iFT261dpevs'),
  ECPAY_AIO_URL: z.string().url().default('https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5'),
  ECPAY_ACCEPT_SIMULATED: bool, // 僅 STAGE 測試時設為 1；正式環境模擬付款不得入帳

  // 風控
  RISK_HOLD_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),
  RISK_DRAW_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  RISK_DEVICE_ACCOUNT_THRESHOLD: z.coerce.number().int().positive().default(3),
  RISK_LARGE_TOPUP_TWD: z.coerce.number().int().positive().default(20000),

  // 開發用登入/驗證替身（正式環境必須關閉）
  AUTH_DEV_STUB: bool,
  REWARD_VERIFY_STUB: bool,
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

export type AppConfig = z.infer<typeof EnvSchema> & { topupPackages: TopupPackage[] };

export interface TopupPackage {
  code: string;
  amountTwd: number;
  coins: number;
  bonusPoints: number; // 平台點數，不可提領
}

/** 儲值方案（金額、贈點比例待營運/法遵確認）。1 TWD = 1 代幣。 */
const DEFAULT_PACKAGES: TopupPackage[] = [
  { code: 'P500', amountTwd: 500, coins: 500, bonusPoints: 0 },
  { code: 'P1000', amountTwd: 1000, coins: 1000, bonusPoints: 0 },
  { code: 'P3000', amountTwd: 3000, coins: 3000, bonusPoints: 0 },
  { code: 'P5000', amountTwd: 5000, coins: 5000, bonusPoints: 0 },
  { code: 'P10000', amountTwd: 10000, coins: 10000, bonusPoints: 0 },
  { code: 'P30000', amountTwd: 30000, coins: 30000, bonusPoints: 0 },
];

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (!cached) {
    const env = EnvSchema.parse(process.env);
    if (env.NODE_ENV === 'production' && (env.AUTH_DEV_STUB || env.REWARD_VERIFY_STUB || env.ECPAY_ACCEPT_SIMULATED)) {
      throw new Error('Dev stubs / simulated payments must be disabled in production');
    }
    cached = { ...env, topupPackages: DEFAULT_PACKAGES };
  }
  return cached;
}

/** 測試用：改動 process.env 後重新讀取。 */
export function resetConfig(): void {
  cached = null;
}
