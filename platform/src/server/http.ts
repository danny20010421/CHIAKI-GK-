import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { AppError, isAppError } from './errors';
import { config } from './config';
import { db } from './db';
import { authenticate } from './modules/auth/users';
import { isStaff, type Principal } from './modules/auth/rbac';
import { clientIp, ipInList } from './security/ip';
import { rateLimitStore } from './security/rate-limit';
import { blockedReason } from './security/blocklist';
import { securityHeaders } from './security/headers';
import { csrfViolation, parseCookies, SESSION_COOKIE } from './security/cookies';
import { recordSecurityEvent } from './security/events';
import { botCheck } from './security/bot';

/**
 * Route handler 共用工具＋應用層防火牆。只使用 Web 標準 Request/Response，
 * 因此同一份 handler 可在 Next.js App Router 與 scripts/dev-server.ts（無 Next 時）執行。
 *
 * 所有 route handler 都必須以 route()（JSON API）或 route(..., { allowForm: true })（綠界通知）包裝；
 * tests/security.test.ts 會掃描 src/app/api 確認沒有遺漏。route() 依序執行：
 *   1. IP / 裝置封鎖清單              → 403 BLOCKED
 *   2. 每 IP token bucket 限流          → 429 RATE_LIMITED（Retry-After）
 *   3. 請求本文大小上限（MAX_BODY_BYTES）→ 413；有本文時必須是 application/json → 415
 *   4. 身分（Bearer 或 HttpOnly cookie）；cookie 身分的非安全方法須通過 CSRF（double-submit＋Origin）→ 403
 *   5. 每會員 token bucket 限流          → 429
 *   6. /api/admin/**：員工角色、密碼登入的 session、近期重新驗證、（設定時）MFA 與 IP 允許清單
 *   7. 抽賞/鎖籤的機器人行為偵測        → 429 BOT_SUSPECTED
 *   8. 回應一律加上安全標頭；錯誤訊息一律為通用格式（不含堆疊）
 * 被攔截的請求寫入 risk_events（同類型同來源每 60 秒最多一筆）。
 */
export type RouteContext<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };

export interface RouteOptions {
  /** 抽賞 / 鎖籤：啟用機器人行為偵測 */
  bot?: 'DRAW' | 'HOLD';
  /** 允許 application/x-www-form-urlencoded（綠界 server-to-server 通知） */
  allowForm?: boolean;
  /** 後台路由中「登入後即可使用」的端點（MFA 綁定、重新驗證本身）：不要求近期重新驗證與 MFA */
  adminAuthOnly?: boolean;
  /** 覆寫請求本文上限（預設 MAX_BODY_BYTES；例如圖片上傳） */
  maxBodyBytes?: number | (() => number);
}

const BASE_HEADERS = { 'cache-control': 'no-store' } as const;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...securityHeaders('api'), ...headers },
  });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...BASE_HEADERS, ...securityHeaders('api'), ...headers } });
}

const RETRY_CODES = new Set(['RATE_LIMITED', 'ACCOUNT_LOCKED', 'BOT_SUSPECTED']);

export function errorResponse(e: unknown): Response {
  if (isAppError(e)) {
    const retry = RETRY_CODES.has(e.code) && typeof e.details?.retryAfterSec === 'number' ? { 'retry-after': String(e.details.retryAfterSec) } : undefined;
    return json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, e.status, retry);
  }
  if (e instanceof ZodError) {
    return json({ error: { code: 'VALIDATION', message: 'invalid request', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } }, 400);
  }
  if (e instanceof SyntaxError) return json({ error: { code: 'VALIDATION', message: 'body must be JSON' } }, 400);
  const pg = e as { code?: string; message?: string };
  if (pg?.code === '23505') return json({ error: { code: 'CONFLICT', message: 'duplicate' } }, 409);
  // 只在伺服器端記錄細節；回應不含堆疊或內部訊息
  console.error('[api] unhandled error', e);
  return json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
}

function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...securityHeaders('api') })) if (!h.has(k)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** 已由防火牆驗證過的身分（避免 handler 再查一次資料庫） */
const resolved = new WeakMap<Request, Principal | null>();

function credentials(req: Request): { token: string; via: 'BEARER' | 'COOKIE' } | null {
  const h = req.headers.get('authorization');
  const m = h?.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  if (m) return { token: m[1]!, via: 'BEARER' };
  const c = parseCookies(req)[SESSION_COOKIE];
  if (c && /^[A-Za-z0-9_-]{20,}$/.test(c)) return { token: c, via: 'COOKIE' };
  return null;
}

async function readBody(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) throw new AppError('PAYLOAD_TOO_LARGE', 'request body too large', { maxBytes: max });
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('PAYLOAD_TOO_LARGE', 'request body too large', { maxBytes: max });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function firewall(req: Request, opts: RouteOptions): Promise<Request> {
  const c = config();
  const ip = clientIp(req);
  const device = req.headers.get('x-device-fingerprint');
  const path = new URL(req.url).pathname;

  // 1. 封鎖清單
  const blocked = await blockedReason(ip, device);
  if (blocked) {
    await recordSecurityEvent('BLOCKED_REQUEST', { ip, key: `${blocked}:${blocked === 'IP' ? ip : device}`, details: { by: blocked, path, device } });
    throw new AppError('BLOCKED', '存取被拒');
  }

  // 2. 每 IP 限流
  const ipTake = await rateLimitStore().take(`ip:${ip}`, c.RATE_LIMIT_IP_CAPACITY, c.RATE_LIMIT_IP_REFILL_PER_SEC);
  if (!ipTake.allowed) {
    await recordSecurityEvent('RATE_LIMIT_IP', { ip, details: { path } });
    throw new AppError('RATE_LIMITED', '請求過於頻繁，請稍後再試', { retryAfterSec: ipTake.retryAfterSec });
  }

  // 3. 本文大小與格式
  let next = req;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    let buf: Uint8Array;
    try {
      const max = typeof opts.maxBodyBytes === 'function' ? opts.maxBodyBytes() : (opts.maxBodyBytes ?? c.MAX_BODY_BYTES);
      buf = await readBody(req, max);
    } catch (e) {
      await recordSecurityEvent('PAYLOAD_REJECTED', { ip, key: `size:${ip}`, details: { path, reason: 'too large' } });
      throw e;
    }
    if (buf.byteLength > 0) {
      const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const ok = ct === 'application/json' || (opts.allowForm && ct === 'application/x-www-form-urlencoded');
      if (!ok) {
        await recordSecurityEvent('PAYLOAD_REJECTED', { ip, key: `ct:${ip}`, severity: 'LOW', details: { path, contentType: ct || null } });
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', opts.allowForm ? 'unsupported content type' : 'content-type must be application/json');
      }
    }
    next = new Request(req.url, { method: req.method, headers: req.headers, body: buf.byteLength ? Buffer.from(buf) : undefined });
  }

  // 4. 身分 + CSRF
  const cred = credentials(next);
  let principal: Principal | null = null;
  if (cred) {
    principal = await authenticate(db(), cred.token, cred.via);
    if (principal && cred.via === 'COOKIE') {
      const why = csrfViolation(next);
      if (why) {
        await recordSecurityEvent('CSRF_REJECTED', { ip, userId: principal.userId, details: { path, reason: why } });
        throw new AppError('CSRF_REJECTED', '請重新整理頁面後再試');
      }
    }
  }
  resolved.set(next, principal);

  // 5. 每會員限流
  if (principal) {
    const uTake = await rateLimitStore().take(`user:${principal.userId}`, c.RATE_LIMIT_USER_CAPACITY, c.RATE_LIMIT_USER_REFILL_PER_SEC);
    if (!uTake.allowed) {
      await recordSecurityEvent('RATE_LIMIT_USER', { ip, userId: principal.userId, details: { path } });
      throw new AppError('RATE_LIMITED', '操作過於頻繁，請稍後再試', { retryAfterSec: uTake.retryAfterSec });
    }
  }

  // 6. 後台
  if (path.startsWith('/api/admin/')) await requireAdminAccess(principal, ip, path, opts);

  // 7. 機器人行為
  if (opts.bot && principal) {
    const b = botCheck(principal.userId, opts.bot);
    if (b.suspected) {
      await recordSecurityEvent('BOT_SUSPECTED', { ip, userId: principal.userId, key: `${opts.bot}:${principal.userId}`, severity: 'HIGH', details: { action: opts.bot, requestsInWindow: b.count, windowMs: c.BOT_WINDOW_MS } });
      throw new AppError('BOT_SUSPECTED', '操作速度異常，請稍後再試', { retryAfterSec: Math.ceil(c.BOT_WINDOW_MS / 1000) });
    }
  }
  return next;
}

async function requireAdminAccess(p: Principal | null, ip: string, path: string, opts: RouteOptions): Promise<void> {
  const c = config();
  const deny = async (reason: string, err: AppError) => {
    await recordSecurityEvent('ADMIN_ACCESS_DENIED', { ip, userId: p?.userId ?? null, key: `${reason}:${p?.userId ?? ip}`, details: { path, reason } });
    throw err;
  };
  if (c.ADMIN_IP_ALLOWLIST && !ipInList(ip, c.ADMIN_IP_ALLOWLIST)) await deny('ip_not_allowed', new AppError('FORBIDDEN', '後台僅限允許的網路存取'));
  if (!p) throw new AppError('UNAUTHENTICATED', 'login required');
  if (!isStaff(p)) await deny('not_staff', new AppError('FORBIDDEN', 'admin only'));
  if (p.session?.authMethod !== 'PASSWORD') await deny('not_password_session', new AppError('FORBIDDEN', '後台需以帳號密碼登入'));
  if (opts.adminAuthOnly) return;
  if (c.ADMIN_MFA_REQUIRED && !p.session?.mfaVerifiedAt) throw new AppError('MFA_REQUIRED', '後台需完成兩步驟驗證', { mfa: 'TOTP' });
  const age = p.session?.reauthAt ? Date.now() - p.session.reauthAt.getTime() : Infinity;
  if (age > c.ADMIN_REAUTH_MAX_AGE_MIN * 60_000) throw new AppError('REAUTH_REQUIRED', '請重新輸入密碼以繼續', { maxAgeMinutes: c.ADMIN_REAUTH_MAX_AGE_MIN });
}

/** 包裝 handler：防火牆 + 統一錯誤格式 + 安全標頭。 */
export function route<C>(fn: (req: Request, ctx: C) => Promise<Response>, opts: RouteOptions = {}): (req: Request, ctx?: C) => Promise<Response> {
  return async (req, ctx) => {
    let res: Response;
    try {
      const r = await firewall(req, opts);
      res = await fn(r, ctx as C);
    } catch (e) {
      res = errorResponse(e);
    }
    return withSecurityHeaders(res);
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

/** 本文可省略的端點：空本文 → {} */
export async function optionalBody<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const t = await req.text();
  if (!t) return schema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    throw new AppError('VALIDATION', 'body must be JSON');
  }
  return schema.parse(raw);
}

export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

export async function optionalPrincipal(req: Request): Promise<Principal | null> {
  if (resolved.has(req)) return resolved.get(req) ?? null;
  const cred = credentials(req);
  return cred ? authenticate(db(), cred.token, cred.via) : null;
}

export async function requirePrincipal(req: Request): Promise<Principal> {
  const p = await optionalPrincipal(req);
  if (!p) throw new AppError('UNAUTHENTICATED', 'login required');
  return p;
}

export function requestIp(req: Request): string {
  return clientIp(req);
}

export function intParam(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION', `${name} must be a positive integer`);
  return n;
}
