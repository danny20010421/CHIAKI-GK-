/**
 * Next.js 啟動掛勾：伺服器啟動時驗證設定（設定錯誤 → 立即失敗，而不是第一個請求才失敗）並輸出部署狀態。
 * 測試模式（SITE_TEST_MODE=true）會以 warn 等級明確標示「金流與簡訊停用」。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { config, deploymentMode } = await import('./server/config');
  const { log } = await import('./server/lib/log');
  config();
  const mode = deploymentMode();
  log.info('chiaki app starting', { nodeEnv: process.env.NODE_ENV, ...mode });
  if (mode.testMode) {
    log.warn('TEST MODE: payments are disabled (403 TEST_SITE) unless PAYMENT_SANDBOX=1; set SITE_TEST_MODE=false only after ECPay and SMS are configured', { payments: mode.payments, sms: mode.sms });
  }
  if (mode.sms === 'DISABLED') log.warn('SMS provider not configured: OTP login and SMS notifications return 503 SMS_DISABLED');
}
