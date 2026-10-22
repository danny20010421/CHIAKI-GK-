import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { AppError, isAppError } from './errors';
import { db } from './db';
import { authenticate } from './modules/auth/users';
import type { Principal } from './modules/auth/rbac';

/**
 * Route handler 共用工具。只使用 Web 標準 Request/Response，
 * 因此同一份 handler 可在 Next.js App Router 與 scripts/dev-server.ts（無 Next 時）執行。
 */
export type RouteContext<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (isAppError(e)) return json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, e.status);
  if (e instanceof ZodError) {
    return json({ error: { code: 'VALIDATION', message: 'invalid request', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } }, 400);
  }
  const pg = e as { code?: string; message?: string };
  if (pg?.code === '23505') return json({ error: { code: 'CONFLICT', message: 'duplicate' } }, 409);
  console.error('[api] unhandled error', e);
  return json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
}

/** 包裝 handler：統一錯誤格式。 */
export function route<C>(fn: (req: Request, ctx: C) => Promise<Response>): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError('VALIDATION', 'body must be JSON');
  }
  return schema.parse(raw);
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h?.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  return m?.[1] ?? null;
}

export async function optionalPrincipal(req: Request): Promise<Principal | null> {
  const t = bearer(req);
  return t ? authenticate(db(), t) : null;
}

export async function requirePrincipal(req: Request): Promise<Principal> {
  const p = await optionalPrincipal(req);
  if (!p) throw new AppError('UNAUTHENTICATED', 'login required');
  return p;
}

export function intParam(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION', `${name} must be a positive integer`);
  return n;
}
