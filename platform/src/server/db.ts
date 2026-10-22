import postgres from 'postgres';
import { config } from './config';

/**
 * 資料存取：postgres.js（原生 SQL、明確交易與列鎖）。
 * bigint（int8）一律轉為 JS number，並檢查不超過 2^53。
 */
const int8 = {
  to: 20,
  from: [20],
  serialize: (x: number | bigint | string) => String(x),
  parse: (x: string) => {
    const n = Number(x);
    if (!Number.isSafeInteger(n)) throw new Error(`int8 out of safe range: ${x}`);
    return n;
  },
};

function create(url: string, max: number) {
  return postgres(url, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
    transform: postgres.camel,
    types: { int8 },
  });
}

export type Sql = ReturnType<typeof create>;
export type Tx = postgres.TransactionSql<Sql extends postgres.Sql<infer T> ? T : never>;
/** 可接受連線池或交易物件的查詢介面 */
export type Db = Sql | Tx;

let instance: Sql | null = null;

export function db(): Sql {
  if (!instance) {
    const c = config();
    instance = create(c.DATABASE_URL, c.DATABASE_POOL_MAX);
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    const i = instance;
    instance = null;
    await i.end({ timeout: 5 });
  }
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * 執行一個資料庫交易；遇到序列化失敗/死結時整筆重試（交易內所有寫入皆已 rollback，重試安全）。
 */
export async function transaction<T>(fn: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return (await db().begin((tx) => fn(tx as Tx))) as T;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (i < attempts && code && RETRYABLE.has(code)) continue;
      throw e;
    }
  }
}
