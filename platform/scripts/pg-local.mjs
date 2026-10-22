// 本機開發資料庫：node scripts/pg-local.mjs start|stop
// 資料存放於 PGLOCAL_DIR（預設 /tmp/chiaki-pg），埠號 PGLOCAL_PORT（預設 55432）。
import { startCluster, stopCluster } from './pg-cluster.mjs';
import { spawnSync } from 'node:child_process';

const dir = process.env.PGLOCAL_DIR ?? '/tmp/chiaki-pg';
const port = Number(process.env.PGLOCAL_PORT ?? 55432);
const cmd = process.argv[2] ?? 'start';
if (cmd === 'stop') {
  stopCluster({ dir });
  console.log('stopped');
} else {
  const { url } = startCluster({ dir, port });
  spawnSync('psql', [url, '-qc', 'CREATE DATABASE chiaki'], { stdio: 'ignore' });
  console.log(`PostgreSQL running. DATABASE_URL=postgres://postgres@127.0.0.1:${port}/chiaki`);
}
