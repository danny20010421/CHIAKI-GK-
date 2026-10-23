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
  // 業主規則（2026-10 第二批）：到期自動轉換、邀請獎勵、運費部分退還的代幣一律「不可退款・無法轉換」。
  // 舊的 EXPIRY_COINS_REFUNDABLE 開關已移除（設定了也不會生效）。
  // 運費按套預收：一份運費涵蓋同一會員在同一套的「小獎」件數上限（發布時寫入規則快照）
  SHIPPING_SMALL_ITEMS_PER_FEE: z.coerce.number().int().positive().default(20),
  // 逐件運費退還：每回收一件小獎退 運費 ÷ N 代幣（N 為發布時寫入每套的預設值，後台可逐套調整）
  SHIPPING_REFUND_DIV: z.coerce.number().int().positive().default(20),
  // 綠界 ReturnURL 防護：來源 IP 允許清單（逗號分隔，可用 CIDR；空＝不限制）、通知時間新鮮度（小時，0＝不檢查）
  ECPAY_NOTIFY_IP_ALLOWLIST: z.string().default(''),
  ECPAY_NOTIFY_MAX_AGE_HOURS: z.coerce.number().int().min(0).default(0),

  // 邀請獎勵：達成人數、獎勵代幣（不可退款）、防濫用門檻
  REFERRAL_REWARD_THRESHOLD: z.coerce.number().int().positive().default(20),
  REFERRAL_REWARD_COINS: z.coerce.number().int().positive().default(1000),
  REFERRAL_PHONE_PREFIX_LEN: z.coerce.number().int().min(4).max(10).default(8),
  REFERRAL_PHONE_PREFIX_MAX: z.coerce.number().int().positive().default(3),
  REFERRAL_IP_BURST_MAX: z.coerce.number().int().positive().default(3),
  REFERRAL_IP_BURST_WINDOW_MIN: z.coerce.number().int().positive().default(60),

  // 防火牆（應用層）：用戶端 IP 來源 header（部署於 Vercel/Cloudflare 等反向代理之後）
  CLIENT_IP_HEADER: z.string().default('x-forwarded-for'),
  RATE_LIMIT_IP_CAPACITY: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_IP_REFILL_PER_SEC: z.coerce.number().positive().default(2),
  RATE_LIMIT_USER_CAPACITY: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_USER_REFILL_PER_SEC: z.coerce.number().positive().default(1),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(64 * 1024),
  // 圖片素材上傳（base64 JSON）本文上限：最大 1500 KB 的檔案 base64 後約 2.0 MB
  ASSET_UPLOAD_MAX_BODY_BYTES: z.coerce.number().int().positive().default(2_200_000),
  BLOCKLIST_CACHE_MS: z.coerce.number().int().min(0).default(30_000),
  // 機器人偵測：抽賞/鎖籤在 BOT_WINDOW_MS 內超過 BOT_MAX_REQUESTS 次 → 拒絕並記錄風控事件
  BOT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  BOT_WINDOW_MS: z.coerce.number().int().positive().default(3000),
  // 登入暴力破解防護：連續失敗 LOGIN_BACKOFF_AFTER 次起指數退避，達 LOGIN_MAX_FAILURES 次鎖定 LOGIN_LOCK_MINUTES 分鐘
  LOGIN_BACKOFF_AFTER: z.coerce.number().int().positive().default(3),
  LOGIN_BACKOFF_BASE_SEC: z.coerce.number().int().positive().default(2),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(10),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(30),

  // 後台：重新驗證有效時間、MFA 是否必須、IP 允許清單（逗號分隔，可用 CIDR；空＝不限制）
  ADMIN_REAUTH_MAX_AGE_MIN: z.coerce.number().int().positive().default(30),
  ADMIN_MFA_REQUIRED: bool,
  ADMIN_IP_ALLOWLIST: z.string().default(''),
  // TOTP 秘密金鑰加密用（32 bytes，hex 或 base64）；production 必填
  MFA_ENCRYPTION_KEY: z.string().default(''),

  // 客服補償點數：超過此數需第二人核准
  CS_COMPENSATION_APPROVAL_THRESHOLD: z.coerce.number().int().positive().default(500),

  // 通知外送：重試次數與退避、外部管道替身（開發用；正式環境必須關閉）
  NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  NOTIFY_BACKOFF_BASE_SEC: z.coerce.number().int().positive().default(30),
  NOTIFY_STUB_SEND: bool,
  MITAKE_API_URL: z.string().default('https://smsapi.mitake.com.tw/api/mtk/SmSend'),
  MITAKE_USERNAME: z.string().default(''),
  MITAKE_PASSWORD: z.string().default(''),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().default(''),
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:service@chiaki.example'),
  EMAIL_FROM: z.string().default('CHIAKI <no-reply@chiaki.example>'),

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
    if (env.NODE_ENV === 'production' && (env.AUTH_DEV_STUB || env.REWARD_VERIFY_STUB || env.ECPAY_ACCEPT_SIMULATED || env.NOTIFY_STUB_SEND)) {
      throw new Error('Dev stubs / simulated payments must be disabled in production');
    }
    if (env.NODE_ENV === 'production' && !env.MFA_ENCRYPTION_KEY) {
      throw new Error('MFA_ENCRYPTION_KEY is required in production');
    }
    cached = { ...env, topupPackages: DEFAULT_PACKAGES };
  }
  return cached;
}

/** 測試用：改動 process.env 後重新讀取。 */
export function resetConfig(): void {
  cached = null;
}
