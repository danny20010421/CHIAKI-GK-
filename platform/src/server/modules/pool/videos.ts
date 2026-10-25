import { z } from 'zod';
import { canonicalJson } from '../../lib/canonical';
import { mediaUrl } from '../../lib/media';
import type { Db, Tx } from '../../db';

/**
 * 抽賞演出影片（pool_videos）：每個賞池可設定多支，前台在 animation = VIDEO 時隨機挑一支播放。
 * behavior 為「依抽賞結果的演出方式」，由前台解讀（伺服器只驗證格式）：
 *   { kind: 'beam',  beamAt: 7.4 }                     光束約 7.4 秒出現，依最高獎項變色（白＝小獎、紫＝3～4 獎、彩＝大獎／2 獎）
 *   { kind: 'kills', stop: { low: 13.9, mid: 15.6 } }  小獎 13.9 秒、3～4 獎 15.6 秒停止；大獎／2 獎完整播放
 *   { kind: 'plain' }                                   完整播放，不依結果變化
 * 其他 kind 也可使用（附加欄位原樣保存，JSON ≤ 2000 字）。
 * url 存站內路徑（/media/video/...）或 https://；輸出時套用 MEDIA_BASE_URL（見 lib/media.ts）。
 */
export const MediaPathSchema = z
  .string()
  .max(2000)
  .regex(/^(https:\/\/[^/\s]+|\/[^/\s])\S*$/, '須為 https:// 網址或站內路徑（如 /media/video/gacha1.mp4）');

const seconds = z.number().min(0).max(600);

export const VideoBehaviorSchema = z
  .object({ kind: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'kind 須為英文小寫') })
  .passthrough()
  .superRefine((v, ctx) => {
    const r = v as Record<string, unknown>;
    if (v.kind === 'beam' && !seconds.safeParse(r.beamAt).success) ctx.addIssue({ code: 'custom', message: 'beam 需設定 beamAt（秒）', path: ['beamAt'] });
    if (v.kind === 'kills') {
      const s = z.object({ low: seconds, mid: seconds }).safeParse(r.stop);
      if (!s.success) ctx.addIssue({ code: 'custom', message: 'kills 需設定 stop.low 與 stop.mid（秒）', path: ['stop'] });
    }
    let len = Infinity;
    try {
      len = canonicalJson(v).length;
    } catch {
      /* 非 JSON 原生型別 */
    }
    if (len > 2000) ctx.addIssue({ code: 'custom', message: 'behavior 須為 2000 字以內的 JSON' });
  });
export type VideoBehavior = z.infer<typeof VideoBehaviorSchema>;

export const PoolVideoSchema = z.object({
  url: MediaPathSchema,
  behavior: VideoBehaviorSchema.default({ kind: 'plain' }),
  enabled: z.boolean().default(true),
});

export const PoolVideosSchema = z
  .array(PoolVideoSchema)
  .max(10, '每個賞池最多 10 支影片')
  .refine((a) => new Set(a.map((v) => v.url)).size === a.length, '影片網址不可重複');
export type PoolVideoInput = z.input<typeof PoolVideoSchema>;

/** 以新清單取代賞池的影片（順序＝清單順序） */
export async function replacePoolVideos(tx: Tx, poolId: string, videos: z.infer<typeof PoolVideosSchema>): Promise<void> {
  await tx`DELETE FROM pool_videos WHERE pool_id = ${poolId}`;
  let i = 0;
  for (const v of videos) {
    await tx`INSERT INTO pool_videos (pool_id, url, sort_order, behavior_json, enabled)
             VALUES (${poolId}, ${v.url}, ${++i}, ${canonicalJson(v.behavior)}, ${v.enabled})`;
  }
}

export interface PoolVideoOut {
  /** 播放網址（已套用 MEDIA_BASE_URL） */
  url: string;
  /** 資料庫中的原始路徑 */
  path: string;
  behavior: VideoBehavior;
  enabled: boolean;
}

/** 讀取賞池影片；預設只回傳啟用中的（公開 API） */
export async function loadPoolVideos(d: Db, poolId: string, opts: { includeDisabled?: boolean } = {}): Promise<PoolVideoOut[]> {
  const rows = await d<{ url: string; behaviorJson: string; enabled: boolean }[]>`
    SELECT url, behavior_json, enabled FROM pool_videos
    WHERE pool_id = ${poolId} ${opts.includeDisabled ? d`` : d`AND enabled`}
    ORDER BY sort_order, created_at`;
  return rows.map((r) => ({ url: mediaUrl(r.url)!, path: r.url, behavior: JSON.parse(r.behaviorJson) as VideoBehavior, enabled: r.enabled }));
}
