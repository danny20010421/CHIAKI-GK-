-- CHIAKI platform — 業主 2026-10（第八批）（不修改已套用的 migration）
--   1. VIP 會員等級（VIP0–VIP6）：依「抽賞累計花費 CC幣」（可退款＋不可退款皆計；抽賞退款扣回）升級。
--      等級設定存於 vip_tiers（後台可改、留稽核），預設值由本 migration 寫入。
--      升級禮（每個等級一生一次、跳級逐級發放）、生日禮（每年一次、生日當月、台灣時間）、每月優惠券（每月 1 日、每人每月一次）、
--      年度重新評等（1/1 依前 12 個月花費、每年最多降一級）、等級加碼寄存天數。贈送的 CC幣一律「不可退款」。
--   2. 每日簽到：每週一 00:00（台灣時間）重新計算；本週第 1–6 次 2 CC幣、第 7 次 10 CC幣（不可退款，帳本 CHECKIN）。
--   3. 帳本類型：CHECKIN、VIP_UPGRADE_GIFT、VIP_BIRTHDAY_GIFT（皆為不可退款入帳）。

-- ───────────────────────── 1. 帳本類型 ─────────────────────────
ALTER TABLE wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK (entry_type IN (
  'TOPUP', 'DRAW_DEBIT', 'PURCHASE_DEBIT', 'SHIPPING_FEE', 'SHIPPING_PREPAID', 'RECYCLE_CREDIT', 'EXPIRY_AUTO_CONVERT',
  'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD', 'CS_COMPENSATION', 'REFUND_DEBIT', 'ADMIN_ADJUST', 'BIND_REWARD', 'TOPUP_BONUS',
  'POINTS_MERGED', 'CHECKIN', 'VIP_UPGRADE_GIFT', 'VIP_BIRTHDAY_GIFT'));
ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_sign_rules;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_sign_rules CHECK (
  (entry_type NOT IN ('SHIPPING_PREPAID', 'DRAW_DEBIT', 'REFUND_DEBIT') OR amount < 0)
  AND (entry_type NOT IN ('EXPIRY_AUTO_CONVERT', 'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD', 'CS_COMPENSATION',
                          'CHECKIN', 'VIP_UPGRADE_GIFT', 'VIP_BIRTHDAY_GIFT') OR amount > 0));
ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_nonrefundable_sources;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_nonrefundable_sources CHECK (
  entry_type NOT IN ('EXPIRY_AUTO_CONVERT', 'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD', 'RECYCLE_CREDIT', 'BIND_REWARD',
                     'TOPUP_BONUS', 'CS_COMPENSATION', 'POINTS_MERGED', 'CHECKIN', 'VIP_UPGRADE_GIFT', 'VIP_BIRTHDAY_GIFT')
  OR refundable = false) NOT VALID;
-- 第二道防線：同一筆簽到/禮物只能入帳一次（ref_id = 會員:日期 / 會員:L等級 / 會員:年份）
CREATE UNIQUE INDEX wallet_ledger_gift_once ON wallet_ledger (entry_type, ref_id)
  WHERE entry_type IN ('CHECKIN', 'VIP_UPGRADE_GIFT', 'VIP_BIRTHDAY_GIFT');

-- ───────────────────────── 2. VIP 等級設定 ─────────────────────────
-- monthly_coupons_json：[{"discountPct":5,"qty":1}]（discountPct 5 = 95折）
-- perks_json：本等級「新增」的權益 [{"code":"LIVE_ODDS","label":"賞池頁即時機率顯示"}]（較高等級自動包含較低等級的權益）
CREATE TABLE vip_tiers (
  level                 integer PRIMARY KEY CHECK (level BETWEEN 0 AND 20),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20),
  spend_threshold       bigint NOT NULL CHECK (spend_threshold >= 0),
  upgrade_gift_coins    integer NOT NULL DEFAULT 0 CHECK (upgrade_gift_coins >= 0),
  birthday_gift_coins   integer NOT NULL DEFAULT 0 CHECK (birthday_gift_coins >= 0),
  monthly_coupons_json  text NOT NULL DEFAULT '[]',
  extra_storage_days    integer NOT NULL DEFAULT 0 CHECK (extra_storage_days BETWEEN 0 AND 365),
  perks_json            text NOT NULL DEFAULT '[]',
  updated_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (level <> 0 OR spend_threshold = 0)
);
INSERT INTO vip_tiers (level, name, spend_threshold, upgrade_gift_coins, birthday_gift_coins, monthly_coupons_json, extra_storage_days, perks_json) VALUES
  (0, '新手籤', 0, 0, 0, '[]', 0, '[]'),
  (1, '銅籤', 3000, 30, 50, '[{"discountPct":5,"qty":1}]', 0, '[]'),
  (2, '銀籤', 10000, 100, 100, '[{"discountPct":5,"qty":2}]', 0, '[{"code":"EARLY_NOTICE","label":"新賞提前 1 小時通知"}]'),
  (3, '金籤', 30000, 300, 300, '[{"discountPct":10,"qty":2}]', 15, '[{"code":"LIVE_ODDS","label":"賞池頁即時機率顯示"}]'),
  (4, '白金籤', 80000, 800, 600, '[{"discountPct":10,"qty":3}]', 15, '[{"code":"PRIORITY_SHIPPING","label":"優先出貨"}]'),
  (5, '鑽石籤', 200000, 2000, 1200, '[{"discountPct":10,"qty":3},{"discountPct":15,"qty":1}]', 30, '[{"code":"DEDICATED_CS","label":"專屬客服"}]'),
  (6, '黑金籤', 500000, 5000, 3000, '[{"discountPct":15,"qty":3}]', 30, '[{"code":"EXCLUSIVE_EVENTS","label":"專屬活動與限定賞池"}]');

-- ───────────────────────── 3. 會員 VIP 狀態 ─────────────────────────
-- qualifying_spend：決定升級的累計花費（年度重新評等時重設為 max(前 12 個月花費, 新等級門檻) + 評等期後的花費）
-- lifetime_spend：歷來抽賞淨花費（僅顯示）
CREATE TABLE vip_members (
  user_id           uuid PRIMARY KEY REFERENCES users(id),
  level             integer NOT NULL DEFAULT 0 CHECK (level >= 0),
  qualifying_spend  bigint NOT NULL DEFAULT 0 CHECK (qualifying_spend >= 0),
  lifetime_spend    bigint NOT NULL DEFAULT 0 CHECK (lifetime_spend >= 0),
  level_since       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vip_members_level_idx ON vip_members (level);

-- 花費事件（append-only）：每筆抽賞 +金額；抽賞退款 −金額。年度評等以此計算前 12 個月花費。
CREATE TABLE vip_spend_events (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  draw_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('DRAW', 'DRAW_REFUND')),
  ref_id       text NOT NULL,
  amount       bigint NOT NULL CHECK (amount <> 0),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'DRAW') = (amount > 0)),
  UNIQUE (kind, ref_id)
);
CREATE INDEX vip_spend_events_user_idx ON vip_spend_events (user_id, occurred_at);
CREATE TRIGGER vip_spend_events_append_only BEFORE UPDATE OR DELETE ON vip_spend_events FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

-- 禮物紀錄（append-only）：UPGRADE period='L<等級>'（一生一次）；BIRTHDAY period='<年>'；MONTHLY_COUPONS period='<年-月>'
CREATE TABLE vip_gift_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('UPGRADE', 'BIRTHDAY', 'MONTHLY_COUPONS')),
  period        text NOT NULL CHECK (period ~ '^(L\d{1,2}|\d{4}|\d{4}-\d{2})$'),
  level         integer NOT NULL CHECK (level >= 0),
  coins         integer NOT NULL DEFAULT 0 CHECK (coins >= 0),
  coupons_json  text NOT NULL DEFAULT '[]',
  ledger_id     bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, period),
  CHECK ((coins > 0) = (ledger_id IS NOT NULL))
);
CREATE INDEX vip_gift_grants_user_idx ON vip_gift_grants (user_id, created_at DESC);
CREATE TRIGGER vip_gift_grants_append_only BEFORE UPDATE OR DELETE ON vip_gift_grants FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

-- 每月 VIP 優惠券（discount_pct 5 = 95折；當月有效，至下月 1 日 00:00 台灣時間）
CREATE TABLE vip_coupons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  grant_id      uuid NOT NULL REFERENCES vip_gift_grants(id),
  discount_pct  integer NOT NULL CHECK (discount_pct BETWEEN 1 AND 90),
  label         text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
  valid_from    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL CHECK (expires_at > valid_from),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vip_coupons_user_idx ON vip_coupons (user_id, expires_at);

-- 年度重新評等（每人每年一次）
CREATE TABLE vip_ratings (
  user_id         uuid NOT NULL REFERENCES users(id),
  year            integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  from_level      integer NOT NULL,
  computed_level  integer NOT NULL,
  to_level        integer NOT NULL,
  window_spend    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, year),
  CHECK (to_level >= from_level - 1)
);

-- 既有抽賞：補記花費事件與累計（不補發升級禮；升級禮於下一次抽賞結算時補發尚未領取的等級）
INSERT INTO vip_spend_events (user_id, draw_id, kind, ref_id, amount, occurred_at)
  SELECT user_id, id, 'DRAW', id::text, amount_coins, created_at FROM draws WHERE amount_coins > 0 ORDER BY created_at;
INSERT INTO vip_members (user_id, qualifying_spend, lifetime_spend)
  SELECT user_id, sum(amount), sum(amount) FROM vip_spend_events GROUP BY user_id;
UPDATE vip_members m SET level = (SELECT max(t.level) FROM vip_tiers t WHERE t.spend_threshold <= m.qualifying_spend);

-- ───────────────────────── 4. 每日簽到 ─────────────────────────
CREATE TABLE member_checkins (
  user_id     uuid NOT NULL REFERENCES users(id),
  day         date NOT NULL,                 -- 台灣日期
  week_start  date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  seq         integer NOT NULL CHECK (seq BETWEEN 1 AND 7),
  coins       integer NOT NULL CHECK (coins > 0),
  ledger_id   bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day),
  UNIQUE (user_id, week_start, seq),
  CHECK (day >= week_start AND day < week_start + 7)
);
CREATE TRIGGER member_checkins_append_only BEFORE UPDATE OR DELETE ON member_checkins FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();
