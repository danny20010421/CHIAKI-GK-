# CHIAKI 平台 — 後端核心（chiaki-platform）

CHIAKI（CHIAKI GARAGE KIT）線上一番賞與實體收藏商品平台的**伺服器端核心**：賞池、選籤／鎖籤、原子抽賞交易、保底、雙幣錢包與帳本、綠界金流、中獎倉庫、出貨、稽核雜湊鏈、RBAC 與雙人覆核、風控掛勾、綁定獎勵。

> **前台 UI 不在本專案範圍**：視覺設計仍待業主核可，`/` 僅為佔位頁。所有功能皆透過 JSON API 提供。

---

## ⚠ 本次開發環境限制（請先讀）

開發時所在的沙箱 **無法連線 npm／pip registry 與 `binaries.prisma.sh`**（只能連 GitHub）。因此：

| 原規劃 | 實際狀態 | 說明 |
|---|---|---|
| Next.js 15 App Router | **程式碼已依 App Router 慣例撰寫，但未安裝 Next** | 所有 route handler 位於 `src/app/api/**/route.ts`，只使用 Web 標準 `Request`/`Response`（不 import `next/*`），簽章符合 Next 15（`ctx.params` 為 Promise）。離線時以 `scripts/dev-server.ts` 直接執行同一批 handler。`npm install` 後即可 `npm run dev` / `npm run build:next`（**尚未在真正的 Next 下建置驗證**）。 |
| Prisma ORM | **以 postgres.js（原生 SQL）實作資料存取；`prisma/schema.prisma` 為鏡像** | Prisma 引擎需從 binaries.prisma.sh 下載，無法取得。SQL migration 為唯一真實來源；`schema.prisma` 由實際資料庫結構產生，並由 `tests/schema-drift.test.ts` 每次比對（表／欄／型別／可空性）。未執行 `prisma validate`。 |
| Vitest | **改用 Node 內建 `node:test` + tsx** | 測試寫法（describe/it/assert）可直接搬到 Vitest。 |
| embedded-postgres | **使用系統已安裝的 PostgreSQL 16** | `npm test` 會自動 `initdb` 一個暫時叢集（真正的 PostgreSQL，非 SQLite／mock）。 |

離線環境所用套件：zod 3.25.76、typescript 6.0.3、tsx 4.23.12（取自本機 `/opt/npm-tools`，以 `scripts/offline-bootstrap.sh` 連結）、postgres.js 3.4.7（從 GitHub `porsager/postgres` 取得，Unlicense，置於 `vendor/postgres`）。

---

## 架構

```
                ┌──────────────────────────── Next.js App Router（模組化單體）────────────────────────────┐
  瀏覽器/App ──▶│ src/app/api/**/route.ts   zod 驗證 → 認證(Bearer) → 呼叫 domain → JSON / 統一錯誤格式      │
  綠界 ECPay ──▶│ /api/payments/ecpay/notify（text: 1|OK）                                                 │
                │                                                                                          │
                │ src/server/modules/                                                                      │
                │   auth ─ rbac  pool ─ commitment/rules/admin/queries   draw ─ holds/draw                 │
                │   wallet ─ ledger/refunds   payment ─ ecpay/payments   warehouse   shipping   catalog      │
                │   admin ─ approvals(雙人覆核)   audit ─ hash chain   risk   rewards   merchant(P4 預留)    │
                │                                                                                          │
                │ src/server/db.ts  postgres.js：明確交易、FOR UPDATE 列鎖、死結/序列化失敗自動重試         │
                └──────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                               ▼
                         PostgreSQL（CHECK 約束 + trigger：帳本/稽核/抽賞紀錄 append-only、
                         規則版本與承諾不可變、倉庫狀態機、雙人覆核 decided_by ≠ requested_by）
```

### 模組地圖

| 模組 | 檔案 | 職責 |
|---|---|---|
| pool | `modules/pool/*` | 賞池草稿（來源 OFFICIAL/CUSTOM/MIXED × 玩法 STANDARD/GUARANTEE/SOLO）、發布（CSPRNG 洗牌、salt、承諾雜湊、不可變規則版本）、規則改版、公開查詢（剩餘/即時機率/籤板）、完售揭露 |
| draw | `modules/draw/holds.ts`, `draw.ts` | 鎖籤（預設 180 秒、lazy 過期、全有或全無）、原子抽賞交易、冪等、保底、最後賞、完售換套 |
| wallet | `modules/wallet/*` | 代幣 coins／平台點數 points 分帳、唯一異動入口 `postLedger`、對帳、退款申請工作流 |
| payment | `modules/payment/*` | 綠界 AIO CheckMacValue、建立訂單、ReturnURL 冪等入帳、銀行轉帳人工對帳 |
| warehouse | `modules/warehouse/*` | 中獎倉庫、回收換點（費率表、部分賞級不可回收、不可逆） |
| shipping | `modules/shipping/*` | 合併出貨、宅配/7-11/全家/萊爾富/OK、運費設定、出貨/送達 |
| catalog | `modules/catalog/*` | 直購商城（固定價、無隨機性），購得商品進倉庫 |
| audit | `modules/audit/*` | append-only 稽核紀錄＋雜湊鏈、驗證 |
| auth | `modules/auth/*` | 角色/權限矩陣、Session、OTP／LINE 介面（開發替身）、年齡驗證 |
| admin | `modules/admin/approvals.ts` | 高風險動作申請 → 第二人核准並於同一交易執行 |
| risk | `modules/risk/*` | 限流、同裝置多帳號、大額儲值、付款金額不符 → `risk_events` |
| rewards | `modules/rewards/*` | 綁定獎勵（LINE 官方帳號、LINE 社群、IG、手機），每人每任務一次 |
| merchant | `modules/merchant/*` | P4 多商家預留；所有賞池/商品/訂單/帳本列皆有 `merchant_id`（預設 `chiaki`） |

### 抽賞交易（`executeDraw`）

一次 HTTP 請求 = 一個資料庫交易（READ COMMITTED + 明確列鎖）：

1. **冪等鍵**登記（`Idempotency-Key` header 必填）。同鍵並發請求在唯一索引上等待；先完成者提交後，後到者讀到同一份回應重播（HTTP 200 + `Idempotent-Replayed: true`），不重複扣款。同鍵不同內容 → 422。
2. 會員狀態、**年齡驗證**（未驗證 → 403 `AGE_VERIFICATION_REQUIRED`）。
3. `pool_sets … FOR UPDATE`：同一套的抽賞序列化，保證「最後一籤／完售」判定唯一正確。
4. `tickets … FOR UPDATE`：檢查未抽出、未被他人有效保留。
5. 條件式扣款 `UPDATE wallets SET coins = coins - x WHERE coins - x >= 0` + 帳本（含 `balance_after`）。
6. 標記籤、寫 `draws`/`draw_results`、入中獎倉庫。
7. 保底（獨立保底庫存，不改變籤的機率）、最後賞、完售 → 下一套開賣／整池結束。
8. 稽核鏈（最後取得的鎖）＋儲存冪等回應 → COMMIT。

任何錯誤 → 整筆 rollback（不會留下扣款、籤狀態或冪等鍵）。鎖順序固定：`set → tickets → wallet → pool_guarantees → guarantee_counters → audit_head`。

### 公平性：事前承諾（commit–reveal）

- 發布時每套：`crypto.randomInt` Fisher–Yates 洗牌、32 bytes salt、
  `commitment = SHA-256( canonicalJson({scheme, poolId, setNo, rulesHash, tickets:[[no, rank, prizeId]…]}) + "\n" + salt )`。
- `rulesHash = SHA-256(canonicalJson(規則快照))`，規則版本發布後不可修改（DB trigger），修改＝建立新版本並經雙人覆核。
- 承諾與 rulesHash 發布即公開；籤表與 salt **只在完售後**由 `GET /api/pools/:id/sets/:no/reveal` 公開。
- 任何人可驗證：`npm run verify:set -- reveal.json`（或直接給 reveal URL）。

---

## API

所有回應為 JSON（綠界通知除外）。錯誤格式：`{"error":{"code":"TICKET_TAKEN","message":"…","details":{…}}}`。認證：`Authorization: Bearer <token>`。

**公開**

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/pools?source=&playType=` | 賞池列表（目前開賣中的套、剩餘數） |
| GET | `/api/pools/:idOrSlug` | 詳情：獎項、規則版本與雜湊、保底剩餘、各套承諾 |
| GET | `/api/pools/:id/sets/:no` | 剩餘數、即時機率、籤板（未抽出不揭露獎項） |
| GET | `/api/pools/:id/sets/:no/reveal` | 完售後揭露籤表＋salt（未完售 409） |
| GET | `/api/products`、`/api/shipping-methods` | 直購商品、物流方式與運費 |
| POST | `/api/auth/otp/request`、`/api/auth/otp/verify` | 手機 OTP 登入（開發替身固定碼 `000000`） |

**會員**

| Method | Path | 說明 |
|---|---|---|
| POST / DELETE | `/api/pools/:id/sets/:no/holds` | 鎖籤／釋出 |
| POST | `/api/draws` | 抽賞（`Idempotency-Key` 必填；`{poolId, setNo, ticketNos}` 或 `{…, count}` 由伺服器代選） |
| POST | `/api/me/age-verification` | 年齡驗證（替身） |
| GET | `/api/me/wallet` | 餘額＋帳本明細＋儲值訂單 |
| GET | `/api/me/warehouse?status=` | 中獎倉庫 |
| GET / POST | `/api/me/shipments` | 出貨單／申請合併出貨 |
| POST | `/api/me/recycle` | 回收換平台點數 |
| GET / POST | `/api/me/refund-requests` | 未使用代幣退款申請（僅建單） |
| GET / POST | `/api/me/rewards` | 綁定獎勵任務／領取 |
| POST | `/api/me/purchases` | 直購（`Idempotency-Key` 必填） |
| POST | `/api/payments/ecpay/checkout` | 建立綠界訂單，回傳要 POST 到綠界的表單參數 |
| POST | `/api/payments/ecpay/notify` | 綠界 ReturnURL（回 `1|OK`） |
| POST | `/api/payments/bank-transfer` | 銀行轉帳（人工對帳）訂單 |

**後台**（依 RBAC；★ = 需第二人核准）

| Method | Path | 說明 |
|---|---|---|
| POST | `/api/admin/pools` | 建立賞池草稿 |
| POST | `/api/admin/pools/:id/publish-request` | ★ 申請發布 |
| POST | `/api/admin/pools/:id/rule-versions`、`/api/admin/rule-versions/:id/publish-request` | ★ 規則改版 |
| GET | `/api/admin/approvals?status=` | 覆核清單 |
| POST | `/api/admin/approvals/:id/approve`、`/reject` | 覆核（不可處理自己的申請） |
| POST | `/api/admin/wallet-adjustments` | ★ 人工調整餘額 |
| POST | `/api/admin/refund-requests/:id/decision` | 駁回，或 ★ 提出核准退款 |
| POST | `/api/admin/payments/:id/confirm-bank-transfer` | ★ 確認銀行轉帳入帳 |
| POST | `/api/admin/shipments/:id/ship`、`/deliver` | 出貨／送達 |
| GET | `/api/admin/audit/verify`、`/api/admin/wallets/reconcile`、`/api/admin/risk-events` | 稽核鏈驗證、錢包對帳、風控事件 |

角色：`SUPER_ADMIN`、`OPS`、`FINANCE`、`CS`、`MERCHANT`（P4 預留，無權限）、`MEMBER`。權限矩陣見 `src/server/modules/auth/rbac.ts`。

---

## 本機執行

需求：Node ≥ 22、PostgreSQL ≥ 14 伺服器程式（`initdb`/`pg_ctl`；或自備資料庫並設定 `DATABASE_URL`）。

```bash
cd chiaki-platform
npm install                 # 有網路時
# npm run bootstrap:offline # 無法連 npm 時（本次開發環境）

npm test                    # 自動啟動暫時 PostgreSQL → migrate → 60 個測試
npm run build               # TypeScript strict 型別檢查

npm run db:local            # 啟動本機 PostgreSQL（/tmp/chiaki-pg，埠 55432）並建立 chiaki 資料庫
cp .env.example .env        # 並 export 其中變數（或 set -a; . ./.env; set +a）
npm run db:migrate
npm run db:seed             # 參考資料、員工/示範會員、範例賞池（經雙人覆核流程發布）
npm run dev:api             # 無 Next 的本機 API 伺服器（http://localhost:3000）
# npm run dev               # 安裝 next 後使用

curl -s localhost:3000/api/pools
curl -s -X POST localhost:3000/api/auth/otp/verify -H 'content-type: application/json' \
     -d '{"phone":"0900000010","code":"000000"}'
npm run verify:set -- http://localhost:3000/api/pools/chiaki-gk-01/sets/1/reveal   # 完售後
npm run db:local:stop
```

種子帳號（OTP `000000`）：`0900000001` SUPER_ADMIN、`0900000002` OPS、`0900000003`/`0900000004` FINANCE A/B、`0900000005` CS、`0900000010` 示範會員（已年齡驗證、5000 代幣）。
範例賞池：「CHIAKI GK 一番賞 第一彈」（`chiaki-gk-01`，10 套 × 100 籤，A1 B1 C1 D6 E6 F15 G20 H50，300 代幣/抽）、保底挑戰範例（`chiaki-black-gold-guarantee`）。

以 root 執行時，PostgreSQL 不允許 root 啟動，腳本會改用 `PG_RUN_AS`（預設 `claude` 或 `nobody`）。

## 環境變數

見 `.env.example`（每項皆有註解）。重點：`DATABASE_URL`、`HOLD_SECONDS`(180)、`AGE_MIN`(18，待法務)、`ECPAY_*`（預設為綠界官方公開 STAGE 測試商店 `3002607` / `pwFHCqoQZGmho4w6` / `EkRm7iFT261dpevs`，已與 GitHub 上綠界官方 Python SDK 範例比對一致）、`ECPAY_ACCEPT_SIMULATED`、`RISK_*`、`AUTH_DEV_STUB`、`REWARD_VERIFY_STUB`。`NODE_ENV=production` 時若任何替身或模擬付款開關為 1，程式拒絕啟動。

---

## 已實作 vs 替身／未實作

**已實作並有測試**
- 賞池兩維度分類＋直購商城；多套；固定籤表無放回；最後賞；完售自動開下一套／結束。
- 發布：CSPRNG 洗牌、salt、SHA-256 承諾、不可變規則版本（trigger）、改版＝新版本＋雙人覆核；完售揭露與獨立驗證腳本。
- 鎖籤 180 秒（可設定）、他人保留阻擋、lazy 過期、釋出、全有或全無。
- 原子抽賞、冪等、多抽一次結算、伺服器代選（CSPRNG）。**並發測試：40 人同時搶同一籤 → 恰 1 筆 201、39 筆 409 `TICKET_TAKEN`，未得者零扣款，全系統餘額精確對帳**；另有 90 筆重疊多抽混戰與 40 人同時鎖籤測試。
- 保底：每使用者每池計數、命中門檻歸零、獨立保底庫存、庫存耗盡即停止、並發不超發、不改變籤的機率。
- 即時剩餘與機率（DB 計算）。
- 錢包雙幣分帳（點數不可儲值購得、不可退款現金化：DB CHECK）、append-only 帳本＋`balance_after` 鏈、對帳函式；退款申請工作流（雙人覆核後才扣代幣）。
- 中獎倉庫狀態機（DB trigger 強制）、回收換點（費率表、不可回收賞級、不可逆）、合併出貨、運費設定、出貨/送達。
- 綠界 AIO：CheckMacValue（以官方文件範例向量 `6C51C9E6…5B840` 驗證）、建立訂單、ReturnURL 驗章＋商店代號＋金額比對、每個 MerchantTradeNo 只入帳一次（並發重送測試）、模擬付款預設不入帳、失敗交易標記；銀行轉帳人工對帳（雙人覆核）。
- 稽核雜湊鏈：所有抽賞、錢包異動、後台動作；驗證可偵測竄改、刪除、截尾。
- RBAC＋雙人覆核（應用層＋DB CHECK 雙重保障；核准與執行同一交易）。
- 風控：鎖籤/抽賞限流、同裝置多帳號、大額儲值、付款金額不符。
- 綁定獎勵（每人每任務一次，並發安全；點數＋優惠券）。

**替身（介面已定義）**
- 手機 OTP 簡訊供應商、LINE Login（`modules/auth/providers.ts`）：開發替身固定碼 `000000`，正式環境未設定時回 501。
- 年齡／身分驗證：目前以自填生日判斷 ≥ `AGE_MIN`；正式驗證方式待法務。
- LINE 官方帳號／LINE 社群／IG 追蹤任務驗證：需串接官方 API，目前僅開發替身。

**尚未實作（後續）**
- 前台 UI（待設計核可）；Next.js 實機建置驗證；Prisma Client（如需）。
- 綠界：PaymentInfoURL（ATM/超商代碼取號通知）、查詢訂單 API 主動對帳、退款/刷退 API、電子發票。
- 物流串接（綠界物流/超商電子地圖、託運單、追蹤回寫）、出貨取消、寄存期限。
- 優惠券使用、VIP、邀請碼、客服工單、報表、進銷存、MFA、Redis 快取／佇列、多商家（P4）。
- 限流目前存在 PostgreSQL（`rate_counters`）；量大時建議改 Redis 並加 WAF。

## 安全性說明

- **伺服器決定結果**：前端只送籤號；結果早在發布時已承諾。未抽出的籤號 → 獎項對應與 salt 不會出現在任何完售前的 API（有測試）。
- **資料庫層防線**：帳本、稽核、抽賞紀錄、付款通知 append-only（UPDATE/DELETE/TRUNCATE trigger）；規則版本、承諾、籤表不可變；倉庫狀態機；`coins/points >= 0`；雙人覆核 `decided_by <> requested_by`；每筆付款只入帳一次（部分唯一索引）。
- **正式環境請以非 superuser 的 DB 角色執行應用程式**（superuser 可 `session_replication_role=replica` 繞過 trigger；測試正是用此模擬竄改並驗證偵測能力）。建議另以排程定期跑 `verifyAuditChain` 與 `reconcileWallets`，並將稽核鏈 head hash 定期外部存證。
- 承諾 salt 目前以明文存於 `pool_sets.commit_salt`（任何 API 完售前都不輸出）；擁有資料庫讀取權者本即可看到籤表，正式環境應嚴格限制 DB 讀取權並考慮以 KMS 加密 salt。
- 綠界 CheckMacValue 以 timing-safe 比對；金鑰只放環境變數/secret manager；`ECPAY_ACCEPT_SIMULATED` 正式環境強制關閉。
- Session token 為 32 bytes 隨機值，DB 只存 SHA-256；回應加上 `cache-control: no-store`、`x-content-type-options: nosniff`。
- 金額一律整數（bigint），超出 2^53 直接拋錯，無浮點誤差。
- 稽核鏈 head 是全域序列化點（每筆交易最後才鎖、持鎖極短）；若未來吞吐不足，可改為分區鏈或批次封存。
- 綠界 URL encode 依 .NET 規則（`~` 會編碼為 `%7e`）；官方 Python SDK 不編碼 `~`。參數值目前不含 `~`，若日後商品名稱可能含 `~`，上線前請以綠界測試環境實際驗證。

---

## 待法律／金流服務商確認事項（摘自規格 §11，另補充實作相關項目）

規格 §11「待法律、金流或產品設計確認」：
- 付費抽賞、保底與單挑的完整合法性與廣告用語。
- 中獎品轉點數的性質、折算價值、期限與撤回條件。
- 儲值退款條件、付款服務商支持方式及必要的金流牌照／合作關係。
- 未成年認證之年齡門檻、驗證資料保存與未成年交易限制。
- 精確的保底觸發規則、鎖籤時間、庫存分配及爭議應對方式。
- 商品素材規格、動畫分級、VIP 權益、運費及寄存期限。

規格 §07–08 另列需確認：需由支付服務商（綠界等）核准實際抽賞營運模式；上線前聘請台灣律師確認付費隨機抽賞、保底機制、獎品回收換點數、未使用儲值退款、商家代收付及消費者權益。

本實作中的「暫定值」（皆可設定，需確認後調整）：
- 年齡門檻 `AGE_MIN=18`、驗證方式（目前自填生日）。
- 鎖籤 180 秒；單次最多 100 籤。
- 回收點數費率（A/B/LAST/直購品不可回收；C 300、D 150、E 100、F 60、G 40、H 20、參加獎 10）。
- 運費（宅配 150、7-11/全家 70、萊爾富/OK 60 代幣）。
- 儲值方案（500～30000 元，1 元 = 1 代幣，未設贈點）、大額儲值風控門檻 20000 元。
- 退款：目前上限為「錢包餘額 − 進行中申請」，未扣手續費；實際撥款為線下流程（狀態 `PAID` 尚無 API）。
- 保底：庫存耗盡後計數持續累積但不再給獎（與原型一致）；保底獎是否可回收（目前 B 不可回收）。
- 綠界模擬付款（SimulatePaid=1）一律不入帳（STAGE 可開）。

---

## 測試

`npm test`：11 個測試檔、60 個測試，全部對真實 PostgreSQL 執行（每檔獨立資料庫，由已 migrate 的 template 複製）。

| 檔案 | 涵蓋 |
|---|---|
| `tests/draw.test.ts` | 抽賞交易、年齡驗證、餘額不足全有或全無、冪等（含並發同鍵）、代選、鎖籤、最後賞/完售/換套/揭露驗證、即時機率 |
| `tests/concurrency.test.ts` | 40 人搶同籤（HTTP handler）、40 人搶鎖籤、90 筆重疊多抽混戰＋對帳＋稽核鏈 |
| `tests/guarantee.test.ts` | 保底觸發/歸零/耗盡停止/不改機率、並發不超發、設定驗證 |
| `tests/ecpay.test.ts` | 官方範例向量、.NET 編碼規則、checkout 參數、通知只入帳一次（含並發）、錯章/金額/未知訂單/失敗/模擬付款、大額風控 |
| `tests/pool.test.ts` | 承諾機制、規格範例賞池形狀、公開 API 不洩漏、草稿不公開、規則版本不可變與改版 |
| `tests/wallet-audit.test.ts` | 雙幣、點數規則、帳本 append-only、對帳偵測竄改、退款雙人覆核、稽核鏈竄改/刪除/截尾偵測 |
| `tests/warehouse-shipping.test.ts` | 回收、狀態機、合併出貨與運費、回滾、直購 |
| `tests/admin-rbac.test.ts` | 權限矩陣、雙人覆核（應用層/DB）、並發重複核准、執行失敗維持 PENDING、銀行轉帳 |
| `tests/risk-rewards.test.ts` | 限流、同裝置多帳號、綁定獎勵一次性（並發） |
| `tests/api-flow.test.ts` | 會員完整旅程（登入→儲值→驗證→鎖籤→抽→倉庫→出貨/回收→獎勵→退款）＋後台驗證 |
| `tests/schema-drift.test.ts` | `prisma/schema.prisma` 與實際 DB 結構一致 |
