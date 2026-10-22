/** 通知外送：偏好（管道 × 事件）、收件位址、冪等鍵、交易一致性、派送重試/退避/失敗、管道轉接器請求、模板、API */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db, transaction } from '../src/server/db';
import { backoffSeconds, dispatchOutbox, notifyEvent } from '../src/server/modules/notifications/outbox';
import { buildLinePushRequest, buildMitakeRequest, buildWebPushPayload, setChannelAdapter, type Channel, type OutboundMessage } from '../src/server/modules/notifications/channels';
import { NOTIFICATION_TYPES } from '../src/server/modules/notifications/notifications';
import { renderTemplate } from '../src/server/modules/notifications/templates';
import { GET as prefsGet, PUT as prefsPut } from '../src/app/api/me/notification-preferences/route';
import { DELETE as pushDelete, POST as pushPost } from '../src/app/api/me/push-subscriptions/route';
import { POST as dispatchRoute } from '../src/app/api/admin/jobs/notifications-dispatch/route';
import { apiRequest, makeUser, setupTestDb } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb({ NOTIFY_MAX_ATTEMPTS: '3', NOTIFY_BACKOFF_BASE_SEC: '30' });
});
after(async () => {
  for (const c of ['SMS', 'LINE', 'WEB_PUSH', 'EMAIL'] as Channel[]) setChannelAdapter(c, null);
  await env.teardown();
});

const none = undefined as never;
const outboxOf = async (userId: string) =>
  db()<{ channel: Channel; status: string; attempts: number; destination: string | null; idempotencyKey: string; nextAttemptAt: Date; lastError: string | null }[]>`
    SELECT channel, status, attempts, destination, idempotency_key, next_attempt_at, last_error FROM notification_outbox WHERE user_id = ${userId} ORDER BY channel`;
const shipped = (userId: string, n = 1) =>
  transaction((tx) =>
    notifyEvent(tx, { userId, event: 'SHIPMENT_SHIPPED', data: { shipmentId: `s${n}`, carrierLabel: '黑貓宅急便', trackingNo: `T${n}`, trackingUrl: 'https://x/y' }, dedupeOn: { shipment: n } }),
  );

describe('outbox enqueue', () => {
  it('channels follow defaults, preferences and available destinations; one row per channel; idempotent; rolled back with the business tx', async () => {
    const u = await makeUser(); // 有手機、沒有 LINE/Email/推播訂閱
    const r1 = await shipped(u.id);
    assert.deepEqual([r1.inApp, r1.queued], [true, ['SMS']]);
    assert.deepEqual((await outboxOf(u.id)).map((o) => [o.channel, o.status]), [['IN_APP', 'SENT'], ['SMS', 'PENDING']]);
    const r2 = await shipped(u.id);
    assert.deepEqual([r2.inApp, r2.queued], [false, []], 'same event → no duplicates');
    assert.equal((await outboxOf(u.id)).length, 2);
    // 新增 LINE、Email、推播訂閱 → 新事件走全部管道
    await db()`UPDATE users SET line_user_id = ${`U${u.id.replace(/-/g, '')}`}, email = 'a@example.com' WHERE id = ${u.id}`;
    const push = await pushPost(apiRequest('POST', '/api/me/push-subscriptions', { token: u.token, body: { endpoint: `https://fcm.googleapis.com/fcm/send/${u.id}`, keys: { p256dh: 'BOr4nd0mP256dhKeyxxxxxxxx', auth: 'authsecret123' } } }), none);
    assert.equal(push.status, 201);
    assert.deepEqual((await shipped(u.id, 2)).queued.sort(), ['EMAIL', 'LINE', 'SMS', 'WEB_PUSH']);
    // 偏好：關閉全部簡訊、關閉此事件的 Email
    const put = await prefsPut(apiRequest('PUT', '/api/me/notification-preferences', { token: u.token, body: { preferences: [{ channel: 'SMS', eventType: '*', enabled: false }, { channel: 'EMAIL', eventType: 'SHIPMENT_SHIPPED', enabled: false }] } }), none);
    assert.equal(put.status, 200);
    assert.deepEqual((await shipped(u.id, 3)).queued.sort(), ['LINE', 'WEB_PUSH']);
    const prefs = (await (await prefsGet(apiRequest('GET', '/api/me/notification-preferences', { token: u.token }), none)).json()) as { events: { eventType: string; channels: Record<Channel, boolean> }[]; channels: { channel: Channel; available: boolean }[] };
    const ev = prefs.events.find((e) => e.eventType === 'SHIPMENT_SHIPPED')!;
    assert.deepEqual(ev.channels, { IN_APP: true, SMS: false, LINE: true, WEB_PUSH: true, EMAIL: false });
    assert.equal(prefs.events.find((e) => e.eventType === 'DRAW_RESULT')!.channels.IN_APP, false, 'draw results default to push only');
    assert.ok(prefs.channels.every((c) => c.available));
    // 取消推播訂閱
    assert.equal(((await (await pushDelete(apiRequest('DELETE', '/api/me/push-subscriptions', { token: u.token, body: { endpoint: `https://fcm.googleapis.com/fcm/send/${u.id}` } }), none)).json()) as { revoked: number }).revoked, 1);
    assert.deepEqual((await shipped(u.id, 4)).queued, ['LINE']);
    // 業務交易 rollback → 不留通知
    await assert.rejects(transaction(async (tx) => {
      await notifyEvent(tx, { userId: u.id, event: 'TICKET_REPLY', data: { ticketNo: 1, subject: 'x' }, dedupeOn: { t: 'rollback' } });
      throw new Error('business failure');
    }), /business failure/);
    assert.equal((await db()`SELECT 1 FROM notification_outbox WHERE user_id = ${u.id} AND event_type = 'TICKET_REPLY'`).length, 0);
  });
});

describe('dispatcher', () => {
  it('retries with exponential backoff, marks FAILED after NOTIFY_MAX_ATTEMPTS, SENT on success; concurrent dispatchers send each row once', async () => {
    const u = await makeUser();
    await db()`UPDATE users SET line_user_id = 'Uline000000000000000000000000000001' WHERE id = ${u.id}`;
    await shipped(u.id, 10);
    const smsCalls = new Map<string, number>();
    const lineCalls: OutboundMessage[] = [];
    // dispatchOutbox 為全域派送（也會處理本檔其他會員的列）；以本會員的訊息判斷
    setChannelAdapter('SMS', {
      channel: 'SMS',
      send: async (m) => {
        if (m.userId !== u.id) return { providerRef: 'other' };
        const c = (smsCalls.get(m.id) ?? 0) + 1;
        smsCalls.set(m.id, c);
        if (c < 3) throw new Error(`provider 503 (${m.destination})`);
        return { providerRef: 'mitake-msgid-1' };
      },
    });
    setChannelAdapter('LINE', { channel: 'LINE', send: async (m) => (m.userId === u.id && lineCalls.push(m), Promise.reject(new Error('LINE 429'))) });
    try {
      const t0 = new Date();
      await dispatchOutbox({ now: t0 });
      let rows = await outboxOf(u.id);
      const sms = () => rows.find((r) => r.channel === 'SMS')!;
      const line = () => rows.find((r) => r.channel === 'LINE')!;
      assert.deepEqual([sms().status, sms().attempts], ['PENDING', 1]);
      assert.equal(sms().nextAttemptAt.getTime(), t0.getTime() + 30_000);
      assert.match(sms().lastError!, /503/);
      await dispatchOutbox({ now: new Date(t0.getTime() + 10_000) }); // 尚未到期
      rows = await outboxOf(u.id);
      assert.equal(sms().attempts, 1);
      const t1 = new Date(t0.getTime() + 31_000);
      await dispatchOutbox({ now: t1 });
      rows = await outboxOf(u.id);
      assert.equal(sms().nextAttemptAt.getTime(), t1.getTime() + 60_000, 'backoff doubles');
      await dispatchOutbox({ now: new Date(t1.getTime() + 61_000) });
      rows = await outboxOf(u.id);
      assert.deepEqual([sms().status, sms().attempts], ['SENT', 3]);
      assert.deepEqual([line().status, line().attempts], ['FAILED', 3], 'gives up after NOTIFY_MAX_ATTEMPTS');
      assert.equal(lineCalls.length, 3);
      assert.equal(lineCalls[0]!.destination, 'Uline000000000000000000000000000001');
      assert.deepEqual([backoffSeconds(1), backoffSeconds(2), backoffSeconds(3), backoffSeconds(30)], [30, 60, 120, 6 * 3600]);

      // 並發派送：每列只送一次
      const v = await makeUser();
      for (let i = 0; i < 5; i++) await shipped(v.id, 100 + i);
      const sent: string[] = [];
      setChannelAdapter('SMS', { channel: 'SMS', send: async (m) => (sent.push(m.id), await new Promise((r) => setTimeout(r, 5)), { providerRef: 'ok' }) });
      await Promise.all([dispatchOutbox(), dispatchOutbox(), dispatchOutbox()]);
      const mine = (await outboxOf(v.id)).filter((r) => r.channel === 'SMS');
      assert.equal(mine.length, 5);
      assert.ok(mine.every((r) => r.status === 'SENT'));
      assert.equal(new Set(sent).size, sent.length, 'no row sent twice');
    } finally {
      setChannelAdapter('SMS', null);
      setChannelAdapter('LINE', null);
    }
  });

  it('default external adapters are stubs: NOT_IMPLEMENTED unless NOTIFY_STUB_SEND; admin job route requires jobs.run', async () => {
    const u = await makeUser();
    await shipped(u.id, 200);
    await dispatchOutbox();
    const [sms] = (await outboxOf(u.id)).filter((r) => r.channel === 'SMS');
    assert.match(sms!.lastError!, /SMS provider not configured/);
    const ops = await makeUser({ roles: ['OPS'] });
    const m = await makeUser();
    assert.equal((await dispatchRoute(apiRequest('POST', '/api/admin/jobs/notifications-dispatch', { token: m.token }), none)).status, 403);
    assert.equal((await dispatchRoute(apiRequest('POST', '/api/admin/jobs/notifications-dispatch', { token: ops.token }), none)).status, 200);
  });
});

describe('channel request builders and templates', () => {
  const msg: OutboundMessage = {
    id: '6f1c2c1e-1111-4222-8333-444455556666',
    userId: 'u',
    merchantId: 'chiaki',
    eventType: 'SHIPMENT_SHIPPED',
    channel: 'SMS',
    destination: '0912345678',
    title: '您的包裹已出貨',
    body: '包裹已由黑貓宅急便寄出，追蹤編號 T1。',
    payload: { url: '/me/shipments/1' },
    idempotencyKey: 'SHIPMENT_SHIPPED:abc:SMS',
  };
  it('Mitake (三竹) SmSend form request, LINE push request, Web Push payload', () => {
    const m = buildMitakeRequest(msg);
    assert.equal(m.method, 'POST');
    assert.match(m.url, /^https:\/\/smsapi\.mitake\.com\.tw\/api\/mtk\/SmSend\?CharsetURL=UTF8$/);
    const p = new URLSearchParams(m.body);
    assert.deepEqual([p.get('dstaddr'), p.get('smbody'), p.get('clientid')], ['0912345678', msg.body, 'SHIPMENT_SHIPPED:abc:SMS']);
    const l = buildLinePushRequest({ ...msg, channel: 'LINE', destination: 'Uabc' });
    assert.equal(l.url, 'https://api.line.me/v2/bot/message/push');
    assert.equal(l.headers['x-line-retry-key'], msg.id);
    assert.deepEqual(JSON.parse(l.body), { to: 'Uabc', messages: [{ type: 'text', text: `${msg.title}\n${msg.body}` }] });
    assert.deepEqual(JSON.parse(buildWebPushPayload(msg)), { title: msg.title, body: msg.body, url: '/me/shipments/1', tag: 'SHIPMENT_SHIPPED' });
  });

  it('every event type has a template (title, body, SMS text ≤ 70 chars, deep link)', () => {
    const data = { poolTitle: 'CHIAKI 一番賞', setNo: 1, count: 3, summary: '原創雕像 等 3 件', drawId: 'd', warnDays: 7, day: '2026-11-01', totalCoins: 550, carrierLabel: '黑貓宅急便', trackingNo: '900011112222', shipmentId: 's', kindLabel: '運費退款', amountLabel: 'NT$35', statusLabel: '已撥款', coins: 1000, ticketNo: 12, subject: '出貨問題', ticketId: 't' };
    for (const t of NOTIFICATION_TYPES) {
      const r = renderTemplate(t, data);
      assert.ok(r.title && r.body && r.url.startsWith('/'), t);
      assert.ok([...r.sms].length <= 70, `${t} sms too long: ${r.sms}`);
    }
    assert.match(renderTemplate('STORAGE_AUTO_CONVERTED', data).body, /不可退款・無法轉換，如有疑問請聯絡官方小編/);
    assert.match(renderTemplate('SHIPMENT_SHIPPED', data).body, /900011112222/);
  });
});
