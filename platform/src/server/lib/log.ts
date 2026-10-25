/**
 * 結構化日誌（JSON 一行一筆，適合 Docker / Zeabur / Render 的日誌收集）。
 * 欄位：ts、level、msg 與呼叫端提供的欄位；Error 物件會轉成 { name, message, stack }。
 * 等級由 LOG_LEVEL 控制（預設 info）。不要把密碼、token、金鑰放進欄位。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function threshold(): number {
  const v = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
  return LEVELS[v] ?? LEVELS.info;
}

function serialize(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, ...(v.stack ? { stack: v.stack } : {}), ...((v as { code?: string }).code ? { code: (v as { code?: string }).code } : {}) };
  return v;
}

/** 組出一筆日誌（純函式，供測試） */
export function formatLog(level: LogLevel, msg: string, fields: Record<string, unknown> = {}, now = new Date()): string {
  const out: Record<string, unknown> = { ts: now.toISOString(), level, msg };
  for (const [k, v] of Object.entries(fields)) out[k] = serialize(v);
  return JSON.stringify(out);
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const line = formatLog(level, msg, fields);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
