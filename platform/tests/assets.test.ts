/** 圖片素材：手寫檔頭解析（PNG/JPEG/WebP）、規格逐項檢查（繁中訊息）、不信任副檔名/MIME、儲存與連結、規格表 API */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { db } from '../src/server/db';
import { readImageHeader } from '../src/server/modules/assets/image-header';
import { ASSET_SPECS, ASSET_TYPES } from '../src/server/modules/assets/specs';
import { validateAsset } from '../src/server/modules/assets/assets';
import { GET as listRoute, POST as uploadRoute } from '../src/app/api/admin/assets/route';
import { DELETE as unlinkRoute, POST as linkRoute } from '../src/app/api/admin/assets/[id]/links/route';
import { GET as specsRoute } from '../src/app/api/assets/specs/route';
import { GET as rawRoute } from '../src/app/api/assets/[id]/route';
import { POST as rewardsRoute } from '../src/app/api/me/rewards/route';
import { apiRequest, ctx, customPool, makeUser, publishPool, setupTestDb, type TestUser } from './helpers';

// ───────────── 測試用的最小合法檔頭（解析器只讀檔頭；其餘以填充位元組湊足檔案大小） ─────────────
const be32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const be16 = (n: number) => Buffer.from([(n >>> 8) & 255, n & 255]);
const le16 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255]);
const le24 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255]);
const pad = (b: Buffer, size: number) => (b.length >= size ? b : Buffer.concat([b, Buffer.alloc(size - b.length, 0x5a)]));

function png(w: number, h: number, size = 2048): Buffer {
  const ihdr = Buffer.concat([be32(13), Buffer.from('IHDR'), be32(w), be32(h), Buffer.from([8, 6, 0, 0, 0]), be32(0)]);
  return pad(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]), size);
}
function jpeg(w: number, h: number, size = 2048, sof = 0xc0): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), be16(16), Buffer.from('JFIF\0'), Buffer.alloc(9)]);
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1]), be16(602), Buffer.alloc(600, 0x11)]); // 大型 APP1 在 SOF 之前
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb]), be16(67), Buffer.alloc(65, 1)]);
  const sofSeg = Buffer.concat([Buffer.from([0xff, sof]), be16(17), Buffer.from([8]), be16(h), be16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]);
  return Buffer.concat([pad(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, exif, dqt, sofSeg]), size - 2), Buffer.from([0xff, 0xd9])]);
}
function webp(kind: 'VP8X' | 'VP8 ' | 'VP8L', w: number, h: number, size = 2048): Buffer {
  let payload: Buffer;
  if (kind === 'VP8X') payload = Buffer.concat([Buffer.from([0x10, 0, 0, 0]), le24(w - 1), le24(h - 1)]);
  else if (kind === 'VP8 ') payload = Buffer.concat([Buffer.from([0x9d, 0x01, 0x2a].map((x, i) => [0x50, 0x09, 0x00][i]!)), Buffer.from([0x9d, 0x01, 0x2a]), le16(w), le16(h)]);
  else {
    const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
    payload = Buffer.concat([Buffer.from([0x2f]), Buffer.from([bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255])]);
  }
  const chunk = Buffer.concat([Buffer.from(kind), Buffer.from([payload.length, 0, 0, 0]), payload]);
  const body = pad(Buffer.concat([Buffer.from('WEBP'), chunk]), size - 8);
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([body.length & 255, (body.length >>> 8) & 255, (body.length >>> 16) & 255, 0]), body]);
}

let env: Awaited<ReturnType<typeof setupTestDb>>;
let ops: TestUser;
before(async () => {
  env = await setupTestDb();
  ops = await makeUser({ roles: ['OPS'] });
});
after(async () => {
  await env.teardown();
});

const none = undefined as never;
const j = async <T = Record<string, unknown>>(r: Response) => ({ status: r.status, body: (await r.json()) as T });
type Check = { check: string; ok: boolean; message: string };
type Rejected = { error: { code: string; details: { report: { ok: boolean; checks: Check[]; detected: { format: string; width: number; height: number } | null; warnings: string[] } } } };
const upload = (body: Record<string, unknown>, token = ops.token) => uploadRoute(apiRequest('POST', '/api/admin/assets', { token, body }), none);
const base = (type: string, file: Buffer, extra: Record<string, unknown> = {}) => ({ type, altText: '測試圖片', copyrightConfirmed: true, dataBase64: file.toString('base64'), ...extra });
const failed = (checks: Check[]) => checks.filter((c) => !c.ok).map((c) => c.check);

describe('hand-written image header parsing', () => {
  it('PNG IHDR, JPEG SOF0/SOF2 after APP segments, WebP VP8 / VP8L / VP8X; garbage and truncated input → null', () => {
    assert.deepEqual(readImageHeader(png(1600, 900)), { format: 'png', width: 1600, height: 900 });
    assert.deepEqual(readImageHeader(jpeg(2400, 900)), { format: 'jpeg', width: 2400, height: 900 });
    assert.deepEqual(readImageHeader(jpeg(1080, 2999, 4096, 0xc2)), { format: 'jpeg', width: 1080, height: 2999 }, 'progressive JPEG');
    assert.deepEqual(readImageHeader(webp('VP8X', 3000, 2040)), { format: 'webp', width: 3000, height: 2040 });
    assert.deepEqual(readImageHeader(webp('VP8 ', 1200, 1200)), { format: 'webp', width: 1200, height: 1200 });
    assert.deepEqual(readImageHeader(webp('VP8L', 801, 799)), { format: 'webp', width: 801, height: 799 });
    assert.equal(readImageHeader(Buffer.from('GIF89a........................')), null);
    assert.equal(readImageHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(readImageHeader(png(100, 100).subarray(0, 20)), null, 'truncated PNG');
    assert.equal(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 8])), null, 'JPEG without SOF');
    assert.equal(readImageHeader(Buffer.alloc(0)), null);
  });
});

describe('spec checks (pure)', () => {
  it('table has the 11 owner types with the given numbers', () => {
    assert.deepEqual([...ASSET_TYPES], ['cover', 'prize', 'banner', 'bannerM', 'event', 'eventBody', 'ticket', 'ip', 'product', 'partner', 'og', 'avatar', 'forum']);
    assert.deepEqual(ASSET_SPECS.ticket, { type: 'ticket', label: '籤紙圖', suggested: { width: 3000, height: 2040 }, min: { width: 1500, height: 1020 }, maxHeight: null, formats: ['png'], maxKB: 1500, ratioTolerance: 0.02 });
    assert.deepEqual([ASSET_SPECS.eventBody.min, ASSET_SPECS.eventBody.maxHeight, ASSET_SPECS.eventBody.ratioTolerance], [{ width: 1080, height: null }, 3000, null]);
    assert.deepEqual([ASSET_SPECS.og.min, ASSET_SPECS.og.formats, ASSET_SPECS.og.maxKB], [{ width: 1200, height: 630 }, ['jpeg', 'png'], 300]);
  });

  it('format / size / min dimensions / ratio ±2% / max height, with Traditional Chinese messages', () => {
    const ok = validateAsset('cover', jpeg(1600, 1600, 500 * 1024));
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.checks.map((c) => c.check), ['format', 'size', 'minDimensions', 'ratio']);
    assert.match(ok.checks[0]!.message, /格式 JPEG 符合/);
    // 比例：1.0% 誤差可、2.5% 不可
    assert.equal(validateAsset('cover', jpeg(1600, 1616)).ok, true);
    const ratio = validateAsset('cover', jpeg(1600, 1640));
    assert.deepEqual(failed(ratio.checks), ['ratio']);
    assert.match(ratio.checks.find((c) => c.check === 'ratio')!.message, /不符合 1:1.*超過 ±2%/);
    // 格式：封面不收 PNG
    const fmt = validateAsset('cover', png(1600, 1600));
    assert.deepEqual(failed(fmt.checks), ['format']);
    assert.match(fmt.checks[0]!.message, /「賞池封面」只接受 JPEG、WebP/);
    // 大小：600 KB 上限
    const big = validateAsset('cover', jpeg(1600, 1600, 600 * 1024 + 1));
    assert.deepEqual(failed(big.checks), ['size']);
    assert.match(big.checks[1]!.message, /超過上限 600 KB/);
    // 最小尺寸
    const small = validateAsset('banner', webp('VP8X', 1500, 500));
    assert.deepEqual(failed(small.checks), ['minDimensions']);
    assert.match(small.checks[2]!.message, /太小，需至少 1800×600 px（建議 2400×800 px）/);
    // 長圖：寬 ≥ 1080、高度不限但 ≤ 3000，不檢查比例
    const body = validateAsset('eventBody', png(1080, 2800, 900 * 1024));
    assert.equal(body.ok, true);
    assert.equal(body.checks.find((c) => c.check === 'ratio')!.message, '高度不限，不檢查比例');
    assert.deepEqual(failed(validateAsset('eventBody', jpeg(1080, 3200)).checks), ['maxHeight']);
    assert.deepEqual(failed(validateAsset('eventBody', jpeg(1000, 2000)).checks), ['minDimensions']);
    // OG 最小即建議 1200×630；籤紙只收 PNG
    assert.equal(validateAsset('og', jpeg(1200, 630)).ok, true);
    assert.deepEqual(failed(validateAsset('og', jpeg(1199, 630)).checks), ['minDimensions']);
    assert.deepEqual(failed(validateAsset('og', webp('VP8X', 1200, 630)).checks), ['format']);
    assert.equal(validateAsset('ticket', png(3000, 2040, 1400 * 1024)).ok, true);
    assert.deepEqual(failed(validateAsset('ticket', jpeg(3000, 2040)).checks), ['format']);
    // 無法辨識 → 格式失敗，且不再檢查尺寸
    const junk = validateAsset('prize', Buffer.from('not an image at all, just text pretending'));
    assert.deepEqual(junk.checks.map((c) => [c.check, c.ok]), [['format', false], ['size', true]]);
    // 解壓縮炸彈防護
    assert.deepEqual(failed(validateAsset('prize', png(9000, 9000)).checks), ['pixelLimit']);
  });
});

describe('POST /api/admin/assets', () => {
  it('rejects by real bytes, not extension/MIME; returns per-check Chinese results; requires alt text and copyright confirmation', async () => {
    // PNG 內容偽裝成 .jpg / image/jpeg 上傳到只收 JPEG/WebP 的封面
    const disguised = await j<Rejected>(await upload(base('cover', png(1600, 1600), { filename: 'cover.jpg', mimeType: 'image/jpeg' })));
    assert.equal(disguised.status, 422);
    assert.equal(disguised.body.error.code, 'ASSET_REJECTED');
    assert.equal(disguised.body.error.details.report.detected!.format, 'png');
    assert.deepEqual(failed(disguised.body.error.details.report.checks), ['format']);
    assert.ok(disguised.body.error.details.report.warnings.some((w) => /副檔名 \.jpg 與實際內容（PNG）不符/.test(w)));
    // 文字檔改名為 .png
    const fake = await j<Rejected>(await upload(base('prize', Buffer.from('<script>alert(1)</script>'.repeat(10)), { filename: 'x.png', mimeType: 'image/png' })));
    assert.equal(fake.status, 422);
    assert.match(fake.body.error.details.report.checks[0]!.message, /無法辨識的圖片格式/);
    assert.equal((await upload(base('prize', png(1200, 1200), { altText: '  ' }))).status, 400);
    assert.equal((await upload(base('prize', png(1200, 1200), { copyrightConfirmed: false }))).status, 400);
    assert.equal((await upload({ ...base('prize', png(1200, 1200)), copyrightConfirmed: undefined })).status, 400);
    const member = await makeUser();
    assert.equal((await upload(base('prize', png(1200, 1200)), member.token)).status, 403);
    assert.equal((await db()`SELECT count(*)::int AS n FROM assets`)[0]!.n, 0, 'nothing stored');
  });

  it('stores accepted assets (type, dims, sha256, alt, uploader, copyright) idempotently; dry run; serves the image; links to pools/prizes/IPs/banners/partners/products', async () => {
    const file = webp('VP8X', 1200, 1200, 300 * 1024);
    const dry = await j<{ stored: boolean; report: { ok: boolean } }>(await upload(base('prize', file, { dryRun: true })));
    assert.deepEqual([dry.status, dry.body.stored, dry.body.report.ok], [200, false, true]);
    const poolId = await publishPool(customPool());
    const [prize] = await db()<{ id: string }[]>`SELECT id FROM pool_prizes WHERE pool_id = ${poolId} AND kind = 'TICKET' ORDER BY sort_order LIMIT 1`;
    const res = await upload(base('prize', file, { altText: '原創雕像 正面', filename: 'statue.webp', links: [{ targetType: 'PRIZE', targetId: prize!.id }] }));
    assert.equal(res.status, 201);
    const up = (await res.json()) as { asset: { id: string; type: string; format: string; width: number; height: number; bytes: number; sha256: string; altText: string; copyrightConfirmed: boolean; uploadedBy: string }; links: unknown[] };
    assert.deepEqual(
      [up.asset.type, up.asset.format, up.asset.width, up.asset.height, up.asset.bytes, up.asset.altText, up.asset.copyrightConfirmed, up.asset.uploadedBy],
      ['prize', 'webp', 1200, 1200, file.length, '原創雕像 正面', true, ops.id],
    );
    assert.equal(up.asset.sha256, createHash('sha256').update(file).digest('hex'));
    const again = await upload(base('prize', file));
    assert.equal(again.status, 200, 'same content → existing asset');
    assert.equal(((await again.json()) as { asset: { id: string } }).asset.id, up.asset.id);

    const raw = await rawRoute(apiRequest('GET', `/api/assets/${up.asset.id}`), ctx({ id: up.asset.id }));
    assert.equal(raw.headers.get('content-type'), 'image/webp');
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await raw.arrayBuffer()).equals(file));

    // 連結：類型相容性與目標存在檢查
    assert.equal((await upload(base('cover', jpeg(1600, 1600), { links: [{ targetType: 'BANNER', targetId: 'home-hero' }] }))).status, 400, 'a cover is not a banner image');
    const cover = await j<{ asset: { id: string } }>(await upload(base('cover', jpeg(1600, 1600), { links: [{ targetType: 'POOL', targetId: poolId }] })));
    assert.equal(cover.status, 201);
    const coverId = cover.body.asset.id;
    const banner = await j<{ links: { targetType: string; targetId: string; role: string }[] }>(await upload(base('banner', webp('VP8X', 2400, 800), { links: [{ targetType: 'BANNER', targetId: 'home-hero', role: 'hero' }] })));
    assert.deepEqual([banner.status, banner.body.links], [201, [{ targetType: 'BANNER', targetId: 'home-hero', role: 'hero' }]]);
    assert.equal((await linkRoute(apiRequest('POST', `/api/admin/assets/${coverId}/links`, { token: ops.token, body: { targetType: 'PARTNER', targetId: 'painter-rrrrryan2d' } }), ctx({ id: coverId }))).status, 400, 'cover cannot be a partner logo');
    assert.equal((await linkRoute(apiRequest('POST', `/api/admin/assets/${coverId}/links`, { token: ops.token, body: { targetType: 'POOL', targetId: 'no-such-pool' } }), ctx({ id: coverId }))).status, 404);
    const [ip] = await db()<{ id: string }[]>`INSERT INTO ips (slug, name) VALUES ('asset-ip', '素材 IP') RETURNING id`;
    assert.equal((await linkRoute(apiRequest('POST', `/api/admin/assets/${coverId}/links`, { token: ops.token, body: { targetType: 'IP', targetId: ip!.id } }), ctx({ id: coverId }))).status, 201);
    const logo = await j<{ asset: { id: string } }>(await upload(base('partner', png(400, 400), { links: [{ targetType: 'PARTNER', targetId: 'painter-best-do7788' }] })));
    assert.equal(logo.status, 201);
    const [prod] = await db()<{ id: string }[]>`INSERT INTO products (sku, name, source, price_coins, stock) VALUES ('ASSET-1', '展示盒', 'CUSTOM', 100, 1) RETURNING id`;
    assert.equal((await upload(base('product', jpeg(1200, 1200), { links: [{ targetType: 'PRODUCT', targetId: prod!.id }] }))).status, 201);

    const byPool = await j<{ assets: { id: string; links: { targetType: string }[]; url: string }[] }>(await listRoute(apiRequest('GET', `/api/admin/assets?targetType=POOL&targetId=${poolId}`, { token: ops.token }), none));
    assert.deepEqual(byPool.body.assets.map((a) => a.id), [coverId]);
    assert.deepEqual(byPool.body.assets[0]!.links.map((l) => l.targetType).sort(), ['IP', 'POOL']);
    assert.equal(byPool.body.assets[0]!.url, `/api/assets/${coverId}`);
    assert.equal((await unlinkRoute(apiRequest('DELETE', `/api/admin/assets/${coverId}/links`, { token: ops.token, body: { targetType: 'IP', targetId: ip!.id } }), ctx({ id: coverId }))).status, 200);
    assert.equal((await unlinkRoute(apiRequest('DELETE', `/api/admin/assets/${coverId}/links`, { token: ops.token, body: { targetType: 'IP', targetId: ip!.id } }), ctx({ id: coverId }))).status, 404);
    const audits = await db()`SELECT action FROM audit_log WHERE entity_type = 'asset' ORDER BY seq`;
    assert.deepEqual([...new Set(audits.map((a) => a.action))].sort(), ['ASSET_LINKED', 'ASSET_REUSED', 'ASSET_UNLINKED', 'ASSET_UPLOADED']);
    await assert.rejects(db()`INSERT INTO assets (type, format, width, height, bytes, sha256, alt_text, copyright_confirmed, uploaded_by, content)
                              VALUES ('prize', 'png', 1, 1, 1, ${'0'.repeat(64)}, 'x', false, ${ops.id}, '\\x00')`, /check constraint/);
  });

  it('upload body limit is raised only for this route (1500 KB ticket fits; others keep 64 KB)', async () => {
    const ticket = png(3000, 2040, 1500 * 1024);
    const r = await upload(base('ticket', ticket));
    assert.equal(r.status, 201);
    const tooBig = await upload(base('ticket', png(3000, 2040, 1700 * 1024)));
    assert.equal(tooBig.status, 413);
    const member = await makeUser();
    const other = await rewardsRoute(apiRequest('POST', '/api/me/rewards', { token: member.token, body: { taskCode: 'BIND_PHONE', evidence: 'x'.repeat(100_000) } }), none);
    assert.equal(other.status, 413);
  });
});

describe('GET /api/assets/specs', () => {
  it('public spec table for the front-end checker', async () => {
    const r = await j<{ note: string; specs: { type: string; label: string; formats: string[]; maxKB: number; heightFree: boolean; ratioTolerancePercent: number | null }[] }>(await specsRoute(apiRequest('GET', '/api/assets/specs'), none));
    assert.equal(r.status, 200);
    assert.equal(r.body.specs.length, 13);
    assert.match(r.body.note, /不採信副檔名或 MIME/);
    const eb = r.body.specs.find((x) => x.type === 'eventBody')!;
    assert.deepEqual([eb.heightFree, eb.ratioTolerancePercent, eb.formats, eb.maxKB], [true, null, ['JPEG', 'WebP', 'PNG'], 1000]);
    assert.deepEqual(r.body.specs.find((x) => x.type === 'banner')!.ratioTolerancePercent, 2);
  });
});
