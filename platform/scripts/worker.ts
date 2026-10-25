/**
 * 背景工作程序（docker-compose 的 worker 服務；平台上請另開一個「背景工作 / worker」服務執行）：
 *   通知外送（每分鐘）、寄存到期掃描（每小時）、抽賞紀錄封存（每日 03:30）、硬刪除過期軟刪除資料（每日 04:00）、
 *   VIP 年度重新評等（1/1 00:01）、VIP 每月優惠券（每月 1 日 00:05）、VIP 生日禮（每日 00:10）——皆為台灣時間。
 * 所有工作皆冪等；多個 worker 並行時以 PostgreSQL advisory lock 確保同一工作同時只有一個在跑。
 *
 * 用法：
 *   npm run worker                    常駐執行
 *   npm run worker -- --run <工作名稱>  立即執行單一工作後結束（給只支援 cron 的平台）
 *   npm run worker -- --list          列出工作與排程
 * 環境變數：WORKER_TICK_SEC（預設 30）、WORKER_NOTIFY_INTERVAL_SEC（預設 60）、WORKER_RETRY_SEC（失敗後重試間隔，預設 300）
 */
import { closeDb, db } from '../src/server/db';
import { config } from '../src/server/config';
import { log } from '../src/server/lib/log';
import { describeSpec, dueTasks, validateSpec, type TaskState } from '../src/server/jobs/schedule';
import { jobTasks, type JobTask } from '../src/server/jobs/tasks';

config(); // 設定錯誤 → 立即失敗
const tasks = jobTasks();
for (const t of tasks) validateSpec(t.spec);

const args = process.argv.slice(2);
const tickMs = (Number(process.env.WORKER_TICK_SEC ?? 30) || 30) * 1000;
const retryMs = (Number(process.env.WORKER_RETRY_SEC ?? 300) || 300) * 1000;

/** 以 advisory lock 執行（session 級鎖，需固定同一條連線） */
async function runLocked(t: JobTask, now: Date): Promise<'ran' | 'skipped'> {
  const conn = await db().reserve();
  try {
    const [r] = await conn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${`chiaki-job:${t.name}`})) AS ok`;
    if (!r?.ok) return 'skipped';
    try {
      const started = Date.now();
      const result = await t.run(now);
      log.info('job finished', { job: t.name, durationMs: Date.now() - started, result });
      return 'ran';
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext(${`chiaki-job:${t.name}`}))`;
    }
  } finally {
    conn.release();
  }
}

if (args[0] === '--list') {
  for (const t of tasks) console.log(`${t.name.padEnd(24)} ${describeSpec(t.spec)}`);
  await closeDb();
  process.exit(0);
}

if (args[0] === '--run') {
  const t = tasks.find((x) => x.name === args[1]);
  if (!t) {
    console.error(`unknown job "${args[1] ?? ''}". Jobs: ${tasks.map((x) => x.name).join(', ')}`);
    process.exit(2);
  }
  let code = 0;
  try {
    const r = await runLocked(t, new Date());
    if (r === 'skipped') log.warn('job already running elsewhere; skipped', { job: t.name });
  } catch (e) {
    log.error('job failed', { job: t.name, err: e });
    code = 1;
  }
  await closeDb();
  process.exit(code);
}

const startedAt = new Date();
const states = new Map<string, TaskState & { retryAt?: Date | null }>();
let stopping = false;
let running: Promise<void> | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  for (const t of dueTasks(tasks, states, now, startedAt)) {
    if (stopping) return;
    try {
      const r = await runLocked(t, now);
      if (r === 'skipped') log.info('job locked by another worker; skipped', { job: t.name });
      states.set(t.name, { lastRunAt: now, retryAt: null });
    } catch (e) {
      log.error('job failed', { job: t.name, err: e, retryInSec: retryMs / 1000 });
      states.set(t.name, { ...states.get(t.name), retryAt: new Date(Date.now() + retryMs) });
    }
  }
}

log.info('worker started', { tickSec: tickMs / 1000, jobs: tasks.map((t) => ({ name: t.name, schedule: describeSpec(t.spec) })) });
const loop = async () => {
  if (stopping) return;
  running = tick().catch((e) => log.error('worker tick failed', { err: e }));
  await running;
  running = null;
  if (!stopping) timer = setTimeout(loop, tickMs);
};
let timer: NodeJS.Timeout | undefined = setTimeout(loop, 0);

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  log.info('worker stopping', { signal });
  if (running) await running;
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
