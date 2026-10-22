-- CHIAKI platform — 圖片素材（伺服器端驗證；不信任副檔名/MIME，以實際檔頭解析格式與尺寸）
-- 素材內容暫存於資料庫 bytea（單檔上限 1.5 MB）；流量變大時建議改存物件儲存（S3/R2）並只在此保留中繼資料。

CREATE TABLE assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id          text NOT NULL DEFAULT 'chiaki' REFERENCES merchants(id),
  type                 text NOT NULL CHECK (type IN ('cover', 'prize', 'banner', 'bannerM', 'event', 'eventBody', 'ticket', 'ip', 'product', 'partner', 'og')),
  format               text NOT NULL CHECK (format IN ('png', 'jpeg', 'webp')),
  width                integer NOT NULL CHECK (width > 0),
  height               integer NOT NULL CHECK (height > 0),
  bytes                integer NOT NULL CHECK (bytes > 0),
  sha256               text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  alt_text             text NOT NULL CHECK (length(btrim(alt_text)) BETWEEN 1 AND 200),
  copyright_confirmed  boolean NOT NULL CHECK (copyright_confirmed),   -- 上傳者必須確認擁有使用授權
  original_filename    text,
  uploaded_by          uuid NOT NULL REFERENCES users(id),
  content              bytea NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) = bytes),
  UNIQUE (type, sha256)
);
CREATE INDEX assets_type_idx ON assets (type, created_at DESC);

-- 素材連結：賞池 / 獎項 / 橫幅 / IP / 合作夥伴 / 商城商品（橫幅與合作夥伴尚無資料表，以識別碼 slug 連結）
CREATE TABLE asset_links (
  asset_id     uuid NOT NULL REFERENCES assets(id),
  target_type  text NOT NULL CHECK (target_type IN ('POOL', 'PRIZE', 'BANNER', 'IP', 'PARTNER', 'PRODUCT')),
  target_id    text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 100),
  role         text NOT NULL DEFAULT 'main' CHECK (role ~ '^[a-z][a-z0-9_-]{0,29}$'),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, target_type, target_id, role)
);
CREATE INDEX asset_links_target_idx ON asset_links (target_type, target_id);
