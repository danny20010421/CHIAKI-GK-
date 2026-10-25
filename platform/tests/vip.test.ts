import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, transaction } from '../src/server/db';
import { executeDraw, type DrawResponse } from '../src/server/modules/draw/draw';
import {
  couponLabel,
  cumulativePerks,
  loadTiers,
  oddsUnlockLevel,
  recordDrawRefund,
  runVipAnnualRerating,
  runVipBirthdayGifts,
  runVipMonthlyCoupons,
  tierForSpend,
} from '../src/server/modules/vip/vip';
import { postLedger, reconcileWallets } from '../src/server/modules/wallet/wallet';
import { VIP_TIER_DEFAULTS } from '../src/server/seed/reference';
import { GET as vipRoute } from '../src/app/api/me/vip/route';
import { GET as tiersRoute } from '../src/app/api/admin/vip/tiers/route';
import { PATCH as tierPatch } from '../src/app/api/admin/vip/tiers/[level]/route';
import { GET as listRoute } from '../src/app/api/pools/route';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { GET as setRoute } from '../src/app/api/pools/[id]/sets/[no]/route';
import { GET as warehouseRoute } from '../src/app/api/me/warehouse/route';
import { POST as drawRoute } from '../src/app/api/draws/route';
import { apiRequest, ctx, customPool, ledgerOf, makeUser, pickTickets, publishPool, setupTestDb, smallPool, walletOf } from './helpers';

const key = () => `vip-${randomUUID()}`;
const none = undefined as never;

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

async function memberOf(userId: string) {
  const [m] = await db()<{ level: number; qualifyingSpend: number; lifetimeSpend: number }[]>`
    SELECT level, qualifying_spend, lifetime_spend FROM vip_members WHERE user_id = ${userId}`;
  return m ? { ...m } : null;
}
async function grantsOf(userId: string, kind?: string): Promise<{ kind: string; period: string; level: number; coins: number }[]> {
  const d = db();
  return [
    ...(await d<{ kind: string; period: string; level: number; coins: number }[]>`
      SELECT kind, period, level, coins FROM vip_gift_grants WHERE user_id = ${userId} ${kind ? d`AND kind = ${kind}` : d``} ORDER BY kind, level, period`),
  ];
}
async function setVip(userId: string, level: number, spend = 0) {
  await db()`INSERT INTO vip_members (user_id, level, qualifying_spend, lifetime_spend) VALUES (${userId}, ${level}, ${spend}, ${spend})
             ON CONFLICT (user_id) DO UPDATE SET level = EXCLUDED.level, qualifying_spend = EXCLUDED.qualifying_spend`;
}
/** 1000 UC幣 / 抽、40 籤（全部可回收：小獎 50、中獎 400） */
const bigPricePool = () => publishPool(customPool({ priceCoins: 1000 }));

describe('VIP tiers (pure + seeded defaults)', () => {
  it('migration seeds the owner defaults; tierForSpend / cumulative perks / odds unlock level / coupon labels', async () => {
    const tiers = await loadTiers(db());
    assert.deepEqual(tiers, VIP_TIER_DEFAULTS);
    assert.deepEqual(tiers.map((t) => [t.level, t.name, t.spendThreshold]), [
      [0, '新手籤', 0], [1, '銅籤', 3_000], [2, '銀籤', 30_000], [3, '金籤', 200_000], [4, '白金籤', 500_000], [5, '鑽石籤', 1_000_000], [6, '黑金籤', 2_000_000],
    ]);
    assert.deepEqual(tiers.map((t) => [t.upgradeGiftCoins, t.birthdayGiftCoins]), [[0, 0], [50, 0], [100, 100], [500, 500], [1000, 2000], [2500, 5000], [5000, 10000]]);
    assert.deepEqual(
      tiers.map((t) => t.monthlyCoupons.map((c) => `${couponLabel(c.discountPct)}×${c.qty}`).join('+')),
      ['', '95折券×1', '95折券×2', '95折券×2', '9折券×3', '85折券×3+8折券×1', '8折券×3'],
    );
    assert.deepEqual(
      [0, 2999, 3000, 29_999, 30_000, 199_999, 200_000, 499_999, 500_000, 999_999, 1_000_000, 1_999_999, 2_000_000, 9e9].map((s) => tierForSpend(tiers, s).level),
      [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6],
    );
    assert.equal(oddsUnlockLevel(tiers), 3);
    assert.deepEqual(cumulativePerks(tiers, 1), []);
    assert.deepEqual(cumulativePerks(tiers, 4).map((p) => p.label), ['生日禮', '賞池頁即時機率顯示', '免費保管期限 +7 天']);
    assert.deepEqual(cumulativePerks(tiers, 6).map((p) => p.code), ['BIRTHDAY_GIFT', 'LIVE_ODDS', 'FREE_STORAGE_PLUS_7', 'DEDICATED_CS', 'EXCLUSIVE_EVENTS']);
    assert.deepEqual([5, 10, 15, 20].map(couponLabel), ['95折券', '9折券', '85折券', '8折券']);
    assert.deepEqual(tiers.map((t) => t.extraStorageDays), [0, 0, 0, 0, 7, 14, 14], 'totals per tier, not additive');
  });
});

describe('VIP — draw spend, upgrade gifts', () => {
  it('counts both refundable and non-refundable spend; crossing 3,000 → VIP1 + 50 non-refundable UC幣 in the same settle', async () => {
    const poolId = await bigPricePool();
    const u = await makeUser({ coins: 2000, nonRefundableCoins: 1500 });
    const r1 = await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 2) });
    assert.deepEqual([r1.response.vip.level, r1.response.vip.upgraded, r1.response.vip.gifts], [0, false, []]);
    assert.equal((await memberOf(u.id))!.qualifyingSpend, 2000, 'NR 1500 + refundable 500 both count');
    const r2 = await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 1) });
    assert.deepEqual(r2.response.vip, { previousLevel: 0, level: 1, levelName: '銅籤', upgraded: true, spend: 3000, gifts: [{ level: 1, name: '銅籤', coins: 50 }], giftCoins: 50 });
    assert.equal(r2.response.coinsAfter, 3500 - 3000 + 50, 'coinsAfter includes the gift');
    const w = await walletOf(u.id);
    assert.deepEqual([w.coins, w.nonRefundableCoins], [550, 50], 'gift is non-refundable');
    const gift = (await ledgerOf(u.id)).filter((l) => l.entryType === 'VIP_UPGRADE_GIFT');
    assert.deepEqual(gift.map((g) => [g.amount, g.refundable]), [[50, false]]);
    assert.deepEqual(await grantsOf(u.id), [{ kind: 'UPGRADE', period: 'L1', level: 1, coins: 50 }]);
    assert.ok((await reconcileWallets(db(), u.id)).every((r) => r.ok));
  });

  it('skipping levels grants each skipped level once; replay and later draws never re-grant; items get VIP storage days', async () => {
    const poolId = await bigPricePool();
    const u = await makeUser({ coins: 40_000 });
    const k = key();
    const nos = await pickTickets(poolId, 31);
    const r = await executeDraw(u.id, k, { poolId, setNo: 1, ticketNos: nos });
    assert.deepEqual(r.response.vip.gifts.map((g) => [g.level, g.coins]), [[1, 50], [2, 100]]);
    assert.equal(r.response.vip.level, 2);
    assert.equal(r.response.coinsAfter, 40_000 - 31_000 + 150);
    const replay = await executeDraw(u.id, k, { poolId, setNo: 1, ticketNos: nos });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response.vip, r.response.vip);
    const again = await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 1) });
    assert.deepEqual([again.response.vip.level, again.response.vip.gifts], [2, []]);
    assert.deepEqual((await grantsOf(u.id, 'UPGRADE')).map((g) => g.period), ['L1', 'L2']);
    assert.equal((await walletOf(u.id)).coins, 40_000 - 32_000 + 150);
    assert.equal((await ledgerOf(u.id)).filter((l) => l.entryType === 'VIP_UPGRADE_GIFT').length, 2);
    const days = async (drawId: string) =>
      db()<{ days: number }[]>`SELECT round(extract(epoch FROM storage_expires_at - created_at) / 86400)::int AS days FROM warehouse_items WHERE draw_id = ${drawId}`;
    // 銀籤：無加碼 → 一般 30 天
    const items = await days(r.response.drawId);
    assert.ok(items.length === 31 && items.every((i) => i.days === 30), JSON.stringify(items.slice(0, 3)));
    // 跨過 500,000 → 白金籤：逐級補發 L1–L4，該筆入庫的獎品寄存 30 + 7 天
    const p4 = await makeUser({ coins: 1000 });
    await setVip(p4.id, 3, 499_500);
    const r4 = await executeDraw(p4.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 1) });
    assert.deepEqual([r4.response.vip.level, r4.response.vip.gifts.map((g) => [g.level, g.coins])], [4, [[1, 50], [2, 100], [3, 500], [4, 1000]]]);
    assert.deepEqual((await days(r4.response.drawId)).map((i) => i.days), [37]);
    // VIP0 會員：一般 30 天
    const v0 = await makeUser({ coins: 1000 });
    const r0 = await executeDraw(v0.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 1) });
    const [i0] = await db()<{ days: number }[]>`SELECT round(extract(epoch FROM storage_expires_at - created_at) / 86400)::int AS days FROM warehouse_items WHERE draw_id = ${r0.response.drawId}`;
    assert.equal(i0!.days, 30);
  });

  it('concurrent draws crossing the threshold grant the upgrade gift exactly once', async () => {
    const [p1, p2, p3] = [await bigPricePool(), await bigPricePool(), await bigPricePool()];
    const u = await makeUser({ coins: 10_000 });
    await setVip(u.id, 0, 2500);
    const results = await Promise.all([p1, p2, p3].map(async (poolId) => executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 1) })));
    assert.equal(results.filter((r) => r.response.vip.upgraded).length, 1);
    assert.deepEqual(await grantsOf(u.id), [{ kind: 'UPGRADE', period: 'L1', level: 1, coins: 50 }]);
    assert.equal((await memberOf(u.id))!.qualifyingSpend, 5500);
    assert.equal((await walletOf(u.id)).coins, 10_000 - 3000 + 50);
    assert.ok((await reconcileWallets(db(), u.id)).every((r) => r.ok));
  });

  it('a draw refund reduces spend (idempotent per refund id) without demoting mid-year', async () => {
    const poolId = await bigPricePool();
    const u = await makeUser({ coins: 5000 });
    const r = await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 3) });
    assert.equal(r.response.vip.level, 1);
    const refundId = randomUUID();
    const a = await transaction((tx) => recordDrawRefund(tx, { userId: u.id, drawId: r.response.drawId, refundId, amount: 1000 }));
    const b = await transaction((tx) => recordDrawRefund(tx, { userId: u.id, drawId: r.response.drawId, refundId, amount: 1000 }));
    assert.deepEqual([a, b], [{ spend: 2000, applied: true }, { spend: 2000, applied: false }]);
    assert.deepEqual(await memberOf(u.id), { level: 1, qualifyingSpend: 2000, lifetimeSpend: 2000 });
    const [ev] = await db()<{ total: number }[]>`SELECT sum(amount)::bigint AS total FROM vip_spend_events WHERE user_id = ${u.id}`;
    assert.equal(ev!.total, 2000);
  });
});

describe('VIP — birthday gifts, monthly coupons, annual re-rating (job functions)', () => {
  it('birthday gift: birthday month in Asia/Taipei, once per calendar year, by current level, non-refundable; VIP0 gets nothing', async () => {
    const u = await makeUser();
    const v0 = await makeUser();
    await db()`UPDATE users SET birth_date = '1990-11-15' WHERE id IN (${u.id}, ${v0.id})`;
    await setVip(u.id, 2, 32_000);
    await setVip(v0.id, 0, 100);
    const oct31Taipei = new Date('2026-10-31T15:59:00Z'); // 台灣 10/31 23:59
    const nov1Taipei = new Date('2026-10-31T16:30:00Z'); // 台灣 11/1 00:30（UTC 仍為 10/31）
    await runVipBirthdayGifts(oct31Taipei);
    assert.equal((await grantsOf(u.id, 'BIRTHDAY')).length, 0, 'not yet November in Taipei');
    await runVipBirthdayGifts(nov1Taipei);
    await runVipBirthdayGifts(new Date('2026-11-20T04:00:00Z'));
    assert.deepEqual(await grantsOf(u.id, 'BIRTHDAY'), [{ kind: 'BIRTHDAY', period: '2026', level: 2, coins: 100 }]);
    assert.equal((await grantsOf(v0.id)).length, 0);
    await setVip(u.id, 3, 210_000);
    await runVipBirthdayGifts(new Date('2027-11-02T04:00:00Z'));
    assert.deepEqual((await grantsOf(u.id, 'BIRTHDAY')).map((g) => [g.period, g.coins]), [['2026', 100], ['2027', 500]]);
    const led = (await ledgerOf(u.id)).filter((l) => l.entryType === 'VIP_BIRTHDAY_GIFT');
    assert.deepEqual(led.map((l) => [l.amount, l.refundable]), [[100, false], [500, false]]);
    assert.deepEqual(await walletOf(u.id), { coins: 600, nonRefundableCoins: 600 });
    // 並行執行同一天的工作：仍只發一次
    const w = await makeUser();
    await db()`UPDATE users SET birth_date = '1991-11-01' WHERE id = ${w.id}`;
    await setVip(w.id, 2, 30_000);
    await Promise.all([1, 2, 3].map(() => runVipBirthdayGifts(nov1Taipei)));
    assert.deepEqual((await grantsOf(w.id, 'BIRTHDAY')).map((g) => g.coins), [100]);
    assert.equal((await walletOf(w.id)).coins, 100);
    // VIP1 銅籤：生日禮為 0 → 不發放、不留紀錄、不通知
    const b1 = await makeUser();
    await db()`UPDATE users SET birth_date = '1992-11-20' WHERE id = ${b1.id}`;
    await setVip(b1.id, 1, 3000);
    const r1 = await runVipBirthdayGifts(nov1Taipei);
    assert.equal((await grantsOf(b1.id, 'BIRTHDAY')).length, 0);
    assert.equal((await walletOf(b1.id)).coins, 0);
    assert.equal(r1.granted, 0);
    const [n1] = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${b1.id} AND type = 'VIP_BIRTHDAY_GIFT'`;
    assert.equal(n1!.n, 0);
  });

  it('monthly coupons: issued per tier on the 1st (Asia/Taipei), idempotent per member-month, valid until next month', async () => {
    const v1 = await makeUser();
    const v5 = await makeUser();
    const v0 = await makeUser();
    await setVip(v1.id, 1, 3000);
    await setVip(v5.id, 5, 1_000_000);
    await setVip(v0.id, 0, 10);
    const now = new Date('2026-10-31T16:05:00Z'); // 台灣 2026-11-01 00:05
    const r = await runVipMonthlyCoupons(now);
    assert.equal(r.month, '2026-11');
    const coupons = async (id: string) =>
      db()<{ label: string; discountPct: number; validFrom: Date; expiresAt: Date }[]>`
        SELECT label, discount_pct, valid_from, expires_at FROM vip_coupons WHERE user_id = ${id} ORDER BY discount_pct, label`;
    assert.deepEqual((await coupons(v1.id)).map((c) => c.label), ['95折券']);
    assert.deepEqual((await coupons(v5.id)).map((c) => [c.label, c.discountPct]), [['85折券', 15], ['85折券', 15], ['85折券', 15], ['8折券', 20]]);
    assert.equal((await coupons(v0.id)).length, 0);
    const c = (await coupons(v5.id))[0]!;
    assert.equal(c.validFrom.toISOString(), '2026-10-31T16:00:00.000Z');
    assert.equal(c.expiresAt.toISOString(), '2026-11-30T16:00:00.000Z');
    await runVipMonthlyCoupons(new Date('2026-11-15T03:00:00Z'));
    await Promise.all([runVipMonthlyCoupons(now), runVipMonthlyCoupons(now)]);
    assert.equal((await coupons(v5.id)).length, 4, 'idempotent per member-month');
    assert.deepEqual((await grantsOf(v5.id, 'MONTHLY_COUPONS')).map((g) => [g.period, g.level]), [['2026-11', 5]]);
    await runVipMonthlyCoupons(new Date('2026-11-30T16:10:00Z')); // 台灣 12/1
    assert.equal((await coupons(v1.id)).length, 2);
    // 會員端：本月有效的優惠券
    const res = await vipRoute(apiRequest('GET', '/api/me/vip', { token: v5.token }), none);
    const body = (await res.json()) as { coupons: unknown[]; gifts: { kind: string }[] };
    assert.ok(body.gifts.some((g) => g.kind === 'MONTHLY_COUPONS'));
    assert.ok(Array.isArray(body.coupons));
  });

  it('annual re-rating on Jan 1: previous 12 months spend, drops at most one level, resets qualifying spend, idempotent', async () => {
    const [a, b, c, d] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    await setVip(a.id, 4, 520_000);
    await setVip(b.id, 2, 35_000);
    await setVip(c.id, 1, 3_500);
    await setVip(d.id, 0, 0);
    const ev = async (userId: string, amount: number, at: string) =>
      db()`INSERT INTO vip_spend_events (user_id, draw_id, kind, ref_id, amount, occurred_at) VALUES (${userId}, ${randomUUID()}, 'DRAW', ${randomUUID()}, ${amount}, ${at})`;
    await ev(a.id, 515_000, '2025-06-01T00:00:00Z'); // 兩年前：不計
    await ev(a.id, 5_000, '2026-06-01T00:00:00Z'); // 2026 年：VIP1 水準
    await ev(b.id, 32_000, '2026-03-01T00:00:00Z'); // 維持 VIP2
    await ev(b.id, 700, '2025-12-31T15:59:00Z'); // 台灣 2025-12-31 23:59：不在 2026 期間內
    await ev(c.id, 500, '2026-12-31T16:01:00Z'); // 台灣 2027-01-01 00:01：評等後的花費
    await ev(d.id, 35_000, '2026-09-01T00:00:00Z'); // 門檻調整等情況：期間花費達 VIP2 → 升級並補發升級禮
    const jan1 = new Date('2026-12-31T16:05:00Z'); // 台灣 2027-01-01 00:05
    const r = await runVipAnnualRerating(jan1);
    assert.equal(r.year, 2027);
    assert.deepEqual(await memberOf(a.id), { level: 3, qualifyingSpend: 200_000, lifetimeSpend: 520_000 }, 'VIP4 → VIP3 only (computed VIP1)');
    assert.deepEqual(await memberOf(b.id), { level: 2, qualifyingSpend: 32_000, lifetimeSpend: 35_000 });
    assert.deepEqual(await memberOf(c.id), { level: 0, qualifyingSpend: 500, lifetimeSpend: 3_500 });
    assert.equal((await memberOf(d.id))!.level, 2);
    assert.deepEqual((await grantsOf(d.id, 'UPGRADE')).map((g) => g.period), ['L1', 'L2']);
    assert.equal((await walletOf(d.id)).coins, 150);
    const ratings = await db()<{ userId: string; fromLevel: number; computedLevel: number; toLevel: number; windowSpend: number }[]>`
      SELECT user_id, from_level, computed_level, to_level, window_spend FROM vip_ratings WHERE year = 2027 AND user_id IN (${a.id}, ${b.id})`;
    assert.deepEqual(ratings.find((x) => x.userId === a.id), { userId: a.id, fromLevel: 4, computedLevel: 1, toLevel: 3, windowSpend: 5_000 });
    // 冪等：再執行（含並行）不會再降級
    await Promise.all([runVipAnnualRerating(jan1), runVipAnnualRerating(new Date('2027-03-01T00:00:00Z'))]);
    assert.equal((await memberOf(a.id))!.level, 3);
    assert.equal((await db()`SELECT 1 FROM vip_ratings WHERE user_id = ${a.id}`).length, 1);
    // 隔年（2028/1/1）：2027 年無花費 → 再降一級
    await runVipAnnualRerating(new Date('2027-12-31T16:30:00Z'));
    assert.equal((await memberOf(a.id))!.level, 2);
    assert.equal((await memberOf(a.id))!.qualifyingSpend, 30_000, 'reset to the VIP2 threshold');
    // 降級後再升回：同一等級的升級禮一生只發一次
    const poolId = await publishPool(customPool({ priceCoins: 10_000 }));
    await transaction((tx) => postLedger(tx, { userId: a.id, amount: 200_000, entryType: 'ADMIN_ADJUST', refType: 'test_seed', refId: randomUUID() }));
    await db()`INSERT INTO vip_gift_grants (user_id, kind, period, level) VALUES (${a.id}, 'UPGRADE', 'L1', 1), (${a.id}, 'UPGRADE', 'L2', 2), (${a.id}, 'UPGRADE', 'L3', 3)`;
    const back = await executeDraw(a.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 20) });
    assert.deepEqual([back.response.vip.previousLevel, back.response.vip.level], [2, 3], '30,000 + 200,000 → back to VIP3');
    assert.deepEqual(back.response.vip.gifts, [], 'L3 gift already received once');
  });
});

describe('VIP — member and admin API', () => {
  it('GET /api/me/vip: level, spend, next threshold, progress, perks, gift history', async () => {
    const poolId = await bigPricePool();
    const u = await makeUser({ coins: 40_000 });
    await executeDraw(u.id, key(), { poolId, setNo: 1, ticketNos: await pickTickets(poolId, 35) });
    const res = await vipRoute(apiRequest('GET', '/api/me/vip', { token: u.token }), none);
    assert.equal(res.status, 200);
    const v = (await res.json()) as {
      level: number; name: string; spend: number; nextThreshold: number; progress: number; nextLevel: { level: number; remaining: number };
      perks: { code: string }[]; benefits: { oddsVisible: boolean; extraStorageDays: number; monthlyCoupons: { label: string; qty: number }[] };
      oddsUnlockLevel: number; gifts: { kind: string; period: string; coins: number; refundable: boolean }[]; tiers: unknown[];
    };
    assert.deepEqual([v.level, v.name, v.spend, v.nextThreshold], [2, '銀籤', 35_000, 200_000]);
    assert.deepEqual(v.nextLevel, { level: 3, name: '金籤', spendThreshold: 200_000, remaining: 165_000 });
    assert.equal(v.progress, 0.0294, '(35,000 − 30,000) / (200,000 − 30,000)');
    assert.deepEqual(v.perks.map((p) => p.code), ['BIRTHDAY_GIFT']);
    assert.deepEqual(v.benefits.monthlyCoupons.map((c) => [c.label, c.qty]), [['95折券', 2]]);
    assert.equal(v.benefits.oddsVisible, false);
    assert.equal(v.oddsUnlockLevel, 3);
    assert.deepEqual(v.gifts.map((g) => [g.kind, g.period, g.coins, g.refundable]).sort(), [['UPGRADE', 'L1', 50, false], ['UPGRADE', 'L2', 100, false]]);
    assert.equal(v.tiers.length, 7);
    const fresh = await makeUser();
    const f = (await (await vipRoute(apiRequest('GET', '/api/me/vip', { token: fresh.token }), none)).json()) as { level: number; spend: number; progress: number; gifts: unknown[] };
    assert.deepEqual([f.level, f.spend, f.progress, f.gifts.length], [0, 0, 0, 0]);
    assert.equal((await vipRoute(apiRequest('GET', '/api/me/vip'), none)).status, 401);
  });

  it('admin can read/update tiers (audited, validated); members cannot', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const member = await makeUser();
    const list = await tiersRoute(apiRequest('GET', '/api/admin/vip/tiers', { token: ops.token }), none);
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { tiers: unknown[]; oddsUnlockLevel: number }).oddsUnlockLevel, 3);
    assert.equal((await tiersRoute(apiRequest('GET', '/api/admin/vip/tiers', { token: member.token }), none)).status, 403);
    const patch = (level: string, body: unknown, token = ops.token) => tierPatch(apiRequest('PATCH', `/api/admin/vip/tiers/${level}`, { token, body }), ctx({ level }));
    assert.equal((await patch('1', { birthdayGiftCoins: 60 }, member.token)).status, 403);
    assert.equal((await patch('2', { spendThreshold: 2000 })).status, 400, 'thresholds must increase with level');
    assert.equal((await patch('0', { spendThreshold: 1 })).status, 400, 'VIP0 threshold is 0');
    assert.equal((await patch('4', { perks: [{ code: 'LIVE_ODDS', label: 'x' }] })).status, 400, 'a perk code lives on one level only');
    assert.equal((await patch('9', { name: 'x' })).status, 404);
    assert.equal((await patch('1', { bogus: 1 })).status, 400);
    const ok = await patch('1', { name: '銅籤+', birthdayGiftCoins: 60, monthlyCoupons: [{ discountPct: 5, qty: 2 }] });
    assert.equal(ok.status, 200);
    const t1 = (await ok.json()) as { name: string; birthdayGiftCoins: number; monthlyCoupons: { label: string; qty: number }[] };
    assert.deepEqual([t1.name, t1.birthdayGiftCoins, t1.monthlyCoupons], ['銅籤+', 60, [{ discountPct: 5, qty: 2, label: '95折券' }]]);
    const [a] = await db()<{ actorId: string; payloadJson: string }[]>`SELECT actor_id, payload_json FROM audit_log WHERE action = 'VIP_TIER_UPDATED' ORDER BY seq DESC LIMIT 1`;
    assert.equal(a!.actorId, ops.id);
    assert.match(a!.payloadJson, /"before":\{[^}]*"birthdayGiftCoins":0/);
    // 即時機率改由 VIP2 解鎖（移動 LIVE_ODDS 權益）
    assert.equal((await patch('3', { perks: [] })).status, 200);
    assert.equal((await patch('2', { perks: [{ code: 'BIRTHDAY_GIFT', label: '生日禮' }, { code: 'LIVE_ODDS', label: '賞池頁即時機率顯示' }] })).status, 200);
    assert.equal(oddsUnlockLevel(await loadTiers(db())), 2);
    // 還原預設（其他測試依賴預設值）
    for (const t of VIP_TIER_DEFAULTS.slice(1, 4)) {
      const r = await patch(String(t.level), { name: t.name, birthdayGiftCoins: t.birthdayGiftCoins, monthlyCoupons: t.monthlyCoupons, perks: t.perks });
      assert.equal(r.status, 200);
    }
    assert.deepEqual(await loadTiers(db()), VIP_TIER_DEFAULTS);
  });
});

describe('pool page: odds gated by VIP level, recycle values hidden', () => {
  const j = async <T>(r: Response) => (await r.json()) as T;
  type Board = { oddsLocked: boolean; oddsUnlockLevel: number; remaining: number; total: number; levels: Record<string, unknown>[]; prizes: Record<string, unknown>[]; lastPrize: Record<string, unknown> | null };

  it('guests and VIP0–2 get counts but no probabilities (oddsLocked); VIP3+ get current per-prize probabilities', async () => {
    const poolId = await publishPool(smallPool());
    const v2 = await makeUser();
    const v3 = await makeUser();
    const v6 = await makeUser();
    await setVip(v2.id, 2, 10_000);
    await setVip(v3.id, 3, 30_000);
    await setVip(v6.id, 6, 500_000);
    const board = async (token?: string) => j<Board>(await setRoute(apiRequest('GET', `/api/pools/${poolId}/sets/1`, { token }), ctx({ id: poolId, no: '1' })));
    for (const b of [await board(), await board(v2.token)]) {
      assert.deepEqual([b.oddsLocked, b.oddsUnlockLevel, b.remaining, b.total], [true, 3, 10, 10]);
      assert.ok(b.prizes.every((p) => !('probability' in p) && typeof p.remaining === 'number' && typeof p.total === 'number'));
      assert.ok(b.levels.every((l) => !('probability' in l) && typeof l.remaining === 'number'));
      assert.ok(!JSON.stringify(b).includes('probability'));
    }
    for (const b of [await board(v3.token), await board(v6.token)]) {
      assert.equal(b.oddsLocked, false);
      assert.deepEqual(b.prizes.map((p) => p.probability), [0.1, 0.1, 0.2, 0.6]);
      assert.deepEqual(b.levels.map((l) => l.probability), [0.1, 0.1, 0.2, 0.6]);
    }
    const detail = async (token?: string) => j<{ oddsLocked: boolean; oddsUnlockLevel: number }>(await poolRoute(apiRequest('GET', `/api/pools/${poolId}`, { token }), ctx({ id: poolId })));
    const d0 = await detail();
    assert.deepEqual([d0.oddsLocked, d0.oddsUnlockLevel], [true, 3]);
    assert.equal((await detail(v2.token)).oddsLocked, true);
    assert.equal((await detail(v3.token)).oddsLocked, false);
  });

  it('pool list / detail / board never expose recycle values; draw results and my warehouse do', async () => {
    const poolId = await publishPool(smallPool());
    const v3 = await makeUser({ coins: 1000 });
    await setVip(v3.id, 3, 30_000);
    const bodies = [
      await (await listRoute(apiRequest('GET', '/api/pools'), none)).text(),
      await (await poolRoute(apiRequest('GET', `/api/pools/${poolId}`, { token: v3.token }), ctx({ id: poolId }))).text(),
      await (await setRoute(apiRequest('GET', `/api/pools/${poolId}/sets/1`, { token: v3.token }), ctx({ id: poolId, no: '1' }))).text(),
    ];
    for (const b of bodies) assert.ok(!/recycleValue|recycle_value/i.test(b), b.slice(0, 200));
    const res = await drawRoute(apiRequest('POST', '/api/draws', { token: v3.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, count: 10 } }), none);
    assert.equal(res.status, 201);
    const d = (await res.json()) as DrawResponse;
    const byName = Object.fromEntries(d.results.map((r) => [r.prizeName, [r.recycleValue, r.recyclable]]));
    assert.deepEqual(byName['C賞'], [300, true]);
    assert.deepEqual(byName['D賞'], [150, true]);
    assert.deepEqual(byName['A賞'], [0, false]);
    assert.deepEqual(byName['Last賞（測試）'], [0, false]);
    const wh = (await (await warehouseRoute(apiRequest('GET', '/api/me/warehouse', { token: v3.token }), none)).json()) as { items: { prizeName: string; recycleValue: number | null }[] };
    assert.equal(wh.items.find((i) => i.prizeName === 'C賞')!.recycleValue, 300);
  });
});
