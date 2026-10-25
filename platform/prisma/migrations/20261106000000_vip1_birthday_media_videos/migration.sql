-- 部署準備（2026-10-25）：VIP1 生日禮改為 0、賞池封面網址、抽賞演出影片（每個賞池可多支，前台隨機播放）

-- ───────────────────────── 1. VIP1 銅籤 生日禮 → 0（其他等級不變）─────────────────────────
-- 業主指示：銅籤不再有生日禮（生日禮權益 BIRTHDAY_GIFT 原本就從 VIP2 銀籤起列出）。已發放的生日禮不受影響。
UPDATE vip_tiers SET birthday_gift_coins = 0, updated_by = NULL, updated_at = now() WHERE level = 1 AND birthday_gift_coins <> 0;

-- ───────────────────────── 2. 賞池封面（站內路徑或 https://）─────────────────────────
-- 站內路徑（/media/...）輸出時會加上 MEDIA_BASE_URL（CDN）；/api/assets/:id 為資料庫內的上傳素材
ALTER TABLE pools ADD COLUMN cover_url text
  CHECK (cover_url IS NULL OR (cover_url ~ '^(https://[^/\s]+|/[^/\s])\S*$' AND char_length(cover_url) <= 2000));

-- ───────────────────────── 3. 抽賞演出影片 ─────────────────────────
-- behavior_json：依抽賞結果的演出方式（前台解讀），例如
--   {"kind":"beam","beamAt":7.4}                       光束：約 7.4 秒依最高獎項變色
--   {"kind":"kills","stop":{"low":13.9,"mid":15.6}}    擊殺：小獎 13.9 秒停、3～4 獎 15.6 秒停、大獎完整播放
--   {"kind":"plain"}                                    完整播放，不依結果變化
CREATE TABLE pool_videos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id       uuid NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  url           text NOT NULL CHECK (url ~ '^(https://[^/\s]+|/[^/\s])\S*$' AND char_length(url) <= 2000),
  sort_order    integer NOT NULL DEFAULT 0,
  behavior_json text NOT NULL DEFAULT '{"kind":"plain"}',
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, url)
);
CREATE INDEX pool_videos_pool_idx ON pool_videos (pool_id, sort_order);

-- 既有資料庫：「世界之王」補上三支影片（新資料庫由種子 WK_POOL.videos 建立）
INSERT INTO pool_videos (pool_id, url, sort_order, behavior_json)
SELECT p.id, v.url, v.sort_order, v.behavior_json
FROM pools p
CROSS JOIN (VALUES
  ('/media/video/gacha1.mp4', 1, '{"beamAt":7.4,"kind":"beam"}'),
  ('/media/video/gacha2.mp4', 2, '{"kind":"kills","stop":{"low":13.9,"mid":15.6}}'),
  ('/media/video/gacha3.mp4', 3, '{"kind":"plain"}')
) AS v(url, sort_order, behavior_json)
WHERE p.slug = 'wk-world-king'
ON CONFLICT (pool_id, url) DO NOTHING;
