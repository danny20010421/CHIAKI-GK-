-- CHIAKI platform — 業主 2026-10（第五批）：機率賞（playType = 'PROB'）（不修改已套用的 migration）
--   等級可設定固定的單抽機率 odds（0 < odds < 1；所有等級 odds 總和 < 1，由應用層驗證）。
--   庫存仍是有限的籤；每次抽出由伺服器以可驗證的種子流（chiaki-prob-v1）決定：
--     每套發布時產生 server seed，只公開 sha256(seed)；每筆抽賞記錄 client seed 與 nonce；完售後公開 seed 供重算。

ALTER TABLE pools DROP CONSTRAINT pools_play_type_check;
ALTER TABLE pools ADD CONSTRAINT pools_play_type_check CHECK (play_type IN ('STANDARD', 'GUARANTEE', 'SOLO', 'PROB'));

ALTER TABLE pool_levels ADD COLUMN odds double precision CHECK (odds IS NULL OR (odds > 0 AND odds < 1));

ALTER TABLE pool_sets ADD COLUMN prob_seed_hash text;            -- 公開：sha256(server seed bytes)
ALTER TABLE pool_sets ADD COLUMN prob_server_seed text;          -- 機密：完售前任何 API 不得輸出
ALTER TABLE pool_sets ADD COLUMN prob_nonce integer NOT NULL DEFAULT 0 CHECK (prob_nonce >= 0);
ALTER TABLE pool_sets ADD CONSTRAINT pool_sets_prob_seed_pair CHECK ((prob_seed_hash IS NULL) = (prob_server_seed IS NULL));

ALTER TABLE draws ADD COLUMN prob_client_seed text CHECK (prob_client_seed IS NULL OR length(prob_client_seed) BETWEEN 1 AND 128);
ALTER TABLE draws ADD COLUMN prob_nonce integer;
ALTER TABLE draws ADD CONSTRAINT draws_prob_pair CHECK ((prob_client_seed IS NULL) = (prob_nonce IS NULL));
CREATE UNIQUE INDEX draws_prob_nonce_uniq ON draws (set_id, prob_nonce) WHERE prob_nonce IS NOT NULL;

-- 種子承諾與籤表承諾一樣不可變（0 銷售重新產生時例外，見 20261030）
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
     OR NEW.total_tickets IS DISTINCT FROM OLD.total_tickets
     OR NEW.prob_seed_hash IS DISTINCT FROM OLD.prob_seed_hash OR NEW.prob_server_seed IS DISTINCT FROM OLD.prob_server_seed THEN
    IF NOT (COALESCE(current_setting('chiaki.relayout', true), '') = 'on' AND NOT EXISTS (SELECT 1 FROM draws d WHERE d.set_id = OLD.id)) THEN
      RAISE EXCEPTION 'set commitment is immutable' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.prob_nonce < OLD.prob_nonce THEN
    RAISE EXCEPTION 'prob nonce cannot go back' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'SOLD_OUT' AND NEW.status <> 'SOLD_OUT' THEN
    RAISE EXCEPTION 'sold-out set cannot reopen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
