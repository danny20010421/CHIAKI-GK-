/**
 * 業主 2026-10 第九批：
 *  3. 首頁橫幅（後台 CRUD＋稽核、連結驗證、台灣日期起訖、公開端點依排序；種子 2 則）。
 *  4. 抽賞結帳使用會員優惠券（pct / amt；本人、未過期、未使用、啟用、達最低消費；與抽賞同一交易標記已使用；並發只成功一筆；rollback 不消耗）。
 *  5. 會員通知：VIP 升級禮、生日禮、優惠券發放（站內＋依偏好的外部管道；與發放工作同樣冪等）；GET /api/me/notifications、POST /api/me/notifications/read。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/server/db';
import { executeDraw, quoteDraw } from '../src/server/modules/draw/draw';
import { claimCoupon, couponDiscount, evaluateCoupon } from '../src/server/modules/marketing/coupons';
import { createCoupon, liveBanners, updateCoupon } from '../src/server/modules/marketing/marketing';
import { createNotification } from '../src/server/modules/notifications/notifications';
import { setPreferences } from '../src/server/modules/notifications/outbox';
import { runVipBirthdayGifts, runVipMonthlyCoupons } from '../src/server/modules/vip/vip';
import { claimReward } from '../src/server/modules/rewards/rewards';
import { reconcileWallets } from '../src/server/modules/wallet/wallet';
import { HOME_BANNERS, seedHomeBanners } from '../src/server/seed/reference';
import { GET as myCouponsRoute, POST as claimRoute } from '../src/app/api/me/coupons/route';
import { POST as drawRoute } from '../src/app/api/draws/route';
import { GET as notesRoute } from '../src/app/api/me/notifications/route';
import { POST as readRoute } from '../src/app/api/me/notifications/read/route';
import { GET as bannersRoute } from '../src/app/api/banners/route';
import { GET as adminBannersRoute, POST as adminBannerCreate } from '../src/app/api/admin/banners/route';
import { DELETE as adminBannerDelete, GET as adminBannerGet, PATCH as adminBannerPatch } from '../src/app/api/admin/banners/[id]/route';
import { apiRequest, ctx, customPool, expectAppError, makeUser, publishPool, setupTestDb, walletOf } from './helpers';

const key = () => `cpn-${randomUUID()}`;
const none = undefined as never;
const j = async <T>(r: Response) => ({ status: r.status, body: (await r.json()) as T });

let env: Awaited<ReturnType<typeof setupTestDb>>;
let codeSeq = 0;
const code = () => `T${process.pid % 1000}C${++codeSeq}`.replace(/[^A-Z0-9]/g, '').slice(0, 16);
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});

async function ops() {
  return makeUser({ roles: ['OPS'] });
}
/** 建立代碼券並讓會員領取，回傳會員券 id */
async function codeCoupon(userId: string, def: { kind: 'pct' | 'amt'; value: number; minSpend?: number; expiresAt?: Date | null }) {
  const o = await ops();
  const c = await createCoupon(o.principal, { code: code(), ...def });
  const mine = await claimCoupon(userId, { code: c.code });
  return { couponDefId: c.id, id: mine.id, code: c.code, ops: o };
}
const couponRow = async (id: string) =>
  (await db()<{ status: string; usedDrawId: string | null; discountCoins: number | null }[]>`
    SELECT status, used_draw_id, discount_coins FROM user_coupons WHERE id = ${id} UNION ALL SELECT status, used_draw_id, discount_coins FROM vip_coupons WHERE id = ${id}`)[0]!;

describe('coupon maths (pure)', () => {
  it('pct = floor(subtotal × pct / 100); amt = min(amount, subtotal); reasons', () => {
    assert.deepEqual([couponDiscount('pct', 5, 999), couponDiscount('pct', 15, 300), couponDiscount('pct', 90, 101)], [49, 45, 90]);
    assert.deepEqual([couponDiscount('amt', 300, 1000), couponDiscount('amt', 1000, 300)], [300, 300]);
    const base = { status: 'ACTIVE' as const, enabled: true, validFrom: null, expiresAt: null, minSpend: 500, kind: 'amt' as const, value: 100 };
    const now = new Date('2026-11-01T00:00:00Z');
    assert.deepEqual(evaluateCoupon(base, 499, now), { usable: false, reason: 'MIN_SPEND', discountCoins: 0, payCoins: 499 });
    assert.deepEqual(evaluateCoupon(base, 500, now), { usable: true, reason: null, discountCoins: 100, payCoins: 400 });
    assert.equal(evaluateCoupon({ ...base, status: 'USED' }, 500, now).reason, 'USED');
    assert.equal(evaluateCoupon({ ...base, expiresAt: now }, 500, now).reason, 'EXPIRED');
    assert.equal(evaluateCoupon({ ...base, validFrom: new Date(now.getTime() + 1) }, 500, now).reason, 'NOT_YET_VALID');
    assert.equal(evaluateCoupon({ ...base, enabled: false }, 500, now).reason, 'DISABLED');
  });
});

describe('coupons at draw checkout', () => {
  let poolId: string;
  before(async () => {
    poolId = await publishPool(customPool({ priceCoins: 100, setCount: 1, prizes: [{ name: '小獎', grade: 'SMALL', qtyPerSet: 400, recycleValue: 10 }] }));
  });

  it('GET /api/me/coupons?usable_for=&qty= lists each coupon with usable flag, reason and discount; best pick', async () => {
    const u = await makeUser({ coins: 5000 });
    const pct = await codeCoupon(u.id, { kind: 'pct', value: 15 });
    const amt = await codeCoupon(u.id, { kind: 'amt', value: 300, minSpend: 1000 });
    const old = await codeCoupon(u.id, { kind: 'amt', value: 50, expiresAt: new Date(Date.now() + 60_000) });
    await db()`UPDATE coupons SET expires_at = now() - interval '1 minute' WHERE id = ${old.couponDefId}`;
    const off = await codeCoupon(u.id, { kind: 'pct', value: 10 });
    await updateCoupon(off.ops.principal, off.couponDefId, { enabled: false });
    type L = { coupons: { id: string; kind: string; value: number; label: string; usable: boolean; reason: string | null; discountCoins: number; payCoins: number }[]; usableFor: { subtotal: number; qty: number; unitPrice: number }; best: string | null };
    const q = async (qty: number, all = false) =>
      j<L>(await myCouponsRoute(apiRequest('GET', `/api/me/coupons?usable_for=${poolId}&qty=${qty}${all ? '&all=1' : ''}`, { token: u.token }), none));
    const five = await q(5);
    assert.equal(five.status, 200);
    assert.deepEqual(five.body.usableFor, { poolId, qty: 5, unitPrice: 100, subtotal: 500 });
    const by = (b: L, id: string) => b.coupons.find((c) => c.id === id)!;
    assert.deepEqual([by(five.body, pct.id).usable, by(five.body, pct.id).discountCoins, by(five.body, pct.id).payCoins, by(five.body, pct.id).label], [true, 75, 425, '85折券']);
    assert.deepEqual([by(five.body, amt.id).usable, by(five.body, amt.id).reason, by(five.body, amt.id).discountCoins, by(five.body, amt.id).label], [false, 'MIN_SPEND', 0, '折抵 300 UC幣']);
    assert.deepEqual([by(five.body, off.id).usable, by(five.body, off.id).reason], [false, 'DISABLED']);
    assert.equal(by(five.body, old.id), undefined, 'expired coupons hidden by default');
    assert.equal(five.body.best, pct.id);
    const ten = await q(10, true);
    assert.deepEqual([by(ten.body, amt.id).usable, by(ten.body, amt.id).discountCoins], [true, 300]);
    assert.deepEqual([by(ten.body, pct.id).discountCoins, ten.body.best], [150, amt.id]);
    assert.equal(by(ten.body, old.id).reason, 'EXPIRED');
    // 不帶 usable_for：只列可用狀態
    const plain = await j<{ coupons: { id: string; usable: boolean }[] }>(await myCouponsRoute(apiRequest('GET', '/api/me/coupons', { token: u.token }), none));
    assert.equal(plain.body.coupons.length, 3);
    // 領取 API：重複領取 409、無效碼 404
    const o = await ops();
    const c = await createCoupon(o.principal, { code: code(), kind: 'amt', value: 20 });
    assert.equal((await claimRoute(apiRequest('POST', '/api/me/coupons', { token: u.token, body: { code: c.code.toLowerCase() } }), none)).status, 201);
    assert.equal((await claimRoute(apiRequest('POST', '/api/me/coupons', { token: u.token, body: { code: c.code } }), none)).status, 409);
    assert.equal((await claimRoute(apiRequest('POST', '/api/me/coupons', { token: u.token, body: { code: 'NOPE0000' } }), none)).status, 404);
    // 免運券已停用
    await assert.rejects(createCoupon(o.principal, { code: code(), kind: 'ship' as never, value: 0 }));
  });

  it('draw with a coupon: discount recorded on draw + ledger, coupon marked used atomically, VIP spend counts the amount paid', async () => {
    const u = await makeUser({ coins: 5000 });
    const pct = await codeCoupon(u.id, { kind: 'pct', value: 15, minSpend: 300 });
    const quote = await quoteDraw(u.id, { poolId, setNo: 1, count: 3, couponId: pct.id });
    assert.deepEqual([quote.drawCoins, quote.discountCoins, quote.totalCoins, quote.coupon!.usable], [300, 45, 255, true]);
    const res = await j<{ drawId: string; amountCoins: number; discountCoins: number; paidCoins: number; totalCoins: number; coinsAfter: number; coupon: { id: string; source: string; kind: string; discountCoins: number } }>(
      await drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, count: 3, couponId: pct.id } }), none),
    );
    assert.equal(res.status, 201);
    const d = res.body;
    assert.deepEqual([d.amountCoins, d.discountCoins, d.paidCoins, d.totalCoins, d.coinsAfter], [300, 45, 255, 255, 5000 - 255]);
    assert.deepEqual([d.coupon.id, d.coupon.source, d.coupon.kind, d.coupon.discountCoins], [pct.id, 'CODE', 'pct', 45]);
    assert.deepEqual(await couponRow(pct.id), { status: 'USED', usedDrawId: d.drawId, discountCoins: 45 });
    const [dr] = await db()<{ amountCoins: number; discountCoins: number; couponId: string; couponSource: string }[]>`SELECT amount_coins, discount_coins, coupon_id, coupon_source FROM draws WHERE id = ${d.drawId}`;
    assert.deepEqual(dr, { amountCoins: 300, discountCoins: 45, couponId: pct.id, couponSource: 'CODE' });
    const [led] = await db()<{ amount: number; memo: string }[]>`SELECT amount, memo FROM wallet_ledger WHERE user_id = ${u.id} AND entry_type = 'DRAW_DEBIT' AND ref_id = ${d.drawId}`;
    assert.equal(led!.amount, -255);
    assert.match(led!.memo, /小計 300 − 優惠券「85折券」45 = 實付 255 UC幣/);
    const [sp] = await db()<{ amount: number }[]>`SELECT amount FROM vip_spend_events WHERE draw_id = ${d.drawId}`;
    assert.equal(sp!.amount, 255, 'VIP spend counts the amount actually paid');
    const [cu] = await db()<{ usedCount: number }[]>`SELECT used_count FROM coupons WHERE id = ${pct.couponDefId}`;
    assert.equal(cu!.usedCount, 1);
    // 同券再用 → 422 USED；他人的券 → 404；低於最低消費 → 422
    const again = await drawRoute(apiRequest('POST', '/api/draws', { token: u.token, headers: { 'idempotency-key': key() }, body: { poolId, setNo: 1, count: 3, couponId: pct.id } }), none);
    assert.equal(again.status, 422);
    assert.equal(((await again.json()) as { error: { details: { reason: string } } }).error.details.reason, 'USED');
    const v = await makeUser({ coins: 1000 });
    const vs = await codeCoupon(v.id, { kind: 'amt', value: 10 });
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 1, couponId: vs.id }), 'NOT_FOUND');
    const min = await codeCoupon(u.id, { kind: 'amt', value: 10, minSpend: 1000 });
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 1, couponId: min.id }), 'COUPON_NOT_USABLE');
    assert.equal((await couponRow(min.id)).status, 'ACTIVE');
    assert.ok((await reconcileWallets(db(), u.id)).every((r) => r.ok));
  });

  it('amt coupon covering the whole subtotal: 0 paid, 0-amount ledger entry, no VIP spend; failed draw (rollback) leaves the coupon unused', async () => {
    const u = await makeUser({ coins: 50 });
    const big = await codeCoupon(u.id, { kind: 'amt', value: 1000 });
    const r = await executeDraw(u.id, key(), { poolId, setNo: 1, count: 3, couponId: big.id });
    assert.deepEqual([r.response.amountCoins, r.response.discountCoins, r.response.paidCoins, r.response.coinsAfter], [300, 300, 0, 50]);
    const led = await db()<{ amount: number }[]>`SELECT amount FROM wallet_ledger WHERE ref_id = ${r.response.drawId} AND entry_type = 'DRAW_DEBIT'`;
    assert.deepEqual(led.map((l) => l.amount), [0]);
    assert.equal((await db()`SELECT 1 FROM vip_spend_events WHERE draw_id = ${r.response.drawId}`).length, 0);
    assert.equal((await walletOf(u.id)).coins, 50);
    // 實付不足 → INSUFFICIENT_FUNDS，整筆 rollback：券仍可用、無抽賞紀錄
    const small = await codeCoupon(u.id, { kind: 'pct', value: 5 });
    await expectAppError(executeDraw(u.id, key(), { poolId, setNo: 1, count: 3, couponId: small.id }), 'INSUFFICIENT_FUNDS');
    assert.deepEqual(await couponRow(small.id), { status: 'ACTIVE', usedDrawId: null, discountCoins: null });
    assert.ok((await reconcileWallets(db(), u.id)).every((x) => x.ok));
  });

  it('concurrent double use of one coupon: exactly one draw succeeds, the other fails COUPON_NOT_USABLE and is not charged', async () => {
    const pools = [poolId, await publishPool(customPool({ priceCoins: 100 })), await publishPool(customPool({ priceCoins: 100 }))];
    const u = await makeUser({ coins: 5000 });
    const c = await codeCoupon(u.id, { kind: 'amt', value: 80 });
    const rs = await Promise.allSettled(pools.map((p) => executeDraw(u.id, key(), { poolId: p, setNo: 1, count: 1, couponId: c.id })));
    const ok = rs.filter((r) => r.status === 'fulfilled');
    const bad = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.ok(bad.every((b) => (b.reason as { code?: string }).code === 'COUPON_NOT_USABLE'), JSON.stringify(bad.map((b) => String(b.reason))));
    assert.equal((await walletOf(u.id)).coins, 5000 - 20);
    assert.equal((await db()`SELECT 1 FROM draws WHERE user_id = ${u.id}`).length, 1);
    // VIP 每月券同樣只能用一次
    const v = await makeUser({ coins: 5000 });
    await db()`INSERT INTO vip_members (user_id, level, qualifying_spend, lifetime_spend) VALUES (${v.id}, 1, 3000, 3000)`;
    await runVipMonthlyCoupons(new Date());
    const [vc] = await db()<{ id: string }[]>`SELECT id FROM vip_coupons WHERE user_id = ${v.id}`;
    const vr = await Promise.allSettled(pools.map((p) => executeDraw(v.id, key(), { poolId: p, setNo: 1, count: 1, couponId: vc!.id })));
    assert.equal(vr.filter((r) => r.status === 'fulfilled').length, 1);
    const used = vr.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof executeDraw>>>;
    assert.deepEqual([used.value.response.coupon!.source, used.value.response.discountCoins, used.value.response.paidCoins], ['VIP', 5, 95]);
    assert.equal((await couponRow(vc!.id)).status, 'USED');
  });
});

describe('member notifications', () => {
  type Note = { id: string; type: string; title: string; body: string; link: string | null; unread: boolean; createdAt: string };
  type Page = { notifications: Note[]; unreadCount: number; nextCursor: string | null };
  const notes = async (token: string, qs = '') => j<Page>(await notesRoute(apiRequest('GET', `/api/me/notifications${qs}`, { token }), none));
  const ofType = async (userId: string, type: string) =>
    db()<{ title: string; body: string; payloadJson: string }[]>`SELECT title, body, payload_json FROM notifications WHERE user_id = ${userId} AND type = ${type}`;

  it('VIP upgrade gift (in the draw), birthday gift and monthly coupons notify in-app once, idempotent with re-runs', async () => {
    const poolId = await publishPool(customPool({ priceCoins: 1000 }));
    const u = await makeUser({ coins: 3000 });
    await executeDraw(u.id, key(), { poolId, setNo: 1, count: 3 });
    const up = await ofType(u.id, 'VIP_UPGRADE_GIFT');
    assert.equal(up.length, 1);
    assert.match(up[0]!.title, /VIP1 銅籤/);
    assert.match(up[0]!.body, /升級禮 50 UC幣已入帳/);
    assert.equal(JSON.parse(up[0]!.payloadJson).url, '/me/vip');
    // 生日禮（11 月生日，台灣 11/1）＋重跑
    await db()`UPDATE users SET birth_date = '1990-11-03' WHERE id = ${u.id}`;
    const nov = new Date('2026-10-31T16:30:00Z');
    await runVipBirthdayGifts(nov);
    await runVipBirthdayGifts(nov);
    const bd = await ofType(u.id, 'VIP_BIRTHDAY_GIFT');
    assert.equal(bd.length, 1);
    assert.match(bd[0]!.body, /生日禮 50 UC幣已入帳/);
    // 每月優惠券＋並行重跑
    await Promise.all([runVipMonthlyCoupons(nov), runVipMonthlyCoupons(nov)]);
    await runVipMonthlyCoupons(new Date('2026-11-10T00:00:00Z'));
    const cp = await ofType(u.id, 'COUPON_ISSUED');
    assert.equal(cp.length, 1);
    assert.equal(cp[0]!.title, '您獲得 1 張優惠券');
    assert.match(cp[0]!.body, /95折券 已存入「我的優惠券」，有效至 2026-11-30/);
    const page = await notes(u.token);
    assert.deepEqual(page.body.notifications.map((n) => n.type).sort(), ['COUPON_ISSUED', 'VIP_BIRTHDAY_GIFT', 'VIP_UPGRADE_GIFT']);
    assert.ok(page.body.notifications.every((n) => n.unread && typeof n.link === 'string'));
    assert.equal(page.body.notifications.find((n) => n.type === 'COUPON_ISSUED')!.link, '/me/coupons');
  });

  it('coupon claim and reward-task coupons notify; other channels are queued only when supported and allowed by preferences', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await db()`UPDATE users SET email = ${`a-${a.id}@example.com`} WHERE id = ${a.id}`;
    await db()`UPDATE users SET email = ${`b-${b.id}@example.com`} WHERE id = ${b.id}`;
    await setPreferences(b.id, { preferences: [{ channel: 'EMAIL', eventType: 'COUPON_ISSUED', enabled: false }] });
    const o = await ops();
    const c = await createCoupon(o.principal, { code: code(), kind: 'amt', value: 30, expiresAt: new Date('2027-01-01T00:00:00+08:00') });
    await claimCoupon(a.id, { code: c.code });
    await claimCoupon(b.id, { code: c.code });
    for (const id of [a.id, b.id]) {
      const n = await ofType(id, 'COUPON_ISSUED');
      assert.equal(n.length, 1);
      assert.match(n[0]!.body, /折抵 30 UC幣 已存入「我的優惠券」，有效至 2026-12-31/);
    }
    const outbox = async (id: string) => (await db()<{ channel: string }[]>`SELECT channel FROM notification_outbox WHERE user_id = ${id} AND event_type = 'COUPON_ISSUED' ORDER BY channel`).map((r) => r.channel);
    assert.deepEqual(await outbox(a.id), ['EMAIL', 'IN_APP'], 'email queued (address on file); no LINE/SMS/push destinations');
    assert.deepEqual(await outbox(b.id), ['IN_APP'], 'email disabled by preference');
    // 任務贈券：代碼對應到有效優惠券 → 連結並通知
    await db()`UPDATE reward_tasks SET coupon_code = ${c.code} WHERE code = 'BIND_PHONE'`;
    const r = await makeUser();
    await claimReward(r.id, 'BIND_PHONE');
    const [uc] = await db()<{ couponId: string | null }[]>`SELECT coupon_id FROM user_coupons WHERE user_id = ${r.id}`;
    assert.equal(uc!.couponId, c.id);
    assert.equal((await ofType(r.id, 'COUPON_ISSUED')).length, 1);
    await db()`UPDATE reward_tasks SET coupon_code = NULL WHERE code = 'BIND_PHONE'`;
  });

  it('GET /api/me/notifications pages newest first with unread count; POST /api/me/notifications/read marks ids (own only) or all', async () => {
    const u = await makeUser();
    const other = await makeUser();
    for (let i = 0; i < 25; i++) {
      await createNotification(db(), { userId: u.id, type: 'COUPON_ISSUED', title: `n${i}`, body: 'b', payload: { url: '/me/coupons' }, dedupeOn: { i } });
      await db()`UPDATE notifications SET created_at = now() - make_interval(mins => ${25 - i}) WHERE user_id = ${u.id} AND title = ${`n${i}`}`;
    }
    await createNotification(db(), { userId: other.id, type: 'COUPON_ISSUED', title: 'x', body: 'b', payload: {}, dedupeOn: { x: 1 } });
    const p1 = await notes(u.token, '?limit=10');
    assert.equal(p1.status, 200);
    assert.deepEqual([p1.body.notifications.length, p1.body.unreadCount, p1.body.notifications[0]!.title, p1.body.notifications[9]!.title], [10, 25, 'n24', 'n15']);
    const p2 = await notes(u.token, `?limit=10&cursor=${p1.body.nextCursor}`);
    const p3 = await notes(u.token, `?limit=10&cursor=${p2.body.nextCursor}`);
    assert.deepEqual([p2.body.notifications[0]!.title, p3.body.notifications.length, p3.body.nextCursor], ['n14', 5, null]);
    assert.equal(new Set([...p1.body.notifications, ...p2.body.notifications, ...p3.body.notifications].map((n) => n.id)).size, 25);
    assert.equal((await notes(u.token, '?cursor=@@')).status, 400);
    const read = (token: string, body: unknown) => readRoute(apiRequest('POST', '/api/me/notifications/read', { token, body }), none);
    const ids = p1.body.notifications.slice(0, 3).map((n) => n.id);
    assert.deepEqual((await j<{ updated: number; unreadCount: number }>(await read(u.token, { ids }))).body, { updated: 3, unreadCount: 22 });
    assert.deepEqual((await j<{ updated: number }>(await read(u.token, { ids }))).body.updated, 0, 'idempotent');
    assert.deepEqual((await j<{ updated: number }>(await read(other.token, { ids }))).body.updated, 0, "cannot mark someone else's notifications");
    const unread = await notes(u.token, '?unread=1&limit=100');
    assert.equal(unread.body.notifications.length, 22);
    assert.ok(!(await notes(u.token)).body.notifications.slice(0, 3).some((n) => n.unread));
    assert.deepEqual((await j<{ updated: number; unreadCount: number }>(await read(u.token, { all: true }))).body, { updated: 22, unreadCount: 0 });
    assert.equal((await notes(other.token)).body.unreadCount, 1);
    assert.equal((await read(u.token, {})).status, 400);
    assert.equal((await readRoute(apiRequest('POST', '/api/me/notifications/read', { body: { all: true } }), none)).status, 401);
  });
});

describe('home banners', () => {
  type B = { id: string; title: string; altText: string; linkUrl: string | null; openInNewTab: boolean; external: boolean; startsAt: string | null; endsAt: string | null; startDate: string | null; endDate: string | null; enabled: boolean; sortOrder: number; desktopImageUrl: string; mobileImageUrl: string | null };
  const create = (token: string, body: unknown) => adminBannerCreate(apiRequest('POST', '/api/admin/banners', { token, body }), none);

  it('admin CRUD (audited) with link validation, new-tab defaults, Asia/Taipei dates; members are forbidden', async () => {
    const o = await ops();
    const member = await makeUser();
    const img = '/media/banners/test.jpg';
    for (const linkUrl of ['javascript:alert(1)', '//evil.example', 'http://example.com', 'https://', '/a b', 'ftp://x.example', 'https://user:pw@x.example/']) {
      assert.equal((await create(o.token, { title: 'x', linkUrl, desktopImageUrl: img })).status, 400, linkUrl);
    }
    assert.equal((await create(o.token, { title: 'x', linkUrl: '/lobby' })).status, 400, 'desktop image required');
    assert.equal((await create(o.token, { title: 'x', desktopImageUrl: 'javascript:x' })).status, 400);
    assert.equal((await create(o.token, { title: 'x', desktopImageUrl: img, startsAt: '2026-12-01', endsAt: '2026-11-30' })).status, 400);
    assert.equal((await create(member.token, { title: 'x', desktopImageUrl: img })).status, 403);
    const ext = await j<B>(await create(o.token, { title: '外部', linkUrl: 'https://www.instagram.com/chiaki_gk.studies/', desktopImageUrl: 'https://cdn.example.com/b.jpg', sortOrder: 5 }));
    assert.equal(ext.status, 201);
    assert.deepEqual([ext.body.openInNewTab, ext.body.external, ext.body.altText], [true, true, '外部']);
    const int = await j<B>(await create(o.token, { title: '站內', linkUrl: '/lobby', desktopImageUrl: img, mobileImageUrl: '/media/banners/m.jpg', startsAt: '2026-10-23', endsAt: '2026-12-31', sortOrder: 1 }));
    assert.deepEqual([int.body.openInNewTab, int.body.external, int.body.mobileImageUrl], [false, false, '/media/banners/m.jpg']);
    assert.deepEqual([int.body.startsAt, int.body.endsAt, int.body.startDate, int.body.endDate], ['2026-10-22T16:00:00.000Z', '2026-12-31T16:00:00.000Z', '2026-10-23', '2026-12-31']);
    const forced = await j<B>(await create(o.token, { title: '外部同頁', linkUrl: 'https://x.example/', openInNewTab: false, desktopImageUrl: img }));
    assert.equal(forced.body.openInNewTab, false);
    // 讀、改、刪（稽核 before/after）
    assert.equal((await adminBannerGet(apiRequest('GET', `/api/admin/banners/${int.body.id}`, { token: o.token }), ctx({ id: int.body.id }))).status, 200);
    const patch = (id: string, body: unknown, token = o.token) => adminBannerPatch(apiRequest('PATCH', `/api/admin/banners/${id}`, { token, body }), ctx({ id }));
    const p = await j<B>(await patch(int.body.id, { linkUrl: 'https://shop.example/x', endsAt: '2027-01-15', enabled: false }));
    assert.deepEqual([p.status, p.body.openInNewTab, p.body.endDate, p.body.enabled], [200, true, '2027-01-15', false], 'link → external flips the default');
    assert.equal((await patch(int.body.id, { linkUrl: '//evil' })).status, 400);
    assert.equal((await patch(int.body.id, { desktopImageUrl: null })).status, 400, 'desktop image cannot be removed');
    assert.equal((await patch(int.body.id, { title: 'y' }, member.token)).status, 403);
    const [a] = await db()<{ actorId: string; payloadJson: string }[]>`SELECT actor_id, payload_json FROM audit_log WHERE action = 'BANNER_UPDATED' AND entity_id = ${int.body.id} ORDER BY seq DESC LIMIT 1`;
    assert.equal(a!.actorId, o.id);
    assert.match(a!.payloadJson, /"before":\{[^}]*"linkUrl":"\/lobby"/);
    const list = await j<{ banners: B[] }>(await adminBannersRoute(apiRequest('GET', '/api/admin/banners', { token: o.token }), none));
    assert.ok(list.body.banners.some((b) => b.id === int.body.id && !b.enabled), 'admin list includes disabled banners');
    const del = await adminBannerDelete(apiRequest('DELETE', `/api/admin/banners/${forced.body.id}`, { token: o.token }), ctx({ id: forced.body.id }));
    assert.equal(del.status, 200);
    assert.equal((await adminBannerDelete(apiRequest('DELETE', `/api/admin/banners/${forced.body.id}`, { token: o.token }), ctx({ id: forced.body.id }))).status, 404);
    assert.equal((await db()`SELECT 1 FROM audit_log WHERE action IN ('BANNER_CREATED', 'BANNER_DELETED') AND entity_id = ${forced.body.id}`).length, 2);
    // 公開：只回傳啟用且在期間內者，依排序
    const pub = await j<{ banners: B[] }>(await bannersRoute(apiRequest('GET', '/api/banners'), none));
    assert.ok(pub.body.banners.some((b) => b.id === ext.body.id));
    assert.ok(!pub.body.banners.some((b) => b.id === int.body.id), 'disabled banner hidden');
  });

  it('seed banners (idempotent): live 2026-10-23 → 2026-12-31 Asia/Taipei, sorted, with link / new-tab settings', async () => {
    await seedHomeBanners(db());
    assert.deepEqual(await seedHomeBanners(db()), HOME_BANNERS.map((b) => `${b.title}: exists`));
    const seeded = (rows: Awaited<ReturnType<typeof liveBanners>>) => rows.filter((b) => HOME_BANNERS.some((h) => h.title === b.title));
    const at = async (iso: string) => seeded(await liveBanners(db(), new Date(iso)));
    const live = await at('2026-10-25T04:00:00Z');
    assert.deepEqual(
      live.map((b) => [b.title, b.linkUrl, b.openInNewTab, b.sortOrder]),
      [
        ['CHIAKI 萬聖百鬼夜', '/lobby', false, 1],
        ['品牌好友強力推薦・追蹤按讚抽 1000 UC幣', 'https://www.instagram.com/chiaki_gk.studies/', true, 2],
      ],
    );
    assert.equal((await at('2026-10-22T15:59:59Z')).length, 0, 'before 10/23 00:00 Taipei');
    assert.equal((await at('2026-10-22T16:00:00Z')).length, 2, '10/23 00:00 Taipei');
    assert.equal((await at('2026-12-31T15:59:59Z')).length, 2, '12/31 23:59:59 Taipei');
    assert.equal((await at('2026-12-31T16:00:00Z')).length, 0, '2027-01-01 Taipei');
  });
});
