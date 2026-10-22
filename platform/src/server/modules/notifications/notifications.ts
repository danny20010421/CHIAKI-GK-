import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../../lib/canonical';
import type { Db, Tx } from '../../db';

/**
 * 站內通知（目前只有 IN_APP 管道；簡訊/LINE/推播尚未串接，之後可由此表派送）。
 * dedupe_key 唯一：同一批次重送不會產生重複通知。
 */
export type NotificationType = 'STORAGE_EXPIRY_7D' | 'STORAGE_EXPIRY_TODAY' | 'STORAGE_AUTO_CONVERTED' | 'STORAGE_EXPIRED_HOLD';

export async function createNotification(
  tx: Tx,
  n: { userId: string; type: NotificationType; title: string; body: string; payload: Record<string, unknown>; dedupeOn: unknown; merchantId?: string },
): Promise<boolean> {
  const dedupeKey = `${n.type}:${sha256Hex(canonicalJson({ userId: n.userId, on: n.dedupeOn as never }))}`;
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
