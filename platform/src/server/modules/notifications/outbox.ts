import { z } from 'zod';
import { config } from '../../config';
import { canonicalJson } from '../../lib/canonical';
import { db, transaction, type Db, type Tx } from '../../db';
import { AppError } from '../../errors';
import { CHANNELS, channelAdapter, type Channel } from './channels';
import { createNotification, eventKeyOf, NOTIFICATION_TYPES, type NotificationType } from './notifications';
import { renderTemplate } from './templates';

/**
 * 通知外送（outbox pattern）：
 *  - 業務交易內呼叫 notifyEvent → 依會員偏好與可用收件位址，每個管道寫一列 notification_outbox（idempotency_key = 事件鍵:管道，唯一）。
 *    站內通知（IN_APP）在同一交易立即寫入收件匣並標記 SENT；其他管道 PENDING，交易提交後才會被派送（不會送出 rollback 的事件）。
 *  - dispatchOutbox（排程每分鐘；或 POST /api/admin/jobs/notifications-dispatch）：認領（lease 60 秒，SKIP LOCKED，可多實例並行）→
 *    呼叫管道轉接器 → 成功 SENT；失敗以指數退避重試（NOTIFY_BACKOFF_BASE_SEC × 2^(n−1)，上限 6 小時），超過 NOTIFY_MAX_ATTEMPTS 次 → FAILED。
 *  - 同一事件重送（例如排程重跑）因 idempotency_key 唯一而不會重複通知。
 */

/** 預設偏好：未設定時是否啟用（會員可逐管道/逐事件覆寫；'*' 代表該管道全部事件） */
const DEFAULTS: Record<NotificationType, Channel[]> = {
  DRAW_RESULT: ['WEB_PUSH'], // 結果已在畫面顯示；推播供離開頁面時使用
  STORAGE_EXPIRY_7D: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
  STORAGE_EXPIRY_TODAY: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
  STORAGE_AUTO_CONVERTED: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
  STORAGE_EXPIRED_HOLD: ['IN_APP', 'WEB_PUSH', 'LINE', 'SMS', 'EMAIL'],
  SHIPMENT_SHIPPED: ['IN_APP', 'WEB_PUSH', 'LINE', 'SMS', 'EMAIL'],
  REFUND_STATUS: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
  TICKET_REPLY: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
  REFERRAL_REWARD: ['IN_APP', 'WEB_PUSH', 'LINE'],
  SHIPMENT_UPDATED: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
  FORUM_MODERATED: ['IN_APP'],
  // VIP 禮物與優惠券：站內＋推播＋LINE＋Email（簡訊預設關閉，會員可於通知設定開啟）
  VIP_UPGRADE_GIFT: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
  VIP_BIRTHDAY_GIFT: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
  COUPON_ISSUED: ['IN_APP', 'WEB_PUSH', 'LINE', 'EMAIL'],
};

interface Recipient {
  phone: string | null;
  lineUserId: string | null;
  email: string | null;
  pushSubs: number;
  prefs: { channel: Channel; eventType: string; enabled: boolean }[];
}

async function loadRecipient(d: Db, userId: string): Promise<Recipient | null> {
  const [r] = await d<{ phone: string | null; lineUserId: string | null; email: string | null; pushSubs: number; prefsJson: string }[]>`
    SELECT u.phone, u.line_user_id, u.email,
           (SELECT count(*)::int FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.revoked_at IS NULL) AS push_subs,
           COALESCE((SELECT json_agg(json_build_object('channel', np.channel, 'eventType', np.event_type, 'enabled', np.enabled))::text
                     FROM notification_preferences np WHERE np.user_id = u.id), '[]') AS prefs_json
    FROM users u WHERE u.id = ${userId}`;
  if (!r) return null;
  return { phone: r.phone, lineUserId: r.lineUserId, email: r.email, pushSubs: r.pushSubs, prefs: JSON.parse(r.prefsJson) as Recipient['prefs'] };
}

function enabledFor(r: Recipient, ch: Channel, ev: NotificationType): boolean {
  const exact = r.prefs.find((p) => p.channel === ch && p.eventType === ev);
  if (exact) return exact.enabled;
  const all = r.prefs.find((p) => p.channel === ch && p.eventType === '*');
  if (all) return all.enabled;
  return DEFAULTS[ev].includes(ch);
}

function destinationFor(r: Recipient, ch: Channel): { ok: boolean; value: string | null } {
  switch (ch) {
    case 'IN_APP':
      return { ok: true, value: null };
    case 'SMS':
      return { ok: Boolean(r.phone), value: r.phone };
    case 'LINE':
      return { ok: Boolean(r.lineUserId), value: r.lineUserId };
    case 'WEB_PUSH':
      return { ok: r.pushSubs > 0, value: null };
    case 'EMAIL':
      return { ok: Boolean(r.email), value: r.email };
  }
}

export interface NotifyInput {
  userId: string;
  event: NotificationType;
  /** 模板變數 */
  data: Record<string, unknown>;
  /** 冪等依據（同一事件同一 dedupeOn 只通知一次） */
  dedupeOn: unknown;
  /** 站內通知 payload（給前台使用的結構化資料） */
  payload?: Record<string, unknown>;
  merchantId?: string;
}

/** 在業務交易內登記通知事件。回傳站內通知是否為新建（重複事件 → false）以及排入的外部管道。 */
export async function notifyEvent(tx: Tx, n: NotifyInput): Promise<{ inApp: boolean; queued: Channel[]; eventKey: string }> {
  const eventKey = eventKeyOf(n.event, n.userId, n.dedupeOn);
  const r = await loadRecipient(tx, n.userId);
  if (!r) return { inApp: false, queued: [], eventKey };
  const t = renderTemplate(n.event, n.data);
  const payload = { ...(n.payload ?? {}), url: t.url };
  let inApp = false;
  const queued: Channel[] = [];
  for (const ch of CHANNELS) {
    if (!enabledFor(r, ch, n.event)) continue;
    const dest = destinationFor(r, ch);
    if (!dest.ok) continue;
    const body = ch === 'SMS' ? t.sms : t.body;
    const key = `${eventKey}:${ch}`;
    if (ch === 'IN_APP') {
      inApp = await createNotification(tx, { userId: n.userId, merchantId: n.merchantId, type: n.event, title: t.title, body, payload, dedupeKey: eventKey });
      await tx`
        INSERT INTO notification_outbox (merchant_id, user_id, event_type, channel, idempotency_key, destination, title, body, payload_json, status, attempts, sent_at, provider_ref)
        VALUES (${n.merchantId ?? 'chiaki'}, ${n.userId}, ${n.event}, 'IN_APP', ${key}, NULL, ${t.title}, ${body}, ${canonicalJson(payload as never)}, 'SENT', 1, now(), 'in-app')
        ON CONFLICT (idempotency_key) DO NOTHING`;
      continue;
    }
    const ins = await tx`
      INSERT INTO notification_outbox (merchant_id, user_id, event_type, channel, idempotency_key, destination, title, body, payload_json)
      VALUES (${n.merchantId ?? 'chiaki'}, ${n.userId}, ${n.event}, ${ch}, ${key}, ${dest.value}, ${t.title}, ${body}, ${canonicalJson(payload as never)})
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
    if (ins.length) queued.push(ch);
  }
  return { inApp, queued, eventKey };
}

export interface DispatchResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

export function backoffSeconds(attempts: number): number {
  return Math.min(config().NOTIFY_BACKOFF_BASE_SEC * 2 ** Math.max(0, attempts - 1), 6 * 3600);
}

/** 派送到期的外送通知（可多實例並行；lease 逾時的 SENDING 列會被重新認領）。 */
export async function dispatchOutbox(opts: { now?: Date; limit?: number } = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const c = config();
  const rows = await db()<
    { id: string; userId: string; merchantId: string; eventType: NotificationType; channel: Channel; destination: string | null; title: string; body: string; payloadJson: string; idempotencyKey: string; attempts: number }[]
  >`
    UPDATE notification_outbox SET status = 'SENDING', attempts = attempts + 1, locked_until = ${new Date(now.getTime() + 60_000)}
    WHERE id IN (
      SELECT id FROM notification_outbox
      WHERE (status = 'PENDING' AND next_attempt_at <= ${now}) OR (status = 'SENDING' AND locked_until < ${now})
      ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, user_id, merchant_id, event_type, channel, destination, title, body, payload_json, idempotency_key, attempts`;
  const out: DispatchResult = { claimed: rows.length, sent: 0, retried: 0, failed: 0 };
  for (const r of rows) {
    try {
      const res = await channelAdapter(r.channel).send({
        id: r.id,
        userId: r.userId,
        merchantId: r.merchantId,
        eventType: r.eventType,
        channel: r.channel,
        destination: r.destination,
        title: r.title,
        body: r.body,
        payload: JSON.parse(r.payloadJson) as Record<string, unknown>,
        idempotencyKey: r.idempotencyKey,
      });
      await db()`UPDATE notification_outbox SET status = 'SENT', sent_at = ${now}, provider_ref = ${res.providerRef}, locked_until = NULL, last_error = NULL
                 WHERE id = ${r.id} AND status = 'SENDING'`;
      out.sent++;
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      if (r.attempts >= c.NOTIFY_MAX_ATTEMPTS) {
        await db()`UPDATE notification_outbox SET status = 'FAILED', last_error = ${msg}, locked_until = NULL WHERE id = ${r.id} AND status = 'SENDING'`;
        out.failed++;
      } else {
        await db()`UPDATE notification_outbox SET status = 'PENDING', last_error = ${msg}, locked_until = NULL,
                          next_attempt_at = ${new Date(now.getTime() + backoffSeconds(r.attempts) * 1000)}
                   WHERE id = ${r.id} AND status = 'SENDING'`;
        out.retried++;
      }
    }
  }
  return out;
}

// ───────────── 偏好設定 ─────────────

export const PreferencesSchema = z.object({
  preferences: z
    .array(
      z.object({
        channel: z.enum(CHANNELS),
        eventType: z.union([z.literal('*'), z.enum(NOTIFICATION_TYPES)]),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(100),
});

export async function getPreferences(d: Db, userId: string) {
  const r = await loadRecipient(d, userId);
  if (!r) throw new AppError('NOT_FOUND', 'user not found');
  return {
    channels: CHANNELS.map((ch) => ({ channel: ch, available: destinationFor(r, ch).ok })),
    events: NOTIFICATION_TYPES.map((ev) => ({ eventType: ev, channels: Object.fromEntries(CHANNELS.map((ch) => [ch, enabledFor(r, ch, ev)])) as Record<Channel, boolean> })),
    overrides: r.prefs,
    vapidPublicKey: config().VAPID_PUBLIC_KEY || null,
  };
}

export async function setPreferences(userId: string, input: z.input<typeof PreferencesSchema>) {
  const v = PreferencesSchema.parse(input);
  await transaction(async (tx) => {
    for (const p of v.preferences) {
      await tx`INSERT INTO notification_preferences (user_id, channel, event_type, enabled) VALUES (${userId}, ${p.channel}, ${p.eventType}, ${p.enabled})
               ON CONFLICT (user_id, channel, event_type) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`;
    }
  });
  return getPreferences(db(), userId);
}

// ───────────── Web Push 訂閱 ─────────────

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().startsWith('https://').max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

export async function savePushSubscription(userId: string, input: z.input<typeof PushSubscriptionSchema>, userAgent?: string | null) {
  const v = PushSubscriptionSchema.parse(input);
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (${userId}, ${v.endpoint}, ${v.keys.p256dh}, ${v.keys.auth}, ${userAgent?.slice(0, 300) ?? null})
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, revoked_at = NULL
    RETURNING id`;
  return { subscriptionId: r!.id };
}

export async function revokePushSubscription(userId: string, endpoint: string) {
  const rows = await db()`UPDATE push_subscriptions SET revoked_at = now() WHERE user_id = ${userId} AND endpoint = ${endpoint} AND revoked_at IS NULL RETURNING id`;
  return { revoked: rows.length };
}
