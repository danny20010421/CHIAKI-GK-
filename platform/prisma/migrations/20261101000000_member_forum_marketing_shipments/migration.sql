-- CHIAKI platform — 業主 2026-10（第六批）（不修改已套用的 migration）
--   1. 會員資料：暱稱、真實姓名、頭像（素材驗證＋重新封裝）；換手機需對「新號碼」OTP；常用收件資訊（一筆預設）
--   2. 討論區：貼文/留言（一律先待審）、按讚、檢舉；審核原因會顯示給作者
--   3. 首頁橫幅與優惠券後台管理
--   4. 出貨更正：新增物流商（嘉里大榮、宅配通）、遺失/破損狀態、可回退的更正（需原因）、出貨事件紀錄（會員可見）
--   5. 賞池資訊欄位：來源說明、商品狀態

-- ───────────────────────── 1. 會員資料 ─────────────────────────
ALTER TABLE assets DROP CONSTRAINT assets_type_check;
ALTER TABLE assets ADD CONSTRAINT assets_type_check CHECK (type IN
  ('cover', 'prize', 'banner', 'bannerM', 'event', 'eventBody', 'ticket', 'ip', 'product', 'partner', 'og', 'avatar', 'forum'));

ALTER TABLE users ADD COLUMN nickname text CHECK (nickname IS NULL OR char_length(nickname) BETWEEN 2 AND 16);
ALTER TABLE users ADD COLUMN real_name text CHECK (real_name IS NULL OR char_length(real_name) BETWEEN 1 AND 50);
ALTER TABLE users ADD COLUMN avatar_asset_id uuid REFERENCES assets(id);
ALTER TABLE users ADD COLUMN profile_updated_at timestamptz;

-- 換手機：OTP 送到新號碼，確認後才更換（一位會員同時只有一筆待確認）
CREATE TABLE phone_change_requests (
  user_id       uuid PRIMARY KEY REFERENCES users(id),
  new_phone     text NOT NULL CHECK (new_phone ~ '^09[0-9]{8}$'),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE TABLE member_addresses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  method          text NOT NULL CHECK (method IN ('home', 'c711', 'fami')),
  recipient_name  text NOT NULL CHECK (char_length(btrim(recipient_name)) BETWEEN 1 AND 50),
  recipient_phone text NOT NULL CHECK (recipient_phone ~ '^09[0-9]{8}$'),
  address         text CHECK (address IS NULL OR char_length(address) BETWEEN 5 AND 200),
  cvs_store_id    text CHECK (cvs_store_id IS NULL OR char_length(cvs_store_id) BETWEEN 3 AND 20),
  cvs_store_name  text CHECK (cvs_store_name IS NULL OR char_length(cvs_store_name) <= 50),
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((method = 'home' AND address IS NOT NULL) OR (method <> 'home' AND cvs_store_id IS NOT NULL))
);
CREATE INDEX member_addresses_user_idx ON member_addresses (user_id, created_at);
CREATE UNIQUE INDEX member_addresses_one_default ON member_addresses (user_id) WHERE is_default;

-- ───────────────────────── 2. 討論區 ─────────────────────────
CREATE TABLE forum_posts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  category           text NOT NULL CHECK (category IN ('開箱分享', '閒聊', '情報', '求助')),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 4 AND 40),
  body               text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 1000),
  image_asset_id     uuid REFERENCES assets(id),
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REMOVED')),
  moderation_reason  text,
  moderated_by       uuid REFERENCES users(id),
  moderated_at       timestamptz,
  like_count         integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('REJECTED', 'REMOVED') OR (moderation_reason IS NOT NULL AND char_length(btrim(moderation_reason)) > 0))
);
CREATE INDEX forum_posts_status_idx ON forum_posts (status, created_at DESC);
CREATE INDEX forum_posts_user_idx ON forum_posts (user_id, created_at DESC);

CREATE TABLE forum_comments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id            uuid NOT NULL REFERENCES forum_posts(id),
  user_id            uuid NOT NULL REFERENCES users(id),
  body               text NOT NULL CHECK (char_length(body) BETWEEN 2 AND 300),
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REMOVED')),
  moderation_reason  text,
  moderated_by       uuid REFERENCES users(id),
  moderated_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('REJECTED', 'REMOVED') OR (moderation_reason IS NOT NULL AND char_length(btrim(moderation_reason)) > 0))
);
CREATE INDEX forum_comments_post_idx ON forum_comments (post_id, created_at);
CREATE INDEX forum_comments_user_idx ON forum_comments (user_id, created_at DESC);

CREATE TABLE forum_likes (
  post_id     uuid NOT NULL REFERENCES forum_posts(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE forum_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type  text NOT NULL CHECK (target_type IN ('POST', 'COMMENT')),
  target_id    uuid NOT NULL,
  reporter_id  uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 300),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, reporter_id)
);
CREATE INDEX forum_reports_open_idx ON forum_reports (status, created_at) WHERE status = 'OPEN';

-- ───────────────────────── 3. 橫幅與優惠券 ─────────────────────────
CREATE TABLE banners (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  title             text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  alt_text          text NOT NULL CHECK (char_length(btrim(alt_text)) BETWEEN 1 AND 200),
  link_url          text CHECK (link_url IS NULL OR link_url LIKE 'https://%' OR link_url LIKE '/%'),
  starts_at         timestamptz,
  ends_at           timestamptz,
  enabled           boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  desktop_asset_id  uuid NOT NULL REFERENCES assets(id),
  mobile_asset_id   uuid REFERENCES assets(id),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX banners_live_idx ON banners (sort_order, created_at) WHERE enabled;

CREATE TABLE coupons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9]{4,16}$'),
  kind          text NOT NULL CHECK (kind IN ('pct', 'amt', 'ship')),
  value         integer NOT NULL CHECK (value >= 0),
  min_spend     integer NOT NULL DEFAULT 0 CHECK (min_spend >= 0),
  issue_limit   integer CHECK (issue_limit IS NULL OR issue_limit > 0),
  issued_count  integer NOT NULL DEFAULT 0 CHECK (issued_count >= 0),
  used_count    integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at    timestamptz,
  enabled       boolean NOT NULL DEFAULT true,
  deleted_at    timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'pct' AND value BETWEEN 1 AND 90) OR (kind = 'amt' AND value >= 1) OR kind = 'ship')
);
CREATE UNIQUE INDEX coupons_code_live_uniq ON coupons (code) WHERE deleted_at IS NULL;
-- 已使用過的優惠碼不可改碼
CREATE FUNCTION chiaki_coupon_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'coupons are soft-deleted only' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code AND OLD.used_count > 0 THEN
    RAISE EXCEPTION 'coupon code is immutable once used' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coupons_guard BEFORE UPDATE OR DELETE ON coupons FOR EACH ROW EXECUTE FUNCTION chiaki_coupon_guard();

-- ───────────────────────── 4. 出貨更正與事件紀錄 ─────────────────────────
INSERT INTO carriers (code, label, category, tracking_url_template, sort_order) VALUES
  ('KERRY', '嘉里大榮', 'HOME', 'https://www.kerrytj.com/ZH/search/search_track.aspx?no={no}', 6),
  ('PELICAN', '宅配通', 'HOME', 'https://www.e-can.com.tw/search_Goods.aspx?no={no}', 7)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE shipments DROP CONSTRAINT shipments_status_check;
ALTER TABLE shipments ADD CONSTRAINT shipments_status_check CHECK (status IN (
  'REQUESTED', 'PICKING', 'PACKING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'EXCEPTION', 'LOST', 'DAMAGED', 'CANCELLED'));
ALTER TABLE shipments ADD COLUMN address_id uuid REFERENCES member_addresses(id) ON DELETE SET NULL;

-- 正常流程照舊；後台「更正」在交易內 SET LOCAL chiaki.shipment_correction = 'on' 時可改為任何狀態（含回退與例外）
CREATE OR REPLACE FUNCTION chiaki_shipment_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipments cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND COALESCE(current_setting('chiaki.shipment_correction', true), '') <> 'on'
     AND NOT (
       (OLD.status = 'REQUESTED' AND NEW.status IN ('PICKING', 'EXCEPTION', 'CANCELLED'))
    OR (OLD.status = 'PICKING' AND NEW.status IN ('PACKING', 'EXCEPTION'))
    OR (OLD.status = 'PACKING' AND NEW.status IN ('SHIPPED', 'EXCEPTION'))
    OR (OLD.status = 'SHIPPED' AND NEW.status IN ('DELIVERED', 'RETURNED', 'EXCEPTION', 'LOST', 'DAMAGED'))
    OR (OLD.status IN ('RETURNED', 'EXCEPTION', 'LOST', 'DAMAGED') AND NEW.status = 'PICKING')) THEN
    RAISE EXCEPTION 'invalid shipment transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status = 'CANCELLED' OR NEW.status = 'CANCELLED')
     AND COALESCE(current_setting('chiaki.shipment_correction', true), '') = 'on' THEN
    RAISE EXCEPTION 'cancellation cannot be corrected' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 倉庫物品：出貨更正時允許「已出貨/已送達」回退（物品仍在同一張出貨單上）
CREATE OR REPLACE FUNCTION chiaki_warehouse_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'warehouse items cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'warehouse item owner cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'STORED' AND NEW.status IN ('SHIP_REQUESTED', 'RECYCLED'))
    OR (OLD.status = 'SHIP_REQUESTED' AND NEW.status IN ('SHIPPED', 'STORED'))
    OR (OLD.status = 'SHIPPED' AND NEW.status = 'DELIVERED')
    OR (COALESCE(current_setting('chiaki.shipment_correction', true), '') = 'on'
        AND OLD.status IN ('SHIP_REQUESTED', 'SHIPPED', 'DELIVERED') AND NEW.status IN ('SHIP_REQUESTED', 'SHIPPED', 'DELIVERED'))) THEN
    RAISE EXCEPTION 'invalid warehouse transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 出貨事件紀錄（append-only；會員可見）
CREATE TABLE shipment_events (
  id           bigserial PRIMARY KEY,
  shipment_id  uuid NOT NULL REFERENCES shipments(id),
  status       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('REQUESTED', 'STATUS', 'CORRECTION')),
  actor_type   text NOT NULL CHECK (actor_type IN ('USER', 'ADMIN', 'SYSTEM')),
  actor_id     uuid REFERENCES users(id),
  note         text,
  changes_json text NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_events_shipment_idx ON shipment_events (shipment_id, id);
CREATE TRIGGER shipment_events_append_only BEFORE UPDATE OR DELETE ON shipment_events FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();
INSERT INTO shipment_events (shipment_id, status, kind, actor_type, actor_id, created_at)
  SELECT id, 'REQUESTED', 'REQUESTED', 'USER', user_id, created_at FROM shipments;
INSERT INTO shipment_events (shipment_id, status, kind, actor_type, note, created_at)
  SELECT id, status, 'STATUS', 'SYSTEM', '（既有資料回填）', updated_at FROM shipments WHERE status <> 'REQUESTED';

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'STORAGE_EXPIRY_7D', 'STORAGE_EXPIRY_TODAY', 'STORAGE_AUTO_CONVERTED', 'STORAGE_EXPIRED_HOLD',
  'DRAW_RESULT', 'SHIPMENT_SHIPPED', 'REFUND_STATUS', 'SHIPPING_FEE_REFUND', 'TICKET_REPLY', 'REFERRAL_REWARD',
  'SHIPMENT_UPDATED', 'FORUM_MODERATED'));

-- ───────────────────────── 5. 賞池資訊欄位 ─────────────────────────
ALTER TABLE pools ADD COLUMN source_note text NOT NULL DEFAULT '' CHECK (char_length(source_note) <= 200);
ALTER TABLE pools ADD COLUMN item_condition text NOT NULL DEFAULT '' CHECK (char_length(item_condition) <= 200);
