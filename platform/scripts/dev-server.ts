/**
 * 無 Next.js 時的本機 API 伺服器：掃描 src/app/api/**\/route.ts（App Router 檔案慣例），
 * 以 Web 標準 Request/Response 直接呼叫相同的 route handler。安裝 next 後請改用 `npm run dev`。
 */
import { createServer } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface RouteDef { pattern: RegExp; keys: string[]; file: string; mod?: Record<string, unknown> }

const API_DIR = join(process.cwd(), 'src', 'app', 'api');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n === 'route.ts' ? [p] : [];
  });
}
const routes: RouteDef[] = walk(API_DIR).map((file) => {
  const segs = relative(API_DIR, file).split(sep).slice(0, -1);
  const keys: string[] = [];
  const re = segs.map((s) => {
    const m = /^\[(\w+)\]$/.exec(s);
    if (m) {
      keys.push(m[1]!);
      return '([^/]+)';
    }
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { pattern: new RegExp(`^/api/${re.join('/')}/?$`), keys, file };
});
// 靜態路徑優先於動態路徑
routes.sort((a, b) => a.keys.length - b.keys.length);

const port = Number(process.env.PORT ?? 3000);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>CHIAKI</title><p>CHIAKI 前台介面設計待確認中。API：<a href="/api/pools">/api/pools</a></p>');
      return;
    }
    const r = routes.find((x) => x.pattern.test(url.pathname));
    if (!r) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"NOT_FOUND"}}');
      return;
    }
    r.mod ??= (await import(pathToFileURL(r.file).href)) as Record<string, unknown>;
    const fn = r.mod[req.method ?? 'GET'] as Handler | undefined;
    if (!fn) {
      res.writeHead(405).end();
      return;
    }
    const m = r.pattern.exec(url.pathname)!;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
    const response = await fn(new Request(url, { method: req.method, headers, body }), { params: Promise.resolve(params) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end();
  }
}).listen(port, () => console.log(`CHIAKI API dev server on http://localhost:${port} (${routes.length} routes)`));
