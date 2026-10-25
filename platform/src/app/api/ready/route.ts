import { db } from '@/server/db';
import { json, route } from '@/server/http';
import { migrationStatus } from '@/server/lib/migrations';
import { log } from '@/server/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

/**
 * GET /api/ready — readiness：資料庫可連線且所有 migration 均已套用（且未被修改）→ 200；否則 503。
 * 負載平衡器/平台用來決定是否把流量導入此實例。錯誤細節只寫日誌，回應不含連線字串等內部資訊。
 */
export const GET = route(
  async () => {
    let database: 'ok' | 'unreachable' = 'ok';
    let migrations: { total: number; applied: number; pending: string[]; modified: string[] } | null = null;
    try {
      await withTimeout(db()`SELECT 1`, TIMEOUT_MS);
      migrations = await withTimeout(migrationStatus(db()), TIMEOUT_MS);
    } catch (e) {
      database = 'unreachable';
      log.warn('readiness check failed', { err: e });
    }
    const ready = database === 'ok' && !!migrations && migrations.pending.length === 0 && migrations.modified.length === 0;
    return json({ status: ready ? 'ready' : 'not_ready', database, migrations }, ready ? 200 : 503);
  },
  { probe: true },
);
