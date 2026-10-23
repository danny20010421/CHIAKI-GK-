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
    // 應用層防火牆：測試檔內所有請求都來自同一個（未知）IP，預設放寬；security.test.ts 會覆寫
    RATE_LIMIT_IP_CAPACITY: '100000',
    RATE_LIMIT_USER_CAPACITY: '100000',
    BOT_MAX_REQUESTS: '100000',
    // 測試站保護（SITE_TEST_MODE 預設開）在測試中關閉，金流測試照常進行；site-mode.test.ts 會覆寫驗證
    SITE_TEST_MODE: 'false',
    // 測試以指定籤號建立可預期的情境（正式站預設關閉自選籤號；quick-draw-only 測試會覆寫）
    ALLOW_TICKET_PICK: 'true',
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
/** coins：可退款 CC幣（人工調整）；nonRefundableCoins：不可退款 CC幣（以客服補償入帳） */
export async function makeUser(opts: { roles?: Role[]; coins?: number; nonRefundableCoins?: number; ageVerified?: boolean; phone?: string | null } = {}): Promise<TestUser> {
  const roles = opts.roles ?? ['MEMBER'];
  // 096 開頭：與種子（0900…）及各測試寫死的號碼（0911…、0977…、0987…、0988…）不會相撞（舊格式在 pid 尾數 00/11 時會撞號）
  const phone = opts.phone === undefined ? `096${String(process.pid % 1000).padStart(3, '0')}${String(++phoneSeq).padStart(4, '0')}` : opts.phone;
  const u = await createUser(db(), { phone, roles });
  if (opts.ageVerified ?? true) await db()`UPDATE users SET age_verified_at = now(), birth_date = '1990-01-01' WHERE id = ${u.id}`;
  if (opts.coins || opts.nonRefundableCoins) {
    await transaction(async (tx) => {
      if (opts.coins) await postLedger(tx, { userId: u.id, amount: opts.coins, entryType: 'ADMIN_ADJUST', refType: 'test_seed', refId: u.id });
      if (opts.nonRefundableCoins) await postLedger(tx, { userId: u.id, amount: opts.nonRefundableCoins, entryType: 'CS_COMPENSATION', refType: 'test_seed', refId: u.id });
    });
  }
  // 員工：模擬「後台帳號密碼登入」的 session（後台 API 需要 PASSWORD session＋近期重新驗證）
  const staff = roles.some((r) => r !== 'MEMBER');
  const token = await createSession(db(), u.id, staff ? { authMethod: 'PASSWORD', mfa: true } : {});
  return { id: u.id, token, principal: { userId: u.id, roles, ageVerified: opts.ageVerified ?? true } };
}

let slugSeq = 0;
/** 測試賞池預設開放全部快速抽包（正式預設為 1、5、10） */
export const ALL_PACKS = [1, 3, 5, 10, 20, 'all'] as const;

type LegacyGrade = 'GRAND' | 'MID' | 'SMALL';
const OLD_CATEGORY_TO_TAG: Record<string, string> = { GK: 'GK', PVC: 'PVC', 景品: '景品盲盒', 盒玩扭蛋: '景品盲盒', 卡牌: '卡牌', 絨毛: '娃娃' };
/** 測試用的精簡寫法：rank（A–H → 等級 1–8）或 grade（GRAND/MID/SMALL → 等級 1/2/3），由 toDraft 轉成等級模型 */
export interface TestPrize {
  rank?: string;
  grade?: LegacyGrade;
  name: string;
  qtyPerSet: number;
  recycleValue?: number;
  recyclable?: boolean;
  tag?: string | null;
  category?: string | null;
  bulky?: boolean;
  shipMethod?: 'home' | 'c711' | 'fami';
  imageUrl?: string | null;
}
export type TestPoolInput = Omit<Partial<PoolDraftInput>, 'guarantee'> & {
  prizes?: TestPrize[];
  lastPrizeName?: string | null;
  lastPrizeRecycleValue?: number;
  lastPrizeRecyclable?: boolean;
  lastPrizeTag?: string | null;
  lastPrizeBulky?: boolean;
  guarantee?:
    | (Record<string, unknown> & { everyN: number; reservePrizeName: string; reserveTotal: number; minGrade?: LegacyGrade; minLevel?: number; reserveRank?: string; reserveGrade?: LegacyGrade; reserveLevelNo?: number })
    | null;
};

const GRADE_ORDER: Record<LegacyGrade, number> = { GRAND: 0, MID: 1, SMALL: 2 };
const defaultGradeForRank = (r: string): LegacyGrade => (r === 'A' ? 'GRAND' : r === 'B' || r === 'C' ? 'MID' : 'SMALL');
const levelOf = (p: { rank?: string; grade?: LegacyGrade }) =>
  p.rank ? p.rank.charCodeAt(0) - 64 : p.grade === 'GRAND' ? 1 : p.grade === 'MID' ? 2 : 3;
const tagOf = (p: { tag?: string | null; category?: string | null }) =>
  (p.tag !== undefined ? p.tag : p.category ? (OLD_CATEGORY_TO_TAG[p.category] ?? '其他') : null) as never;

/** 舊式（rank/grade）測試定義 → 等級 1–8 草稿 */
export function toDraft(input: TestPoolInput): PoolDraftInput {
  const { prizes, lastPrizeName, lastPrizeRecycleValue, lastPrizeRecyclable, lastPrizeTag, lastPrizeBulky, guarantee, ...rest } = input;
  const out: PoolDraftInput = { ...(rest as PoolDraftInput) };
  const grades = new Map<number, LegacyGrade>();
  if (prizes && !rest.levels) {
    const levels = new Map<number, { levelNo: number; name: string; items: NonNullable<PoolDraftInput['levels']>[number]['items']; small: boolean[] }>();
    for (const p of prizes) {
      const no = levelOf(p);
      const g = p.grade ?? (p.rank ? defaultGradeForRank(p.rank) : 'SMALL');
      const name = p.rank ? `${p.rank}賞` : no === 1 ? '大獎' : no === 2 ? '中獎' : '小獎';
      const l = levels.get(no) ?? { levelNo: no, name, items: [], small: [] };
      l.items.push({ name: p.name, qtyPerSet: p.qtyPerSet, recycleValue: p.recycleValue, recyclable: p.recyclable, tag: tagOf(p), bulky: p.bulky, shipMethod: p.shipMethod, imageUrl: p.imageUrl });
      l.small.push(g === 'SMALL');
      levels.set(no, l);
      const cur = grades.get(no);
      if (!cur || GRADE_ORDER[g] < GRADE_ORDER[cur]) grades.set(no, g);
    }
    out.levels = [...levels.values()].map((l) => ({ levelNo: l.levelNo, name: l.name, isSmall: l.small.every(Boolean), items: l.items }));
  }
  if (lastPrizeName !== undefined && rest.lastPrize === undefined) {
    out.lastPrize = lastPrizeName
      ? { name: lastPrizeName, recycleValue: lastPrizeRecycleValue, recyclable: lastPrizeRecyclable, tag: (lastPrizeTag ?? null) as never, bulky: lastPrizeBulky }
      : null;
  }
  if (guarantee !== undefined) {
    if (guarantee === null) out.guarantee = null;
    else {
      const { minGrade, reserveRank, reserveGrade, ...g } = guarantee;
      const levelNos = [...grades.keys()].sort((a, b) => a - b);
      const minLevel = g.minLevel ?? Math.max(...levelNos.filter((n) => GRADE_ORDER[grades.get(n)!] <= GRADE_ORDER[minGrade ?? 'MID']));
      const reserveLevelNo =
        g.reserveLevelNo ?? (reserveRank ? reserveRank.charCodeAt(0) - 64 : levelNos.find((n) => grades.get(n) === (reserveGrade ?? 'MID')) ?? levelNos[0]!);
      out.guarantee = { ...(g as object), minLevel, reserveLevelNo } as never;
    }
  }
  return out;
}

/**
 * 小型測試賞池（官方 OFFICIAL）：預設 2 套 × 10 籤（A1 B1 C2 D6 → 等級 1–4；D 為小獎），每抽 100。
 * 回收值：C 300、D 150（A/B 不可回收）。
 */
export function smallPool(overrides: TestPoolInput = {}): PoolDraftInput {
  return toDraft({
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
    drawPacks: [...ALL_PACKS],
    ...overrides,
  });
}

let customSeq = 0;
/**
 * 自製（CUSTOM）測試賞池：預設 1 套 × 40 籤：大獎（等級 1）1、中獎（等級 2）2、小獎（等級 3，小獎）37
 * （全部可回收：小獎 50、中獎 400）。
 */
export function customPool(overrides: TestPoolInput = {}): PoolDraftInput {
  return toDraft({
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
    drawPacks: [...ALL_PACKS],
    ...overrides,
  });
}

/** 測試用：隨機挑 n 張目前可抽的籤號（取代任意張數的 count 抽法） */
export async function pickTickets(poolId: string, n: number, setNo = 1): Promise<number[]> {
  const rows = await db()<{ ticketNo: number }[]>`
    SELECT t.ticket_no FROM tickets t JOIN pool_sets s ON s.id = t.set_id
    WHERE s.pool_id = ${poolId} AND s.set_no = ${setNo} AND t.status = 'AVAILABLE' ORDER BY random() LIMIT ${n}`;
  if (rows.length < n) throw new Error(`only ${rows.length} free tickets`);
  return rows.map((r) => r.ticketNo).sort((a, b) => a - b);
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
  return db()<{ ticketNo: number; levelNo: number; levelName: string; isSmall: boolean; name: string; prizeId: string; status: string }[]>`
    SELECT t.ticket_no, pl.level_no, pl.name AS level_name, pl.is_small, pr.name, t.prize_id, t.status FROM tickets t
    JOIN pool_sets s ON s.id = t.set_id JOIN pool_prizes pr ON pr.id = t.prize_id JOIN pool_levels pl ON pl.id = pr.level_id
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

/** CC幣餘額：coins = 可退款 + 不可退款 */
export async function walletOf(userId: string) {
  const [w] = await db()<{ coins: number; nonRefundableCoins: number }[]>`SELECT coins, nonrefundable_coins AS non_refundable_coins FROM wallets WHERE user_id = ${userId}`;
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

// ───────────── 測試用的「結構完整」小圖片（可通過重新封裝；像素資料為假資料） ─────────────
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const pngChunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, u32(0)]);
/** PNG：IHDR + tEXt（含「GPS」中繼資料）+ IDAT + IEND */
export function testPng(w: number, h: number, meta = 'GPS 25.0330N 121.5654E'): Buffer {
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(`Comment\0${meta}`, 'latin1')),
    pngChunk('IDAT', Buffer.alloc(300, 0x42)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
/** JPEG：SOI + APP0 + APP1（EXIF，含「GPS」）+ COM + DQT + SOF0 + SOS + 掃描資料 + EOI（+ 尾端夾帶資料） */
export function testJpeg(w: number, h: number, opts: { trailing?: string } = {}): Buffer {
  const seg = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16(data.length + 2), data]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.alloc(9)])),
    seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPS 25.0330N 121.5654E'), Buffer.alloc(200, 0x11)])),
    seg(0xfe, Buffer.from('camera owner: someone')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, Buffer.concat([Buffer.from([8]), u16(h), u16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])])),
    seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
    Buffer.alloc(400, 0x33),
    Buffer.from([0xff, 0xd9]),
    Buffer.from(opts.trailing ?? '', 'latin1'),
  ]);
}
/** WebP（VP8X 延伸格式，帶 EXIF 區塊與旗標） */
export function testWebp(w: number, h: number): Buffer {
  const le24 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(data.length);
    return Buffer.concat([Buffer.from(type, 'latin1'), len, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    chunk('VP8X', Buffer.concat([Buffer.from([0x08, 0, 0, 0]), le24(w - 1), le24(h - 1)])),
    chunk('VP8L', Buffer.concat([Buffer.from([0x2f]), Buffer.alloc(200, 0x21)])),
    chunk('EXIF', Buffer.from('GPS 25.0330N 121.5654E')),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
}
