-- CHIAKI platform — 業主 2026-10（第四批）（不修改已套用的 migration）
--   1. 獎項等級 1–8（所有賞池）：pool_levels（等級號、顯示名稱、是否小獎）＋ 每級 1..N 個獎項（pool_prizes.level_id）。
--      取代舊的 A–H 賞級（rank）與 大獎/中獎/小獎（grade）模型；最後賞（LAST）維持為等級之外的獨立獎項。
--      舊資料對應：賞級 A..H → 等級 1..8；無賞級者 GRAND/MID/SMALL → 1/2/3；是否小獎沿用舊 grade = SMALL。
--   2. 標籤：以 7 個標籤（GK、PVC、一番賞、景品盲盒、卡牌、娃娃、其他）取代 11 個商品分類。
--   3. IP 移除分類（IP 只代表「哪部作品」）。
--   4. 快速抽包：每個賞池可設定 draw_packs（1、3、5、10、20、all 的子集合，預設 1、5、10）。

-- ───────────────────────── 1. 等級 ─────────────────────────
CREATE TABLE pool_levels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id     uuid NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  level_no    integer NOT NULL CHECK (level_no BETWEEN 1 AND 8),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  is_small    boolean NOT NULL,              -- 小獎：計入「滿 20 件再收一份運費」與逐件運費退還
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, level_no)
);

ALTER TABLE pool_prizes ADD COLUMN level_id uuid REFERENCES pool_levels(id);
ALTER TABLE pool_prizes ADD COLUMN image_url text CHECK (image_url IS NULL OR image_url LIKE 'https://%' OR image_url LIKE '/%');

CREATE TEMP TABLE _lvl_map ON COMMIT DROP AS
  SELECT id AS prize_id, pool_id, rank, grade,
         CASE WHEN rank ~ '^[A-H]$' THEN ascii(rank) - 64
              WHEN grade = 'GRAND' THEN 1 WHEN grade = 'MID' THEN 2 ELSE 3 END AS level_no
  FROM pool_prizes WHERE kind <> 'LAST';
INSERT INTO pool_levels (pool_id, level_no, name, is_small)
  SELECT pool_id, level_no,
         CASE WHEN min(rank) ~ '^[A-H]$' THEN min(rank) || '賞'
              WHEN level_no = 1 THEN '大獎' WHEN level_no = 2 THEN '中獎' ELSE '小獎' END,
         bool_and(grade = 'SMALL')
  FROM _lvl_map GROUP BY pool_id, level_no;
UPDATE pool_prizes pp SET level_id = pl.id
  FROM _lvl_map m JOIN pool_levels pl ON pl.pool_id = m.pool_id AND pl.level_no = m.level_no
  WHERE pp.id = m.prize_id;
ALTER TABLE pool_prizes ADD CONSTRAINT pool_prizes_level_by_kind CHECK ((kind = 'LAST') = (level_id IS NULL));
ALTER TABLE pool_prizes ALTER COLUMN grade DROP NOT NULL;            -- legacy：新資料不再寫入
DROP INDEX pool_prizes_ticket_rank_uniq;                             -- legacy：賞級不再使用
CREATE INDEX pool_prizes_level_idx ON pool_prizes (level_id);

-- 保底門檻改為「等級」：抽中 min_level 以上（等級號 ≤ min_level）視為命中
ALTER TABLE pool_guarantees ADD COLUMN min_level integer CHECK (min_level BETWEEN 1 AND 8);
UPDATE pool_guarantees SET min_level = CASE min_grade WHEN 'GRAND' THEN 1 WHEN 'MID' THEN 2 ELSE 3 END;
ALTER TABLE pool_guarantees ALTER COLUMN min_level SET NOT NULL;
ALTER TABLE pool_guarantees DROP COLUMN min_grade;

-- 抽賞結果與倉庫：等級快照（抽出當下的等級號、名稱、是否小獎）
ALTER TABLE draw_results ADD COLUMN level_no integer CHECK (level_no BETWEEN 1 AND 8);
ALTER TABLE draw_results ADD COLUMN level_name text;
ALTER TABLE draw_results ADD COLUMN is_small boolean NOT NULL DEFAULT false;
ALTER TABLE draw_results ALTER COLUMN grade DROP NOT NULL;
ALTER TABLE draw_results DISABLE TRIGGER draw_results_append_only;
UPDATE draw_results dr SET level_no = pl.level_no, level_name = pl.name, is_small = pl.is_small
  FROM pool_prizes pp JOIN pool_levels pl ON pl.id = pp.level_id WHERE pp.id = dr.prize_id;
UPDATE draw_results SET level_name = '最後賞' WHERE kind = 'LAST';
ALTER TABLE draw_results ENABLE TRIGGER draw_results_append_only;
ALTER TABLE draw_results ADD CONSTRAINT draw_results_level_by_kind CHECK ((kind = 'LAST') = (level_no IS NULL));

ALTER TABLE warehouse_items DROP CONSTRAINT warehouse_items_grade_by_source;
ALTER TABLE warehouse_items ADD COLUMN level_no integer CHECK (level_no BETWEEN 1 AND 8);
ALTER TABLE warehouse_items ADD COLUMN level_name text;
ALTER TABLE warehouse_items ADD COLUMN is_small boolean NOT NULL DEFAULT false;
UPDATE warehouse_items wi SET level_no = pl.level_no, level_name = pl.name, is_small = pl.is_small
  FROM pool_prizes pp JOIN pool_levels pl ON pl.id = pp.level_id WHERE pp.id = wi.prize_id;
UPDATE warehouse_items SET level_name = '最後賞' WHERE source = 'LAST';
ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_small_needs_level CHECK (NOT is_small OR level_no IS NOT NULL);
CREATE INDEX warehouse_items_user_set_small_idx ON warehouse_items (user_id, set_id) WHERE is_small;

-- ───────────────────────── 2. 標籤 ─────────────────────────
ALTER TABLE pool_prizes ADD COLUMN tag text CHECK (tag IN ('GK', 'PVC', '一番賞', '景品盲盒', '卡牌', '娃娃', '其他'));
ALTER TABLE products ADD COLUMN tag text CHECK (tag IN ('GK', 'PVC', '一番賞', '景品盲盒', '卡牌', '娃娃', '其他'));
UPDATE pool_prizes SET tag = CASE category WHEN 'GK' THEN 'GK' WHEN 'PVC' THEN 'PVC' WHEN '景品' THEN '景品盲盒' WHEN '盒玩扭蛋' THEN '景品盲盒'
                                         WHEN '卡牌' THEN '卡牌' WHEN '絨毛' THEN '娃娃' ELSE '其他' END WHERE category IS NOT NULL;
UPDATE products SET tag = CASE category WHEN 'GK' THEN 'GK' WHEN 'PVC' THEN 'PVC' WHEN '景品' THEN '景品盲盒' WHEN '盒玩扭蛋' THEN '景品盲盒'
                                      WHEN '卡牌' THEN '卡牌' WHEN '絨毛' THEN '娃娃' ELSE '其他' END WHERE category IS NOT NULL;
ALTER TABLE pool_prizes DROP COLUMN category;
ALTER TABLE products DROP COLUMN category;

-- ───────────────────────── 3. IP 移除分類 ─────────────────────────
DROP INDEX ips_category_idx;
ALTER TABLE ips DROP COLUMN category;

-- ───────────────────────── 4. 快速抽包 ─────────────────────────
ALTER TABLE pools ADD COLUMN draw_packs text[] NOT NULL DEFAULT '{1,5,10}'
  CHECK (cardinality(draw_packs) >= 1 AND draw_packs <@ ARRAY['1', '3', '5', '10', '20', 'all']);
