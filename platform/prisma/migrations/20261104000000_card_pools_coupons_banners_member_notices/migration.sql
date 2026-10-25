-- CHIAKI platform — 業主 2026-10（第九批）（不修改已套用的 migration）
--   1. 卡牌賞池「世界之王」：抽賞演出類型 pools.animation（KUJI 籤紙 / VIDEO 影片）、快速抽包新增 100 抽、
--      每套籤數上限 30,000 → 300,000（程式常數 MAX_TICKETS_PER_SET）；大型機率賞的抽選改用記憶體索引（見 pool/prob.ts），
--      另加「可抽籤」部分索引，讓剩餘數 / 一般快速抽不需掃描已抽出的籤。
--   2. 抽賞結果「轉換 UC幣」（POST /api/me/draws/:drawId/convert）：沿用回收（RECYCLE_CREDIT、recycle_reason USER），無結構變更。
--   3. 首頁橫幅：圖片可用素材 id 或網址（https:// 或站內路徑）、新分頁開啟旗標、連結驗證收緊（站內路徑不可為 //）。
--   4. 抽賞結帳可用優惠券：會員優惠券（VIP 每月券 vip_coupons、代碼領取券 user_coupons → coupons）記錄使用的抽賞與折抵；
--      draws 記錄折抵（amount_coins 仍為小計 = 單價 × 張數，實付 = amount_coins − discount_coins）；
--      實付為 0 時帳本以 0 元 DRAW_DEBIT 記錄折抵；免運券（ship）停用（運費到付）。
--   5. 會員通知：VIP 升級禮、生日禮、優惠券發放。

-- ───────────────────────── 1. 卡牌賞池 ─────────────────────────
ALTER TABLE pools ADD COLUMN animation text NOT NULL DEFAULT 'KUJI' CHECK (animation IN ('KUJI', 'VIDEO'));
ALTER TABLE pools DROP CONSTRAINT pools_draw_packs_check;
ALTER TABLE pools ADD CONSTRAINT pools_draw_packs_check
  CHECK (cardinality(draw_packs) >= 1 AND draw_packs <@ ARRAY['1', '3', '5', '10', '20', '100', 'all']);
CREATE INDEX tickets_available_idx ON tickets (set_id, ticket_no) WHERE status = 'AVAILABLE';

-- ───────────────────────── 3. 首頁橫幅 ─────────────────────────
ALTER TABLE banners ALTER COLUMN desktop_asset_id DROP NOT NULL;
ALTER TABLE banners ADD COLUMN desktop_image_url text
  CHECK (desktop_image_url IS NULL OR (desktop_image_url ~ '^(https://[^/\s]+|/[^/\s])\S*$' AND char_length(desktop_image_url) <= 2000));
ALTER TABLE banners ADD COLUMN mobile_image_url text
  CHECK (mobile_image_url IS NULL OR (mobile_image_url ~ '^(https://[^/\s]+|/[^/\s])\S*$' AND char_length(mobile_image_url) <= 2000));
ALTER TABLE banners ADD CONSTRAINT banners_desktop_image_required CHECK (desktop_asset_id IS NOT NULL OR desktop_image_url IS NOT NULL);
ALTER TABLE banners ADD COLUMN open_in_new_tab boolean NOT NULL DEFAULT false;
UPDATE banners SET open_in_new_tab = true WHERE link_url LIKE 'https://%';
ALTER TABLE banners DROP CONSTRAINT banners_link_url_check;
ALTER TABLE banners ADD CONSTRAINT banners_link_url_check
  CHECK (link_url IS NULL OR link_url ~ '^(https://[^/\s]+|/([^/\s]|$))\S*$') NOT VALID;

-- ───────────────────────── 4. 優惠券 ─────────────────────────
-- 免運券停用：既有 ship 券一律停用並軟刪除；新券只能是 pct / amt
UPDATE coupons SET enabled = false, deleted_at = COALESCE(deleted_at, now()), updated_at = now() WHERE kind = 'ship';
ALTER TABLE coupons DROP CONSTRAINT coupons_kind_check;
ALTER TABLE coupons DROP CONSTRAINT coupons_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_kind_check CHECK (kind IN ('pct', 'amt') OR (kind = 'ship' AND deleted_at IS NOT NULL AND NOT enabled));
ALTER TABLE coupons ADD CONSTRAINT coupons_value_rule CHECK ((kind = 'pct' AND value BETWEEN 1 AND 90) OR (kind = 'amt' AND value >= 1) OR kind = 'ship');

-- 會員代碼券：連結到優惠券定義；使用時記錄抽賞與折抵
ALTER TABLE user_coupons ADD COLUMN coupon_id uuid REFERENCES coupons(id);
ALTER TABLE user_coupons ADD COLUMN used_at timestamptz;
ALTER TABLE user_coupons ADD COLUMN used_draw_id uuid;
ALTER TABLE user_coupons ADD COLUMN discount_coins bigint CHECK (discount_coins IS NULL OR discount_coins >= 0);
ALTER TABLE user_coupons ADD CONSTRAINT user_coupons_used_fields CHECK ((status = 'USED') = (used_at IS NOT NULL)) NOT VALID;
UPDATE user_coupons uc SET coupon_id = c.id FROM coupons c WHERE c.code = uc.code AND c.deleted_at IS NULL AND uc.coupon_id IS NULL;
CREATE UNIQUE INDEX user_coupons_one_per_coupon ON user_coupons (user_id, coupon_id) WHERE coupon_id IS NOT NULL;
CREATE INDEX user_coupons_user_idx ON user_coupons (user_id, created_at DESC);

ALTER TABLE vip_coupons ADD COLUMN used_at timestamptz;
ALTER TABLE vip_coupons ADD COLUMN used_draw_id uuid;
ALTER TABLE vip_coupons ADD COLUMN discount_coins bigint CHECK (discount_coins IS NULL OR discount_coins >= 0);
ALTER TABLE vip_coupons ADD CONSTRAINT vip_coupons_used_fields CHECK ((status = 'USED') = (used_at IS NOT NULL)) NOT VALID;

-- 抽賞：折抵與使用的會員優惠券（amount_coins = 小計；實付 = amount_coins − discount_coins）
DROP VIEW member_draw_history;
ALTER TABLE draws ADD COLUMN discount_coins bigint NOT NULL DEFAULT 0;
ALTER TABLE draws ADD COLUMN coupon_id uuid;
ALTER TABLE draws ADD COLUMN coupon_source text CHECK (coupon_source IS NULL OR coupon_source IN ('VIP', 'CODE'));
ALTER TABLE draws ADD CONSTRAINT draws_discount_rules CHECK (
  discount_coins >= 0 AND discount_coins <= amount_coins
  AND (coupon_id IS NULL) = (coupon_source IS NULL)
  AND (coupon_id IS NOT NULL OR discount_coins = 0));
CREATE UNIQUE INDEX draws_coupon_once ON draws (coupon_source, coupon_id) WHERE coupon_id IS NOT NULL;
CREATE VIEW member_draw_history AS
  SELECT d.* FROM draws d
  WHERE d.created_at > now() - interval '90 days'
    AND NOT EXISTS (SELECT 1 FROM draw_archive a WHERE a.draw_id = d.id);
ALTER TABLE user_coupons ADD CONSTRAINT user_coupons_used_draw_fk FOREIGN KEY (used_draw_id) REFERENCES draws(id);
ALTER TABLE vip_coupons ADD CONSTRAINT vip_coupons_used_draw_fk FOREIGN KEY (used_draw_id) REFERENCES draws(id);

-- 帳本：優惠券全額折抵時以 0 元 DRAW_DEBIT 記錄（其餘扣款仍須為負數）
ALTER TABLE wallet_ledger DROP CONSTRAINT wallet_ledger_amount_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_amount_check CHECK (amount <> 0 OR (entry_type = 'DRAW_DEBIT' AND ref_type = 'draw'));
ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_sign_rules;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_sign_rules CHECK (
  (entry_type NOT IN ('SHIPPING_PREPAID', 'REFUND_DEBIT') OR amount < 0)
  AND (entry_type <> 'DRAW_DEBIT' OR amount < 0 OR (amount = 0 AND ref_type = 'draw'))
  AND (entry_type NOT IN ('EXPIRY_AUTO_CONVERT', 'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD', 'CS_COMPENSATION',
                          'CHECKIN', 'VIP_UPGRADE_GIFT', 'VIP_BIRTHDAY_GIFT') OR amount > 0));

-- ───────────────────────── 5. 會員通知 ─────────────────────────
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'STORAGE_EXPIRY_7D', 'STORAGE_EXPIRY_TODAY', 'STORAGE_AUTO_CONVERTED', 'STORAGE_EXPIRED_HOLD',
  'DRAW_RESULT', 'SHIPMENT_SHIPPED', 'REFUND_STATUS', 'SHIPPING_FEE_REFUND', 'TICKET_REPLY', 'REFERRAL_REWARD',
  'SHIPMENT_UPDATED', 'FORUM_MODERATED', 'VIP_UPGRADE_GIFT', 'VIP_BIRTHDAY_GIFT', 'COUPON_ISSUED'));
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
