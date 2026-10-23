import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { canonicalJson, sha256Hex } from '../src/server/lib/canonical';
import { computeCommitment, generateLayout, verifyCommitment, canonicalLayout } from '../src/server/modules/pool/commitment';
import { createPoolDraft, createRuleVersionDraft } from '../src/server/modules/pool/admin';
import { approve, requestPoolPublish, requestRuleVersionPublish } from '../src/server/modules/admin/approvals';
import { GET as listRoute } from '../src/app/api/pools/route';
import { GET as poolRoute } from '../src/app/api/pools/[id]/route';
import { GET as setRoute } from '../src/app/api/pools/[id]/sets/[no]/route';
import { GET as revealRoute } from '../src/app/api/pools/[id]/sets/[no]/reveal/route';
import { GK_FIRST_POOL } from '../src/server/seed/reference';
import { apiRequest, ctx, expectAppError, layoutOf, makeUser, publishPool, setupTestDb, smallPool } from './helpers';

describe('commitment scheme (pure)', () => {
  it('canonical serialization is order-independent and verify detects any change', () => {
    const layout = generateLayout([
      { id: 'p-a', levelNo: 1, qtyPerSet: 1 },
      { id: 'p-h', levelNo: 8, qtyPerSet: 9 },
    ]);
    assert.equal(layout.length, 10);
    assert.deepEqual(layout.map((l) => l.ticketNo), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(layout.filter((l) => l.levelNo === 1).length, 1);
    const input = { poolId: 'pool', setNo: 1, rulesHash: 'r'.repeat(64), layout };
    const salt = 'ab'.repeat(32);
    const c = computeCommitment(input, salt);
    assert.equal(c, sha256Hex(`${canonicalLayout(input)}\n${salt}`));
    assert.ok(verifyCommitment({ ...input, layout: [...layout].reverse() }, salt, c), 'order of entries does not matter');
    assert.ok(!verifyCommitment(input, 'cd'.repeat(32), c), 'wrong salt');
    assert.ok(!verifyCommitment({ ...input, setNo: 2 }, salt, c), 'bound to set number');
    assert.ok(!verifyCommitment({ ...input, rulesHash: 's'.repeat(64) }, salt, c), 'bound to rule version');
    assert.match(canonicalLayout(input), /"scheme":"chiaki-commit-v2"/);
    assert.match(canonicalLayout(input), /\[\d+,(1|8),"p-[ah]"\]/, 'v2 entries are [ticketNo, levelNo, prizeId]');
    const swapped = layout.map((l) => ({ ...l, levelNo: l.levelNo === 1 ? 8 : 1 }));
    assert.ok(!verifyCommitment({ ...input, layout: swapped }, salt, c), 'bound to level numbers');
  });

  it('legacy chiaki-commit-v1 sets ([ticketNo, rank, prizeId]) still verify', () => {
    const layout = [{ ticketNo: 1, rank: 'A', prizeId: 'p-a' }, { ticketNo: 2, rank: 'B', prizeId: 'p-b' }];
    const input = { scheme: 'chiaki-commit-v1' as const, poolId: 'pool', setNo: 1, rulesHash: 'r'.repeat(64), layout };
    const salt = 'ef'.repeat(32);
    const expected = sha256Hex(`${canonicalJson({ scheme: 'chiaki-commit-v1', poolId: 'pool', setNo: 1, rulesHash: 'r'.repeat(64), tickets: [[1, 'A', 'p-a'], [2, 'B', 'p-b']] })}\n${salt}`);
    assert.equal(computeCommitment(input, salt), expected);
    assert.ok(verifyCommitment(input, salt, expected));
  });

  it('CSPRNG shuffle produces every level at every position over many runs (sanity)', () => {
    const seenA = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const l = generateLayout([{ id: 'a', levelNo: 1, qtyPerSet: 1 }, { id: 'h', levelNo: 8, qtyPerSet: 9 }]);
      seenA.add(l.find((x) => x.levelNo === 1)!.ticketNo);
    }
    assert.equal(seenA.size, 10);
  });

  it('canonicalJson sorts keys and rejects non-JSON values', () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
    assert.throws(() => canonicalJson({ a: NaN }));
  });
});

describe('pool publishing (DB)', () => {
  let env: Awaited<ReturnType<typeof setupTestDb>>;
  before(async () => {
    env = await setupTestDb();
  });
  after(async () => {
    await env.teardown();
  });

  it('spec sample pool (CUSTOM): 10 sets × 100 tickets, qty 1,1,1,6,6,15,20,50 on levels 1–8 (4–8 small), 300 coins/draw', async () => {
    const poolId = await publishPool(GK_FIRST_POOL);
    const res = await poolRoute(apiRequest('GET', `/api/pools/chiaki-gk-01`), ctx({ id: 'chiaki-gk-01' }));
    const p = (await res.json()) as { id: string; priceCoins: number; source: string; playType: string; merchantId: string; shippingNote: string; sets: { setNo: number; status: string; total: number; remaining: number; commitment: string; shippingFees: Record<string, number> }[]; prizes: { levelNo: number; levelName: string; isSmall: boolean; name: string; displayName: string; qtyPerSet: number; tag: string | null; bulky: boolean }[]; tags: string[]; drawPacks: (number | string)[] };
    assert.equal(p.id, poolId);
    assert.equal(p.priceCoins, 300);
    assert.equal(p.source, 'CUSTOM');
    assert.equal(p.playType, 'STANDARD');
    assert.equal(p.merchantId, 'chiaki');
    assert.deepEqual(p.prizes.map((x) => x.qtyPerSet), [1, 1, 1, 6, 6, 15, 20, 50]);
    assert.deepEqual(p.prizes.map((x) => x.levelNo), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(p.prizes.map((x) => x.isSmall), [false, false, false, true, true, true, true, true]);
    assert.ok(p.prizes.every((x) => x.displayName === `${x.levelName} ${x.name}`), 'displayName = level name + item name');
    assert.deepEqual(p.prizes.map((x) => x.bulky), [true, true, true, false, false, false, false, false], 'GK tag / level 1 → bulky by default');
    assert.deepEqual(p.tags, ['GK', '卡牌', '其他']);
    assert.deepEqual(p.drawPacks, [1, 5, 10]);
    assert.equal(p.shippingNote, '平台商品依平台公告時程');
    assert.deepEqual(p.sets[0]!.shippingFees, { HOME_DELIVERY: 150, CVS_711_C2C: 70, CVS_FAMI_C2C: 70 });
    assert.equal(p.sets.length, 10);
    assert.deepEqual(p.sets.map((s) => s.status), ['ON_SALE', ...Array(9).fill('QUEUED')]);
    assert.ok(p.sets.every((s) => s.total === 100 && s.remaining === 100 && /^[0-9a-f]{64}$/.test(s.commitment)));
    assert.equal(new Set(p.sets.map((s) => s.commitment)).size, 10, 'each set has its own layout + salt');
    for (const setNo of [1, 10]) {
      const l = await layoutOf(poolId, setNo);
      const count = (name: string) => l.filter((t) => t.name === name).length;
      assert.deepEqual(p.prizes.map((x) => count(x.name)), [1, 1, 1, 6, 6, 15, 20, 50]);
      assert.equal(l.filter((t) => t.isSmall).length, 97);
    }
    const listRes = await listRoute(apiRequest('GET', '/api/pools?playType=STANDARD'), undefined as never);
    const list = (await listRes.json()) as { pools: { id: string; shippingNote: string; currentSet: { setNo: number; remaining: number } }[] };
    assert.deepEqual(list.pools.find((x) => x.id === poolId)!.currentSet, { setNo: 1, remaining: 100, total: 100 });
    assert.equal(list.pools.find((x) => x.id === poolId)!.shippingNote, '平台商品依平台公告時程');
  });

  it('public endpoints never expose salt or unrevealed ticket→prize mapping', async () => {
    const poolId = await publishPool(smallPool());
    const [s] = await db()`SELECT commit_salt FROM pool_sets WHERE pool_id = ${poolId} AND set_no = 1`;
    const salt = s!.commitSalt as string;
    const prizeIds = (await db()`SELECT id FROM pool_prizes WHERE pool_id = ${poolId}`).map((r) => r.id as string);
    const bodies = [
      await (await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId }))).text(),
      await (await setRoute(apiRequest('GET', `/api/pools/${poolId}/sets/1`), ctx({ id: poolId, no: '1' }))).text(),
      await (await listRoute(apiRequest('GET', '/api/pools'), undefined as never)).text(),
    ];
    for (const b of bodies) {
      assert.ok(!b.includes(salt), 'salt leaked');
      assert.ok(!/salt/i.test(b), 'no salt field at all');
    }
    const board = JSON.parse(bodies[1]!) as { tickets: Record<string, unknown>[] };
    assert.ok(board.tickets.every((t) => !('levelNo' in t) && !('prizeId' in t) && !('displayName' in t)), 'no prize info for unrevealed tickets');
    // 規則內容中的 prizeId 是獎項定義（公開），但籤號 → 獎項的對應不得出現
    assert.ok(!bodies[1]!.includes(prizeIds[0]!));
    const rv = await revealRoute(apiRequest('GET', `/api/pools/${poolId}/sets/1/reveal`), ctx({ id: poolId, no: '1' }));
    assert.equal(rv.status, 409);
    assert.equal(((await rv.json()) as { error: { code: string } }).error.code, 'NOT_SOLD_OUT');
  });

  it('drafts are not public; publish requires a second person', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    const { poolId } = await createPoolDraft(ops.principal, smallPool());
    const r = await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId }));
    assert.equal(r.status, 404);
    const { approvalId } = await requestPoolPublish(ops.principal, poolId);
    await expectAppError(approve(ops.principal, approvalId), 'SELF_APPROVAL');
    const [p] = await db()`SELECT status FROM pools WHERE id = ${poolId}`;
    assert.equal(p!.status, 'PENDING_PUBLISH');
  });

  it('published rule versions are immutable (DB trigger); edits create a new version via two-person approval', async () => {
    const poolId = await publishPool(smallPool({ terms: 'v1 terms' }));
    const [v1] = await db()`SELECT id, rules_json, rules_hash FROM pool_rule_versions WHERE pool_id = ${poolId} AND version = 1`;
    assert.equal(sha256Hex(v1!.rulesJson as string), sha256Hex(canonicalJson(JSON.parse(v1!.rulesJson as string))), 'stored canonical');
    assert.equal(v1!.rulesHash, sha256Hex(v1!.rulesJson as string));
    await assert.rejects(db()`UPDATE pool_rule_versions SET rules_json = '{}' WHERE id = ${v1!.id}`, /immutable/);
    await assert.rejects(db()`DELETE FROM pool_rule_versions WHERE id = ${v1!.id}`, /immutable/);
    await assert.rejects(db()`UPDATE pool_sets SET commitment = 'x' WHERE pool_id = ${poolId}`, /immutable/);
    const [pa] = await db()`SELECT id FROM pool_prizes WHERE pool_id = ${poolId} AND name = 'A賞'`;
    await assert.rejects(
      db()`UPDATE tickets SET prize_id = ${pa!.id} WHERE set_id IN (SELECT id FROM pool_sets WHERE pool_id = ${poolId}) AND prize_id <> ${pa!.id}`,
      /layout is immutable/,
    );

    const ops = await makeUser({ roles: ['OPS'] });
    const ops2 = await makeUser({ roles: ['OPS'] });
    const { ruleVersionId, version } = await createRuleVersionDraft(ops.principal, poolId, { terms: 'v2 terms' });
    assert.equal(version, 2);
    const { approvalId } = await requestRuleVersionPublish(ops.principal, ruleVersionId);
    await approve(ops2.principal, approvalId);
    const res = await poolRoute(apiRequest('GET', `/api/pools/${poolId}`), ctx({ id: poolId }));
    const p = (await res.json()) as { rules: { version: number; content: { terms: string } }; sets: { ruleVersionId: string }[] };
    assert.equal(p.rules.version, 2);
    assert.equal(p.rules.content.terms, 'v2 terms');
    assert.ok(p.sets.every((s) => s.ruleVersionId === v1!.id), 'published sets stay bound to the rules they were committed under');
    const [still] = await db()`SELECT rules_json FROM pool_rule_versions WHERE id = ${v1!.id}`;
    assert.equal(still!.rulesJson, v1!.rulesJson);
  });

  it('SOLO pools need exactly one main prize', async () => {
    const ops = await makeUser({ roles: ['OPS'] });
    await assert.rejects(createPoolDraft(ops.principal, smallPool({ playType: 'SOLO' })), /exactly one main prize/);
    const { poolId } = await createPoolDraft(ops.principal, smallPool({ playType: 'SOLO', prizes: [{ rank: 'A', name: 'A', qtyPerSet: 1 }, { rank: 'H', name: '參加獎', qtyPerSet: 49 }] }));
    assert.ok(poolId);
  });

  it('members cannot create pools', async () => {
    const m = await makeUser();
    await expectAppError(createPoolDraft(m.principal, smallPool()), 'FORBIDDEN');
  });
});
