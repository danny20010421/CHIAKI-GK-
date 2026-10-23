-- CHIAKI platform — 業主 2026-10（第三批）規則（不修改已套用的 migration）
--   1. 運費退還改為「逐件」：每回收一件可回收小獎，退 運費 ÷ N 代幣（N = 每套 ship_refund_div，預設 20），
--      依會員×套累計（refunded_units / refunded_amount），每次退 floor(運費 × 累計件數 / N) − 已退金額；入不可退款代幣。
--      回收的小獎「仍計入」運費份數門檻（floor(本套抽到的全部小獎 / 20) + 1），不再釋放已付運費；
--      不再提供運費的新台幣退款（新台幣退款只剩未使用的儲值代幣）。
--   2. 商品分類（GK、PVC、景品…）與大件（限宅配）旗標：獎項、商城商品。
--   3. IP 目錄：固定分類（少年漫畫、動畫・輕小說…）、別名（搜尋）、排序模式（預設依名稱字數，後台可改手動）。

-- ───────────────────────── 1. 逐件運費退還 ─────────────────────────
ALTER TABLE pool_sets ADD COLUMN ship_refund_div integer NOT NULL DEFAULT 20 CHECK (ship_refund_div > 0);

-- 每位會員 × 每套的累計（運費與除數於第一次退還時鎖定）
CREATE TABLE shipping_item_refunds (
  user_id          uuid NOT NULL REFERENCES users(id),
  set_id           uuid NOT NULL REFERENCES pool_sets(id),
  pool_id          uuid NOT NULL REFERENCES pools(id),
  fee_coins        bigint NOT NULL CHECK (fee_coins > 0),
  divisor          integer NOT NULL CHECK (divisor > 0),
  refunded_units   integer NOT NULL DEFAULT 0 CHECK (refunded_units >= 0),
  refunded_amount  bigint NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, set_id),
  -- 累計金額恆等於 floor(運費 × 件數 / N)：永遠不會超退
  CONSTRAINT shipping_item_refunds_formula CHECK (refunded_amount = (fee_coins * refunded_units) / divisor)
);

-- 每一次回收請求（會員回收批次 / 到期轉換批次）× 每套 一列；UNIQUE 保證同一請求不會重複退還
CREATE TABLE shipping_item_refund_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  set_id         uuid NOT NULL REFERENCES pool_sets(id),
  source_type    text NOT NULL CHECK (source_type IN ('USER_RECYCLE', 'STORAGE_EXPIRY')),
  source_id      uuid NOT NULL,
  units          integer NOT NULL CHECK (units > 0),
  amount         bigint NOT NULL CHECK (amount >= 0),
  units_after    integer NOT NULL CHECK (units_after > 0),
  amount_after   bigint NOT NULL CHECK (amount_after >= 0),
  ledger_id      bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, set_id),
  CHECK ((amount > 0) = (ledger_id IS NOT NULL))
);
CREATE INDEX shipping_item_refund_events_user_idx ON shipping_item_refund_events (user_id, created_at DESC);
CREATE TRIGGER shipping_item_refund_events_append_only BEFORE UPDATE OR DELETE ON shipping_item_refund_events
  FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

-- 舊的「整份運費 × 比例」退還與新台幣運費退款已停用：保留既有紀錄（帳務證據），禁止新增
CREATE TRIGGER shipping_fee_refunds_deprecated BEFORE INSERT ON shipping_fee_refunds
  FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

-- ───────────────────────── 2. 商品分類與大件 ─────────────────────────
ALTER TABLE pool_prizes ADD COLUMN category text CHECK (category IN ('GK', 'PVC', '景品', '精品', '模型', '盒玩扭蛋', '絨毛', '周邊', '卡牌', '戰鬥陀螺', '3C'));
ALTER TABLE pool_prizes ADD COLUMN bulky boolean NOT NULL DEFAULT false;     -- 大件・限宅配
UPDATE pool_prizes SET bulky = true WHERE category = 'GK';
ALTER TABLE products ADD COLUMN category text CHECK (category IN ('GK', 'PVC', '景品', '精品', '模型', '盒玩扭蛋', '絨毛', '周邊', '卡牌', '戰鬥陀螺', '3C'));
ALTER TABLE products ADD COLUMN bulky boolean NOT NULL DEFAULT false;

-- ───────────────────────── 3. IP 目錄 ─────────────────────────
ALTER TABLE ips ADD COLUMN category text CHECK (category IN ('少年漫畫', '動畫・輕小說', '遊戲', '特攝・機甲', '經典・兒童', '角色・療癒', '歐美', '原創'));
ALTER TABLE ips ADD COLUMN aliases text[] NOT NULL DEFAULT '{}' CHECK (cardinality(aliases) <= 30);
-- 舊的可編輯分類（動畫/遊戲/漫畫/原創）改為業主指定的固定分類
UPDATE ips i SET category = CASE c.code WHEN 'ANIME' THEN '動畫・輕小說' WHEN 'GAME' THEN '遊戲' WHEN 'MANGA' THEN '少年漫畫' WHEN 'ORIGINAL' THEN '原創' END
  FROM ip_categories c WHERE c.id = i.category_id;
DROP INDEX ips_category_idx;
ALTER TABLE ips DROP COLUMN category_id;
DROP TABLE ip_categories;
CREATE INDEX ips_category_idx ON ips (category, sort_order);

-- 營運設定（目前：IP 排序模式 AUTO＝依名稱字數再依中文排序；MANUAL＝後台手動排序）
CREATE TABLE app_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{1,63}$'),
  value       text NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key, value) VALUES ('ip.sort_mode', 'AUTO');
