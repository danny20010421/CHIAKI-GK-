import { isIP } from 'node:net';
import { config } from '../config';

/**
 * 用戶端 IP：部署在 Vercel / Cloudflare 等反向代理之後時，由代理寫入的 header 取得（CLIENT_IP_HEADER，預設 x-forwarded-for 的第一個值）。
 * ⚠ 若應用程式直接暴露在網路上（沒有代理），x-forwarded-for 可被偽造 —— 正式環境務必經由代理/WAF 進入（見 docs/security.md）。
 */
export function clientIp(req: Request): string {
  const h = config().CLIENT_IP_HEADER.toLowerCase();
  const raw = req.headers.get(h);
  const first = raw?.split(',')[0]?.trim();
  if (first && isIP(stripPort(first))) return stripPort(first);
  return 'unknown';
}

function stripPort(ip: string): string {
  const m = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(ip);
  return m ? m[1]! : ip.replace(/^\[(.*)\](:\d+)?$/, '$1');
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** 逗號分隔的 IP / IPv4 CIDR 清單比對（IPv6 只支援完全相同） */
export function ipInList(ip: string, list: string): boolean {
  const entries = list.split(',').map((s) => s.trim()).filter(Boolean);
  const v4 = ipv4ToInt(ip.replace(/^::ffff:/, ''));
  for (const e of entries) {
    if (e === ip) return true;
    const [base, bitsStr] = e.split('/');
    if (bitsStr === undefined || v4 === null) continue;
    const b = ipv4ToInt(base!);
    const bits = Number(bitsStr);
    if (b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((v4 & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}
