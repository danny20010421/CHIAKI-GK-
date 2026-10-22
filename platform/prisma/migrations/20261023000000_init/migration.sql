-- CHIAKI platform — initial schema (PostgreSQL 14+)
-- 慣例：snake_case；金額/代幣/點數一律 bigint 整數（1 代幣 = 最小單位，不使用浮點數）。
-- 每個賞池/商品/訂單/帳本列皆帶 merchant_id（預設 'chiaki'），為 P4 多商家預留。

-- ───────────────────────── 共用：append-only 防護 ─────────────────────────
CREATE FUNCTION chiaki_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table "%": % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

-- ───────────────────────── merchant ─────────────────────────
CREATE TABLE merchants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO merchants (id, name) VALUES ('chiaki', 'CHIAKI GARAGE KIT');

-- ───────────────────────── auth ─────────────────────────
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone            text UNIQUE,
  line_user_id     text UNIQUE,
  display_name     text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  birth_date       date,
  age_verified_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('SUPER_ADMIN', 'OPS', 'FINANCE', 'CS', 'MERCHANT', 'MEMBER')),
  merchant_id  text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE auth_sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE user_devices (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint    text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint)
);
CREATE INDEX user_devices_fp_idx ON user_devices (fingerprint);

-- ───────────────────────── wallet ─────────────────────────
-- coins = 儲值代幣（可依政策申請退款）；points = 平台點數（永不可提領/現金化）
CREATE TABLE wallets (
  user_id      uuid PRIMARY KEY REFERENCES users(id),
  merchant_id  text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  coins        bigint NOT NULL DEFAULT 0 CHECK (coins >= 0),
  points       bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_ledger (
  id             bigserial PRIMARY KEY,
  merchant_id    text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  currency       text NOT NULL CHECK (currency IN ('COINS', 'POINTS')),
  amount         bigint NOT NULL CHECK (amount <> 0),
  balance_after  bigint NOT NULL CHECK (balance_after >= 0),
  entry_type     text NOT NULL CHECK (entry_type IN (
                   'TOPUP', 'DRAW_DEBIT', 'PURCHASE_DEBIT', 'SHIPPING_FEE', 'RECYCLE_CREDIT',
                   'REFUND_DEBIT', 'ADMIN_ADJUST', 'BIND_REWARD', 'TOPUP_BONUS')),
  ref_type       text NOT NULL,
  ref_id         text NOT NULL,
  memo           text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- 點數不可由儲值購得、不可退款成現金；儲值只入代幣
  CONSTRAINT ledger_currency_rules CHECK (
    (entry_type IN ('TOPUP', 'REFUND_DEBIT', 'DRAW_DEBIT') AND currency = 'COINS')
    OR (entry_type IN ('RECYCLE_CREDIT', 'BIND_REWARD', 'TOPUP_BONUS') AND currency = 'POINTS')
    OR entry_type IN ('PURCHASE_DEBIT', 'SHIPPING_FEE', 'ADMIN_ADJUST'))
);
CREATE INDEX wallet_ledger_user_idx ON wallet_ledger (user_id, currency, id);
-- 同一筆付款訂單只能入帳一次（防重複通知的第二道防線）
CREATE UNIQUE INDEX wallet_ledger_topup_once ON wallet_ledger (ref_type, ref_id, currency) WHERE entry_type IN ('TOPUP', 'TOPUP_BONUS');
CREATE TRIGGER wallet_ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();
CREATE TRIGGER wallet_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger FOR EACH STATEMENT EXECUTE FUNCTION chiaki_forbid_mutation();

CREATE TABLE refund_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id          text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  amount_coins         bigint NOT NULL CHECK (amount_coins > 0),
  reason               text NOT NULL DEFAULT '',
  status               text NOT NULL DEFAULT 'REQUESTED'
                       CHECK (status IN ('REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PAID')),
  approval_request_id  uuid,
  decided_by           uuid,
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refund_requests_user_idx ON refund_requests (user_id);

-- ───────────────────────── pool ─────────────────────────
CREATE TABLE pools (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id              text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  slug                     text NOT NULL UNIQUE,
  title                    text NOT NULL,
  ip                       text NOT NULL DEFAULT '',
  description              text NOT NULL DEFAULT '',
  terms                    text NOT NULL DEFAULT '',  -- 草稿條款；發布時快照進 rule version
  source                   text NOT NULL CHECK (source IN ('OFFICIAL', 'CUSTOM', 'MIXED')),
  play_type                text NOT NULL CHECK (play_type IN ('STANDARD', 'GUARANTEE', 'SOLO')),
  price_coins              bigint NOT NULL CHECK (price_coins > 0),
  set_count                integer NOT NULL CHECK (set_count BETWEEN 1 AND 1000),
  last_prize_name          text,
  status                   text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_PUBLISH', 'PUBLISHED', 'ENDED')),
  current_rule_version_id  uuid,
  created_by               uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  published_at             timestamptz
);

CREATE TABLE pool_prizes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id      uuid NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  rank         text NOT NULL,
  tier         integer NOT NULL CHECK (tier >= 0),
  name         text NOT NULL,
  qty_per_set  integer NOT NULL CHECK (qty_per_set > 0),
  sort_order   integer NOT NULL DEFAULT 0,
  UNIQUE (pool_id, rank)
);

CREATE TABLE pool_guarantees (
  pool_id             uuid PRIMARY KEY REFERENCES pools(id) ON DELETE CASCADE,
  every_n             integer NOT NULL CHECK (every_n > 0),
  min_tier            integer NOT NULL CHECK (min_tier >= 0),
  reserve_rank        text NOT NULL,
  reserve_prize_name  text NOT NULL,
  reserve_total       integer NOT NULL CHECK (reserve_total >= 0),
  reserve_used        integer NOT NULL DEFAULT 0,
  CHECK (reserve_used >= 0 AND reserve_used <= reserve_total)
);

CREATE TABLE guarantee_counters (
  user_id     uuid NOT NULL REFERENCES users(id),
  pool_id     uuid NOT NULL REFERENCES pools(id),
  misses      integer NOT NULL DEFAULT 0 CHECK (misses >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pool_id)
);

-- 規則版本：發布後不可修改，任何修改產生新版本
CREATE TABLE pool_rule_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  pool_id       uuid NOT NULL REFERENCES pools(id),
  version       integer NOT NULL CHECK (version > 0),
  rules_json    text NOT NULL,
  rules_hash    text NOT NULL,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  UNIQUE (pool_id, version)
);
CREATE FUNCTION chiaki_rule_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'published rule version % is immutable', OLD.id USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'published rule version % is immutable', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.rules_json IS DISTINCT FROM OLD.rules_json OR NEW.rules_hash IS DISTINCT FROM OLD.rules_hash
     OR NEW.pool_id IS DISTINCT FROM OLD.pool_id OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'rule version content cannot change; create a new version' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pool_rule_versions_immutable BEFORE UPDATE OR DELETE ON pool_rule_versions
  FOR EACH ROW EXECUTE FUNCTION chiaki_rule_version_immutable();
ALTER TABLE pools ADD CONSTRAINT pools_current_rule_version_fk
  FOREIGN KEY (current_rule_version_id) REFERENCES pool_rule_versions(id);

CREATE TABLE pool_sets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id         text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  pool_id             uuid NOT NULL REFERENCES pools(id),
  set_no              integer NOT NULL CHECK (set_no > 0),
  rule_version_id     uuid NOT NULL REFERENCES pool_rule_versions(id),
  status              text NOT NULL CHECK (status IN ('QUEUED', 'ON_SALE', 'SOLD_OUT')),
  total_tickets       integer NOT NULL CHECK (total_tickets > 0),
  commit_scheme       text NOT NULL,
  commitment          text NOT NULL,
  commit_salt         text NOT NULL,          -- 機密：完售前任何 API 不得輸出
  last_prize_user_id  uuid REFERENCES users(id),
  published_at        timestamptz NOT NULL DEFAULT now(),
  on_sale_at          timestamptz,
  sold_out_at         timestamptz,
  UNIQUE (pool_id, set_no)
);
CREATE FUNCTION chiaki_set_commitment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published sets cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.commitment IS DISTINCT FROM OLD.commitment OR NEW.commit_salt IS DISTINCT FROM OLD.commit_salt
     OR NEW.commit_scheme IS DISTINCT FROM OLD.commit_scheme OR NEW.rule_version_id IS DISTINCT FROM OLD.rule_version_id
     OR NEW.total_tickets IS DISTINCT FROM OLD.total_tickets THEN
    RAISE EXCEPTION 'set commitment is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'SOLD_OUT' AND NEW.status <> 'SOLD_OUT' THEN
    RAISE EXCEPTION 'sold-out set cannot reopen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pool_sets_commitment_immutable BEFORE UPDATE OR DELETE ON pool_sets
  FOR EACH ROW EXECUTE FUNCTION chiaki_set_commitment_immutable();

CREATE TABLE tickets (
  set_id      uuid NOT NULL REFERENCES pool_sets(id),
  ticket_no   integer NOT NULL CHECK (ticket_no > 0),
  prize_id    uuid NOT NULL REFERENCES pool_prizes(id),
  status      text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'TAKEN')),
  held_by     uuid REFERENCES users(id),
  held_until  timestamptz,
  taken_by    uuid REFERENCES users(id),
  draw_id     uuid,
  taken_at    timestamptz,
  PRIMARY KEY (set_id, ticket_no),
  CHECK ((status = 'TAKEN') = (taken_by IS NOT NULL AND draw_id IS NOT NULL))
);
CREATE INDEX tickets_held_by_idx ON tickets (held_by) WHERE held_by IS NOT NULL;
CREATE FUNCTION chiaki_ticket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tickets cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.prize_id IS DISTINCT FROM OLD.prize_id OR NEW.ticket_no IS DISTINCT FROM OLD.ticket_no OR NEW.set_id IS DISTINCT FROM OLD.set_id THEN
    RAISE EXCEPTION 'ticket layout is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'TAKEN' AND (NEW.status <> 'TAKEN' OR NEW.taken_by IS DISTINCT FROM OLD.taken_by OR NEW.draw_id IS DISTINCT FROM OLD.draw_id) THEN
    RAISE EXCEPTION 'taken ticket is final' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tickets_guard BEFORE UPDATE OR DELETE ON tickets FOR EACH ROW EXECUTE FUNCTION chiaki_ticket_guard();

-- ───────────────────────── draw ─────────────────────────
CREATE TABLE draws (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  pool_id          uuid NOT NULL REFERENCES pools(id),
  set_id           uuid NOT NULL REFERENCES pool_sets(id),
  rule_version_id  uuid NOT NULL REFERENCES pool_rule_versions(id),
  idempotency_key  text NOT NULL,
  ticket_count     integer NOT NULL CHECK (ticket_count > 0),
  unit_price       bigint NOT NULL CHECK (unit_price > 0),
  amount_coins     bigint NOT NULL CHECK (amount_coins > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (amount_coins = unit_price * ticket_count)
);
CREATE TRIGGER draws_append_only BEFORE UPDATE OR DELETE ON draws FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();
ALTER TABLE tickets ADD CONSTRAINT tickets_draw_fk FOREIGN KEY (draw_id) REFERENCES draws(id);

CREATE TABLE draw_results (
  id                 bigserial PRIMARY KEY,
  draw_id            uuid NOT NULL REFERENCES draws(id),
  seq                integer NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('TICKET', 'LAST', 'GUARANTEE')),
  ticket_no          integer,
  prize_id           uuid REFERENCES pool_prizes(id),
  rank               text NOT NULL,
  tier               integer NOT NULL,
  prize_name         text NOT NULL,
  warehouse_item_id  uuid NOT NULL,
  UNIQUE (draw_id, seq)
);
CREATE TRIGGER draw_results_append_only BEFORE UPDATE OR DELETE ON draw_results FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

CREATE TABLE idempotency_keys (
  user_id        uuid NOT NULL REFERENCES users(id),
  scope          text NOT NULL,
  key            text NOT NULL,
  request_hash   text NOT NULL,
  response_json  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, key)
);

-- ───────────────────────── warehouse / shipping ─────────────────────────
CREATE TABLE recycle_rates (
  merchant_id  text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  rank         text NOT NULL,
  points       bigint NOT NULL CHECK (points >= 0),
  recyclable   boolean NOT NULL,
  PRIMARY KEY (merchant_id, rank)
);

CREATE TABLE shipping_methods (
  method       text PRIMARY KEY CHECK (method IN ('HOME_DELIVERY', 'CVS_711', 'CVS_FAMI', 'CVS_HILIFE', 'CVS_OK')),
  merchant_id  text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  label        text NOT NULL,
  fee_coins    bigint NOT NULL CHECK (fee_coins >= 0),
  max_items    integer NOT NULL DEFAULT 50 CHECK (max_items > 0),
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE shipments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  method           text NOT NULL REFERENCES shipping_methods(method),
  recipient_name   text NOT NULL,
  recipient_phone  text NOT NULL,
  address          text,
  cvs_store_id     text,
  cvs_store_name   text,
  fee_coins        bigint NOT NULL CHECK (fee_coins >= 0),
  item_count       integer NOT NULL CHECK (item_count > 0),
  status           text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
  tracking_no      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  shipped_at       timestamptz,
  delivered_at     timestamptz,
  CHECK ((method = 'HOME_DELIVERY' AND address IS NOT NULL) OR (method <> 'HOME_DELIVERY' AND cvs_store_id IS NOT NULL))
);

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  sku          text NOT NULL UNIQUE,
  name         text NOT NULL,
  ip           text NOT NULL DEFAULT '',
  source       text NOT NULL CHECK (source IN ('OFFICIAL', 'CUSTOM', 'MIXED')),
  price_coins  bigint NOT NULL CHECK (price_coins > 0),
  stock        integer NOT NULL CHECK (stock >= 0),
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  product_id       uuid NOT NULL REFERENCES products(id),
  qty              integer NOT NULL CHECK (qty > 0),
  unit_price       bigint NOT NULL CHECK (unit_price > 0),
  amount_coins     bigint NOT NULL CHECK (amount_coins > 0),
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE warehouse_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  source           text NOT NULL CHECK (source IN ('TICKET', 'LAST', 'GUARANTEE', 'PURCHASE')),
  pool_id          uuid REFERENCES pools(id),
  set_id           uuid REFERENCES pool_sets(id),
  draw_id          uuid REFERENCES draws(id),
  ticket_no        integer,
  prize_id         uuid REFERENCES pool_prizes(id),
  product_id       uuid REFERENCES products(id),
  purchase_id      uuid REFERENCES purchase_orders(id),
  rank             text NOT NULL,
  prize_name       text NOT NULL,
  status           text NOT NULL DEFAULT 'STORED' CHECK (status IN ('STORED', 'SHIP_REQUESTED', 'SHIPPED', 'DELIVERED', 'RECYCLED')),
  shipment_id      uuid REFERENCES shipments(id),
  recycled_points  bigint,
  recycled_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX warehouse_items_user_idx ON warehouse_items (user_id, status);
CREATE FUNCTION chiaki_warehouse_transition() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR (OLD.status = 'SHIPPED' AND NEW.status = 'DELIVERED')) THEN
    RAISE EXCEPTION 'invalid warehouse transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER warehouse_items_transition BEFORE UPDATE OR DELETE ON warehouse_items
  FOR EACH ROW EXECUTE FUNCTION chiaki_warehouse_transition();

-- ───────────────────────── payment ─────────────────────────
CREATE TABLE payment_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id        text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id            uuid NOT NULL REFERENCES users(id),
  provider           text NOT NULL CHECK (provider IN ('ECPAY', 'BANK_TRANSFER')),
  merchant_trade_no  text NOT NULL UNIQUE,
  package_code       text NOT NULL,
  amount_twd         bigint NOT NULL CHECK (amount_twd > 0),
  coins              bigint NOT NULL CHECK (coins > 0),
  bonus_points       bigint NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'CANCELLED')),
  provider_trade_no  text,
  payment_type       text,
  bank_last5         text,
  paid_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_orders_user_idx ON payment_orders (user_id);

CREATE TABLE payment_notifications (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  merchant_trade_no  text,
  raw_body           text NOT NULL,
  mac_valid          boolean NOT NULL,
  outcome            text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payment_notifications_append_only BEFORE UPDATE OR DELETE ON payment_notifications
  FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

-- ───────────────────────── audit（hash chain） ─────────────────────────
CREATE TABLE audit_log (
  seq            bigint PRIMARY KEY,
  merchant_id    text NOT NULL DEFAULT 'chiaki',
  actor_type     text NOT NULL CHECK (actor_type IN ('USER', 'ADMIN', 'SYSTEM', 'PROVIDER')),
  actor_id       text,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text NOT NULL,
  payload_json   text NOT NULL,
  created_at     text NOT NULL,            -- ISO-8601，參與雜湊，故以文字精確保存
  prev_hash      text NOT NULL,
  hash           text NOT NULL UNIQUE
);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION chiaki_forbid_mutation();

CREATE TABLE audit_head (
  id         integer PRIMARY KEY CHECK (id = 1),
  last_seq   bigint NOT NULL,
  last_hash  text NOT NULL
);
INSERT INTO audit_head (id, last_seq, last_hash) VALUES (1, 0, repeat('0', 64));

-- ───────────────────────── admin（雙人覆核） ─────────────────────────
CREATE TABLE approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  type          text NOT NULL CHECK (type IN ('PUBLISH_POOL', 'PUBLISH_RULE_VERSION', 'REFUND', 'BALANCE_ADJUST', 'BANK_TRANSFER_CONFIRM')),
  target_id     text NOT NULL,
  payload_json  text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  result_json   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 雙人覆核：資料庫層級禁止自己核准自己的申請
  CONSTRAINT approval_two_person CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX approval_requests_status_idx ON approval_requests (status, created_at);
-- 同一標的同一類型同時間只能有一筆待審
CREATE UNIQUE INDEX approval_requests_one_pending ON approval_requests (type, target_id) WHERE status = 'PENDING';

-- ───────────────────────── risk ─────────────────────────
CREATE TABLE risk_events (
  id            bigserial PRIMARY KEY,
  merchant_id   text NOT NULL DEFAULT 'chiaki',
  user_id       uuid REFERENCES users(id),
  type          text NOT NULL CHECK (type IN ('RATE_LIMIT_HOLD', 'RATE_LIMIT_DRAW', 'MULTI_ACCOUNT_DEVICE', 'LARGE_TOPUP', 'PAYMENT_MISMATCH')),
  severity      text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  details_json  text NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_events_user_idx ON risk_events (user_id, created_at);

CREATE TABLE rate_counters (
  user_id       uuid NOT NULL REFERENCES users(id),
  action        text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL,
  PRIMARY KEY (user_id, action, window_start)
);

-- ───────────────────────── 綁定獎勵 ─────────────────────────
CREATE TABLE reward_tasks (
  code           text PRIMARY KEY CHECK (code IN ('BIND_LINE_OA', 'JOIN_LINE_COMMUNITY', 'FOLLOW_IG', 'BIND_PHONE')),
  merchant_id    text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  title          text NOT NULL,
  reward_points  bigint NOT NULL DEFAULT 0 CHECK (reward_points >= 0),
  coupon_code    text,
  active         boolean NOT NULL DEFAULT true,
  CHECK (reward_points > 0 OR coupon_code IS NOT NULL)
);

CREATE TABLE reward_claims (
  user_id     uuid NOT NULL REFERENCES users(id),
  task_code   text NOT NULL REFERENCES reward_tasks(code),
  evidence    text,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task_code)
);

CREATE TABLE user_coupons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  code         text NOT NULL,
  source       text NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
