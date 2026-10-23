import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import { db, transaction, type Db, type Tx } from '../../db';
import { appendAudit } from '../audit/audit';
import { requirePermission, type Principal } from '../auth/rbac';
import { MemberImageSchema, storeMemberImage } from '../assets/assets';
import { notifyEvent } from '../notifications/outbox';

/**
 * 討論區（業主 2026-10 第六批）：
 *  - 貼文：分類 開箱分享 / 閒聊 / 情報 / 求助；標題 4–40 字、內文 10–1000 字、可附 1 張圖（素材驗證＋去除中繼資料）。
 *  - 留言：2–300 字，只能留在已公開的貼文。
 *  - 一律先「待審」，只有作者本人看得到，審核通過才公開。版主（forum.moderate：客服 / 營運 / 超級管理員）
 *    可核准、退回或下架；退回與下架必須填寫原因，原因會顯示給作者（並站內通知）；全部寫入稽核鏈。
 *  - 按讚（每人每篇一次）、檢舉（每人每個對象一次，供版主處理）。
 *  - 防灌水：每位會員每日（最近 24 小時）發文 / 留言 / 檢舉上限（FORUM_*_PER_DAY）。
 */
export const FORUM_CATEGORIES = ['開箱分享', '閒聊', '情報', '求助'] as const;
export type ForumStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REMOVED';
const STATUS_LABEL: Record<ForumStatus, string> = { PENDING: '審核中', APPROVED: '已公開', REJECTED: '未通過', REMOVED: '已下架' };

const len = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .refine((s) => Array.from(s).length >= min && Array.from(s).length <= max, `${label}須為 ${min}–${max} 字`);

export const CreatePostSchema = z.object({
  category: z.enum(FORUM_CATEGORIES, { errorMap: () => ({ message: `分類須為：${FORUM_CATEGORIES.join('、')}` }) }),
  title: len(4, 40, '標題'),
  body: len(10, 1000, '內文'),
  image: MemberImageSchema.optional(),
});
export const CommentSchema = z.object({ body: len(2, 300, '留言') });
export const ReportSchema = z.object({ targetType: z.enum(['POST', 'COMMENT']), targetId: z.string().uuid(), reason: len(2, 300, '檢舉原因') });
export const ModerateSchema = z
  .object({ action: z.enum(['approve', 'reject', 'remove']), reason: z.string().trim().max(300).optional() })
  .refine((v) => v.action === 'approve' || (v.reason && v.reason.length > 0), { message: '退回或下架必須填寫原因（會顯示給作者）', path: ['reason'] });

async function dailyLimit(tx: Tx, table: 'forum_posts' | 'forum_comments' | 'forum_reports', col: 'user_id' | 'reporter_id', userId: string, max: number, label: string) {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ${tx(table)} WHERE ${tx(col)} = ${userId} AND created_at > now() - interval '24 hours'`;
  if (r!.n >= max) throw new AppError('RATE_LIMITED', `每日${label}上限為 ${max} 則，請明天再試`, { limit: max });
}

async function lockMember(tx: Tx, userId: string) {
  const [u] = await tx<{ status: string }[]>`SELECT status FROM users WHERE id = ${userId} FOR UPDATE`;
  if (!u) throw new AppError('UNAUTHENTICATED', 'user not found');
  if (u.status !== 'ACTIVE') throw new AppError('FORBIDDEN', 'account suspended');
}

// ───────────── 會員：發文、留言、按讚、檢舉 ─────────────

export async function createPost(userId: string, input: z.input<typeof CreatePostSchema>) {
  const v = CreatePostSchema.parse(input);
  return transaction(async (tx) => {
    await lockMember(tx, userId); // 同一會員序列化（每日上限不會被並行繞過）
    await dailyLimit(tx, 'forum_posts', 'user_id', userId, config().FORUM_POSTS_PER_DAY, '發文');
    const image = v.image ? await storeMemberImage(tx, userId, 'forum', v.image, v.title) : null;
    const [p] = await tx<{ id: string; createdAt: Date }[]>`
      INSERT INTO forum_posts (user_id, category, title, body, image_asset_id) VALUES (${userId}, ${v.category}, ${v.title}, ${v.body}, ${image?.id ?? null})
      RETURNING id, created_at`;
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'FORUM_POST_CREATED', entityType: 'forum_post', entityId: p!.id, payload: { category: v.category, image: Boolean(image) } });
    return { postId: p!.id, status: 'PENDING' as const, statusLabel: STATUS_LABEL.PENDING, imageUrl: image?.url ?? null, createdAt: p!.createdAt };
  });
}

export async function createComment(userId: string, postId: string, input: z.input<typeof CommentSchema>) {
  const v = CommentSchema.parse(input);
  return transaction(async (tx) => {
    await lockMember(tx, userId);
    const [post] = await tx<{ status: ForumStatus }[]>`SELECT status FROM forum_posts WHERE id = ${postId}`;
    if (!post || post.status !== 'APPROVED') throw new AppError('NOT_FOUND', 'post not found');
    await dailyLimit(tx, 'forum_comments', 'user_id', userId, config().FORUM_COMMENTS_PER_DAY, '留言');
    const [c] = await tx<{ id: string; createdAt: Date }[]>`
      INSERT INTO forum_comments (post_id, user_id, body) VALUES (${postId}, ${userId}, ${v.body}) RETURNING id, created_at`;
    await appendAudit(tx, { actorType: 'USER', actorId: userId, action: 'FORUM_COMMENT_CREATED', entityType: 'forum_comment', entityId: c!.id, payload: { postId } });
    return { commentId: c!.id, status: 'PENDING' as const, statusLabel: STATUS_LABEL.PENDING, createdAt: c!.createdAt };
  });
}

export async function setLike(userId: string, postId: string, liked: boolean) {
  return transaction(async (tx) => {
    const [post] = await tx<{ status: ForumStatus }[]>`SELECT status FROM forum_posts WHERE id = ${postId} FOR UPDATE`;
    if (!post || post.status !== 'APPROVED') throw new AppError('NOT_FOUND', 'post not found');
    if (liked) {
      const ins = await tx`INSERT INTO forum_likes (post_id, user_id) VALUES (${postId}, ${userId}) ON CONFLICT DO NOTHING RETURNING post_id`;
      if (ins.length) await tx`UPDATE forum_posts SET like_count = like_count + 1 WHERE id = ${postId}`;
    } else {
      const del = await tx`DELETE FROM forum_likes WHERE post_id = ${postId} AND user_id = ${userId} RETURNING post_id`;
      if (del.length) await tx`UPDATE forum_posts SET like_count = like_count - 1 WHERE id = ${postId}`;
    }
    const [r] = await tx<{ likeCount: number }[]>`SELECT like_count FROM forum_posts WHERE id = ${postId}`;
    return { postId, liked, likeCount: r!.likeCount };
  });
}

export async function reportContent(userId: string, input: z.input<typeof ReportSchema>) {
  const v = ReportSchema.parse(input);
  return transaction(async (tx) => {
    await lockMember(tx, userId);
    const visible =
      v.targetType === 'POST'
        ? await tx`SELECT 1 FROM forum_posts WHERE id = ${v.targetId} AND status = 'APPROVED'`
        : await tx`SELECT 1 FROM forum_comments c JOIN forum_posts p ON p.id = c.post_id WHERE c.id = ${v.targetId} AND c.status = 'APPROVED' AND p.status = 'APPROVED'`;
    if (!visible.length) throw new AppError('NOT_FOUND', 'content not found');
    await dailyLimit(tx, 'forum_reports', 'reporter_id', userId, config().FORUM_REPORTS_PER_DAY, '檢舉');
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO forum_reports (target_type, target_id, reporter_id, reason) VALUES (${v.targetType}, ${v.targetId}, ${userId}, ${v.reason})
      ON CONFLICT (target_type, target_id, reporter_id) DO NOTHING RETURNING id`;
    if (!r) throw new AppError('CONFLICT', '您已檢舉過此內容');
    return { reportId: r.id, received: true };
  });
}

// ───────────── 公開查詢（只回傳已公開者＋呼叫者自己的） ─────────────

interface PostRow {
  id: string;
  userId: string;
  category: string;
  title: string;
  body: string;
  imageAssetId: string | null;
  status: ForumStatus;
  moderationReason: string | null;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  nickname: string | null;
  avatarAssetId: string | null;
  createdAt: Date;
}

function showPost(r: PostRow, viewerId: string | null) {
  const mine = viewerId !== null && r.userId === viewerId;
  return {
    id: r.id,
    category: r.category,
    title: r.title,
    body: r.body,
    imageUrl: r.imageAssetId ? `/api/assets/${r.imageAssetId}` : null,
    author: { nickname: r.nickname ?? '會員', avatarUrl: r.avatarAssetId ? `/api/assets/${r.avatarAssetId}` : null },
    likeCount: r.likeCount,
    commentCount: r.commentCount,
    likedByMe: r.likedByMe,
    isMine: mine,
    createdAt: r.createdAt,
    // 審核狀態與原因只給作者本人看
    ...(mine ? { status: r.status, statusLabel: STATUS_LABEL[r.status], moderationReason: r.moderationReason } : {}),
  };
}

const POST_SELECT = (d: Db | Tx, viewerId: string | null) => d`
  SELECT p.id, p.user_id, p.category, p.title, p.body, p.image_asset_id, p.status, p.moderation_reason, p.like_count, p.created_at,
         u.nickname, u.avatar_asset_id,
         (SELECT count(*)::int FROM forum_comments c WHERE c.post_id = p.id AND c.status = 'APPROVED') AS comment_count,
         EXISTS (SELECT 1 FROM forum_likes l WHERE l.post_id = p.id AND l.user_id = ${viewerId}::uuid) AS liked_by_me
  FROM forum_posts p JOIN users u ON u.id = p.user_id`;

export const ListPostsSchema = z.object({
  category: z.enum(FORUM_CATEGORIES).optional(),
  mine: z.boolean().optional(),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function listPosts(d: Db, viewerId: string | null, input: z.input<typeof ListPostsSchema> = {}) {
  const f = ListPostsSchema.parse(input);
  if (f.mine && !viewerId) throw new AppError('UNAUTHENTICATED', 'login required');
  const rows = await d<PostRow[]>`
    ${POST_SELECT(d, viewerId)}
    WHERE (p.status = 'APPROVED' OR p.user_id = ${viewerId}::uuid)
      ${f.mine ? d`AND p.user_id = ${viewerId}::uuid` : d``}
      ${f.category ? d`AND p.category = ${f.category}` : d``}
      ${f.before ? d`AND p.created_at < ${f.before}` : d``}
    ORDER BY p.created_at DESC, p.id LIMIT ${f.limit}`;
  return { categories: FORUM_CATEGORIES, posts: rows.map((r) => showPost(r, viewerId)) };
}

export async function getPost(d: Db, viewerId: string | null, postId: string) {
  const [r] = await d<PostRow[]>`${POST_SELECT(d, viewerId)} WHERE p.id = ${postId} AND (p.status = 'APPROVED' OR p.user_id = ${viewerId}::uuid)`;
  if (!r) throw new AppError('NOT_FOUND', 'post not found');
  const comments = await d<{ id: string; userId: string; body: string; status: ForumStatus; moderationReason: string | null; nickname: string | null; avatarAssetId: string | null; createdAt: Date }[]>`
    SELECT c.id, c.user_id, c.body, c.status, c.moderation_reason, u.nickname, u.avatar_asset_id, c.created_at
    FROM forum_comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ${postId} AND (c.status = 'APPROVED' OR c.user_id = ${viewerId}::uuid)
    ORDER BY c.created_at, c.id`;
  return {
    ...showPost(r, viewerId),
    comments: comments.map((c) => {
      const mine = viewerId !== null && c.userId === viewerId;
      return {
        id: c.id,
        body: c.body,
        author: { nickname: c.nickname ?? '會員', avatarUrl: c.avatarAssetId ? `/api/assets/${c.avatarAssetId}` : null },
        isMine: mine,
        createdAt: c.createdAt,
        ...(mine ? { status: c.status, statusLabel: STATUS_LABEL[c.status], moderationReason: c.moderationReason } : {}),
      };
    }),
  };
}

// ───────────── 版主 ─────────────

export const QueueSchema = z.object({
  type: z.enum(['post', 'comment']).default('post'),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REMOVED']).default('PENDING'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function moderationQueue(actor: Principal, input: z.input<typeof QueueSchema> = {}) {
  requirePermission(actor, 'forum.moderate');
  const f = QueueSchema.parse(input);
  const d = db();
  const items =
    f.type === 'post'
      ? await d`
          SELECT p.id, p.user_id, p.category, p.title, p.body, p.image_asset_id, p.status, p.moderation_reason, p.created_at,
                 (SELECT count(*)::int FROM forum_reports r WHERE r.target_type = 'POST' AND r.target_id = p.id AND r.status = 'OPEN') AS open_reports
          FROM forum_posts p WHERE p.status = ${f.status} ORDER BY p.created_at LIMIT ${f.limit}`
      : await d`
          SELECT c.id, c.post_id, c.user_id, c.body, c.status, c.moderation_reason, c.created_at,
                 (SELECT count(*)::int FROM forum_reports r WHERE r.target_type = 'COMMENT' AND r.target_id = c.id AND r.status = 'OPEN') AS open_reports
          FROM forum_comments c WHERE c.status = ${f.status} ORDER BY c.created_at LIMIT ${f.limit}`;
  return { type: f.type, status: f.status, items };
}

const TRANSITIONS: Record<'approve' | 'reject' | 'remove', { from: ForumStatus[]; to: ForumStatus; label: string }> = {
  approve: { from: ['PENDING', 'REJECTED', 'REMOVED'], to: 'APPROVED', label: '已通過審核並公開' },
  reject: { from: ['PENDING'], to: 'REJECTED', label: '未通過審核' },
  remove: { from: ['APPROVED'], to: 'REMOVED', label: '已被下架' },
};

export async function moderate(actor: Principal, kind: 'post' | 'comment', id: string, input: z.input<typeof ModerateSchema>) {
  requirePermission(actor, 'forum.moderate');
  const v = ModerateSchema.parse(input);
  const t = TRANSITIONS[v.action];
  return transaction(async (tx) => {
    const table = kind === 'post' ? 'forum_posts' : 'forum_comments';
    const [cur] = await tx<{ id: string; userId: string; status: ForumStatus; postId: string | null; title: string | null }[]>`
      SELECT id, user_id, status, ${kind === 'post' ? tx`id` : tx`post_id`} AS post_id, ${kind === 'post' ? tx`title` : tx`NULL`} AS title
      FROM ${tx(table)} WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw new AppError('NOT_FOUND', `${kind} not found`);
    if (!t.from.includes(cur.status)) throw new AppError('INVALID_STATE', `目前狀態為「${STATUS_LABEL[cur.status]}」，不能${v.action === 'approve' ? '核准' : v.action === 'reject' ? '退回' : '下架'}`);
    const reason = v.action === 'approve' ? null : v.reason!;
    await tx`
      UPDATE ${tx(table)} SET status = ${t.to}, moderation_reason = ${reason}, moderated_by = ${actor.userId}, moderated_at = now(), updated_at = now()
      WHERE id = ${id}`;
    // 下架/退回時，針對該內容的未處理檢舉一併結案
    if (t.to !== 'APPROVED') {
      await tx`UPDATE forum_reports SET status = 'RESOLVED', resolved_by = ${actor.userId}, resolved_at = now()
               WHERE target_type = ${kind === 'post' ? 'POST' : 'COMMENT'} AND target_id = ${id} AND status = 'OPEN'`;
    }
    const [post] = cur.postId ? await tx<{ title: string }[]>`SELECT title FROM forum_posts WHERE id = ${cur.postId}` : [];
    await notifyEvent(tx, {
      userId: cur.userId,
      event: 'FORUM_MODERATED',
      data: { postId: cur.postId, title: cur.title ?? post?.title ?? '', targetLabel: kind === 'post' ? '貼文' : '留言', resultLabel: t.label, reason },
      payload: { kind, id, status: t.to },
      dedupeOn: { kind, id, status: t.to, at: Date.now() },
    });
    await appendAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.userId,
      action: `FORUM_${kind.toUpperCase()}_${t.to}`,
      entityType: kind === 'post' ? 'forum_post' : 'forum_comment',
      entityId: id,
      payload: { from: cur.status, to: t.to, reason },
    });
    return { id, kind, status: t.to, statusLabel: STATUS_LABEL[t.to], reason };
  });
}

export async function listReports(actor: Principal, status: 'OPEN' | 'RESOLVED' | 'DISMISSED' = 'OPEN') {
  requirePermission(actor, 'forum.moderate');
  const rows = await db()`
    SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
           count(*) OVER (PARTITION BY r.target_type, r.target_id)::int AS reports_on_target
    FROM forum_reports r WHERE r.status = ${status} ORDER BY r.created_at LIMIT 200`;
  return { status, reports: rows };
}

export async function resolveReport(actor: Principal, reportId: string, input: { status: 'RESOLVED' | 'DISMISSED' }) {
  requirePermission(actor, 'forum.moderate');
  const v = z.object({ status: z.enum(['RESOLVED', 'DISMISSED']) }).parse(input);
  return transaction(async (tx) => {
    const rows = await tx`UPDATE forum_reports SET status = ${v.status}, resolved_by = ${actor.userId}, resolved_at = now() WHERE id = ${reportId} AND status = 'OPEN' RETURNING id`;
    if (!rows.length) throw new AppError('NOT_FOUND', 'open report not found');
    await appendAudit(tx, { actorType: 'ADMIN', actorId: actor.userId, action: `FORUM_REPORT_${v.status}`, entityType: 'forum_report', entityId: reportId, payload: {} });
    return { reportId, status: v.status };
  });
}
