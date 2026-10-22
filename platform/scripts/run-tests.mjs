// 測試執行器：啟動一個真正的 PostgreSQL 叢集（暫存目錄、隨機埠），
// 建立已套用 migration 的 template DB，每個測試檔再由 template 複製出獨立資料庫。
// 若設定 TEST_DATABASE_ADMIN_URL（例如 CI 內建 Postgres 服務），則直接使用該伺服器。
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startCluster, stopCluster } from './pg-cluster.mjs';

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
let dir = null;
if (!adminUrl) {
  dir = mkdtempSync(join(tmpdir(), 'chiaki-test-pg-'));
  const port = await freePort();
  adminUrl = startCluster({ dir, port }).url;
  console.log(`[test] PostgreSQL started at ${adminUrl}`);
}
const templateDb = `chiaki_tpl_${process.pid}`;
const templateUrl = adminUrl.replace(/\/[^/]*$/, `/${templateDb}`);
let code = 1;
try {
  const c = spawnSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-qc', `CREATE DATABASE ${templateDb}`], { stdio: 'inherit' });
  if (c.status !== 0) throw new Error('cannot create template database');
  const m = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: templateUrl },
  });
  if (m.status !== 0) throw new Error('migration failed');
  const files = process.argv.slice(2).length ? process.argv.slice(2) : ['tests/**/*.test.ts'];
  code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', ...files], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_ADMIN_URL: adminUrl, TEST_TEMPLATE_DB: templateDb },
    });
    p.on('exit', (c) => resolve(c ?? 1));
  });
} catch (e) {
  console.error(e);
} finally {
  spawnSync('psql', [adminUrl, '-qc', `DROP DATABASE IF EXISTS ${templateDb} WITH (FORCE)`], { stdio: 'ignore' });
  if (dir) {
    stopCluster({ dir });
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(code);
