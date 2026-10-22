-- CHIAKI platform — 業主 2026-10（第二批）規則與營運模組（不修改已套用的 migration）
--   1. 不可退款代幣來源（到期轉換、邀請獎勵、運費部分退還）一律不可退款
--   2/3/4. 運費預收門檻改為 floor((持有小獎 + 本次籤數) / 20) + 1；回收後多收的運費自動按比例退為不可退款代幣，
--          或由會員申請新台幣退款（銀行轉帳 / 綠界刷退；雙人覆核撥款；同一份運費只能擇一）
--   5. 抽賞紀錄：會員只看得到近 3 個月；超過 90 天的紀錄「標記封存」（不刪除，保留會計/爭議證據，稽核鏈不變）
--   6. 邀請碼與邀請獎勵（20 位完成手機驗證 → 邀請人 1000 不可退款代幣，一次）
--   7. 安全：封鎖清單、登入失敗鎖定、風控事件類型擴充
--   8. 後台密碼登入（scrypt）、MFA（TOTP）、session 重新驗證時間
--   9. 客服工單
--  10. 通知外送佇列（簡訊 / LINE / Web Push / Email）、偏好設定、推播訂閱
--  11. 出貨流程（申請 → 揀貨 → 包裝 → 已出貨 → 已送達；退件 / 異常）、物流商與追蹤網址
--  12. IP（作品）與分類管理

-- ───────────────────────── 1. 錢包：新帳本類型與不可退款來源 ─────────────────────────
ALTER TABLE wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK (entry_type IN (
  'TOPUP', 'DRAW_DEBIT', 'PURCHASE_DEBIT', 'SHIPPING_FEE', 'SHIPPING_PREPAID', 'RECYCLE_CREDIT', 'EXPIRY_AUTO_CONVERT',
  'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD', 'CS_COMPENSATION',
  'REFUND_DEBIT', 'ADMIN_ADJUST', 'BIND_REWARD', 'TOPUP_BONUS'));
ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_currency_rules;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_currency_rules CHECK (
  (entry_type IN ('TOPUP', 'REFUND_DEBIT', 'DRAW_DEBIT', 'SHIPPING_PREPAID', 'EXPIRY_AUTO_CONVERT', 'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD') AND currency = 'COINS')
  OR (entry_type IN ('RECYCLE_CREDIT', 'BIND_REWARD', 'TOPUP_BONUS', 'CS_COMPENSATION') AND currency = 'POINTS')
  OR entry_type IN ('PURCHASE_DEBIT', 'SHIPPING_FEE', 'ADMIN_ADJUST'));
ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_sign_rules;
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_sign_rules CHECK (
  (entry_type NOT IN ('SHIPPING_PREPAID', 'DRAW_DEBIT', 'REFUND_DEBIT') OR amount < 0)
  AND (entry_type NOT IN ('EXPIRY_AUTO_CONVERT', 'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD', 'CS_COMPENSATION') OR amount > 0));
-- 業主規則：這三種代幣「不可退款・無法轉換」。NOT VALID：舊資料（若曾以 EXPIRY_COINS_REFUNDABLE=true 入帳）不追溯，新資料一律強制。
ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_nonrefundable_sources CHECK (
  entry_type NOT IN ('EXPIRY_AUTO_CONVERT', 'SHIPPING_REFUND_COINS', 'REFERRAL_REWARD') OR refundable = false) NOT VALID;

-- ───────────────────────── 3/4. 運費退還（代幣部分退還 / 新台幣退款申請） ─────────────────────────
-- 每列 = 一份預收運費的退還。同一份運費同時只能有一筆「非駁回」的退還（代幣與現金擇一，資料庫保證）。
-- 有效（仍計入已付份數）的預收運費 = shipping_prepayments − 有非駁回退還列者。
CREATE TABLE shipping_fee_refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  set_id            uuid NOT NULL REFERENCES pool_sets(id),
  prepayment_id     uuid NOT NULL REFERENCES shipping_prepayments(id),
  mode              text NOT NULL CHECK (mode IN ('COINS', 'CASH')),
  fee_coins         bigint NOT NULL CHECK (fee_coins > 0),
  ratio_bp          integer NOT NULL CHECK (ratio_bp BETWEEN 0 AND 10000),   -- 退還比例（萬分比）
  amount            bigint NOT NULL CHECK (amount >= 0),                       -- COINS：退回代幣；CASH：新台幣
  payout_method     text CHECK (payout_method IN ('BANK_TRANSFER', 'ECPAY_CARD')),
  bank_code         text,
  bank_account      text,
  account_name      text,
  payment_order_id  uuid REFERENCES payment_orders(id),
  status            text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAID')),
  reason            text NOT NULL DEFAULT '',
  ledger_id         bigint,
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  paid_by           uuid REFERENCES users(id),
  paid_at           timestamptz,
  provider_ref      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'COINS') = (payout_method IS NULL)),
  CHECK (mode <> 'COINS' OR status = 'PAID'),
  CHECK (payout_method IS DISTINCT FROM 'BANK_TRANSFER' OR (bank_code IS NOT NULL AND bank_account IS NOT NULL AND account_name IS NOT NULL)),
  CHECK (payout_method IS DISTINCT FROM 'ECPAY_CARD' OR payment_order_id IS NOT NULL),
  CHECK (mode = 'COINS' OR status <> 'PAID' OR (paid_by IS NOT NULL AND paid_at IS NOT NULL)),
  -- 雙人覆核：核准者與撥款者不可為同一人
  CONSTRAINT shipping_refund_two_person CHECK (mode = 'COINS' OR paid_by IS NULL OR (decided_by IS NOT NULL AND paid_by <> decided_by))
);
CREATE UNIQUE INDEX shipping_fee_refunds_one_active ON shipping_fee_refunds (prepayment_id) WHERE status <> 'REJECTED';
CREATE INDEX shipping_fee_refunds_user_idx ON shipping_fee_refunds (user_id, set_id);
CREATE INDEX shipping_fee_refunds_status_idx ON shipping_fee_refunds (status, created_at) WHERE mode = 'CASH';
CREATE FUNCTION chiaki_shipping_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping fee refunds cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.prepayment_id IS DISTINCT FROM OLD.prepayment_id OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.fee_coins IS DISTINCT FROM OLD.fee_coins OR NEW.ratio_bp IS DISTINCT FROM OLD.ratio_bp THEN
    RAISE EXCEPTION 'shipping fee refund core fields are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.mode = 'COINS' THEN
    RAISE EXCEPTION 'coin shipping refunds are final' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'PAID')) THEN
    RAISE EXCEPTION 'invalid shipping refund transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipping_fee_refunds_guard BEFORE UPDATE OR DELETE ON shipping_fee_refunds
  FOR EACH ROW EXECUTE FUNCTION chiaki_shipping_refund_guard();

-- ───────────────────────── 5. 抽賞紀錄保存：封存標記（不刪除） ─────────────────────────
-- 台灣商業會計法要求會計憑證/帳簿保存多年，且抽賞爭議需要證據 → draws/draw_results 永不刪除（append-only trigger 仍有效）。
-- 會員可見範圍＝近 90 天且未封存；封存工作只「新增」封存標記列，不改動原始紀錄，稽核雜湊鏈不受影響。
CREATE TABLE draw_archive (
  draw_id          uuid PRIMARY KEY REFERENCES draws(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  batch_id         uuid NOT NULL,
  draw_created_at  timestamptz NOT NULL,
  archived_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX draw_archive_batch_idx ON draw_archive (batch_id);
CREATE TRIGGER draw_archive_append_only BEFORE UPDATE OR DELETE ON draw_archive FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();
CREATE TRIGGER draw_archive_no_truncate BEFORE TRUNCATE ON draw_archive FOR EACH STATEMENT EXECUTE FUNCTION chiaki_forbid_mutation();
CREATE INDEX draws_user_created_idx ON draws (user_id, created_at DESC);
CREATE VIEW member_draw_history AS
  SELECT d.* FROM draws d
  WHERE d.created_at > now() - interval '90 days'
    AND NOT EXISTS (SELECT 1 FROM draw_archive a WHERE a.draw_id = d.id);

-- ───────────────────────── 6. 邀請碼 / 邀請獎勵 ─────────────────────────
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
UPDATE users SET phone_verified_at = created_at WHERE phone IS NOT NULL;   -- 既有會員皆以手機 OTP 註冊
ALTER TABLE users ADD COLUMN email text;

CREATE TABLE referral_codes (
  user_id     uuid PRIMARY KEY REFERENCES users(id),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6,12}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE referrals (
  invitee_id          uuid PRIMARY KEY REFERENCES users(id),
  inviter_id          uuid NOT NULL REFERENCES users(id),
  code                text NOT NULL,
  status              text NOT NULL CHECK (status IN ('PENDING', 'QUALIFIED', 'FLAGGED')),
  flag_reasons        text NOT NULL DEFAULT '[]',
  signup_ip           text,
  device_fingerprint  text,
  phone               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  qualified_at        timestamptz,
  CHECK (invitee_id <> inviter_id),
  CHECK ((status = 'QUALIFIED') = (qualified_at IS NOT NULL))
);
CREATE INDEX referrals_inviter_idx ON referrals (inviter_id, status);
-- 每位邀請人只能領一次（PK）
CREATE TABLE referral_rewards (
  inviter_id  uuid PRIMARY KEY REFERENCES users(id),
  milestone   integer NOT NULL CHECK (milestone > 0),
  coins       bigint NOT NULL CHECK (coins > 0),
  ledger_id   bigint NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── 7. 安全 ─────────────────────────
ALTER TABLE risk_events DROP CONSTRAINT risk_events_type_check;
ALTER TABLE risk_events ADD CONSTRAINT risk_events_type_check CHECK (type IN (
  'RATE_LIMIT_HOLD', 'RATE_LIMIT_DRAW', 'MULTI_ACCOUNT_DEVICE', 'LARGE_TOPUP', 'PAYMENT_MISMATCH',
  'RATE_LIMIT_IP', 'RATE_LIMIT_USER', 'BLOCKED_REQUEST', 'BOT_SUSPECTED', 'LOGIN_LOCKOUT', 'CSRF_REJECTED',
  'ADMIN_ACCESS_DENIED', 'ECPAY_NOTIFY_REJECTED', 'REFERRAL_ABUSE', 'PAYLOAD_REJECTED'));
ALTER TABLE risk_events ADD COLUMN ip text;
CREATE INDEX risk_events_type_idx ON risk_events (type, created_at);

CREATE TABLE access_blocklist (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('IP', 'DEVICE')),
  value       text NOT NULL CHECK (length(value) BETWEEN 1 AND 200),
  reason      text NOT NULL DEFAULT '',
  expires_at  timestamptz,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

-- 登入失敗鎖定（key：admin:<loginId> / otp:<phone>）
CREATE TABLE auth_lockouts (
  key              text PRIMARY KEY,
  failures         integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until     timestamptz,
  last_failure_at  timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── 8. 後台帳號：密碼（scrypt）、MFA、重新驗證 ─────────────────────────
ALTER TABLE auth_sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'OTP' CHECK (auth_method IN ('OTP', 'PASSWORD', 'LINE'));
ALTER TABLE auth_sessions ADD COLUMN reauth_at timestamptz;
ALTER TABLE auth_sessions ADD COLUMN mfa_verified_at timestamptz;

CREATE TABLE admin_credentials (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  login_id                text NOT NULL UNIQUE CHECK (login_id ~ '^[a-z0-9._-]{3,64}$'),
  password_hash           text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),   -- 只存雜湊，永不存明文
  password_hint           text CHECK (length(password_hint) <= 100),             -- ⚠ 提示會降低安全性（見程式註解）
  mfa_secret_enc          text,
  mfa_pending_secret_enc  text,
  mfa_enabled_at          timestamptz,
  mfa_last_step           bigint,                                                -- TOTP 防重放：最後使用的時間步
  password_changed_at     timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((mfa_enabled_at IS NULL) = (mfa_secret_enc IS NULL))
);

-- ───────────────────────── 9. 客服工單 ─────────────────────────
CREATE TABLE cs_categories (
  code        text PRIMARY KEY CHECK (code IN ('DRAW_DISPUTE', 'TOPUP_PAYMENT', 'SHIPPING', 'ACCOUNT', 'REFUND', 'OTHER')),
  label       text NOT NULL,
  sla_hours   integer NOT NULL CHECK (sla_hours > 0),
  sort_order  integer NOT NULL DEFAULT 0
);
INSERT INTO cs_categories (code, label, sla_hours, sort_order) VALUES
  ('DRAW_DISPUTE', '抽賞爭議', 24, 1),
  ('TOPUP_PAYMENT', '儲值/付款', 24, 2),
  ('SHIPPING', '出貨/物流', 48, 3),
  ('ACCOUNT', '帳號', 48, 4),
  ('REFUND', '退款', 72, 5),
  ('OTHER', '其他', 72, 6);

CREATE TABLE cs_tickets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id              text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  ticket_no                bigserial UNIQUE,
  user_id                  uuid NOT NULL REFERENCES users(id),
  category                 text NOT NULL REFERENCES cs_categories(code),
  subject                  text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  status                   text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'WAITING_USER', 'CLOSED')),
  assignee_id              uuid REFERENCES users(id),
  sla_due_at               timestamptz NOT NULL,
  linked_draw_id           uuid REFERENCES draws(id),
  linked_payment_order_id  uuid REFERENCES payment_orders(id),
  linked_shipment_id       uuid REFERENCES shipments(id),
  first_response_at        timestamptz,
  closed_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE INDEX cs_tickets_status_idx ON cs_tickets (status, sla_due_at);
CREATE INDEX cs_tickets_user_idx ON cs_tickets (user_id, created_at DESC);

CREATE TABLE cs_messages (
  id           bigserial PRIMARY KEY,
  ticket_id    uuid NOT NULL REFERENCES cs_tickets(id),
  author_type  text NOT NULL CHECK (author_type IN ('USER', 'STAFF', 'SYSTEM')),
  author_id    uuid REFERENCES users(id),
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  internal     boolean NOT NULL DEFAULT false,      -- 內部備註：會員看不到
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT internal OR author_type <> 'USER')
);
CREATE INDEX cs_messages_ticket_idx ON cs_messages (ticket_id, id);
CREATE TRIGGER cs_messages_append_only BEFORE UPDATE OR DELETE ON cs_messages FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

CREATE TABLE cs_canned_replies (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  category    text REFERENCES cs_categories(code),
  title       text NOT NULL,
  body        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);
INSERT INTO cs_canned_replies (code, category, title, body, sort_order) VALUES
  ('GREETING', NULL, '收到詢問', '您好，CHIAKI 客服已收到您的問題，我們會儘快為您處理，請稍候。', 1),
  ('DRAW_VERIFY', 'DRAW_DISPUTE', '抽賞公平性說明', '您好，每一套籤表於開賣前即以雜湊承諾公開，完售後可於該套頁面下載籤表與 salt 自行驗證。我們已調閱您的抽賞紀錄，將於查核後回覆您。', 2),
  ('TOPUP_CHECKING', 'TOPUP_PAYMENT', '儲值查核中', '您好，我們正在向金流服務商查詢此筆付款狀態，確認後會立即為您補入代幣並通知您。', 3),
  ('SHIPPING_TRACKING', 'SHIPPING', '提供追蹤編號', '您好，您的包裹已出貨，可於「我的出貨」查看物流商與追蹤編號，點擊即可查詢配送進度。', 4),
  ('REFUND_PROCESS', 'REFUND', '退款流程說明', '您好，退款申請需經財務雙人覆核，核准後約 7–14 個工作天完成撥款，屆時會再通知您。', 5),
  ('CLOSE_THANKS', NULL, '結案感謝', '感謝您的耐心，此問題已處理完成。如仍有疑問，歡迎再次聯絡官方小編。', 6);

CREATE TABLE cs_actions (
  id                   bigserial PRIMARY KEY,
  ticket_id            uuid NOT NULL REFERENCES cs_tickets(id),
  action               text NOT NULL CHECK (action IN ('RESEND_SHIPMENT', 'EXTEND_STORAGE', 'APPROVE_REFUND', 'GRANT_COMPENSATION')),
  params_json          text NOT NULL,
  result_json          text NOT NULL,
  actor_id             uuid NOT NULL REFERENCES users(id),
  approval_request_id  uuid REFERENCES approval_requests(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cs_actions_append_only BEFORE UPDATE OR DELETE ON cs_actions FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_type_check CHECK (type IN (
  'PUBLISH_POOL', 'PUBLISH_RULE_VERSION', 'REFUND', 'BALANCE_ADJUST', 'BANK_TRANSFER_CONFIRM', 'CS_COMPENSATION'));

-- ───────────────────────── 10. 通知：外送佇列、偏好、推播訂閱 ─────────────────────────
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'STORAGE_EXPIRY_7D', 'STORAGE_EXPIRY_TODAY', 'STORAGE_AUTO_CONVERTED', 'STORAGE_EXPIRED_HOLD',
  'DRAW_RESULT', 'SHIPMENT_SHIPPED', 'REFUND_STATUS', 'SHIPPING_FEE_REFUND', 'TICKET_REPLY', 'REFERRAL_REWARD'));

CREATE TABLE notification_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  event_type       text NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('IN_APP', 'SMS', 'LINE', 'WEB_PUSH', 'EMAIL')),
  idempotency_key  text NOT NULL UNIQUE,              -- <事件鍵>:<管道>
  destination      text,
  title            text NOT NULL,
  body             text NOT NULL,
  payload_json     text NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text,
  provider_ref     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox (next_attempt_at) WHERE status IN ('PENDING', 'SENDING');
CREATE INDEX notification_outbox_user_idx ON notification_outbox (user_id, created_at DESC);

CREATE TABLE notification_preferences (
  user_id     uuid NOT NULL REFERENCES users(id),
  channel     text NOT NULL CHECK (channel IN ('IN_APP', 'SMS', 'LINE', 'WEB_PUSH', 'EMAIL')),
  event_type  text NOT NULL,                          -- 事件類型或 '*'（該管道全部事件）
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel, event_type)
);

CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  endpoint    text NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%'),
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE revoked_at IS NULL;

-- ───────────────────────── 11. 出貨流程與物流商 ─────────────────────────
CREATE TABLE carriers (
  code                   text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  label                  text NOT NULL,
  category               text NOT NULL CHECK (category IN ('HOME', 'CVS_711', 'CVS_FAMI')),
  tracking_url_template  text NOT NULL CHECK (tracking_url_template LIKE 'https://%{no}%'),
  active                 boolean NOT NULL DEFAULT true,
  sort_order             integer NOT NULL DEFAULT 0
);
-- 追蹤網址為各物流商公開查詢頁（上線前請以實際單號驗證，可於後台/SQL 調整）
INSERT INTO carriers (code, label, category, tracking_url_template, sort_order) VALUES
  ('TCAT', '黑貓宅急便', 'HOME', 'https://www.t-cat.com.tw/Inquire/Trace.aspx?no={no}', 1),
  ('HCT', '新竹物流', 'HOME', 'https://www.hct.com.tw/Search/SearchGoods_n.aspx?no={no}', 2),
  ('POST', '中華郵政', 'HOME', 'https://postserv.post.gov.tw/pstmail/main_mail.html?targetTxn=EB500100&MAILNO={no}', 3),
  ('SEVEN_C2C', '7-ELEVEN 交貨便', 'CVS_711', 'https://eservice.7-11.com.tw/e-tracking/search.aspx?shipNo={no}', 4),
  ('FAMI_C2C', '全家店到店', 'CVS_FAMI', 'https://fmec.famiport.com.tw/FP_Entrance/QueryBox?orderNo={no}', 5);

ALTER TABLE shipments DROP CONSTRAINT shipments_status_check;
ALTER TABLE shipments ADD CONSTRAINT shipments_status_check CHECK (status IN (
  'REQUESTED', 'PICKING', 'PACKING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'EXCEPTION', 'CANCELLED'));
ALTER TABLE shipments ADD COLUMN carrier text REFERENCES carriers(code);
ALTER TABLE shipments ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0);
ALTER TABLE shipments ADD COLUMN picking_at timestamptz;
ALTER TABLE shipments ADD COLUMN packing_at timestamptz;
ALTER TABLE shipments ADD COLUMN returned_at timestamptz;
ALTER TABLE shipments ADD COLUMN exception_at timestamptz;
ALTER TABLE shipments ADD COLUMN exception_note text;
ALTER TABLE shipments ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- 標記已出貨必須有物流商與追蹤編號（NOT VALID：舊的已出貨資料不追溯）
ALTER TABLE shipments ADD CONSTRAINT shipments_tracking_required CHECK (
  status NOT IN ('SHIPPED', 'DELIVERED') OR (carrier IS NOT NULL AND tracking_no IS NOT NULL)) NOT VALID;
CREATE INDEX shipments_status_idx ON shipments (status, created_at);
CREATE FUNCTION chiaki_shipment_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipments cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REQUESTED' AND NEW.status IN ('PICKING', 'EXCEPTION', 'CANCELLED'))
    OR (OLD.status = 'PICKING' AND NEW.status IN ('PACKING', 'EXCEPTION'))
    OR (OLD.status = 'PACKING' AND NEW.status IN ('SHIPPED', 'EXCEPTION'))
    OR (OLD.status = 'SHIPPED' AND NEW.status IN ('DELIVERED', 'RETURNED', 'EXCEPTION'))
    OR (OLD.status IN ('RETURNED', 'EXCEPTION') AND NEW.status = 'PICKING')) THEN
    RAISE EXCEPTION 'invalid shipment transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipments_transition BEFORE UPDATE OR DELETE ON shipments FOR EACH ROW EXECUTE FUNCTION chiaki_shipment_transition();

-- ───────────────────────── 12. IP（作品）管理 ─────────────────────────
CREATE TABLE ip_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
  sort_order  integer NOT NULL DEFAULT 0,
  visible     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ip_categories (code, name, sort_order) VALUES ('ANIME', '動畫', 1), ('GAME', '遊戲', 2), ('MANGA', '漫畫', 3), ('ORIGINAL', '原創', 4);

CREATE TABLE ips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  category_id  uuid REFERENCES ip_categories(id),
  sort_order   integer NOT NULL DEFAULT 0,
  visible      boolean NOT NULL DEFAULT true,
  cover_url    text CHECK (cover_url IS NULL OR cover_url LIKE 'https://%' OR cover_url LIKE '/%'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, name)
);
CREATE INDEX ips_category_idx ON ips (category_id, sort_order);
ALTER TABLE pools ADD COLUMN ip_id uuid REFERENCES ips(id);
CREATE INDEX pools_ip_idx ON pools (ip_id);
-- 回填：既有賞池的 IP 文字 → 建立未分類 IP（後台再指定分類）
INSERT INTO ips (merchant_id, slug, name, sort_order)
  SELECT merchant_id, 'ip-' || substr(md5(merchant_id || ':' || ip), 1, 12), ip, row_number() OVER (ORDER BY ip)
  FROM (SELECT DISTINCT merchant_id, ip FROM pools WHERE ip <> '') x;
UPDATE pools p SET ip_id = i.id FROM ips i WHERE i.merchant_id = p.merchant_id AND i.name = p.ip AND p.ip <> '';
