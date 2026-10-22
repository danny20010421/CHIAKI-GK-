import { AppError } from '../../errors';
import { config } from '../../config';
import { canonicalJson } from '../../lib/canonical';
import { db, type Db } from '../../db';

/**
 * 風控規則掛勾（MVP）：只記錄事件、限流；不自動封鎖帳號（人工審查）。
 */
export type RiskType = 'RATE_LIMIT_HOLD' | 'RATE_LIMIT_DRAW' | 'MULTI_ACCOUNT_DEVICE' | 'LARGE_TOPUP' | 'PAYMENT_MISMATCH';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

export async function recordRiskEvent(
  d: Db,
  e: { userId: string | null; type: RiskType; severity: Severity; details?: Record<string, unknown> },
): Promise<void> {
  await d`INSERT INTO risk_events (user_id, type, severity, details_json)
          VALUES (${e.userId}, ${e.type}, ${e.severity}, ${canonicalJson(e.details ?? {})})`;
}

/**
 * 每使用者每分鐘固定視窗計數。以獨立（autocommit）語句執行，
 * 所以即使後續交易 rollback，計數仍會留下（防止以失敗請求灌流量）。
 */
export async function enforceRateLimit(userId: string, action: 'HOLD' | 'DRAW'): Promise<void> {
  const c = config();
  const limit = action === 'HOLD' ? c.RISK_HOLD_LIMIT_PER_MIN : c.RISK_DRAW_LIMIT_PER_MIN;
  const [row] = await db()<{ count: number }[]>`
    INSERT INTO rate_counters (user_id, action, window_start, count)
    VALUES (${userId}, ${action}, date_trunc('minute', now()), 1)
    ON CONFLICT (user_id, action, window_start) DO UPDATE SET count = rate_counters.count + 1
    RETURNING count`;
  if (row!.count > limit) {
    if (row!.count === limit + 1) {
      await recordRiskEvent(db(), {
        userId,
        type: action === 'HOLD' ? 'RATE_LIMIT_HOLD' : 'RATE_LIMIT_DRAW',
        severity: 'MEDIUM',
        details: { limitPerMinute: limit },
      });
    }
    throw new AppError('RATE_LIMITED', '操作過於頻繁，請稍後再試');
  }
}

/** 登入時記錄裝置指紋；同一指紋關聯帳號數達門檻即標記（不阻擋）。 */
export async function recordDevice(d: Db, userId: string, fingerprint: string): Promise<{ flagged: boolean; accounts: number }> {
  const inserted = await d`
    INSERT INTO user_devices (user_id, fingerprint) VALUES (${userId}, ${fingerprint})
    ON CONFLICT (user_id, fingerprint) DO UPDATE SET last_seen_at = now()
    RETURNING (xmax = 0) AS is_new`;
  const isNew = Boolean((inserted[0] as { isNew?: boolean } | undefined)?.isNew);
  const [c] = await d<{ n: number }[]>`SELECT count(DISTINCT user_id)::int AS n FROM user_devices WHERE fingerprint = ${fingerprint}`;
  const accounts = c!.n;
  const flagged = accounts >= config().RISK_DEVICE_ACCOUNT_THRESHOLD;
  if (flagged && isNew) {
    await recordRiskEvent(d, {
      userId,
      type: 'MULTI_ACCOUNT_DEVICE',
      severity: accounts >= config().RISK_DEVICE_ACCOUNT_THRESHOLD * 2 ? 'HIGH' : 'MEDIUM',
      details: { fingerprint, accounts },
    });
  }
  return { flagged, accounts };
}

export async function flagLargeTopup(d: Db, userId: string, amountTwd: number, orderId: string): Promise<boolean> {
  if (amountTwd < config().RISK_LARGE_TOPUP_TWD) return false;
  await recordRiskEvent(d, { userId, type: 'LARGE_TOPUP', severity: 'MEDIUM', details: { amountTwd, orderId } });
  return true;
}

export async function listRiskEvents(d: Db, limit = 100) {
  return d`SELECT id, user_id, type, severity, details_json, created_at FROM risk_events ORDER BY id DESC LIMIT ${limit}`;
}
