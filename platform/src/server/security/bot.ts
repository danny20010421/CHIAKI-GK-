import { config } from '../config';

/**
 * 機器人行為偵測（抽賞 / 鎖籤端點）：同一會員在 BOT_WINDOW_MS 內送出超過 BOT_MAX_REQUESTS 次 → 視為過快序列（腳本/外掛），
 * 拒絕（429 BOT_SUSPECTED）並記錄風控事件。這是行為層啟發式，與每分鐘限流（risk.ts）、IP 限流互補。
 * 記憶體實作（單一實例）；多實例部署請改用共用儲存（與 RateLimitStore 相同）。
 */
const windows = new Map<string, number[]>();

export function botCheck(userId: string, action: 'DRAW' | 'HOLD', nowMs = Date.now()): { suspected: boolean; count: number } {
  const c = config();
  const key = `${action}:${userId}`;
  const arr = (windows.get(key) ?? []).filter((t) => nowMs - t < c.BOT_WINDOW_MS);
  arr.push(nowMs);
  windows.set(key, arr);
  if (windows.size > 100_000) windows.clear();
  return { suspected: arr.length > c.BOT_MAX_REQUESTS, count: arr.length };
}

export function resetBotWindows(): void {
  windows.clear();
}
