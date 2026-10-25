# CHIAKI 平台 — 部署手冊

本手冊說明如何把 `platform/`（Next.js API ＋ PostgreSQL ＋ 背景工作）部署到正式主機。
目前還沒有公司登記、綠界帳號與簡訊帳號，所以第一次上線會是**測試模式**：網站與後台都能運作，
但**金流一律停用**（403「此為測試網站，不進行商業行為」），**簡訊 OTP 停用**（503 `SMS_DISABLED`）。
等公司成立、綠界與簡訊都申請好，再依第 9 節關閉測試模式。

---

## 0. 架構一覽

| 元件 | 說明 | 指令 |
|---|---|---|
| **app**（網站＋API） | Next.js，監聽 3000 埠 | `node server.js`（Docker 映像預設） |
| **worker**（背景工作） | 通知外送、寄存到期、抽賞紀錄封存、VIP 每月優惠券／生日禮／年度評等 | `node dist/worker.mjs` |
| **migrate**（一次性） | 套用 `prisma/migrations/*`（每次部署新版本前執行） | `node dist/migrate.mjs` |
| **PostgreSQL 16+** | 唯一的資料庫 | — |
| **媒體 CDN**（建議） | 抽賞影片、橫幅等大型檔案 | 設定 `MEDIA_BASE_URL` |

網域建議：

- 前台：`https://chiaki.tw`（或 `www.chiaki.tw`）→ app
- 後台：`https://admin.chiaki.tw` → **同一個 app**，以 `ADMIN_HOST=admin.chiaki.tw` 限定後台 API 只在這個網域提供
- 媒體：`https://cdn.chiaki.tw` → 物件儲存（Cloudflare R2、Bunny、S3 皆可）

健康檢查：

- `GET /api/health`：程序活著就回 200（不連資料庫），回應內含 `mode`（是否測試模式、金流/簡訊狀態）
- `GET /api/ready`：資料庫可連線且所有 migration 已套用才回 200，否則 503

---

## 1. 事前準備（清單）

- [ ] 一台主機或平台帳號（Zeabur / Render / 任一可跑 Docker 的 VPS）
- [ ] 網域，並可以修改 DNS（建議交給 Cloudflare 管理，可順便使用 WAF，見 `docs/security.md`）
- [ ] 產生 `MFA_ENCRYPTION_KEY`（**只產生一次，之後不可更換**，請存進密碼管理器）：
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- [ ] 建議在有網路的電腦上執行一次 `npm install`，把產生的 `package-lock.json` 一起提交，讓 Docker 建置可重現（沒有 lock 檔時 Dockerfile 會改用 `npm install`）

### 正式環境必設的環境變數

| 變數 | 值 |
|---|---|
| `NODE_ENV` | `production`（Docker 映像已預設） |
| `DATABASE_URL` | 資料庫連線字串（雲端資料庫通常要加 `?sslmode=require`） |
| `APP_BASE_URL` | `https://chiaki.tw` |
| `ADMIN_HOST` | `admin.chiaki.tw` |
| `MFA_ENCRYPTION_KEY` | 上面產生的 64 字 hex |
| `SITE_TEST_MODE` | `true`（第 9 節之前都維持 true） |
| `AUTH_DEV_STUB` / `REWARD_VERIFY_STUB` / `NOTIFY_STUB_SEND` / `ECPAY_ACCEPT_SIMULATED` | 全部 `0`（production 若為 1 會拒絕啟動） |
| `EMAIL_FROM` | 公司網域的寄件者 |

選填：`ADMIN_BASE_URL`、`CORS_ALLOWED_ORIGINS`（前台若放在別的網域）、`MEDIA_BASE_URL`、`ADMIN_IP_ALLOWLIST`、`CLIENT_IP_HEADER`（Cloudflare 前置時設 `cf-connecting-ip`）。
其餘變數都有預設值，說明見 `.env.example`（每一項都有中文註解）。

> ⚠ `.env.example` 的預設值是給**本機開發**用的（含 `AUTH_DEV_STUB=1`）。直接複製到正式環境時，
> 程式會因為開發替身未關閉而**拒絕啟動**，這是刻意的保護。請依上表修改。

---

## 2. 方案 A：VPS ＋ Docker Compose（最完整、最便宜）

適用：Linode / DigitalOcean / Vultr / GCP / AWS Lightsail 等任何 Ubuntu 主機（建議 2 vCPU / 4 GB RAM 起）。

```bash
# 1) 安裝 Docker（Ubuntu）
curl -fsSL https://get.docker.com | sh

# 2) 取得程式碼
git clone <repo> chiaki && cd chiaki/platform

# 3) 設定環境變數
cp .env.example .env
nano .env        # 依第 1 節修改；另外設定 POSTGRES_PASSWORD（compose 內建資料庫的密碼）

# 4) 建置並啟動：資料庫 → migration（自動）→ 網站
docker compose up -d --build

# 5) 啟動背景工作（通知、VIP 排程等；正式環境一定要開）
docker compose --profile worker up -d

# 6) 寫入正式參考資料（物流方式、任務獎勵、VIP 等級、首頁橫幅；不含任何示範帳號）
docker compose run --rm app node dist/seed-prod.mjs
#    若要把內建賞池（含「世界之王」與三支抽卡影片）建立成「草稿」供後台審核發布，先做完第 4 節再執行：
#    docker compose run --rm app node dist/seed-prod.mjs --pool-drafts

# 7) 確認
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:3000/api/ready
```

### HTTPS 與兩個網域（Caddy，自動申請憑證）

compose 只在主機的 3000 埠提供 HTTP；請在前面放一個反向代理處理 HTTPS。最簡單是 Caddy：

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
chiaki.tw, www.chiaki.tw, admin.chiaki.tw {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy
```

- Caddy 會原樣轉送 `Host`，所以 `HOST_HEADER` 維持預設 `host` 即可；用戶端 IP 會寫在 `x-forwarded-for`（預設值）。
- 如果再加上 Cloudflare（橘色雲朵），把 `CLIENT_IP_HEADER=cf-connecting-ip`，並把主機防火牆限制成只接受 Cloudflare IP。
- **不要**把 3000 埠直接開放到網際網路（`ufw allow 80,443/tcp` 即可）。

---

## 3. 方案 B：Zeabur

1. 建立專案 → **Add Service → Marketplace → PostgreSQL**。建好後在服務頁可看到連線字串。
2. **Add Service → Git**，選擇這個 repo，**Root Directory 設為 `platform`**。Zeabur 偵測到 `Dockerfile` 會用它建置。
3. 在該服務的 **Variables** 填入第 1 節的變數；`DATABASE_URL` 可直接引用 PostgreSQL 服務提供的變數（例如 `${POSTGRES_CONNECTION_STRING}`）。
4. **Networking**：Port 3000；健康檢查路徑填 `/api/ready`。
5. 第一次部署完成後，開啟服務的 **Command / Terminal**（或「執行指令」），依序執行：
   ```bash
   node dist/migrate.mjs
   node dist/seed-prod.mjs
   node dist/create-admin.mjs --login <你的帳號>
   ```
   之後每次部署新版本，可把 **Start Command** 設成 `sh -c "node dist/migrate.mjs && node server.js"`，讓 migration 自動套用。
6. 再新增一個服務（同一個 repo、同樣 Root Directory 與變數），**Start Command 設為 `node dist/worker.mjs`**、不需要對外網域 —— 這就是 worker。
7. **Domains**：在 app 服務綁定 `chiaki.tw` 與 `admin.chiaki.tw`（依畫面指示到 DNS 加 CNAME）。

---

## 4. 方案 C：Render

1. **New → PostgreSQL**（選台灣附近區域，例如 Singapore）。複製 **Internal Database URL**。
2. **New → Web Service** → 連接 repo → Root Directory `platform` → Runtime **Docker**。
   - Health Check Path：`/api/ready`
   - Environment：第 1 節的變數（`DATABASE_URL` 用上面的 Internal URL）
   - Pre-Deploy Command：`node dist/migrate.mjs`（每次部署自動套用 migration）
3. **New → Background Worker** → 同一 repo、Root Directory `platform`、Docker、相同環境變數（可用 Environment Group 共用）→ Docker Command：`node dist/worker.mjs`。
4. 部署完成後，在 Web Service 的 **Shell** 執行：
   ```bash
   node dist/seed-prod.mjs
   node dist/create-admin.mjs --login <你的帳號>
   ```
5. **Settings → Custom Domains**：加上 `chiaki.tw`、`admin.chiaki.tw`，依指示設定 DNS。

> 只支援 cron 的平台：worker 也可以改用排程呼叫單一工作，例如每分鐘 `node dist/worker.mjs --run notifications-dispatch`、
> 每日 `--run vip-birthday-gifts` 等（`node dist/worker.mjs --list` 會列出所有工作與時刻）。

---

## 5. 資料庫、migration 與種子資料

| 動作 | 指令（容器內） | 本機（有原始碼時） |
|---|---|---|
| 套用 migration | `node dist/migrate.mjs` | `npm run db:migrate` |
| 正式參考資料 | `node dist/seed-prod.mjs` | `npm run db:seed:prod` |
| 內建賞池草稿 | `node dist/seed-prod.mjs --pool-drafts` | `npm run db:seed:prod -- --pool-drafts` |
| 開發示範資料 | `node dist/seed.mjs`（**只限測試站**：會建立示範會員與 5000 UC幣） | `npm run db:seed` |

- migration 會記錄 checksum；已套用的檔案若被修改，`migrate` 與 `/api/ready` 都會報錯（不要修改已上線的 migration，請新增一個）。
- 所有種子都是冪等的，可以重複執行；不會覆蓋後台已修改的設定。
- `--pool-drafts` 只建立**草稿**。發布仍須在後台「送審 → 另一位員工核准」（雙人覆核），因此至少需要兩個後台帳號。

---

## 6. 建立第一個超級管理員並啟用兩步驟驗證

```bash
# 互動輸入密碼（不會顯示、至少 12 碼）
node dist/create-admin.mjs --login owner --name "業主"
# 無互動終端機時：NEW_ADMIN_PASSWORD='...' node dist/create-admin.mjs --login owner（執行後清掉該變數）
```

接著綁定 TOTP（Google Authenticator / 1Password 等）。後台介面完成前可用 curl（以下皆打**後台網域**）：

```bash
A=https://admin.chiaki.tw
# 1) 登入，取得 token
curl -s $A/api/auth/admin/login -H 'content-type: application/json' \
  -d '{"loginId":"owner","password":"<密碼>"}'
# 2) 產生 TOTP 金鑰：回應中的 otpauth:// 網址轉成 QR code 或手動輸入到驗證器 App
curl -s -X POST $A/api/admin/auth/mfa/enroll -H "authorization: Bearer <token>"
# 3) 輸入 App 上的 6 位數驗證碼完成綁定
curl -s $A/api/admin/auth/mfa/verify -H "authorization: Bearer <token>" \
  -H 'content-type: application/json' -d '{"code":"123456"}'
```

完成後把 `ADMIN_MFA_REQUIRED=true` 並重新部署 —— 之後所有後台帳號都必須先綁定 TOTP 才能操作。
其他員工帳號（營運、財務、客服）請在後台建立，或再用 `create-admin` 建立後於後台調整角色。

> 建議同時設定 `ADMIN_IP_ALLOWLIST`（公司/家中固定 IP），並在 Cloudflare 對 `admin.chiaki.tw` 加上存取限制（見 `docs/security.md`）。

---

## 7. 網域設定

1. DNS：`chiaki.tw`、`www`、`admin` 都指向 app（VPS 用 A 記錄指向主機 IP；Zeabur/Render 依平台指示用 CNAME）。
2. 環境變數：
   ```
   APP_BASE_URL=https://chiaki.tw
   ADMIN_HOST=admin.chiaki.tw
   # 前台若有第二個網址（例如 www 或另外架設的前端），加入 CORS / CSRF 允許清單：
   CORS_ALLOWED_ORIGINS=https://www.chiaki.tw
   ```
3. 驗證：
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://chiaki.tw/api/admin/audit/verify        # 404（後台 API 不在前台網域）
   curl -s -o /dev/null -w '%{http_code}\n' https://admin.chiaki.tw/api/admin/audit/verify  # 401（需要登入，代表路由存在）
   ```
4. 反向代理若會改寫 `Host`（少見），改設 `HOST_HEADER=x-forwarded-host`。

---

## 8. 上傳媒體（圖片、抽賞影片）

資料庫只存**站內路徑**；設定 `MEDIA_BASE_URL` 後，API 輸出的網址會自動變成 `MEDIA_BASE_URL + 路徑`
（賞池封面、獎項圖、首頁橫幅、IP 封面、抽賞影片）。後台上傳的圖片素材（`/api/assets/:id`）存在資料庫，不受影響。

目前需要上傳的檔案：

| 路徑 | 用途 |
|---|---|
| `/media/video/gacha1.mp4` | 世界之王 抽卡影片一（光束：約 7.4 秒依最高獎項變色） |
| `/media/video/gacha2.mp4` | 世界之王 抽卡影片二（擊殺：小獎 13.9 秒、3～4 獎 15.6 秒停止，大獎完整播放） |
| `/media/video/gacha3.mp4` | 世界之王 抽卡影片三（完整播放） |
| `/media/banners/halloween.jpg` | 首頁橫幅「CHIAKI 萬聖百鬼夜」 |
| `/media/banners/friends-ig.jpg` | 首頁橫幅「品牌好友強力推薦」 |

（三支影片目前在 repo 根目錄的 `assets/gacha1.mp4`～`gacha3.mp4`。）

**作法一（建議）：Cloudflare R2 ＋ 自訂網域**
1. R2 → Create bucket `chiaki-media` → Settings → Custom Domains → 綁定 `cdn.chiaki.tw`。
2. 依上表路徑上傳（物件鍵＝路徑去掉開頭的 `/`，例如 `media/video/gacha1.mp4`）。可用網頁上傳或 `rclone` / `aws s3 cp --endpoint-url ...`。
3. 設定 `MEDIA_BASE_URL=https://cdn.chiaki.tw` 並重新部署（不需改資料庫）。
4. 影片請確認 `Content-Type: video/mp4`，並開啟快取（R2 自訂網域預設會經過 Cloudflare 快取）。

**作法二：跟網站一起提供（不用 CDN）**
在建置**之前**把檔案放到 `platform/public/media/...`（與路徑相同），`MEDIA_BASE_URL` 留空。
缺點：影片會佔用主機頻寬，且更換檔案需要重新建置映像。

賞池影片可在後台修改：`PATCH /api/admin/pools/:id` 帶 `videos`（整份取代）與 `coverUrl`：
```json
{ "videos": [
    { "url": "/media/video/gacha1.mp4", "behavior": { "kind": "beam", "beamAt": 7.4 } },
    { "url": "/media/video/gacha2.mp4", "behavior": { "kind": "kills", "stop": { "low": 13.9, "mid": 15.6 } } },
    { "url": "/media/video/gacha3.mp4", "behavior": { "kind": "plain" }, "enabled": true } ],
  "coverUrl": "/media/pools/wk-cover.jpg" }
```
前台從 `GET /api/pools/:id` 的 `videos`（只含啟用中的）隨機挑一支播放，並依 `behavior` 決定演出。

---

## 9. 關閉測試模式（公司成立、綠界與簡訊都好了之後）

1. **綠界**：簽約完成後取得正式特店編號、HashKey、HashIV，設定：
   ```
   ECPAY_MERCHANT_ID=<正式特店編號>
   ECPAY_HASH_KEY=<正式 HashKey>
   ECPAY_HASH_IV=<正式 HashIV>
   ECPAY_AIO_URL=https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5
   ECPAY_NOTIFY_IP_ALLOWLIST=<綠界提供的通知來源 IP>
   ECPAY_NOTIFY_MAX_AGE_HOURS=72
   PAYMENT_SANDBOX=
   ```
   在綠界後台確認付款完成通知網址為 `https://chiaki.tw/api/payments/ecpay/notify`。
2. **簡訊**：取得三竹帳號後設定 `MITAKE_USERNAME`、`MITAKE_PASSWORD`。
   ⚠ 目前程式已備妥簡訊請求格式，但 **OTP 發送尚待以正式帳號實作與驗證**（設定帳號後 OTP 會回 501「串接尚未完成」），請在關閉測試模式前完成並測試。
3. （可選）上線前先用沙盒驗證：`SITE_TEST_MODE=true` ＋ `PAYMENT_SANDBOX=1` 走一次綠界 STAGE 儲值流程。
4. 設定 `SITE_TEST_MODE=false` 並重新部署。
   **安全檢查**：production 若關閉測試模式，但綠界仍是公開測試商店（3002607）/ STAGE 網址、缺 HashKey/IV、開著 `PAYMENT_SANDBOX`、缺簡訊帳號，或 `APP_BASE_URL` 不是 https —— 程式會**拒絕啟動**並在日誌列出缺少的項目。
5. 確認 `curl https://chiaki.tw/api/health` 的 `mode` 為 `{"testMode":false,"payments":"LIVE","sms":"CONFIGURED",...}`。
6. 用一張真實信用卡做一次最小金額儲值，並在後台確認入帳與稽核紀錄。

---

## 10. 備份與還原

**資料庫是唯一需要備份的東西**（後台上傳的圖片也在資料庫裡）；媒體檔另存在物件儲存。

- **Zeabur / Render**：在 PostgreSQL 服務開啟自動備份（Render 付費方案有每日備份與 PITR）。
- **VPS（compose）**：每天凌晨備份，保留 14 天，並複製到別處（R2 / S3 / 另一台主機）：
  ```bash
  sudo mkdir -p /var/backups/chiaki
  sudo tee /etc/cron.d/chiaki-backup >/dev/null <<'EOF'
  15 3 * * * root cd /root/chiaki/platform && docker compose exec -T db pg_dump -U chiaki -Fc chiaki > /var/backups/chiaki/chiaki-$(date +\%F).dump && find /var/backups/chiaki -name '*.dump' -mtime +14 -delete
  EOF
  ```
- **還原**（先在測試資料庫演練過一次）：
  ```bash
  docker compose exec -T db pg_restore -U chiaki -d chiaki --clean --if-exists < /var/backups/chiaki/chiaki-YYYY-MM-DD.dump
  ```
- 另外把 `MFA_ENCRYPTION_KEY` 與所有金鑰存在密碼管理器 —— 遺失 `MFA_ENCRYPTION_KEY` 會使所有 TOTP 綁定失效（需重新綁定）。

---

## 11. 更新版本與回滾

- 更新：`git pull && docker compose up -d --build && docker compose --profile worker up -d`（compose 會先跑 migrate 再啟動 app）。
  Zeabur / Render 推送到 main 後自動重新部署（migration 由 Start / Pre-Deploy Command 執行）。
- 回滾：部署上一版映像即可。migration 只會新增，舊版程式通常可以在新結構上執行；若某次 migration 有破壞性變更，會在該 migration 檔案註解中說明。
- 上線前檢查：`npm test`、`npm run build`。

---

## 12. 疑難排解

| 症狀 | 原因 / 處理 |
|---|---|
| 啟動即結束，日誌 `Dev stubs / simulated payments must be disabled in production` | `AUTH_DEV_STUB`、`REWARD_VERIFY_STUB`、`NOTIFY_STUB_SEND`、`ECPAY_ACCEPT_SIMULATED` 要設 0 |
| `MFA_ENCRYPTION_KEY is required in production` | 依第 1 節產生並設定 |
| `SITE_TEST_MODE=false requires live ECPay / SMS settings: ...` | 第 9 節的設定未完成；日誌會列出缺少項目 |
| `/api/ready` 回 503、`database: unreachable` | `DATABASE_URL` 錯誤、資料庫未啟動，或雲端資料庫需要 `?sslmode=require` |
| `/api/ready` 回 503、`pending` 有值 | 尚未執行 `node dist/migrate.mjs` |
| 會員登入回 503 `SMS_DISABLED` | 測試模式下尚未設定簡訊供應商，屬預期行為 |
| 儲值回 403 `TEST_SITE` | 測試模式下金流停用，屬預期行為 |
| 後台 API 回 404 | 從前台網域呼叫了後台 API；請改用 `ADMIN_HOST` 網域 |
| 前端跨網域呼叫被瀏覽器擋下（CORS） | 把前端網址加入 `CORS_ALLOWED_ORIGINS` |
| Docker 建置在 `prisma generate` 失敗 | 執行期不使用 Prisma Client，可用 `docker build --build-arg PRISMA_GENERATE=0 .` 略過 |
| 影片/圖片 404 | 檔案未上傳到 `MEDIA_BASE_URL` 下相同路徑，或未設定 `MEDIA_BASE_URL` 且檔案不在 `public/` |

日誌為 JSON 一行一筆（`ts`、`level`、`msg`…），可直接在平台的日誌頁面搜尋 `"level":"error"`。
