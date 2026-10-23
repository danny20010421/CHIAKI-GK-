/** 會員資料（暱稱、姓名、Email、頭像重新封裝、生日鎖定）、換手機（OTP 送新號碼）、常用收件資訊與出貨引用 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { executeDraw } from '../src/server/modules/draw/draw';
import { listWarehouse } from '../src/server/modules/warehouse/warehouse';
import { rateLimitStore } from '../src/server/security/rate-limit';
import { GET as profileGet, PATCH as profilePatch } from '../src/app/api/me/profile/route';
import { POST as phoneRequest } from '../src/app/api/me/phone/request/route';
import { POST as phoneConfirm } from '../src/app/api/me/phone/confirm/route';
import { GET as addrList, POST as addrCreate } from '../src/app/api/me/addresses/route';
import { DELETE as addrDelete, PATCH as addrPatch } from '../src/app/api/me/addresses/[id]/route';
import { POST as shipRoute } from '../src/app/api/me/shipments/route';
import { GET as myEvents } from '../src/app/api/me/shipments/[id]/events/route';
import { GET as assetRaw } from '../src/app/api/assets/[id]/route';
import { apiRequest, ctx, makeUser, publishPool, setupTestDb, smallPool, testJpeg, testPng, testWebp, type TestUser } from './helpers';

let env: Awaited<ReturnType<typeof setupTestDb>>;
before(async () => {
  env = await setupTestDb();
});
after(async () => {
  await env.teardown();
});
const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
type Err = { error: { code: string; message: string; issues?: { message: string }[] } };
type Profile = { phone: string; nickname: string | null; realName: string | null; email: string | null; birthDate: string | null; birthDateLocked: boolean; avatarUrl: string | null; pendingPhoneChange: { phone: string } | null };
const patch = (u: TestUser, b: unknown) => profilePatch(apiRequest('PATCH', '/api/me/profile', { token: u.token, body: b }), none);
const b64 = (b: Buffer) => b.toString('base64');

describe('member profile', () => {
  it('nickname 2–16 chars, real name, email; birthday locked once age-verified; audit records field names only', async () => {
    const u = await makeUser({ ageVerified: false });
    assert.equal((await patch(u, { nickname: '王' })).status, 400);
    assert.equal((await patch(u, { nickname: '一二三四五六七八九十一二三四五六七' })).status, 400);
    assert.equal((await patch(u, { email: 'not-an-email' })).status, 400);
    const ok = await j<Profile>(await patch(u, { nickname: '卡西法😺', realName: '王小明', email: 'Ming@Example.com', birthDate: '1995-06-01' }));
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.nickname, ok.body.realName, ok.body.email, ok.body.birthDate, ok.body.birthDateLocked], ['卡西法😺', '王小明', 'ming@example.com', '1995-06-01', false]);
    assert.equal((await patch(u, { birthDate: '1996-01-01' })).status, 200, 'still editable before age verification');
    const v = await makeUser(); // 已完成年齡驗證（1990-01-01）
    const locked = await j<Err>(await patch(v, { birthDate: '2000-01-01' }));
    assert.deepEqual([locked.status, locked.body.error.code], [403, 'FORBIDDEN']);
    assert.match(locked.body.error.message, /生日不可修改/);
    assert.equal((await patch(v, { birthDate: '1990-01-01', nickname: '同一天' })).status, 200, 'same birthday is not a change');
    const got = await j<Profile>(await profileGet(apiRequest('GET', '/api/me/profile', { token: v.token }), none));
    assert.equal(got.body.birthDateLocked, true);
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'PROFILE_UPDATED' AND entity_id = ${u.id} ORDER BY seq LIMIT 1`;
    assert.match(a!.payloadJson as string, /"fields":\["nickname","realName","email","birthDate"\]/);
    assert.ok(!(a!.payloadJson as string).includes('王小明'), 'personal data is not written into the audit chain');
  });

  it('avatar: validated by the asset validator (400×400 square), re-encoded without EXIF/GPS or trailing data', async () => {
    const u = await makeUser();
    const wrong = await j<Err & { error: { details: { report: { checks: { check: string; ok: boolean; message: string }[] } } } }>(
      await patch(u, { avatar: { dataBase64: b64(testJpeg(401, 400)), copyrightConfirmed: true } }),
    );
    assert.deepEqual([wrong.status, wrong.body.error.code], [422, 'ASSET_REJECTED']);
    assert.ok(wrong.body.error.details.report.checks.some((c) => !c.ok && /400×400/.test(c.message)));
    assert.equal((await patch(u, { avatar: { dataBase64: b64(testJpeg(400, 400)) } })).status, 400, 'copyright confirmation required');
    const r = await j<Profile>(await patch(u, { avatar: { dataBase64: b64(testJpeg(400, 400, { trailing: 'GPS hidden payload' })), copyrightConfirmed: true } }));
    assert.equal(r.status, 200);
    const id = r.body.avatarUrl!.split('/').pop()!;
    const raw = Buffer.from(await (await assetRaw(apiRequest('GET', r.body.avatarUrl!), ctx({ id }))).arrayBuffer());
    assert.deepEqual([raw[0], raw[1], raw.at(-2), raw.at(-1)], [0xff, 0xd8, 0xff, 0xd9], 'still a complete JPEG');
    assert.ok(!raw.includes('GPS') && !raw.includes('Exif') && !raw.includes('camera owner'), 'EXIF / comments / trailing data removed');
    for (const img of [testPng(400, 400), testWebp(400, 400)]) {
      const p = await j<Profile>(await patch(u, { avatar: { dataBase64: b64(img), copyrightConfirmed: true } }));
      assert.equal(p.status, 200);
      const pid = p.body.avatarUrl!.split('/').pop()!;
      const bytes = Buffer.from(await (await assetRaw(apiRequest('GET', p.body.avatarUrl!), ctx({ id: pid }))).arrayBuffer());
      assert.ok(!bytes.includes('GPS'), 'PNG tEXt / WebP EXIF removed');
      assert.ok(bytes.length < img.length);
    }
    const [row] = await db()`SELECT type, uploaded_by FROM assets WHERE id = ${id}`;
    assert.deepEqual(row, { type: 'avatar', uploadedBy: u.id });
    assert.equal((await j<Profile>(await patch(u, { avatar: null }))).body.avatarUrl, null);
  });
});

describe('phone change (OTP to the NEW number)', () => {
  it('request → confirm with the code sent to the new number; taken numbers rejected; wrong code fails', async () => {
    const u = await makeUser();
    const other = await makeUser();
    const [o] = await db()`SELECT phone FROM users WHERE id = ${other.id}`;
    const req = (phone: string, t = u) => phoneRequest(apiRequest('POST', '/api/me/phone/request', { token: t.token, body: { phone } }), none);
    assert.equal((await req('12345')).status, 400);
    assert.equal((await req(o!.phone as string)).status, 409);
    const newPhone = `0955${String(process.pid % 1000).padStart(3, '0')}${String(Date.now() % 1000).padStart(3, '0')}`;
    const sent = await j<{ sentTo: string }>(await req(newPhone));
    assert.equal(sent.status, 201);
    assert.match(sent.body.sentTo, /^0955\*\*\*\d{3}$/);
    assert.ok((await j<Profile>(await profileGet(apiRequest('GET', '/api/me/profile', { token: u.token }), none))).body.pendingPhoneChange);
    const confirm = (phone: string, code: string) => phoneConfirm(apiRequest('POST', '/api/me/phone/confirm', { token: u.token, body: { phone, code } }), none);
    assert.equal((await confirm(newPhone, '999999')).status, 401);
    assert.equal((await confirm('0911111111', '000000')).status, 409, 'must match the requested number');
    const ok = await j<{ phone: string }>(await confirm(newPhone, '000000'));
    assert.deepEqual([ok.status, ok.body.phone], [200, newPhone]);
    const [row] = await db()`SELECT phone, phone_verified_at IS NOT NULL AS verified FROM users WHERE id = ${u.id}`;
    assert.deepEqual(row, { phone: newPhone, verified: true });
    assert.equal((await confirm(newPhone, '000000')).status, 409, 'request consumed');
    const [a] = await db()`SELECT payload_json FROM audit_log WHERE action = 'PHONE_CHANGED' AND entity_id = ${u.id}`;
    assert.ok(!(a!.payloadJson as string).includes(newPhone), 'masked in audit');
  });

  it('rate-limited per member', async () => {
    rateLimitStore().reset?.();
    const u = await makeUser();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await phoneRequest(apiRequest('POST', '/api/me/phone/request', { token: u.token, body: { phone: `09770${String(process.pid % 100).padStart(2, '0')}${String(i).padStart(3, '0')}` } }), none)).status);
    }
    assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
  });
});

describe('saved recipients', () => {
  type Addr = { id: string; method: string; isDefault: boolean; address: string | null; cvsStoreId: string | null };
  it('CRUD with exactly one default; validation; owner-only; shipments can reference an address id', async () => {
    const u = await makeUser({ coins: 5000 });
    const create = (b: unknown, t = u) => addrCreate(apiRequest('POST', '/api/me/addresses', { token: t.token, body: b }), none);
    const home = await j<Addr>(await create({ method: 'home', recipientName: '王小明', recipientPhone: '0912345678', address: '台中市西屯區測試路 100 號' }));
    assert.deepEqual([home.status, home.body.isDefault], [201, true], 'first one becomes default');
    assert.equal((await create({ method: 'c711', recipientName: '王小明', recipientPhone: '0912345678' })).status, 400, 'store id required');
    assert.equal((await create({ method: 'home', recipientName: '王', recipientPhone: '12345', address: '台中市西屯區' })).status, 400);
    const c711 = await j<Addr>(await create({ method: 'c711', recipientName: '王小明', recipientPhone: '0912345678', cvsStoreId: '123456', cvsStoreName: '測試門市', isDefault: true }));
    assert.equal(c711.body.isDefault, true);
    let list = (await j<{ addresses: Addr[] }>(await addrList(apiRequest('GET', '/api/me/addresses', { token: u.token }), none))).body.addresses;
    assert.deepEqual(list.map((a) => [a.method, a.isDefault]), [['c711', true], ['home', false]]);
    // 改為宅配 → 門市清除、需要地址
    assert.equal((await addrPatch(apiRequest('PATCH', `/api/me/addresses/${c711.body.id}`, { token: u.token, body: { method: 'home' } }), ctx({ id: c711.body.id }))).status, 400);
    const fam = await j<Addr>(await addrPatch(apiRequest('PATCH', `/api/me/addresses/${c711.body.id}`, { token: u.token, body: { method: 'fami', cvsStoreId: '009876' } }), ctx({ id: c711.body.id })));
    assert.deepEqual([fam.body.method, fam.body.cvsStoreId], ['fami', '009876']);
    const other = await makeUser();
    assert.equal((await addrPatch(apiRequest('PATCH', `/api/me/addresses/${home.body.id}`, { token: other.token, body: { recipientName: 'x' } }), ctx({ id: home.body.id }))).status, 404);
    // 刪除預設 → 最新的一筆成為預設
    const del = await j<{ newDefaultId: string }>(await addrDelete(apiRequest('DELETE', `/api/me/addresses/${c711.body.id}`, { token: u.token }), ctx({ id: c711.body.id })));
    assert.equal(del.body.newDefaultId, home.body.id);
    for (let i = 0; i < 9; i++) await create({ method: 'home', recipientName: `收件${i}`, recipientPhone: '0912345678', address: `台北市信義區測試路 ${i} 號` });
    assert.equal((await create({ method: 'home', recipientName: 'x', recipientPhone: '0912345678', address: '台北市信義區測試路 99 號' })).status, 400, 'max 10');
    list = (await j<{ addresses: Addr[] }>(await addrList(apiRequest('GET', '/api/me/addresses', { token: u.token }), none))).body.addresses;
    assert.equal(list.filter((a) => a.isDefault).length, 1);

    // 申請出貨直接引用收件資訊
    const poolId = await publishPool(smallPool({ setCount: 1, prizes: [{ rank: 'D', name: 'D賞', qtyPerSet: 10 }] }));
    await executeDraw(u.id, `mem-${process.pid}-1`, { poolId, setNo: 1, count: 1, shippingMethod: 'HOME_DELIVERY' });
    const items = await listWarehouse(db(), u.id, 'STORED');
    const s = await j<{ shipmentId: string }>(await shipRoute(apiRequest('POST', '/api/me/shipments', { token: u.token, body: { itemIds: items.map((i) => i.id), addressId: home.body.id } }), none));
    assert.equal(s.status, 201);
    const [row] = await db()`SELECT method, recipient_name, address, address_id FROM shipments WHERE id = ${s.body.shipmentId}`;
    assert.deepEqual(row, { method: 'HOME_DELIVERY', recipientName: '王小明', address: '台中市西屯區測試路 100 號', addressId: home.body.id });
    assert.equal((await shipRoute(apiRequest('POST', '/api/me/shipments', { token: other.token, body: { itemIds: [items[0]!.id], addressId: home.body.id } }), none)).status, 404, "cannot use someone else's address");
    const ev = await j<{ events: { status: string; kindLabel: string; actor: string }[] }>(await myEvents(apiRequest('GET', `/api/me/shipments/${s.body.shipmentId}/events`, { token: u.token }), ctx({ id: s.body.shipmentId })));
    assert.deepEqual(ev.body.events.map((e) => [e.status, e.kindLabel, e.actor]), [['REQUESTED', '申請出貨', '會員']]);
  });
});
