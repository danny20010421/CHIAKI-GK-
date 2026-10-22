-- CHIAKI platform — 業主 2026-10 新商業規則（不修改已套用的 init migration；既有資料皆於此回填）
--   1. 獎項等級 GRAND/MID/SMALL（自製賞池無 A–H 賞級；官方/混合保留賞級但仍需等級）
--   2. 回收值改為「每套 × 每獎項」後台設定（取代全域依賞級的 recycle_rates）
--   3. 寄存 30 天、到期前 7 天與到期當日通知、到期自動依回收值轉「代幣」（預設不可退款）
--   4. 運費「按套預收」：抽賞時於同一交易扣除；一份運費涵蓋同套 20 件小獎
--   5. 每個賞池的出貨時程說明 shipping_note

-- ───────────────────────── 1. 獎項：等級／種類／預設回收值 ─────────────────────────
-- kind：TICKET＝籤池獎項；LAST＝最後賞；GUARANTEE＝保底專用庫存獎項。
-- 最後賞與保底獎也成為獎項列，才能各自擁有等級與每套回收值。
ALTER TABLE pool_prizes ADD COLUMN kind text NOT NULL DEFAULT 'TICKET' CHECK (kind IN ('TICKET', 'LAST', 'GUARANTEE'));
ALTER TABLE pool_prizes ADD COLUMN grade text CHECK (grade IN ('GRAND', 'MID', 'SMALL'));
ALTER TABLE pool_prizes ADD COLUMN recycle_value bigint NOT NULL DEFAULT 0 CHECK (recycle_value >= 0);  -- 發布時複製到每一套的預設值
ALTER TABLE pool_prizes ADD COLUMN recyclable boolean NOT NULL DEFAULT false;
ALTER TABLE pool_prizes ALTER COLUMN rank DROP NOT NULL;                                           -- 自製(CUSTOM)賞池沒有賞級
ALTER TABLE pool_prizes DROP CONSTRAINT pool_prizes_pool_id_rank_key;
ALTER TABLE pool_prizes DROP CONSTRAINT pool_prizes_qty_per_set_check;
ALTER TABLE pool_prizes DROP COLUMN tier;                                                         -- tier 由 grade 取代

-- 預設對應：LAST/A → GRAND、B/C → MID、其他 → SMALL（後台可覆寫）
UPDATE pool_prizes SET grade = CASE WHEN rank IN ('LAST', 'A') THEN 'GRAND' WHEN rank IN ('B', 'C') THEN 'MID' ELSE 'SMALL' END;
UPDATE pool_prizes pp SET recycle_value = rr.points, recyclable = rr.recyclable
  FROM pools p, recycle_rates rr
  WHERE p.id = pp.pool_id AND rr.merchant_id = p.merchant_id AND rr.rank = pp.rank;

INSERT INTO pool_prizes (pool_id, kind, rank, grade, name, qty_per_set, sort_order, recycle_value, recyclable)
SELECT p.id, 'LAST', 'LAST', 'GRAND', p.last_prize_name, 0, 1000, COALESCE(rr.points, 0), COALESCE(rr.recyclable, false)
FROM pools p LEFT JOIN recycle_rates rr ON rr.merchant_id = p.merchant_id AND rr.rank = 'LAST'
WHERE p.last_prize_name IS NOT NULL;

INSERT INTO pool_prizes (pool_id, kind, rank, grade, name, qty_per_set, sort_order, recycle_value, recyclable)
SELECT g.pool_id, 'GUARANTEE', g.reserve_rank,
       CASE WHEN g.reserve_rank IN ('LAST', 'A') THEN 'GRAND' WHEN g.reserve_rank IN ('B', 'C') THEN 'MID' ELSE 'SMALL' END,
       g.reserve_prize_name, 0, 1001, COALESCE(rr.points, 0), COALESCE(rr.recyclable, false)
FROM pool_guarantees g JOIN pools p ON p.id = g.pool_id
LEFT JOIN recycle_rates rr ON rr.merchant_id = p.merchant_id AND rr.rank = g.reserve_rank;

ALTER TABLE pool_prizes ALTER COLUMN grade SET NOT NULL;
ALTER TABLE pool_prizes ADD CONSTRAINT pool_prizes_qty_by_kind CHECK (qty_per_set >= 0 AND (kind = 'TICKET') = (qty_per_set > 0));
ALTER TABLE pool_prizes ADD CONSTRAINT pool_prizes_last_rank CHECK (kind <> 'LAST' OR rank IS NULL OR rank = 'LAST');
CREATE UNIQUE INDEX pool_prizes_ticket_rank_uniq ON pool_prizes (pool_id, rank) WHERE rank IS NOT NULL AND kind = 'TICKET';
CREATE UNIQUE INDEX pool_prizes_name_uniq ON pool_prizes (pool_id, kind, name);
CREATE UNIQUE INDEX pool_prizes_one_last ON pool_prizes (pool_id) WHERE kind = 'LAST';
CREATE UNIQUE INDEX pool_prizes_one_guarantee ON pool_prizes (pool_id) WHERE kind = 'GUARANTEE';

-- 保底：門檻改為「等級」（min_grade 以上視為命中、計數歸零）；保底獎指向 GUARANTEE 獎項列
-- 注意：舊 min_tier=2（B 以上）對應 MID，C 賞現為 MID → 舊賞池的 C 賞也會使保底計數歸零（以等級為準）。
ALTER TABLE pool_guarantees ADD COLUMN min_grade text CHECK (min_grade IN ('GRAND', 'MID', 'SMALL'));
UPDATE pool_guarantees SET min_grade = CASE WHEN min_tier >= 3 THEN 'GRAND' WHEN min_tier >= 1 THEN 'MID' ELSE 'SMALL' END;
ALTER TABLE pool_guarantees ALTER COLUMN min_grade SET NOT NULL;
ALTER TABLE pool_guarantees DROP COLUMN min_tier;
ALTER TABLE pool_guarantees ALTER COLUMN reserve_rank DROP NOT NULL;
ALTER TABLE pool_guarantees ADD COLUMN reserve_prize_id uuid REFERENCES pool_prizes(id);
UPDATE pool_guarantees g SET reserve_prize_id = pp.id FROM pool_prizes pp WHERE pp.pool_id = g.pool_id AND pp.kind = 'GUARANTEE';
ALTER TABLE pool_guarantees ALTER COLUMN reserve_prize_id SET NOT NULL;

-- ───────────────────────── 5 + 4. 賞池：出貨時程說明、預設運費 ─────────────────────────
ALTER TABLE pools ADD COLUMN shipping_note text NOT NULL DEFAULT '';
UPDATE pools SET shipping_note = CASE source
  WHEN 'OFFICIAL' THEN '官方商品依官方出貨時程'
  WHEN 'CUSTOM' THEN '平台商品依平台公告時程'
  ELSE '官方商品依官方出貨時程；平台商品依平台公告時程' END;
-- 宅配 150–300 代幣；超商 C2C（7-ELEVEN 交貨便／全家 店到店）60–150 代幣
ALTER TABLE pools ADD COLUMN ship_fee_home bigint NOT NULL DEFAULT 150 CHECK (ship_fee_home BETWEEN 150 AND 300);
ALTER TABLE pools ADD COLUMN ship_fee_cvs bigint NOT NULL DEFAULT 70 CHECK (ship_fee_cvs BETWEEN 60 AND 150);

-- 每套運費（發布時由賞池預設值複製，後台可逐套調整；新值只影響之後的預收）
ALTER TABLE pool_sets ADD COLUMN ship_fee_home bigint NOT NULL DEFAULT 150 CHECK (ship_fee_home BETWEEN 150 AND 300);
ALTER TABLE pool_sets ADD COLUMN ship_fee_cvs bigint NOT NULL DEFAULT 70 CHECK (ship_fee_cvs BETWEEN 60 AND 150);

-- ───────────────────────── 2. 每套 × 每獎項 回收值 ─────────────────────────
-- 回收值單位為「整數」：會員主動回收 → 入平台點數；寄存到期自動轉換 → 入代幣（同一數值）。
CREATE TABLE set_prizes (
  set_id         uuid NOT NULL REFERENCES pool_sets(id),
  prize_id       uuid NOT NULL REFERENCES pool_prizes(id),
  recycle_value  bigint NOT NULL CHECK (recycle_value >= 0),
  recyclable     boolean NOT NULL,
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (set_id, prize_id)
);
INSERT INTO set_prizes (set_id, prize_id, recycle_value, recyclable)
SELECT s.id, pp.id, pp.recycle_value, pp.recyclable FROM pool_sets s JOIN pool_prizes pp ON pp.pool_id = s.pool_id;

-- 全域依賞級回收費率表已由 set_prizes 取代（上面已用於回填），移除以免誤用
DROP TABLE recycle_rates;

-- ───────────────────────── 抽賞結果：等級（append-only 表的一次性回填） ─────────────────────────
ALTER TABLE draw_results ALTER COLUMN rank DROP NOT NULL;
ALTER TABLE draw_results ALTER COLUMN tier DROP NOT NULL;   -- legacy：新紀錄不再寫入 tier
ALTER TABLE draw_results ADD COLUMN grade text CHECK (grade IN ('GRAND', 'MID', 'SMALL'));
ALTER TABLE draw_results DISABLE TRIGGER draw_results_append_only;
UPDATE draw_results dr SET prize_id = pp.id
  FROM draws d, pool_prizes pp
  WHERE dr.prize_id IS NULL AND d.id = dr.draw_id AND pp.pool_id = d.pool_id AND pp.kind = dr.kind;
UPDATE draw_results dr SET grade = pp.grade FROM pool_prizes pp WHERE pp.id = dr.prize_id;
ALTER TABLE draw_results ENABLE TRIGGER draw_results_append_only;
ALTER TABLE draw_results ALTER COLUMN grade SET NOT NULL;

-- ───────────────────────── 3. 倉庫：等級、寄存期限、到期轉換 ─────────────────────────
ALTER TABLE warehouse_items ALTER COLUMN rank DROP NOT NULL;
ALTER TABLE warehouse_items ADD COLUMN grade text CHECK (grade IN ('GRAND', 'MID', 'SMALL'));
ALTER TABLE warehouse_items ADD COLUMN storage_expires_at timestamptz;
ALTER TABLE warehouse_items ADD COLUMN storage_warned_7d_at timestamptz;
ALTER TABLE warehouse_items ADD COLUMN storage_warned_day_at timestamptz;
ALTER TABLE warehouse_items ADD COLUMN storage_expired_hold_at timestamptz;   -- 到期但不可回收 → 保留待客服處理
ALTER TABLE warehouse_items ADD COLUMN recycled_coins bigint CHECK (recycled_coins >= 0);
ALTER TABLE warehouse_items ADD COLUMN recycle_reason text CHECK (recycle_reason IN ('USER', 'STORAGE_EXPIRY'));

UPDATE warehouse_items wi SET prize_id = pp.id
  FROM pool_prizes pp
  WHERE wi.prize_id IS NULL AND wi.source IN ('LAST', 'GUARANTEE') AND pp.pool_id = wi.pool_id AND pp.kind = wi.source;
UPDATE warehouse_items wi SET grade = pp.grade FROM pool_prizes pp WHERE pp.id = wi.prize_id;
UPDATE warehouse_items SET rank = NULL WHERE source = 'PURCHASE';
UPDATE warehouse_items SET recycle_reason = 'USER' WHERE status = 'RECYCLED';
-- 既有物品：自入庫起 30 天，但至少保留 8 天，確保仍能收到「到期前 7 天」通知
UPDATE warehouse_items SET storage_expires_at = GREATEST(created_at + interval '30 days', now() + interval '8 days');

ALTER TABLE warehouse_items ALTER COLUMN storage_expires_at SET NOT NULL;
ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_grade_by_source CHECK ((source = 'PURCHASE') = (grade IS NULL));
ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_prize_by_source CHECK (source = 'PURCHASE' OR prize_id IS NOT NULL);
ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_recycle_reason CHECK ((status = 'RECYCLED') = (recycle_reason IS NOT NULL));
ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_expiry_coins CHECK ((recycle_reason = 'STORAGE_EXPIRY') = (recycled_coins IS NOT NULL));
CREATE INDEX warehouse_items_storage_idx ON warehouse_items (storage_expires_at) WHERE status = 'STORED';
CREATE INDEX warehouse_items_user_set_idx ON warehouse_items (user_id, set_id) WHERE set_id IS NOT NULL;

-- ───────────────────────── 4. 物流方式：只保留宅配、7-11 交貨便、全家 店到店 ─────────────────────────
ALTER TABLE shipping_methods DROP CONSTRAINT shipping_methods_method_check;
INSERT INTO shipping_methods (method, merchant_id, label, fee_coins, max_items, active)
  SELECT 'CVS_711_C2C', merchant_id, '7-ELEVEN 交貨便', fee_coins, max_items, active FROM shipping_methods WHERE method = 'CVS_711';
INSERT INTO shipping_methods (method, merchant_id, label, fee_coins, max_items, active)
  SELECT 'CVS_FAMI_C2C', merchant_id, '全家 店到店', fee_coins, max_items, active FROM shipping_methods WHERE method = 'CVS_FAMI';
UPDATE shipments SET method = 'CVS_711_C2C' WHERE method = 'CVS_711';
UPDATE shipments SET method = 'CVS_FAMI_C2C' WHERE method = 'CVS_FAMI';
-- 萊爾富/OK 已停用：若已有出貨單使用，外鍵會讓本 migration 失敗（需人工決定如何處理那些出貨單）
DELETE FROM shipping_methods WHERE method IN ('CVS_711', 'CVS_FAMI', 'CVS_HILIFE', 'CVS_OK');
ALTER TABLE shipping_methods ADD CONSTRAINT shipping_methods_method_check CHECK (method IN ('HOME_DELIVERY', 'CVS_711_C2C', 'CVS_FAMI_C2C'));

ALTER TABLE shipments ADD COLUMN prepaid_item_count integer NOT NULL DEFAULT 0 CHECK (prepaid_item_count >= 0);
ALTER TABLE draws ADD COLUMN shipping_coins bigint NOT NULL DEFAULT 0 CHECK (shipping_coins >= 0);

-- 按套預收運費：每列＝一份運費（涵蓋該會員在該套最多 small_items_covered 件「小獎」）
CREATE TABLE shipping_prepayments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id          text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  pool_id              uuid NOT NULL REFERENCES pools(id),
  set_id               uuid NOT NULL REFERENCES pool_sets(id),
  draw_id              uuid NOT NULL REFERENCES draws(id),
  seq                  integer NOT NULL CHECK (seq > 0),
  method               text NOT NULL REFERENCES shipping_methods(method),
  fee_coins            bigint NOT NULL CHECK (fee_coins > 0),
  small_items_covered  integer NOT NULL CHECK (small_items_covered > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, set_id, seq)
);
CREATE TRIGGER shipping_prepayments_append_only BEFORE UPDATE OR DELETE ON shipping_prepayments
  FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

-- ───────────────────────── 錢包：不可退款代幣 ─────────────────────────
-- wallets.nonrefundable_coins ⊆ coins：可退款餘額 = coins − nonrefundable_coins。
-- 一般扣款優先消耗不可退款部分；退款扣款只能動用可退款部分。
ALTER TABLE wallets ADD COLUMN nonrefundable_coins bigint NOT NULL DEFAULT 0;
ALTER TABLE wallets ADD CONSTRAINT wallets_nonrefundable_range CHECK (nonrefundable_coins >= 0 AND nonrefundable_coins <= coins);

ALTER TABLE wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK (entry_type IN (
  'TOPUP', 'DRAW_DEBIT', 'PURCHASE_DEBIT', 'SHIPPING_FEE', 'SHIPPING_PREPAID', 'RECYCLE_CREDIT', 'EXPIRY_AUTO_CONVERT',
  'REFUND_DEBIT', 'ADMIN_ADJUST', 'BIND_REWARD', 'TOPUP_BONUS'));
ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_currency_rules;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_currency_rules CHECK (
  (entry_type IN ('TOPUP', 'REFUND_DEBIT', 'DRAW_DEBIT', 'SHIPPING_PREPAID', 'EXPIRY_AUTO_CONVERT') AND currency = 'COINS')
  OR (entry_type IN ('RECYCLE_CREDIT', 'BIND_REWARD', 'TOPUP_BONUS') AND currency = 'POINTS')
  OR entry_type IN ('PURCHASE_DEBIT', 'SHIPPING_FEE', 'ADMIN_ADJUST'));
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_sign_rules CHECK (
  (entry_type NOT IN ('SHIPPING_PREPAID', 'DRAW_DEBIT', 'REFUND_DEBIT') OR amount < 0)
  AND (entry_type <> 'EXPIRY_AUTO_CONVERT' OR amount > 0));
ALTER TABLE wallet_ledger ADD COLUMN refundable boolean;           -- 只用於「代幣入帳」列
ALTER TABLE wallet_ledger ADD COLUMN nonrefundable_after bigint;   -- 代幣列：異動後的不可退款餘額
ALTER TABLE wallet_ledger DISABLE TRIGGER wallet_ledger_append_only;
UPDATE wallet_ledger SET refundable = true WHERE currency = 'COINS' AND amount > 0;
UPDATE wallet_ledger SET nonrefundable_after = 0 WHERE currency = 'COINS';
ALTER TABLE wallet_ledger ENABLE TRIGGER wallet_ledger_append_only;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_refundable_flag CHECK ((refundable IS NOT NULL) = (currency = 'COINS' AND amount > 0));
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_nonrefundable_after CHECK (
  (nonrefundable_after IS NOT NULL) = (currency = 'COINS')
  AND (nonrefundable_after IS NULL OR (nonrefundable_after >= 0 AND nonrefundable_after <= balance_after)));

-- ───────────────────────── 通知（站內；尚未串接推播/簡訊） ─────────────────────────
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  type          text NOT NULL CHECK (type IN ('STORAGE_EXPIRY_7D', 'STORAGE_EXPIRY_TODAY', 'STORAGE_AUTO_CONVERTED', 'STORAGE_EXPIRED_HOLD')),
  channel       text NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('IN_APP')),
  title         text NOT NULL,
  body          text NOT NULL,
  payload_json  text NOT NULL DEFAULT '{}',
  dedupe_key    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
