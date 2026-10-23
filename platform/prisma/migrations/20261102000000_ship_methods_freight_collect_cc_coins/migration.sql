-- CHIAKI platform — 業主 2026-10（第七批）（不修改已套用的 migration）
--   1. 寄送方式「逐件預設」：每個獎項上架時設定 ship_method（home 宅配到府 / c711 7-11 交貨便 / fami 全家店到店），
--      賞池一有銷售即鎖定（trigger）。會員不可選擇寄送方式；一次出貨申請依寄送方式拆成多張出貨單（shipments.request_id）。
--   2. 運費到付：移除抽賞時按套預收運費、逐件運費退還、每套運費設定與運費相關帳本類型；
--      出貨單一律 freight_collect = true、fee_coins = 0（既有出貨單標記為 false，保留當時收取的金額）。
--   3. 單一貨幣 CC幣：平台點數併入代幣帳本（不可退款部分）。既有點數餘額以 POINTS_MERGED 帳本列轉為不可退款代幣，
--      之後所有帳本列只能是 COINS；回收、綁定/邀請/儲值贈送、客服補償一律入「不可退款」代幣。
--   4. 等級上限 8 → 12（官方 A–I 等九個以上等級）。

-- ───────────────────────── 1. 寄送方式逐件預設 ─────────────────────────
-- 預設：大件（GK 標籤或等級 1，或後台標記大件）→ 宅配，其餘 → 7-11 交貨便
ALTER TABLE pool_prizes ADD COLUMN ship_method text;
UPDATE pool_prizes SET ship_method = CASE WHEN bulky THEN 'home' ELSE 'c711' END;
ALTER TABLE pool_prizes ALTER COLUMN ship_method SET NOT NULL;
ALTER TABLE pool_prizes ADD CONSTRAINT pool_prizes_ship_method_check CHECK (ship_method IN ('home', 'c711', 'fami'));

-- 賞池一有銷售（任何一套有抽賞紀錄），獎項的寄送方式即不可再改
CREATE FUNCTION chiaki_prize_ship_method_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ship_method IS DISTINCT FROM OLD.ship_method AND EXISTS (SELECT 1 FROM draws d WHERE d.pool_id = OLD.pool_id) THEN
    RAISE EXCEPTION 'ship method is locked once the pool has sales' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pool_prizes_ship_method_lock BEFORE UPDATE OF ship_method ON pool_prizes
  FOR EACH ROW EXECUTE FUNCTION chiaki_prize_ship_method_lock();
CREATE INDEX IF NOT EXISTS draws_pool_idx ON draws (pool_id);

-- 出貨單：運費到付旗標、同一次申請拆單的群組 id
ALTER TABLE shipments ADD COLUMN freight_collect boolean NOT NULL DEFAULT true;
UPDATE shipments SET freight_collect = false;                                    -- 既有出貨單：運費已預收/已收取
ALTER TABLE shipments ADD CONSTRAINT shipments_freight_collect_no_fee CHECK (NOT freight_collect OR fee_coins = 0);
ALTER TABLE shipments ADD CONSTRAINT shipments_freight_collect_only CHECK (freight_collect) NOT VALID;  -- 新出貨單一律到付
ALTER TABLE shipments ADD COLUMN request_id uuid;
CREATE INDEX shipments_request_idx ON shipments (request_id) WHERE request_id IS NOT NULL;
ALTER TABLE shipments DROP COLUMN prepaid_item_count;

-- 物流方式不再有運費
ALTER TABLE shipping_methods DROP COLUMN fee_coins;

-- ───────────────────────── 2. 移除預收運費 ─────────────────────────
DROP TABLE shipping_fee_refunds;
DROP FUNCTION chiaki_shipping_refund_guard();
DROP TABLE shipping_item_refund_events;
DROP TABLE shipping_item_refunds;
DROP TABLE shipping_prepayments;
ALTER TABLE pools DROP COLUMN ship_fee_home;
ALTER TABLE pools DROP COLUMN ship_fee_cvs;
ALTER TABLE pool_sets DROP COLUMN ship_fee_home;
ALTER TABLE pool_sets DROP COLUMN ship_fee_cvs;
ALTER TABLE pool_sets DROP COLUMN ship_refund_div;

DROP VIEW member_draw_history;
ALTER TABLE draws DROP COLUMN shipping_coins;
CREATE VIEW member_draw_history AS
  SELECT d.* FROM draws d
  WHERE d.created_at > now() - interval '90 days'
    AND NOT EXISTS (SELECT 1 FROM draw_archive a WHERE a.draw_id = d.id);

-- ───────────────────────── 3. 單一貨幣 CC幣 ─────────────────────────
ALTER TABLE wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK (entry_type IN (
  'TOPUP', 'DRAW_DEBIT', 'PURCHASE_DEBIT', 'SHIPPING_FEE', 'SHIPPING_PREPAID', 'RECYCLE_CREDIT', 'EXPIRY_AUTO_CONVERT',
  'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD', 'CS_COMPENSATION', 'REFUND_DEBIT', 'ADMIN_ADJUST', 'BIND_REWARD', 'TOPUP_BONUS',
  'POINTS_MERGED'));
-- 歷史列：POINTS 只出現在原本的點數類型；之後一律 COINS（ledger_coins_only，NOT VALID → 只檢查新列）
ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_currency_rules;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_currency_rules CHECK (
  currency = 'COINS'
  OR entry_type IN ('RECYCLE_CREDIT', 'BIND_REWARD', 'TOPUP_BONUS', 'CS_COMPENSATION', 'ADMIN_ADJUST', 'POINTS_MERGED'));
-- 儲值與儲值贈送現在同為代幣：一筆付款單各只能入帳一次（依類型區分）
DROP INDEX wallet_ledger_topup_once;
CREATE UNIQUE INDEX wallet_ledger_topup_once ON wallet_ledger (ref_type, ref_id, entry_type) WHERE entry_type IN ('TOPUP', 'TOPUP_BONUS');

-- 既有點數 → 不可退款代幣（每位會員兩列：POINTS 扣到 0、COINS 入帳；餘額鏈與對帳維持一致）
INSERT INTO wallet_ledger (merchant_id, user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, memo)
  SELECT merchant_id, user_id, 'POINTS', -points, 0, 'POINTS_MERGED', 'points_merge', user_id::text, '平台點數併入 CC幣'
  FROM wallets w WHERE w.points > 0 ORDER BY w.user_id;
INSERT INTO wallet_ledger (merchant_id, user_id, currency, amount, balance_after, entry_type, ref_type, ref_id, memo, refundable, nonrefundable_after)
  SELECT merchant_id, user_id, 'COINS', points, coins + points, 'POINTS_MERGED', 'points_merge', user_id::text,
         '平台點數併入 CC幣（不可退款・無法轉換）', false, nonrefundable_coins + points
  FROM wallets w WHERE w.points > 0 ORDER BY w.user_id;
UPDATE wallets SET coins = coins + points, nonrefundable_coins = nonrefundable_coins + points, points = 0, updated_at = now() WHERE points > 0;
ALTER TABLE wallets DROP COLUMN points;

ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_coins_only CHECK (currency = 'COINS') NOT VALID;
-- 不可退款來源（新列）：到期轉換、邀請、回收、綁定任務、儲值贈送、客服補償、點數併入
ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_nonrefundable_sources;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_nonrefundable_sources CHECK (
  entry_type NOT IN ('EXPIRY_AUTO_CONVERT', 'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD', 'RECYCLE_CREDIT', 'BIND_REWARD',
                     'TOPUP_BONUS', 'CS_COMPENSATION', 'POINTS_MERGED')
  OR refundable = false) NOT VALID;
-- 運費相關類型停用（歷史列保留）
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_retired_entry_types CHECK (
  entry_type NOT IN ('SHIPPING_FEE', 'SHIPPING_PREPAID', 'SHIPPING_REFUND_COINS')) NOT VALID;

-- 回收值一律記在 recycled_coins（會員回收與到期轉換皆為代幣）
ALTER TABLE warehouse_items DROP CONSTRAINT warehouse_items_expiry_coins;
UPDATE warehouse_items SET recycled_coins = COALESCE(recycled_points, 0) WHERE recycle_reason = 'USER' AND recycled_coins IS NULL;
ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_recycled_coins CHECK ((recycle_reason IS NOT NULL) = (recycled_coins IS NOT NULL));
ALTER TABLE warehouse_items DROP COLUMN recycled_points;

-- ───────────────────────── 4. 等級上限 12 ─────────────────────────
ALTER TABLE pool_levels DROP CONSTRAINT pool_levels_level_no_check;
ALTER TABLE pool_levels ADD CONSTRAINT pool_levels_level_no_check CHECK (level_no BETWEEN 1 AND 12);
ALTER TABLE draw_results DROP CONSTRAINT draw_results_level_no_check;
ALTER TABLE draw_results ADD CONSTRAINT draw_results_level_no_check CHECK (level_no BETWEEN 1 AND 12);
ALTER TABLE warehouse_items DROP CONSTRAINT warehouse_items_level_no_check;
ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_level_no_check CHECK (level_no BETWEEN 1 AND 12);
