# CHIAKI 一番賞平台

> 為大家的青春與夢想而存在。

CHIAKI（CHIAKI GARAGE KIT）線上一番賞與實體收藏商品平台。以自營為起點，提供透明獎池、可追溯交易與收藏倉庫，未來擴充合作商家入駐、寄售與分潤。

## 專案結構

| 目錄 | 內容 | 狀態 |
| --- | --- | --- |
| `prototype/` | 前台＋後台高保真互動原型（單一 HTML，手機／平板／電腦通用） | 視覺確認中 |
| `platform/` | 正式系統後端核心：賞池、選籤、原子抽賞交易、保底、錢包帳本、綠界金流、倉庫、出貨、稽核、權限 | 核心完成，60 項測試通過 |

## 原型

```bash
cd prototype
python3 build.py      # 由 src/ 組裝出 index.html
open index.html       # 直接以瀏覽器開啟
```

- 字型：思源宋體（Noto Serif TC）、思源黑體（Noto Sans TC），由 Google Fonts 載入。
- 主要頁面：首頁、抽賞大廳、賞池詳情與選籤、撕籤揭曉演出、中獎倉庫、錢包儲值、會員中心、直購商城、客服與規範、管理後台。
- 保底賞池封面：可將自有圖片放在 `prototype/assets/guarantee-cover.jpg`（不納入版控）後重新建置。

## 後端

技術：TypeScript、Next.js App Router 路由結構、PostgreSQL（postgres.js 原生 SQL 交易與列鎖）。詳見 [`platform/README.md`](platform/README.md)。

```bash
cd platform
npm install
npm test          # 自動啟動暫時 PostgreSQL，執行 60 項測試
npm run build     # TypeScript 型別檢查
```

## 上線前待確認

- 付費抽賞、保底、回收換點數、儲值退款之法律意見（台灣律師）
- 綠界正式商店審核與 CheckMacValue 於正式環境之驗證
- 主機與資料庫（暫緩）
- 網站條款、隱私權政策等文字之最終法律審閱
