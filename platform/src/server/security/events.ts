import { canonicalJson } from '../lib/canonical';
import { db } from '../db';

/**
 * 安全事件 → risk_events。被攔截的請求可能大量出現（攻擊時），因此同一 (類型, key) 每 60 秒只寫一筆，
 * 避免攻擊流量轉嫁成資料庫寫入壓力。寫入失敗不影響回應（fail-open 只針對記錄，不針對攔截本身）。
 */
export type SecurityEventType =
  | 'RATE_LIMIT_IP'
  | 'RATE_LIMIT_USER'
  | 'BLOCKED_REQUEST'
  | 'BOT_SUSPECTED'
  | 'LOGIN_LOCKOUT'
  | 'CSRF_REJECTED'
  | 'ADMIN_ACCESS_DENIED'
  | 'ECPAY_NOTIFY_REJECTED'
  | 'REFERRAL_ABUSE'
  | 'PAYLOAD_REJECTED';

const recent = new Map<string, number>();
const THROTTLE_MS = 60_000;

export async function recordSecurityEvent(
  type: SecurityEventType,
  e: { ip?: string | null; userId?: string | null; key?: string; severity?: 'LOW' | 'MEDIUM' | 'HIGH'; details?: Record<string, unknown> },
): Promise<boolean> {
  const k = `${type}:${e.key ?? e.userId ?? e.ip ?? ''}`;
  const now = Date.now();
  const last = recent.get(k);
  if (last !== undefined && now - last < THROTTLE_MS) return false;
  recent.set(k, now);
  if (recent.size > 50_000) recent.clear();
  try {
    await db()`INSERT INTO risk_events (user_id, type, severity, details_json, ip)
               VALUES (${e.userId ?? null}, ${type}, ${e.severity ?? 'MEDIUM'}, ${canonicalJson((e.details ?? {}) as never)}, ${e.ip ?? null})`;
    return true;
  } catch (err) {
    console.error('[security] failed to record event', type, (err as Error).message);
    return false;
  }
}

/** 測試用 */
export function resetSecurityEventThrottle(): void {
  recent.clear();
}
