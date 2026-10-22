// 本機 PostgreSQL 叢集管理（測試與本機開發用）。使用系統已安裝的 PostgreSQL（≥14）。
// 以 root 執行時，postgres 不允許 root 啟動，會改以 PG_RUN_AS（預設 claude 或 nobody）身分執行。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

export function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  try {
    const d = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    if (existsSync(join(d, 'initdb'))) return d;
  } catch {}
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    const v = readdirSync(base).sort((a, b) => Number(b) - Number(a))[0];
    if (v && existsSync(join(base, v, 'bin', 'initdb'))) return join(base, v, 'bin');
  }
  throw new Error('PostgreSQL server binaries not found; set PG_BIN or install postgresql (or use DATABASE_URL to an existing server)');
}

function runAsUser() {
  if (process.getuid && process.getuid() !== 0) return null;
  if (process.env.PG_RUN_AS) return process.env.PG_RUN_AS;
  const r = spawnSync('id', ['-u', 'claude']);
  return r.status === 0 ? 'claude' : 'nobody';
}

function run(bin, args, user) {
  const cmd = user ? 'runuser' : bin;
  const full = user ? ['-u', user, '--', bin, ...args] : args;
  const r = spawnSync(cmd, full, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function chownTree(dir, user) {
  if (!user) return;
  const uid = Number(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim());
  chownSync(dir, uid, gid);
}

export function startCluster({ dir, port }) {
  const bin = findPgBin();
  const user = runAsUser();
  mkdirSync(dir, { recursive: true });
  chownTree(dir, user);
  const data = join(dir, 'data');
  if (!existsSync(join(data, 'PG_VERSION'))) {
    run(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], user);
  }
  run(
    join(bin, 'pg_ctl'),
    ['-D', data, '-l', join(dir, 'postgres.log'), '-w', '-t', '60', '-o',
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c max_connections=400 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      'start'],
    user,
  );
  return { url: `postgres://postgres@127.0.0.1:${port}/postgres`, bin, user, data };
}

export function stopCluster({ dir }) {
  const bin = findPgBin();
  const data = join(dir, 'data');
  if (!existsSync(join(data, 'postmaster.pid'))) return;
  run(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], runAsUser());
}

export function whoami() {
  return userInfo().username;
}
