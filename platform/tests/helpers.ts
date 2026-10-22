import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { resetConfig } from '../src/server/config';
import { closeDb, db, transaction } from '../src/server/db';
import { createSession, createUser } from '../src/server/modules/auth/users';
import type { Principal, Role } from '../src/server/modules/auth/rbac';
import { postLedger } from '../src/server/modules/wallet/wallet';
import { createPoolDraft, type PoolDraftInput } from '../src/server/modules/pool/admin';
import { approve, requestPoolPublish } from '../src/server/modules/admin/approvals';
import { seedReferenceData } from '../src/server/seed/reference';

/**
 * 每個測試檔建立一個獨立的「真實 PostgreSQL」資料庫（由已 migrate 的 template 複製）。
 * 必須透過 `npm test`（scripts/run-tests.mjs）執行，以取得 TEST_DATABASE_ADMIN_URL。
 */
export async function setupTestDb(env: Record<string, string> = {}) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  const template = process.env.TEST_TEMPLATE_DB;
  if (!adminUrl || !template) throw new Error('run tests with `npm test` (needs TEST_DATABASE_ADMIN_URL / TEST_TEMPLATE_DB)');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  for (let i = 0; ; i++) {
    try {
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      break;
    } catch (e) {
      if (i >= 20 || !/being accessed by other users/.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  await admin.end();
  Object.assign(process.env, {
    DATABASE_URL: adminUrl.replace(/\/[^/]*$/, `/${name}`),
    DATABASE_POOL_MAX: '80',
    AUTH_DEV_STUB: '1',
    REWARD_VERIFY_STUB: '1',
    ...env,
  });
  resetConfig();
  await seedReferenceData(db());
  return {
    name,
    async teardown() {
      await closeDb();
      const a = postgres(adminUrl, { max: 1, onnotice: () => undefined });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export interface TestUser {
  id: string;
  token: string;
  principal: Principal;
}

let phoneSeq = 0;
export async function makeUser(opts: { roles?: Role[]; coins?: number; points?: number; ageVerified?: boolean; phone?: string | null } = {}): Promise<TestUser> {
  const roles = opts.roles ?? ['MEMBER'];
  const phone = opts.phone === undefined ? `09${String(process.pid % 100).padStart(2, '0')}${String(++phoneSeq).padStart(6, '0')}` : opts.phone;
  const u = await createUser(db(), { phone, roles });
  if (opts.ageVerified ?? true) await db()`UPDATE users SET age_verified_at = now(), birth_date = '1990-01-01' WHERE id = ${u.id}`;
  if (opts.coins || opts.points) {
    await transaction(async (tx) => {
      if (opts.coins) await postLedger(tx, { userId: u.id, currency: 'COINS', amount: opts.coins, entryType: 'ADMIN_ADJUST', refType: 'test_seed', refId: u.id });
      if (opts.points) await postLedger(tx, { userId: u.id, currency: 'POINTS', amount: opts.points, entryType: 'ADMIN_ADJUST', refType: 'test_seed', refId: u.id });
    });
  }
  const token = await createSession(db(), u.id);
  return { id: u.id, token, principal: { userId: u.id, roles, ageVerified: opts.ageVerified ?? true } };
}

let slugSeq = 0;
/** 測試賞池預設運費（宅配 / 超商 C2C） */
export const FEE_HOME = 150;
export const FEE_CVS = 70;

/**
 * 小型測試賞池（官方 OFFICIAL：有賞級）：預設 2 套 × 10 籤（A1 B1 C2 D6），每抽 100。
 * 等級採預設對應：A → GRAND、B/C → MID、D → SMALL。回收值：C 300、D 150（A/B 不可回收）。
 */
export function smallPool(overrides: Partial<PoolDraftInput> = {}): PoolDraftInput {
  return {
    slug: `test-pool-${process.pid}-${++slugSeq}`,
    title: '測試賞池',
    source: 'OFFICIAL',
    playType: 'STANDARD',
    priceCoins: 100,
    setCount: 2,
    lastPrizeName: 'Last賞（測試）',
    prizes: [
      { rank: 'A', name: 'A賞', qtyPerSet: 1 },
      { rank: 'B', name: 'B賞', qtyPerSet: 1 },
      { rank: 'C', name: 'C賞', qtyPerSet: 2, recycleValue: 300 },
      { rank: 'D', name: 'D賞', qtyPerSet: 6, recycleValue: 150 },
    ],
    guarantee: null,
    shippingFeeHome: FEE_HOME,
    shippingFeeCvs: FEE_CVS,
    ...overrides,
  };
}

let customSeq = 0;
/**
 * 自製（CUSTOM）測試賞池：沒有賞級，獎項以名稱識別、等級由後台指定。
 * 預設 1 套 × 40 籤：大獎 1、中獎 2、小獎 37（全部可回收：小獎 50、中獎 400）。
 */
export function customPool(overrides: Partial<PoolDraftInput> = {}): PoolDraftInput {
  return {
    slug: `custom-pool-${process.pid}-${++customSeq}`,
    title: '自製測試賞池',
    source: 'CUSTOM',
    playType: 'STANDARD',
    priceCoins: 10,
    setCount: 1,
    lastPrizeName: null,
    prizes: [
      { name: '原創雕像', grade: 'GRAND', qtyPerSet: 1 },
      { name: '半身像', grade: 'MID', qtyPerSet: 2, recycleValue: 400 },
      { name: '壓克力立牌', grade: 'SMALL', qtyPerSet: 37, recycleValue: 50 },
    ],
    guarantee: null,
    shippingFeeHome: FEE_HOME,
    shippingFeeCvs: FEE_CVS,
    ...overrides,
  };
}

/** 依正式流程建立並發布：OPS 建草稿＋申請 → 另一位 SUPER_ADMIN 核准。 */
export async function publishPool(draft: PoolDraftInput): Promise<string> {
  const ops = await makeUser({ roles: ['OPS'] });
  const boss = await makeUser({ roles: ['SUPER_ADMIN'] });
  const { poolId } = await createPoolDraft(ops.principal, draft);
  const { approvalId } = await requestPoolPublish(ops.principal, poolId);
  await approve(boss.principal, approvalId);
  return poolId;
}

/** 測試專用：直接從資料庫讀出籤表（正式 API 不提供）。 */
export async function layoutOf(poolId: string, setNo: number) {
  return db()<{ ticketNo: number; rank: string | null; grade: 'GRAND' | 'MID' | 'SMALL'; name: string; prizeId: string; status: string }[]>`
    SELECT t.ticket_no, pr.rank, pr.grade, pr.name, t.prize_id, t.status FROM tickets t
    JOIN pool_sets s ON s.id = t.set_id JOIN pool_prizes pr ON pr.id = t.prize_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${setNo} ORDER BY t.ticket_no`;
}

export function apiRequest(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {}): Request {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let b: string | undefined;
  if (opts.rawBody !== undefined) b = opts.rawBody;
  else if (opts.body !== undefined) {
    b = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  return new Request(`http://localhost${path}`, { method, headers, body: b });
}

export const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

/** 測試用：某會員的帳本（依 id 升冪） */
export async function ledgerOf(userId: string) {
  return db()<{ amount: number; balanceAfter: number; entryType: string; refundable: boolean | null }[]>`
    SELECT amount, balance_after, entry_type, refundable FROM wallet_ledger WHERE user_id = ${userId} ORDER BY id`;
}

export async function walletOf(userId: string) {
  const [w] = await db()<{ coins: number; points: number }[]>`SELECT coins, points FROM wallets WHERE user_id = ${userId}`;
  return w!;
}

export async function expectAppError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const c = (e as { code?: string }).code;
    if (c === code) return;
    throw new Error(`expected AppError ${code}, got ${c ?? ''}: ${(e as Error).message}`);
  }
  throw new Error(`expected AppError ${code}, but promise resolved`);
}
