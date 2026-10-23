import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../../lib/canonical';
import type { Db, Tx } from '../../db';

/**
 * 站內通知（IN_APP 收件匣）。dedupe_key 唯一：同一事件重送不會產生重複通知。
 * 其他管道（簡訊 / LINE / Web Push / Email）經由 outbox.ts 的外送佇列派送。
 */
export const NOTIFICATION_TYPES = [
  'DRAW_RESULT',
  'STORAGE_EXPIRY_7D',
  'STORAGE_EXPIRY_TODAY',
  'STORAGE_AUTO_CONVERTED',
  'STORAGE_EXPIRED_HOLD',
  'SHIPMENT_SHIPPED',
  'REFUND_STATUS',
  'TICKET_REPLY',
  'REFERRAL_REWARD',
  'SHIPMENT_UPDATED',
  'FORUM_MODERATED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** 事件鍵（冪等鍵）：同一使用者、同一事件、同一 dedupeOn → 同一鍵 */
export function eventKeyOf(type: NotificationType, userId: string, dedupeOn: unknown): string {
  return `${type}:${sha256Hex(canonicalJson({ userId, on: dedupeOn as never }))}`;
}

export async function createNotification(
  tx: Tx | Db,
  n: { userId: string; type: NotificationType; title: string; body: string; payload: Record<string, unknown>; dedupeOn?: unknown; dedupeKey?: string; merchantId?: string },
): Promise<boolean> {
  const dedupeKey = n.dedupeKey ?? eventKeyOf(n.type, n.userId, n.dedupeOn);
  const rows = await tx`
    INSERT INTO notifications (merchant_id, user_id, type, title, body, payload_json, dedupe_key)
    VALUES (${n.merchantId ?? 'chiaki'}, ${n.userId}, ${n.type}, ${n.title}, ${n.body}, ${canonicalJson(n.payload as never)}, ${dedupeKey})
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

export interface NotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  payload: unknown;
  createdAt: Date;
  readAt: Date | null;
}

export async function listNotifications(db: Db, userId: string, unreadOnly = false): Promise<NotificationRow[]> {
  const rows = await db<(Omit<NotificationRow, 'payload'> & { payloadJson: string })[]>`
    SELECT id, type, title, body, payload_json, created_at, read_at FROM notifications
    WHERE user_id = ${userId} ${unreadOnly ? db`AND read_at IS NULL` : db``}
    ORDER BY created_at DESC, id LIMIT 100`;
  return rows.map(({ payloadJson, ...r }) => ({ ...r, payload: JSON.parse(payloadJson) as unknown }));
}

export const MarkReadSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

export async function markNotificationsRead(db: Db, userId: string, ids: string[]): Promise<{ updated: number }> {
  const rows = await db`UPDATE notifications SET read_at = now() WHERE user_id = ${userId} AND id = ANY(${ids}::uuid[]) AND read_at IS NULL RETURNING id`;
  return { updated: rows.length };
}
