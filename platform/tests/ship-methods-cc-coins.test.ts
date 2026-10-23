/**
 * 業主 2026-10 第七批：
 *  1. 寄送方式逐件預設（home / c711 / fami）：後台建立/編輯時設定、未設定的預設值、賞池一有銷售即鎖定（應用層＋資料庫 trigger）。
 *  2. 單一貨幣 CC幣：餘額 = 可退款 + 不可退款；抽賞先扣不可退款；只有可退款可申請退款；獎勵/贈送/補償/回收皆不可退款。
 *  3. migration 20261102：既有平台點數 → 不可退款 CC幣（帳本鏈與對帳一致）、獎項寄送方式回填。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { db, transaction } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { createPoolDraft } from '../src/server/modules/pool/admin';
import { getAdminPool, updatePrize } from '../src/server/modules/pool/structure';
import { createRefundRequest } from '../src/server/modules/wallet/refunds';
import { getCoinBreakdown, postLedger, reconcileWallets } from '../src/server/modules/wallet/wallet';
import { approve, requestBalanceAdjust } from '../src/server/modules/admin/approvals';
import { runMigrations } from '../src/server/lib/migrations';
import { PATCH as prizePatch } from '../src/app/api/admin/prizes/[id]/route';
import { GET as breakdownRoute } from '../src/app/api/me/wallet/breakdown/route';
import { apiRequest, ctx, customPool, expectAppError, ledgerOf, makeUser, publishPool, setupTestDb, walletOf } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
let k = 0;
const key = () => `sm-${process.pid}-${++k}-${Date.now()}`;
const none = undefined as never;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

const prizeId = async (poolId: string, name: string) => (await db()<{ id: string }[]>`SELECT id FROM pool_prizes WHERE pool_id = ${poolId} AND name = ${name}`)[0]!.id;
const shipOf = async (poolId: string) =>
  Object.fromEntries((await db()<{ name: string; shipMethod: string }[]>`SELECT name, ship_method FROM pool_prizes WHERE pool_id = ${poolId}`).map((r) => [r.name, r.shipMethod]));

describe('rule 1 — ship method preset per prize', () => {
  it('admin sets it at listing; default: GK tag or level 1 (bulky) → home, else c711; invalid values rejected', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const draft = customPool({
      levels: [
        { levelNo: 1, name: '大獎', items: [{ name: '雕像', qtyPerSet: 1, tag: 'PVC' }] },
        { levelNo: 2, name: '2 獎', items: [{ name: 'GK 胸像', qtyPerSet: 1, tag: 'GK' }, { name: '地毯', qtyPerSet: 1, tag: '其他', shipMethod: 'home' }] },
        { levelNo: 3, name: '3 獎', items: [{ name: '徽章', qtyPerSet: 5 }, { name: '毛巾', qtyPerSet: 5, shipMethod: 'fami' }] },
      ],
      lastPrizeName: '最後賞雕像',
      lastPrizeTag: 'GK',
    });
    const { poolId } = await createPoolDraft(ops.principal, draft);
    assert.deepEqual(await shipOf(poolId), { 雕像: 'home', 'GK 胸像': 'home', 地毯: 'home', 徽章: 'c711', 毛巾: 'fami', 最後賞雕像: 'home' });
    await assert.rejects(
      createPoolDraft(ops.principal, customPool({ levels: [{ levelNo: 1, name: 'A', items: [{ name: 'x', qtyPerSet: 1, shipMethod: 'CVS_OK' as never }] }] })),
      /寄送方式須為/,
    );
    await assert.rejects(db()`UPDATE pool_prizes SET ship_method = 'ok' WHERE pool_id = ${poolId}`, /pool_prizes_ship_method_check/);
    const admin = await getAdminPool(db(), poolId);
    assert.equal(admin.shipMethodEditable, true);
    assert.deepEqual(admin.levels[2]!.items.map((i) => [i.name, i.shipMethod, i.shipMethodLabel]), [['徽章', 'c711', '7-11 交貨便'], ['毛巾', 'fami', '全家店到店']]);
  });

  it('editable in draft and after publish until the first sale; then locked (HAS_SALES) — also enforced by a DB trigger', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const poolId = await publishPool(customPool());
    const small = await prizeId(poolId, '壓克力立牌');
    // 已發布、尚無銷售：可改（不影響籤表與承諾）
    const r1 = await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${small}`, { token: ops.token, body: { shipMethod: 'fami' } }), ctx({ id: small }));
    assert.equal(r1.status, 200);
    assert.equal(((await r1.json()) as { shipMethod: string }).shipMethod, 'fami');
    assert.equal((await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${small}`, { token: ops.token, body: { shipMethod: 'post' } }), ctx({ id: small }))).status, 400);
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'PRIZE_UPDATED' ORDER BY seq DESC LIMIT 1`;
    assert.match(a!.payloadJson as string, /"shipMethod":"fami"/);

    const u = await makeUser({ coins: 1000 });
    await executeDraw(u.id, key(), { poolId, setNo: 1, count: 1 });
    assert.equal((await getAdminPool(db(), poolId)).shipMethodEditable, false);
    await expectAppError(updatePrize(ops.principal, small, { shipMethod: 'c711' }), 'HAS_SALES');
    const r2 = await prizePatch(apiRequest('PATCH', `/api/admin/prizes/${small}`, { token: ops.token, body: { shipMethod: 'home' } }), ctx({ id: small }));
    assert.equal(r2.status, 409);
    await assert.rejects(db()`UPDATE pool_prizes SET ship_method = 'c711' WHERE id = ${small}`, /ship method is locked/);
    // 其他非結構欄位仍可改；同值不算變更
    await updatePrize(ops.principal, small, { name: '壓克力立牌（新版）', shipMethod: 'fami' });
    assert.equal((await shipOf(poolId))['壓克力立牌（新版）'], 'fami');
  });
});

describe('rule 3 — one currency (CC幣)', () => {
  it('draws spend non-refundable first, then refundable; only refundable coins can be refunded', async () => {
    const poolId = await publishPool(customPool({ priceCoins: 100 }));
    const u = await makeUser({ coins: 300, nonRefundableCoins: 150 });
    assert.deepEqual(await walletOf(u.id), { coins: 450, nonRefundableCoins: 150 });
    await expectAppError(createRefundRequest(u.id, 301, 'x'), 'INSUFFICIENT_FUNDS');
    await executeDraw(u.id, key(), { poolId, setNo: 1, count: 1 });
    assert.deepEqual(await walletOf(u.id), { coins: 350, nonRefundableCoins: 50 }, '100 taken from non-refundable');
    await executeDraw(u.id, key(), { poolId, setNo: 1, count: 1 });
    assert.deepEqual(await walletOf(u.id), { coins: 250, nonRefundableCoins: 0 }, '50 non-refundable + 50 refundable');
    await expectAppError(createRefundRequest(u.id, 251, 'x'), 'INSUFFICIENT_FUNDS');
    await createRefundRequest(u.id, 250, 'refund the rest');
    const b = await getCoinBreakdown(db(), u.id);
    assert.deepEqual([b.currency, b.coins, b.refundableCoins, b.nonRefundableCoins], ['CC幣', 250, 250, 0]);
    assert.equal(b.nonRefundableCredited.CS_COMPENSATION, 150);
    const res = await breakdownRoute(apiRequest('GET', '/api/me/wallet/breakdown', { token: u.token }), none);
    assert.equal(res.status, 200);
    assert.ok((await reconcileWallets(db(), u.id))[0]!.ok);
  });

  it('top-up bonus / binding / compensation / recycle credits are always non-refundable; admin adjustments default refundable (legacy POINTS → non-refundable)', async () => {
    const u = await makeUser();
    for (const t of ['TOPUP_BONUS', 'BIND_REWARD', 'CS_COMPENSATION', 'RECYCLE_CREDIT', 'REFERRAL_REWARD', 'EXPIRY_AUTO_CONVERT'] as const) {
      await assert.rejects(transaction((tx) => postLedger(tx, { userId: u.id, amount: 1, entryType: t, refType: 't', refId: t, refundable: true })), /always non-refundable/);
      await transaction((tx) => postLedger(tx, { userId: u.id, amount: 10, entryType: t, refType: 't', refId: t }));
    }
    assert.deepEqual(await walletOf(u.id), { coins: 60, nonRefundableCoins: 60 });
    await assert.rejects(
      db()`INSERT INTO wallet_ledger (user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, refundable, nonrefundable_after)
           VALUES (${u.id}, 'COINS', 1, 61, 'TOPUP_BONUS', 't', 'x', true, 60)`,
      /ledger_nonrefundable_sources/,
    );
    const fin1 = await makeUser({ roles: ['FINANCE'] });
    const fin2 = await makeUser({ roles: ['FINANCE'] });
    for (const input of [
      { userId: u.id, amount: 100, memo: '人工補發（可退款）' },
      { userId: u.id, amount: 40, refundable: false, memo: '活動贈送（不可退款）' },
      { userId: u.id, currency: 'POINTS' as const, amount: 25, memo: '舊格式：平台點數' },
    ]) {
      const { approvalId } = await requestBalanceAdjust(fin1.principal, input);
      await approve(fin2.principal, approvalId);
    }
    assert.deepEqual(await walletOf(u.id), { coins: 225, nonRefundableCoins: 125 });
    assert.deepEqual(
      (await ledgerOf(u.id)).filter((l) => l.entryType === 'ADMIN_ADJUST').map((l) => [l.amount, l.refundable]),
      [[100, true], [40, false], [25, false]],
    );
    await assert.rejects(requestBalanceAdjust(fin1.principal, { userId: u.id, amount: -5, refundable: false, memo: 'bad flag' }), /refundable only applies to credits/);
  });
});

describe('migration 20261102 — points → non-refundable CC幣, ship method backfill', () => {
  it('converts existing point balances with a balanced ledger chain and backfills prize ship methods from bulky', async () => {
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
    const name = `m_${randomBytes(6).toString('hex')}`;
    const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await admin.end();
    const int8 = { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) };
    const sql = postgres(adminUrl.replace(/\/[^/]*$/, `/${name}`), { max: 1, onnotice: () => undefined, transform: postgres.camel, types: { int8 } });
    const src = join(process.cwd(), 'prisma', 'migrations');
    const all = readdirSync(src).filter((n) => /^\d{14}_/.test(n)).sort();
    const target = '20261102000000_ship_methods_freight_collect_cc_coins';
    const dir = mkdtempSync(join(tmpdir(), 'chiaki-mig-'));
    try {
      for (const n of all.slice(0, all.indexOf(target))) cpSync(join(src, n), join(dir, n), { recursive: true });
      await runMigrations(sql as never, dir);
      // 合併前的資料：A 有 500 可退款代幣＋70 點；B 只有 30 點；C 沒有點數
      const [a, b, c] = ['0911222001', '0911222002', '0911222003'];
      const ids: string[] = [];
      for (const phone of [a, b, c]) {
        const [u] = await sql<{ id: string }[]>`INSERT INTO users (phone) VALUES (${phone!}) RETURNING id`;
        await sql`INSERT INTO wallets (user_id) VALUES (${u!.id}) ON CONFLICT DO NOTHING`;
        ids.push(u!.id);
      }
      await sql`INSERT INTO wallet_ledger (user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, refundable, nonrefundable_after)
                VALUES (${ids[0]!}, 'COINS', 500, 500, 'TOPUP', 'payment_order', 'o1', true, 0)`;
      await sql`INSERT INTO wallet_ledger (user_id, currency, amount, balance_after, entry_type, ref_type, ref_id) VALUES (${ids[0]!}, 'POINTS', 70, 70, 'BIND_REWARD', 'reward_claim', 'r1')`;
      await sql`INSERT INTO wallet_ledger (user_id, currency, amount, balance_after, entry_type, ref_type, ref_id) VALUES (${ids[1]!}, 'POINTS', 30, 30, 'RECYCLE_CREDIT', 'recycle_batch', 'b1')`;
      await sql`UPDATE wallets SET coins = 500, points = 70 WHERE user_id = ${ids[0]!}`;
      await sql`UPDATE wallets SET points = 30 WHERE user_id = ${ids[1]!}`;
      const [pool] = await sql<{ id: string }[]>`INSERT INTO pools (slug, title, source, play_type, price_coins, set_count) VALUES ('mig-pool', 'm', 'CUSTOM', 'STANDARD', 10, 1) RETURNING id`;
      const [lv] = await sql<{ id: string }[]>`INSERT INTO pool_levels (pool_id, level_no, name, is_small) VALUES (${pool!.id}, 1, 'A', false) RETURNING id`;
      await sql`INSERT INTO pool_prizes (pool_id, kind, level_id, name, qty_per_set, bulky) VALUES (${pool!.id}, 'TICKET', ${lv!.id}, '大件', 1, true), (${pool!.id}, 'TICKET', ${lv!.id}, '小件', 1, false)`;

      cpSync(join(src, target), join(dir, target), { recursive: true });
      assert.deepEqual(await runMigrations(sql as never, dir), [target]);

      const w = await sql<{ userId: string; coins: number; nonrefundableCoins: number }[]>`SELECT user_id, coins::int, nonrefundable_coins::int FROM wallets ORDER BY coins`;
      const byId = new Map(w.map((r) => [r.userId, r]));
      assert.deepEqual([byId.get(ids[0]!)!.coins, byId.get(ids[0]!)!.nonrefundableCoins], [570, 70]);
      assert.deepEqual([byId.get(ids[1]!)!.coins, byId.get(ids[1]!)!.nonrefundableCoins], [30, 30]);
      assert.deepEqual([byId.get(ids[2]!)!.coins, byId.get(ids[2]!)!.nonrefundableCoins], [0, 0]);
      const merged = await sql<{ userId: string; currency: string; amount: number; balanceAfter: number; refundable: boolean | null; nonrefundableAfter: number | null }[]>`
        SELECT user_id, currency, amount::int, balance_after::int, refundable, nonrefundable_after::int FROM wallet_ledger WHERE entry_type = 'POINTS_MERGED' ORDER BY user_id, id`;
      assert.deepEqual(
        merged.filter((m) => m.userId === ids[0]).map((m) => [m.currency, m.amount, m.balanceAfter, m.refundable, m.nonrefundableAfter]),
        [['POINTS', -70, 0, null, null], ['COINS', 70, 570, false, 70]],
      );
      assert.equal(merged.filter((m) => m.userId === ids[2]).length, 0);
      const rec = await reconcileWallets(sql as never);
      assert.ok(rec.every((r) => r.ok), JSON.stringify(rec));
      const ships = await sql<{ name: string; shipMethod: string }[]>`SELECT name, ship_method FROM pool_prizes ORDER BY name`;
      assert.deepEqual(ships.map((s) => [s.name, s.shipMethod]).sort(), [['大件', 'home'], ['小件', 'c711']]);
    } finally {
      await sql.end();
      rmSync(dir, { recursive: true, force: true });
      const a2 = postgres(adminUrl, { max: 1, onnotice: () => undefined });
      await a2.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a2.end();
    }
  });
});
