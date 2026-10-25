import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../../lib/canonical';
import type { Db, Tx } from '../../db';
import { AppError } from '../../errors';

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
  'VIP_UPGRADE_GIFT',
  'VIP_BIRTHDAY_GIFT',
  'COUPON_ISSUED',
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
  /** 前台深連結（相對路徑；模板產生，存於 payload.url） */
  link: string | null;
  unread: boolean;
  payload: unknown;
  createdAt: Date;
  readAt: Date | null;
}

export const NotificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** 上一頁回傳的 nextCursor */
  cursor: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  unreadOnly: z.boolean().default(false),
});

const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
function decodeCursor(c: string): { createdAt: Date; id: string } {
  const [t, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(t ?? '');
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) throw new AppError('VALIDATION', 'invalid cursor');
  return { createdAt, id: id! };
}

/** 站內通知（新到舊、游標分頁）＋未讀數 */
export async function listNotifications(db: Db, userId: string, q: z.input<typeof NotificationListQuerySchema> = {}) {
  const v = NotificationListQuerySchema.parse(q);
  const cur = v.cursor ? decodeCursor(v.cursor) : null;
  const rows = await db<(Omit<NotificationRow, 'payload' | 'link' | 'unread'> & { payloadJson: string })[]>`
    SELECT id, type, title, body, payload_json, created_at, read_at FROM notifications
    WHERE user_id = ${userId} ${v.unreadOnly ? db`AND read_at IS NULL` : db``}
      ${cur ? db`AND (created_at, id) < (${cur.createdAt}, ${cur.id}::uuid)` : db``}
    ORDER BY created_at DESC, id DESC LIMIT ${v.limit + 1}`;
  const page = rows.slice(0, v.limit);
  const [u] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId} AND read_at IS NULL`;
  return {
    notifications: page.map(({ payloadJson, ...r }): NotificationRow => {
      const payload = JSON.parse(payloadJson) as Record<string, unknown>;
      return { ...r, link: typeof payload.url === 'string' ? payload.url : null, unread: r.readAt === null, payload };
    }),
    unreadCount: u!.n,
    nextCursor: rows.length > v.limit ? encodeCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : null,
  };
}

/** 標記已讀：{ ids: uuid[] } 或 { all: true } */
export const MarkReadSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export async function markNotificationsRead(db: Db, userId: string, input: z.input<typeof MarkReadSchema> | string[]): Promise<{ updated: number; unreadCount: number }> {
  const v = Array.isArray(input) ? { ids: input } : MarkReadSchema.parse(input);
  const rows =
    'ids' in v
      ? await db`UPDATE notifications SET read_at = now() WHERE user_id = ${userId} AND id = ANY(${v.ids}::uuid[]) AND read_at IS NULL RETURNING id`
      : await db`UPDATE notifications SET read_at = now() WHERE user_id = ${userId} AND read_at IS NULL RETURNING id`;
  const [u] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId} AND read_at IS NULL`;
  return { updated: rows.length, unreadCount: u!.n };
}
