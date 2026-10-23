-- CHIAKI platform — 業主 2026-10（第四批追加）：後台管理賞池與套（修正錯誤用）（不修改已套用的 migration）
--   1. 下架 / 重新上架：pools.offline、pool_sets.offline（下架者不出現在公開列表、不可鎖籤或購買；既有抽賞與倉庫不受影響）
--   2. 套的顯示名稱、內部備註；0 銷售的套可重新產生籤表與新承諾雜湊（舊承諾與 salt 保存在 pool_set_commit_history，可公開驗證）
--   3. 軟刪除（deleted_at，30 天內可還原），30 天後由排程硬刪除；只允許 0 銷售的賞池/套
--   不變式仍由資料庫保證：已有抽賞（draws）的套，承諾/籤表永遠不可改、不可刪；只有交易內明確 SET LOCAL 的
--   chiaki.relayout（重新產生籤表）或 chiaki.purge（硬刪除）才可對「0 銷售」的套動作。

ALTER TABLE pools ADD COLUMN offline boolean NOT NULL DEFAULT false;
ALTER TABLE pools ADD COLUMN deleted_at timestamptz;
ALTER TABLE pools ADD COLUMN delete_reason text;
CREATE INDEX pools_deleted_idx ON pools (deleted_at) WHERE deleted_at IS NOT NULL;

ALTER TABLE pool_sets ADD COLUMN offline boolean NOT NULL DEFAULT false;
ALTER TABLE pool_sets ADD COLUMN display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 100);
ALTER TABLE pool_sets ADD COLUMN internal_note text NOT NULL DEFAULT '' CHECK (length(internal_note) <= 2000);
ALTER TABLE pool_sets ADD COLUMN deleted_at timestamptz;
ALTER TABLE pool_sets ADD COLUMN delete_reason text;
CREATE INDEX pool_sets_deleted_idx ON pool_sets (deleted_at) WHERE deleted_at IS NOT NULL;

-- 被取代的承諾（重新產生籤表前的版本）：0 銷售才可能被取代，因此舊 salt 與籤表可直接公開
CREATE TABLE pool_set_commit_history (
  id              bigserial PRIMARY KEY,
  pool_id         uuid NOT NULL,
  set_id          uuid NOT NULL,
  set_no          integer NOT NULL,
  commit_scheme   text NOT NULL,
  commitment      text NOT NULL,
  commit_salt     text NOT NULL,
  rules_hash      text NOT NULL,
  layout_json     text NOT NULL,
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  superseded_by   uuid REFERENCES users(id),
  superseded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pool_set_commit_history_set_idx ON pool_set_commit_history (set_id, id);
CREATE TRIGGER pool_set_commit_history_append_only BEFORE UPDATE OR DELETE ON pool_set_commit_history
  FOR EACH ROW EXECUTE FUNCTION chiaki_forbid_mutation();

-- 有銷售（任何 draws 列）＝不可改承諾、不可刪
CREATE OR REPLACE FUNCTION chiaki_set_commitment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('chiaki.purge', true), '') = 'on' AND NOT EXISTS (SELECT 1 FROM draws d WHERE d.set_id = OLD.id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'published sets cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.commitment IS DISTINCT FROM OLD.commitment OR NEW.commit_salt IS DISTINCT FROM OLD.commit_salt
     OR NEW.commit_scheme IS DISTINCT FROM OLD.commit_scheme OR NEW.rule_version_id IS DISTINCT FROM OLD.rule_version_id
     OR NEW.total_tickets IS DISTINCT FROM OLD.total_tickets THEN
    IF NOT (COALESCE(current_setting('chiaki.relayout', true), '') = 'on' AND NOT EXISTS (SELECT 1 FROM draws d WHERE d.set_id = OLD.id)) THEN
      RAISE EXCEPTION 'set commitment is immutable' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF OLD.status = 'SOLD_OUT' AND NEW.status <> 'SOLD_OUT' THEN
    RAISE EXCEPTION 'sold-out set cannot reopen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION chiaki_ticket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('chiaki.purge', true), '') = 'on' AND OLD.status = 'AVAILABLE' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'tickets cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.ticket_no IS DISTINCT FROM OLD.ticket_no OR NEW.set_id IS DISTINCT FROM OLD.set_id THEN
    RAISE EXCEPTION 'ticket layout is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.prize_id IS DISTINCT FROM OLD.prize_id THEN
    IF NOT (COALESCE(current_setting('chiaki.relayout', true), '') = 'on' AND OLD.status = 'AVAILABLE' AND NEW.status = 'AVAILABLE'
            AND NOT EXISTS (SELECT 1 FROM draws d WHERE d.set_id = OLD.set_id)) THEN
      RAISE EXCEPTION 'ticket layout is immutable' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF OLD.status = 'TAKEN' AND (NEW.status <> 'TAKEN' OR NEW.taken_by IS DISTINCT FROM OLD.taken_by OR NEW.draw_id IS DISTINCT FROM OLD.draw_id) THEN
    RAISE EXCEPTION 'taken ticket is final' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION chiaki_rule_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL
       AND NOT (COALESCE(current_setting('chiaki.purge', true), '') = 'on' AND NOT EXISTS (SELECT 1 FROM draws d WHERE d.rule_version_id = OLD.id)) THEN
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
