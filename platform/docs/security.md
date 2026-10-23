# CHIAKI 平台 — 安全部署指南（邊緣 WAF ＋ 應用層防火牆）

應用程式內建一層「應用層防火牆」（`src/server/http.ts` 的 `route()`，所有 API 路由皆經過）。
它是**第二道防線**；正式環境必須在前面再放一層邊緣 WAF（Cloudflare 或 Vercel Firewall），
把大量惡意流量擋在進入 Node／資料庫之前。

## 1. 應用層已實作的防護（供對照）

| 防護 | 位置 | 設定 |
|---|---|---|
| IP／裝置封鎖清單（後台可管理） | `security/blocklist.ts`、`/api/admin/security/blocklist` | `BLOCKLIST_CACHE_MS` |
| 每 IP、每會員 token bucket 限流 | `security/rate-limit.ts`（記憶體；可換 Redis） | `RATE_LIMIT_*` |
| 請求本文上限、JSON content-type 檢查 | `http.ts` | `MAX_BODY_BYTES` |
| 安全標頭（CSP、HSTS、X-Frame-Options DENY、nosniff、Referrer-Policy、Permissions-Policy） | `security/headers.ts`、`next.config.mjs` | — |
| Cookie session 的 CSRF（double-submit＋Origin） | `security/cookies.ts` | `APP_BASE_URL` |
| 登入暴力破解：指數退避＋鎖定 | `security/lockout.ts` | `LOGIN_*` |
| 後台：員工角色＋密碼 session＋近期重新驗證＋（選用）MFA、IP 允許清單 | `http.ts`、`modules/auth/admin-auth.ts` | `ADMIN_*` |
| 綠界通知：CheckMacValue、來源 IP 允許清單、重放防護、時間新鮮度 | `modules/payment/payments.ts` | `ECPAY_NOTIFY_*` |
| 抽賞/鎖籤機器人行為偵測 | `security/bot.ts` | `BOT_*` |
| 通用錯誤訊息（不回傳堆疊） | `http.ts` `errorResponse` | — |
| 被攔截請求 → `risk_events`（同來源每分鐘最多一筆） | `security/events.ts` | — |

> ⚠ 用戶端 IP 取自 `CLIENT_IP_HEADER`（預設 `x-forwarded-for` 第一個值）。**應用程式不可直接暴露在網際網路上**，
> 否則該 header 可被偽造、IP 限流與封鎖會失效。Cloudflare 前置時建議設 `CLIENT_IP_HEADER=cf-connecting-ip`，
> 並在來源（Vercel／主機）只允許 Cloudflare IP 段連入（Authenticated Origin Pulls 或防火牆）。

> ⚠ 記憶體限流／機器人偵測只在單一實例內有效。Vercel serverless 或多台部署時，請實作 `RateLimitStore`
> （例如 Upstash Redis + Lua）並 `setRateLimitStore()`；在那之前，邊緣 WAF 的限流是主要防線。

## 2. 建議的邊緣 WAF 規則

### 2.1 Cloudflare（WAF Custom Rules / Rate Limiting Rules / Managed Rules）

1. **Managed Rules**：啟用 Cloudflare Managed Ruleset 與 OWASP Core Ruleset（先 Log 觀察一週，再改 Block；
   Paranoia Level 1–2）。啟用 Bot Fight Mode（或 Super Bot Fight Mode：Definitely automated → Block，Likely automated → Managed Challenge，但**排除** `/api/payments/ecpay/notify`）。
2. **後台只允許公司網路**：
   `(http.request.uri.path wildcard "/api/admin/*" or http.request.uri.path eq "/api/auth/admin/login" or http.request.uri.path eq "/api/auth/admin/hint") and not ip.src in $chiaki_office_ips` → **Block**
   （同時設定應用層 `ADMIN_IP_ALLOWLIST` 作為雙保險。）
3. **綠界通知只允許綠界 IP**：
   `http.request.uri.path eq "/api/payments/ecpay/notify" and not ip.src in $ecpay_ips` → **Block**；
   並對此路徑**略過** Bot Fight Mode／JS Challenge（綠界伺服器無法通過挑戰）。綠界 IP 清單請向綠界索取最新版本，同步到 `ECPAY_NOTIFY_IP_ALLOWLIST`。
4. **限流（Rate Limiting Rules）**：
   - 登入：`/api/auth/otp/*`、`/api/auth/admin/login` 每 IP 每分鐘 10 次 → Block 10 分鐘。
   - 抽賞與鎖籤：`/api/draws`、`/api/pools/*/sets/*/holds`（POST）每 IP 每 10 秒 30 次 → Managed Challenge。
   - 一般 API：`/api/*` 每 IP 每分鐘 600 次 → Block 1 分鐘。
   - 儲值建單：`/api/payments/*`（排除 notify）每 IP 每分鐘 20 次。
5. **方法與大小**：
   - `/api/*` 只允許 `GET, POST, PUT, PATCH, DELETE`；其他方法 → Block。
   - `http.request.body.size > 65536 and http.request.uri.path wildcard "/api/*"` → Block（與 `MAX_BODY_BYTES` 一致）。
6. **地理與威脅分數**：服務以台灣為主 → 非 TW/HK/MO/JP 等目標市場的 `/api/auth/*` 請求 → Managed Challenge；
   `cf.threat_score > 30` → Managed Challenge。
7. **快取**：`/api/*` 一律 Bypass cache（API 回應已帶 `cache-control: no-store`）。
8. **TLS**：SSL/TLS 模式 Full (strict)、最低 TLS 1.2、啟用 HSTS（與應用層標頭一致）、Always Use HTTPS。

### 2.2 Vercel Firewall（Project → Firewall）

1. 啟用 **Attack Challenge Mode** 的自動觸發與 **Bot Protection**（排除 `/api/payments/ecpay/notify`）。
2. Custom Rules：
   - Path starts with `/api/admin` 且 IP not in 公司網段 → **Deny**。
   - Path equals `/api/payments/ecpay/notify` 且 IP not in 綠界 IP → **Deny**。
   - Rate limit：`/api/auth/*` 每 IP 10 req/min（Deny 10 分鐘）；`/api/draws` 每 IP 30 req/10s（Challenge）；`/api/*` 每 IP 600 req/min。
3. **Deployment Protection**：Preview 部署啟用 Vercel Authentication，避免預覽環境被公開存取。
4. 環境變數：所有金鑰（`ECPAY_HASH_*`、`MFA_ENCRYPTION_KEY`、`ADMIN_INITIAL_PASSWORD`、簡訊/LINE 憑證）設為 **Sensitive**，只給 Production。

## 3. 上線檢查清單

- [ ] `NODE_ENV=production`；`AUTH_DEV_STUB`、`REWARD_VERIFY_STUB`、`ECPAY_ACCEPT_SIMULATED`、`NOTIFY_STUB_SEND` 皆為 0（否則程式拒絕啟動）。
- [ ] `MFA_ENCRYPTION_KEY` 已設定（32 bytes）；`ADMIN_MFA_REQUIRED=true`；所有後台帳號已綁定 TOTP。
- [ ] 後台密碼提示（`ADMIN_PASSWORD_HINT`）—— 提示會降低安全性，建議正式環境清空。
- [ ] `ADMIN_IP_ALLOWLIST` 與邊緣 WAF 後台規則一致。
- [ ] `ECPAY_NOTIFY_IP_ALLOWLIST` 已設定為綠界最新來源 IP；`ECPAY_NOTIFY_MAX_AGE_HOURS=72`。
- [ ] 應用程式以**非 superuser** 的資料庫角色連線（superuser 可停用 append-only trigger）。
- [ ] 多實例部署已改用 Redis 限流儲存。
- [ ] 排程：`job:storage-sweep`（每小時）、`job:notify`（每分鐘）、`job:draw-archive`（每日）；定期執行 `/api/admin/audit/verify` 與 `/api/admin/wallets/reconcile`，並將稽核鏈 head hash 外部存證。
- [ ] 監控 `risk_events`：`BLOCKED_REQUEST`、`RATE_LIMIT_*`、`BOT_SUSPECTED`、`LOGIN_LOCKOUT`、`ADMIN_ACCESS_DENIED`、`ECPAY_NOTIFY_REJECTED`、`REFERRAL_ABUSE` 異常增加時告警。
