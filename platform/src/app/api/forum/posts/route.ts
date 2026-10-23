import { db } from '@/server/db';
import { body, json, optionalPrincipal, query, requirePrincipal, route } from '@/server/http';
import { createPost, CreatePostSchema, listPosts } from '@/server/modules/forum/forum';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/forum/posts?category=&mine=1&before=&limit= — 已公開的貼文＋自己的待審/未通過/已下架貼文 */
export const GET = route(async (req: Request) => {
  const viewer = await optionalPrincipal(req);
  const q = query(req);
  return json(
    await listPosts(db(), viewer?.userId ?? null, {
      category: (q.get('category') ?? undefined) as never,
      mine: q.get('mine') === '1' || q.get('mine') === 'true' ? true : undefined,
      before: (q.get('before') ?? undefined) as never,
      limit: (q.get('limit') ?? undefined) as never,
    }),
  );
});

/** POST /api/forum/posts — 發文 { category, title (4–40), body (10–1000), image?: { dataBase64, copyrightConfirmed: true } }；一律先待審 */
export const POST = route(
  async (req: Request) => {
    const p = await requirePrincipal(req);
    return json(await createPost(p.userId, await body(req, CreatePostSchema)), 201);
  },
  { maxBodyBytes: 1_150_000 },
);
