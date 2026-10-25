import { randomInt } from 'node:crypto';
import { mediaUrl } from '../../lib/media';
import { z } from 'zod';
import { AppError } from '../../errors';
import { config } from '../../config';
import type { Db } from '../../db';
import { rateLimitStore } from '../../security/rate-limit';
import { recordSecurityEvent } from '../../security/events';
import { resolvePublicPool } from '../pool/queries';
import { displayName, LAST_PRIZE_LABEL } from '../pool/levels';
import type { Tag } from '../catalog/tags';
import { generateServerSeed, pickFromCounts, ProbRng } from '../pool/prob';

/**
 * 免費試玩（GET/POST /api/play/:poolId?count=1|5|10）。
 *  - 不需登入；每 IP 每分鐘 FREE_PLAY_PER_MIN 次（預設 30）。
 *  - 以「目前開賣中那一套」的剩餘分布做不放回抽樣（CSPRNG），只回傳模擬結果，回應標記 demo: true。
 *  - 完全唯讀：不鎖籤、不改庫存、不寫帳本/倉庫/抽賞紀錄/稽核；不回傳籤號（避免與真實籤表產生任何關聯）。
 */
export const PlayCountSchema = z.coerce
  .number()
  .int()
  .refine((n) => n === 1 || n === 5 || n === 10, '試玩抽數須為 1、5 或 10')
  .default(1);

export async function enforceFreePlayLimit(ip: string): Promise<void> {
  const cap = config().FREE_PLAY_PER_MIN;
  const t = await rateLimitStore().take(`play:${ip}`, cap, cap / 60);
  if (!t.allowed) {
    await recordSecurityEvent('RATE_LIMIT_IP', { ip, key: `play:${ip}`, details: { scope: 'free_play' } });
    throw new AppError('RATE_LIMITED', '試玩太頻繁，請稍後再試', { retryAfterSec: t.retryAfterSec });
  }
}

interface Bucket {
  prizeId: string;
  levelNo: number | null;
  levelName: string | null;
  isSmall: boolean | null;
  name: string;
  tag: Tag | null;
  imageUrl: string | null;
  remaining: number;
}

export interface PlayResult {
  seq: number;
  kind: 'TICKET' | 'LAST';
  levelNo: number | null;
  levelName: string | null;
  isSmall: boolean;
  prizeName: string;
  displayName: string;
  tag: Tag | null;
  imageUrl: string | null;
}

export async function freePlay(d: Db, idOrSlug: string, rawCount: unknown) {
  const count = PlayCountSchema.parse(rawCount ?? undefined);
  const { id: poolId } = await resolvePublicPool(d, idOrSlug);
  const [set] = await d<{ id: string; setNo: number; playType: string }[]>`
    SELECT s.id, s.set_no, p.play_type FROM pool_sets s JOIN pools p ON p.id = s.pool_id
    WHERE s.pool_id = ${poolId} AND s.status = 'ON_SALE' AND p.status = 'PUBLISHED' AND NOT p.offline AND NOT s.offline AND s.deleted_at IS NULL
    ORDER BY s.set_no LIMIT 1`;
  if (!set) throw new AppError('SET_NOT_ON_SALE', '目前沒有開賣中的套，無法試玩');
  const buckets = await d<Bucket[]>`
    SELECT pr.id AS prize_id, pl.level_no, pl.name AS level_name, pl.is_small, pr.name, pr.tag, pr.image_url, count(*)::int AS remaining
    FROM tickets t JOIN pool_prizes pr ON pr.id = t.prize_id LEFT JOIN pool_levels pl ON pl.id = pr.level_id
    WHERE t.set_id = ${set.id} AND t.status = 'AVAILABLE'
    GROUP BY pr.id, pl.level_no, pl.name, pl.is_small, pr.name, pr.tag, pr.image_url, pr.sort_order
    ORDER BY pl.level_no, pr.sort_order, pr.id`;
  const remainingBefore = buckets.reduce((s, b) => s + b.remaining, 0);
  const n = Math.min(count, remainingBefore);
  const left = buckets.map((b) => b.remaining);
  let total = remainingBefore;
  const results: PlayResult[] = [];
  // 機率賞：與正式抽賞同一套規則（固定機率等級／其餘平均），以一次性的隨機種子模擬
  const probOdds =
    set.playType === 'PROB'
      ? new Map((await d<{ levelNo: number; odds: number | null }[]>`SELECT level_no, odds FROM pool_levels WHERE pool_id = ${poolId}`).map((o) => [o.levelNo, o.odds]))
      : null;
  const probRng = probOdds ? new ProbRng(generateServerSeed(), 'free-play', 0) : null;
  const probItems = buckets.map((b, k) => ({ k, levelNo: b.levelNo!, remaining: b.remaining }));
  for (let i = 0; i < n; i++) {
    let k = 0;
    if (probOdds) {
      k = pickFromCounts(probItems, probOdds, probRng!).k;
    } else {
      let r = randomInt(total);
      while (r >= left[k]!) r -= left[k++]!;
      left[k]!--;
    }
    total--;
    const b = buckets[k]!;
    results.push({
      seq: i + 1,
      kind: 'TICKET',
      levelNo: b.levelNo,
      levelName: b.levelName,
      isSmall: b.isSmall ?? false,
      prizeName: b.name,
      displayName: displayName(b.levelName, b.name),
      tag: b.tag,
      imageUrl: mediaUrl(b.imageUrl),
    });
  }
  // 模擬抽完整套 → 一併模擬最後賞
  if (n > 0 && total === 0) {
    const [lp] = await d<{ name: string; tag: Tag | null; imageUrl: string | null }[]>`
      SELECT name, tag, image_url FROM pool_prizes WHERE pool_id = ${poolId} AND kind = 'LAST'`;
    if (lp) {
      results.push({ seq: n + 1, kind: 'LAST', levelNo: null, levelName: LAST_PRIZE_LABEL, isSmall: false, prizeName: lp.name, displayName: displayName(LAST_PRIZE_LABEL, lp.name), tag: lp.tag, imageUrl: mediaUrl(lp.imageUrl) });
    }
  }
  return {
    demo: true as const,
    poolId,
    setNo: set.setNo,
    count: n,
    remaining: remainingBefore,
    results,
    note: '免費試玩：依目前這一套的剩餘分布模擬，不扣代幣、不入倉、不影響真實籤表，也不列入抽賞紀錄',
  };
}
