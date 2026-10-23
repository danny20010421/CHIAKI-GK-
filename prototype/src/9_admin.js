<script>
/* =========================================================
   ADMIN — complete modules + image asset specifications
   ========================================================= */
const IMG_SPEC = {
  cover:  {n:'一番賞封面（賞池主圖）', w:1600, h:1600, min:[1080,1080], fmt:['jpeg','webp'], kb:600, safe:.8,
           use:'賞池卡片、賞池詳情主圖', rule:'主體置中，佔畫面 70–80%，四周保留 10% 安全邊；不得放價格、剩餘數或「熱賣」等文字（由系統即時顯示）'},
  prize:  {n:'獎品欄圖片', w:1200, h:1200, min:[800,800], fmt:['png','jpeg','webp'], kb:400, safe:.75,
           use:'獎項表、撕籤揭曉、中獎倉庫', rule:'單一商品置中、佔畫面約 75%；建議去背 PNG 或純色背景；多款式可用組合圖，款式數需與獎項說明一致'},
  banner: {n:'首頁主視覺 Banner（電腦）', w:2400, h:900, min:[1800,675], fmt:['jpeg','webp'], kb:800, safe:.6,
           use:'首頁輪播（電腦／平板）', rule:'標題與主體放在中央 60% 安全區，左下 40% 保留給系統文字與按鈕'},
  bannerM:{n:'首頁主視覺 Banner（手機）', w:1200, h:1500, min:[900,1125], fmt:['jpeg','webp'], kb:600, safe:.7,
           use:'首頁輪播（手機）', rule:'主體置於上半部，下方 40% 保留給系統文字'},
  event:  {n:'活動頁頁首', w:1920, h:640, min:[1440,480], fmt:['jpeg','webp'], kb:700, safe:.6,
           use:'活動頁最上方大圖', rule:'需另附手機版 1080×1080；活動名稱與日期置中，避免細小文字'},
  eventBody:{n:'活動內文圖', w:1080, h:0, min:[1080,0], fmt:['jpeg','webp','png'], kb:1000, maxH:3000,
           use:'活動說明內文', rule:'寬度固定 1080，高度不超過 3000；長圖請分段上傳'},
  ticket: {n:'籤紙設計（每套）', w:3000, h:2040, min:[1500,1020], fmt:['png'], kb:1500, safe:.78,
           use:'撕籤演出的封面與內卡', rule:'封面與內卡各一張；左側 22% 為撕口區，勿放重要文字；內卡中央保留獎品名稱區'},
  ip:     {n:'IP 封面', w:800, h:800, min:[600,600], fmt:['jpeg','webp','png'], kb:300, safe:.8, use:'抽賞大廳 IP 篩選', rule:'作品主視覺置中，避免文字'},
  product:{n:'直購商品圖', w:1200, h:1200, min:[800,800], fmt:['jpeg','webp','png'], kb:400, safe:.75, use:'直購商城', rule:'同獎品欄圖片'},
  partner:{n:'合作夥伴頭像', w:400, h:400, min:[200,200], fmt:['jpeg','webp','png'], kb:150, safe:.8, use:'首頁合作夥伴', rule:'系統裁為圓形，主體置中；需取得本人同意'},
  og:     {n:'公告／分享縮圖', w:1200, h:630, min:[1200,630], fmt:['jpeg','png'], kb:300, safe:.8, use:'LINE、FB 分享預覽', rule:'重點置中，文字不小於 48px'}
};
const ratioOf = s => s.h ? s.w / s.h : 0;
function checkImage(file, key){
  const s = IMG_SPEC[key];
  return new Promise(res => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const w = im.naturalWidth, h = im.naturalHeight, kb = Math.round(file.size / 1024), type = (file.type.split('/')[1] || '').replace('jpg','jpeg');
      const r = [
        ['檔案格式', s.fmt.includes(type), `${type.toUpperCase() || '未知'}（允許 ${s.fmt.map(x => x.toUpperCase()).join('／')}）`],
        ['檔案大小', file.size <= s.kb * 1024, `${file.size < 1024 ? fmt(file.size) + ' B' : fmt(Math.round(file.size / 102.4) / 10) + ' KB'}（上限 ${fmt(s.kb)} KB）`],
        ['最小尺寸', w >= s.min[0] && (!s.min[1] || h >= s.min[1]), `${w}×${h}（至少 ${s.min[0]}×${s.min[1] || '不限'}）`]
      ];
      if (s.h) r.push(['長寬比例', Math.abs(w / h - ratioOf(s)) / ratioOf(s) <= .02, `${(w/h).toFixed(3)}（應為 ${s.w}:${s.h}，誤差 2% 內）`]);
      if (s.maxH) r.push(['最大高度', h <= s.maxH, `${h}（上限 ${s.maxH}）`]);
      res({ok: r.every(x => x[1]), rows: r, url, w, h});
    };
    im.onerror = () => res({ok:false, rows:[['檔案格式', false, '無法讀取圖片']], url:''});
    im.src = url;
  });
}
const specRow = k => { const s = IMG_SPEC[k]; return `<tr><td>${s.n}</td><td class="num">${s.w}×${s.h || '不限'}${s.h ? `<br><span class="dim">${(() => { const g = (a,b) => b ? g(b, a % b) : a, d = g(s.w, s.h); return s.w/d + ':' + s.h/d; })()}</span>` : ''}</td>
  <td class="num">${s.min[0]}×${s.min[1] || '—'}</td><td>${s.fmt.map(x => x.toUpperCase()).join('／')}</td><td class="r num">${fmt(s.kb)} KB</td><td style="white-space:normal;min-width:240px">${s.rule}<br><span class="dim">用於：${s.use}</span></td></tr>`; };
function uploader(key, id){ return `<div class="upl" data-spec="${key}"><label class="btn s" for="${id}">${ic('plus','width:16px;height:16px')}上傳圖片</label>
  <input class="sr" type="file" id="${id}" accept="image/*" data-act="x-upl" data-spec="${key}"><span class="dim" style="font-size:12px">${IMG_SPEC[key].w}×${IMG_SPEC[key].h || '—'}・≤${IMG_SPEC[key].kb}KB</span><div class="upl-out"></div></div>`; }

/* ---------- sample admin data ---------- */
Object.assign(S, {
  members: [
    {uid:'20261023-0001', n:'Chiaki 玩家', ph:'0912-***-321', vip:'銀籤', spend:43800, st:'正常', age:true, mfa:false},
    {uid:'20261019-0142', n:'k***a', ph:'0933-***-118', vip:'金籤', spend:96200, st:'正常', age:true, mfa:true},
    {uid:'20261021-0077', n:'w***l', ph:'0988-***-602', vip:'銅籤', spend:1200, st:'凍結', age:false, mfa:false}
  ],
  vipT: [{n:'銅籤', min:0, perk:'會員基本權益'}, {n:'銀籤', min:10000, perk:'生日 100 點、新賞提前 1 小時通知'}, {n:'金籤', min:50000, perk:'每月免運 1 次、生日 300 點'}, {n:'黑金籤', min:150000, perk:'新賞優先 24 小時、專屬客服'}],
  topups: [
    {id:'TP-88021', user:'Chiaki 玩家', amt:3000, via:'信用卡', no:'2610201914ab', st:'已入帳', rc:'相符'},
    {id:'TP-88020', user:'k***a', amt:10000, via:'ATM', no:'2610191022cd', st:'已入帳', rc:'相符'},
    {id:'TP-88019', user:'y***i', amt:1000, via:'超商代碼', no:'2610181433ef', st:'待付款', rc:'待對帳'}
  ],
  orders: [
    {id:'OD-120931', type:'抽賞', user:'Chiaki 玩家', amt:900, st:'已完成', inv:'AB-12345678'},
    {id:'OD-120930', type:'運費預收', user:'Chiaki 玩家', amt:200, st:'已完成', inv:'AB-12345677'},
    {id:'OD-120927', type:'直購', user:'k***a', amt:1280, st:'待出貨', inv:'AB-12345671'},
    {id:'OD-120911', type:'抽賞', user:'w***l', amt:3000, st:'異常：重複扣款已沖正', inv:'—'}
  ],
  coupons: [{code:'WELCOME90', d:'新會員首抽 9 折', used:128, exp:'2026-11-30', on:true}, {code:'FREESHIP', d:'超商交貨便免運', used:41, exp:'2026-12-31', on:true}],
  banners: [{t:'CHIAKI GK 雕像一番賞 第一彈', from:'2026-10-20', to:'2026-11-20', ok:true}],
  staff: [{n:'輝（擁有者）', role:'超級管理員', mfa:true, last:'剛剛'}, {n:'營運 A', role:'營運', mfa:true, last:'10/22 21:40'}, {n:'客服 B', role:'客服', mfa:false, last:'10/22 18:05'}],
  audit: [{t:'10/23 08:30', who:'輝', a:'運費退還改為每件 運費÷20'}, {t:'10/22 21:40', who:'營運 A', a:'送審：CHIAKI GK 第一彈 第 3 套'}, {t:'10/22 18:05', who:'客服 B', a:'結案 CS-1019'}],
  cfg: {storeDays:30, warnDays:7, homeMin:150, homeMax:300, cvsMin:60, cvsMax:150, refundDiv:20, inviteGoal:20, inviteReward:1000, ageMin:18, holdSec:180, notice:'CHIAKI GK 雕像一番賞 第一彈 熱賣中！'},
  apiKeys: [{k:'ck_live_••••3f9a', n:'官網 LINE Bot', at:'2026-10-01', on:true}],
  merchants: [{n:'範例工作室', at:'2026-10-18', st:'待審核（第四階段開放）'}],
  admPool: 'gk', drawQ: ''
});
const drawRows = () => { const rows = []; const names = ['Chiaki 玩家','k***a','r***n','y***i','t***2','s***o'];
  POOLS.filter(p => !p.soon).forEach((p,pi) => p.tickets.filter(t => t.taken).slice(0, 4).forEach((t,k) => { const pr = p.prizes[t.pi];
    rows.push({at:`10/${22 - (k % 3)} ${pad(10 + pi*2 + k)}:${pad((t.no*7) % 60)}`, user: t.by === 'me' ? 'Chiaki 玩家' : names[(t.no + pi) % names.length], pool:p.ip, set:p.setIdx + 1, no:t.no, res:labelOf(pr) + (pr.custom ? '' : ' ' + pr.name), tx:'CK2610' + pad(pi) + String(t.no).padStart(4,'0')}); }));
  return rows; };
const barSVG = (data, unit, h = 160) => { const max = Math.max(...data.map(d => d[1])) || 1, bw = 100 / data.length;
  return `<svg class="bars" viewBox="0 0 100 ${h/4}" preserveAspectRatio="none" role="img" aria-label="長條圖">${[0,.25,.5,.75,1].map(g => `<line x1="0" x2="100" y1="${(h/4-6)*(1-g)}" y2="${(h/4-6)*(1-g)}" class="grid"/>`).join('')}
    ${data.map((d,i) => { const bh = (h/4-6) * d[1] / max; return `<g class="bar"><rect x="${i*bw + bw*.22}" y="${h/4-6-bh}" width="${bw*.56}" height="${bh}" rx=".8"/><title>${d[0]}：${fmt(d[1])}${unit}</title></g>`; }).join('')}</svg>
    <div class="bars-x">${data.map(d => `<span>${d[0]}</span>`).join('')}</div>`; };

/* ---------- module views ---------- */
Object.assign(ADM_VIEWS, {
  pool: () => `<div class="row between" style="margin-bottom:16px;flex-wrap:wrap;gap:8px"><span class="muted" style="font-size:13px">流程：草稿 → 送審 → 第二位管理員覆核 → 排程／上架 → 完售揭露</span><button class="btn s gold" data-act="x-pooled">${ic('plus','width:16px;height:16px')}建立賞池</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>賞池</th><th>來源／玩法</th><th class="r">單價</th><th class="r">套數</th><th class="r">運費（宅配／超商）</th><th class="r">已抽 / 總數</th><th>狀態</th><th></th></tr></thead><tbody>
    ${(S.poolDrafts || []).map((d,i) => `<tr><td>${d.title}</td><td><span class="tag ${SRC[d.src].c}">${SRC[d.src].t.slice(0,2)}</span> <span class="dim" style="font-size:12px">${PLAY[d.play]}</span></td><td class="r">${fmt(d.price)}</td><td class="r">${d.sets}</td><td class="r">${d.home}／${d.cvs}</td><td class="r dim">—</td><td><span class="tag ${d.st==='待覆核'?'info':'warn'}">${d.st}</span></td><td><button class="btn s" data-act="x-pooled" data-k="draft:${i}">編輯</button></td></tr>`).join('')}
    ${POOLS.map(p => { const d = soldAll(p); return `<tr><td>${p.title.split(' ～')[0]}</td><td><span class="tag ${SRC[p.src].c}">${SRC[p.src].t.slice(0,2)}</span> <span class="dim" style="font-size:12px">${PLAY[p.play]}</span></td>
      <td class="r">${fmt(p.price)}</td><td class="r">${p.sets.length}</td><td class="r">${p.ship.home}／${p.ship.cvs}</td><td class="r">${d} / ${totalAll(p)}</td>
      <td>${p.soon?'<span class="tag info">排程上架</span>':remaining(p)?'<span class="tag ok">上架中</span>':'<span class="tag">已完售</span>'}</td>
      <td><span class="row" style="gap:8px"><button class="btn s" data-act="x-pooled" data-k="${p.id}">編輯</button><button class="btn s ghost" data-act="x-adm-go" data-k="prize" data-p="${p.id}">獎品</button></span></td></tr>`; }).join('')}
    </tbody></table></div>`,
  prize: () => { const p = poolById(S.admPool) || POOLS[0];
    return `<div class="row" style="gap:8px;margin-bottom:16px;flex-wrap:wrap"><label class="sr" for="admP">選擇賞池</label><select class="input" id="admP" data-act="x-admpool" style="height:40px;width:auto;padding:0 40px 0 16px">${POOLS.map(x => `<option value="${x.id}" ${x.id===p.id?'selected':''}>${x.title.split(' ～')[0]}</option>`).join('')}</select>
      <span class="dim" style="font-size:12px">${p.src==='s' ? '自製套組：直接設定獎品名稱與大獎／中獎／小獎' : '官方／混合套組：A 賞、B 賞等賞級'}・已發布之數量不可修改</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>圖片</th><th>${p.src==='s'?'等級':'賞級'}</th><th>獎品名稱</th><th class="r">每套數量</th><th class="r">已抽出（全部套）</th><th class="r">回收值（點）</th><th class="r">已創造收益</th></tr></thead><tbody>
    ${p.prizes.map((pr,i) => { const out = p.sets.reduce((s, x) => s + x.tickets.filter(t => t.taken && t.pi === i).length, 0); return `<tr><td>${uploader('prize', 'pz'+i)}</td>
      <td>${p.src==='s' ? `<select class="input" data-act="x-prg" data-k="${i}" style="height:32px;width:auto;padding:0 32px 0 12px">${Object.entries(GRADE).map(([g,v]) => `<option value="${g}" ${pr.g===g?'selected':''}>${v.label}</option>`).join('')}</select>` : tagOf(pr)}</td>
      <td><input class="input" value="${pr.name}" data-act="x-prn" data-k="${i}" style="height:32px;min-width:200px" aria-label="獎品名稱"></td>
      <td class="r">${pr.qty}</td><td class="r">${out}</td>
      <td class="r"><input class="input num" type="number" min="0" value="${pr.rv}" data-act="x-prv" data-k="${i}" style="height:32px;width:96px;text-align:right" aria-label="回收值"></td>
      <td class="r">${fmt(Math.round(out * p.price))}</td></tr>`; }).join('')}
    </tbody></table></div><p class="dim" style="font-size:12px;margin-top:12px">「已創造收益」＝ 該獎項已抽出次數 × 單價，未扣優惠券與點數折抵。修改後即時套用到前台。</p>`; },
  draw: () => { const q = S.drawQ.trim(), rows = drawRows().filter(r => !q || (r.user + r.pool + r.tx + r.no).includes(q));
    return `<div class="row" style="gap:8px;margin-bottom:16px;flex-wrap:wrap"><label class="sr" for="drQ">搜尋</label><input class="input" id="drQ" placeholder="搜尋會員、賞池、交易編號、籤號" value="${q}" data-act="x-drq" style="height:40px;max-width:360px">
      <button class="btn s" data-act="x-csv">${ic('doc','width:16px;height:16px')}匯出 CSV</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>時間</th><th>交易編號</th><th>會員</th><th>賞池</th><th class="r">套</th><th class="r">籤號</th><th>結果</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td class="dim">${r.at}</td><td class="num">${r.tx}</td><td>${r.user}</td><td>${r.pool}</td><td class="r">${r.set}</td><td class="r num">${pad(r.no)}</td><td>${r.res}</td></tr>`).join('') || '<tr><td colspan="7" class="dim">查無資料</td></tr>'}
    </tbody></table></div><p class="dim" style="font-size:12px;margin-top:12px">會員端僅顯示 3 個月內紀錄；後台保留完整封存資料與不可竄改之稽核雜湊鏈。</p>`; },
  member: () => `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>UID</th><th>暱稱</th><th>手機</th><th>VIP</th><th class="r">累計消費</th><th>年齡驗證</th><th>MFA</th><th>狀態</th><th></th></tr></thead><tbody>
    ${S.members.map((m,i) => `<tr><td class="num">${m.uid}</td><td>${m.n}</td><td class="num">${m.ph}</td><td>${m.vip}</td><td class="r">${fmt(m.spend)}</td><td>${m.age?'<span class="tag ok">已驗證</span>':'<span class="tag warn">未驗證</span>'}</td><td>${m.mfa?'啟用':'—'}</td>
      <td><span class="tag ${m.st==='正常'?'ok':'bad'}">${m.st}</span></td><td><span class="row" style="gap:8px"><button class="btn s" data-act="x-mfreeze" data-k="${i}">${m.st==='正常'?'凍結':'解除凍結'}</button><button class="btn s ghost" data-act="x-madj" data-k="${i}">調整點數</button></span></td></tr>`).join('')}
    </tbody></table></div>`,
  vip: () => `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>等級</th><th class="r">累計消費門檻（代幣）</th><th>權益</th></tr></thead><tbody>
    ${S.vipT.map((v,i) => `<tr><td><b>${v.n}</b></td><td class="r"><input class="input num" type="number" min="0" value="${v.min}" data-act="x-vipmin" data-k="${i}" style="height:32px;width:120px;text-align:right" aria-label="${v.n} 門檻"></td><td><input class="input" value="${v.perk}" data-act="x-vipperk" data-k="${i}" style="height:32px;min-width:280px" aria-label="${v.n} 權益"></td></tr>`).join('')}
    </tbody></table></div><p class="dim" style="font-size:12px;margin-top:12px">等級依近 12 個月累計消費每日重新計算；權益變更自儲存起生效。</p>`,
  wallet: () => `<div class="kpis"><div class="kpi"><span>今日儲值</span><b>NT$ 14,000</b><em>3 筆</em></div><div class="kpi"><span>對帳相符</span><b>${S.topups.filter(t=>t.rc==='相符').length}</b><em>綠界回呼已驗證</em></div><div class="kpi"><span>待對帳</span><b style="color:var(--warn)">${S.topups.filter(t=>t.rc!=='相符').length}</b><em style="color:var(--tx-3)">超商代碼未付款</em></div><div class="kpi"><span>退款申請</span><b>${S.refunds.filter(f=>f.st==='待審核').length}</b><em style="color:var(--tx-3)">見運費退款</em></div></div>
    <div class="tbl-wrap" style="margin-top:24px"><table class="tbl"><thead><tr><th>儲值單</th><th>會員</th><th class="r">金額</th><th>方式</th><th>綠界交易序號</th><th>狀態</th><th>對帳</th></tr></thead><tbody>
    ${S.topups.map(t => `<tr><td class="num">${t.id}</td><td>${t.user}</td><td class="r">NT$ ${fmt(t.amt)}</td><td>${t.via}</td><td class="num">${t.no}</td><td><span class="tag ${t.st==='已入帳'?'ok':'warn'}">${t.st}</span></td><td><span class="tag ${t.rc==='相符'?'ok':'warn'}">${t.rc}</span></td></tr>`).join('')}
    </tbody></table></div><button class="btn s" style="margin-top:16px" data-act="x-recon">${ic('recycle','width:16px;height:16px')}執行今日對帳</button>`,
  order: () => `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>訂單</th><th>類型</th><th>會員</th><th class="r">金額</th><th>狀態</th><th>電子發票</th></tr></thead><tbody>
    ${S.orders.map(o => `<tr><td class="num">${o.id}</td><td>${o.type}</td><td>${o.user}</td><td class="r">${fmt(o.amt)}</td><td><span class="tag ${o.st==='已完成'?'ok':o.st.startsWith('異常')?'bad':'warn'}">${o.st}</span></td><td class="num">${o.inv}</td></tr>`).join('')}
    </tbody></table></div>`,
  report: () => { const days = [['10/17',61200],['10/18',74800],['10/19',58300],['10/20',91200],['10/21',83600],['10/22',77100],['10/23',86450]];
    const funnel = [['造訪',12800],['註冊',2300],['手機驗證',1840],['年齡驗證',1290],['首次儲值',612],['首次抽賞',588]];
    const sell = POOLS.filter(p => !p.soon).map(p => [p.title.replace(/\s*(一番賞|保底挑戰|單挑賞|混合賞).*$/,'').trim(), Math.round((p.total - remaining(p)) / p.total * 100)]);
    return `<div class="agrid" style="margin-top:0"><div class="panel"><h3>近 7 日 GMV（NT$）</h3>${barSVG(days, ' 元')}</div>
      <div class="panel"><h3>轉換漏斗（本月）</h3>${funnel.map(([n,v]) => `<div class="fun"><span>${n}</span><div class="fun-b"><i style="width:${v/funnel[0][1]*100}%"></i></div><b class="num">${fmt(v)}</b></div>`).join('')}</div></div>
      <div class="panel" style="margin-top:24px"><h3>各賞池目前套數售出率（%）</h3>${barSVG(sell, '%')}</div>
      <div class="kpis" style="margin-top:24px"><div class="kpi"><span>本月毛利率</span><b>38.2%</b><em>收益 − 商品成本 − 運費成本</em></div><div class="kpi"><span>未履約責任</span><b>NT$ 214,600</b><em style="color:var(--tx-3)">倉庫中獎品＋未用代幣</em></div><div class="kpi"><span>30 日留存</span><b>41%</b><em>▲ 3%</em></div><div class="kpi"><span>平均客單</span><b>1,460 幣</b><em>每次抽賞</em></div></div>`; },
  mkt: () => `<div class="row between" style="margin-bottom:16px"><b>優惠券</b><button class="btn s gold" data-act="x-cpadd">${ic('plus','width:16px;height:16px')}新增優惠券</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>代碼</th><th>內容</th><th class="r">已使用</th><th>到期</th><th>狀態</th></tr></thead><tbody>
    ${S.coupons.map((c,i) => `<tr><td class="num">${c.code}</td><td>${c.d}</td><td class="r">${c.used}</td><td>${c.exp}</td><td><button class="btn s ${c.on?'':'ghost'}" data-act="x-cpon" data-k="${i}" aria-pressed="${c.on}">${c.on?'啟用中':'已停用'}</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row between" style="margin:32px 0 16px"><b>首頁 Banner 排程</b></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>標題</th><th>電腦版</th><th>手機版</th><th>期間</th><th>狀態</th></tr></thead><tbody>
    ${S.banners.map(b => `<tr><td>${b.t}</td><td>${uploader('banner','bnD')}</td><td>${uploader('bannerM','bnM')}</td><td>${b.from} ～ ${b.to}</td><td><span class="tag ok">刊登中</span></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row between" style="margin:32px 0 16px"><b>邀請好友成效</b></div>
    <div class="kpis"><div class="kpi"><span>本月新邀請</span><b>146</b><em>完成手機驗證 118</em></div><div class="kpi"><span>達標發放</span><b>3 人</b><em>共 3,000 平台代幣</em></div><div class="kpi"><span>疑似濫用</span><b style="color:var(--warn)">9</b><em style="color:var(--tx-3)">轉人工審核</em></div><div class="kpi"><span>分眾推播</span><b>2 檔</b><em>追蹤 IP 新賞通知</em></div></div>`,
  role: () => { const perms = ['賞池上架','獎品編輯','會員凍結','退款撥款','系統設定','客服回覆','出貨作業'];
    const roles = {超級管理員:[1,1,1,1,1,1,1], 營運:[1,1,0,0,0,1,1], 財務:[0,0,0,1,0,0,0], 客服:[0,0,1,0,0,1,0], 倉管:[0,0,0,0,0,0,1]};
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>角色</th>${perms.map(p => `<th>${p}</th>`).join('')}</tr></thead><tbody>
      ${Object.entries(roles).map(([r,v]) => `<tr><td><b>${r}</b></td>${v.map(x => `<td>${x ? ic('check','width:16px;height:16px;color:var(--ok)') : '<span class="dim">—</span>'}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div><p class="dim" style="font-size:12px;margin:12px 0 24px">賞池上架、退款撥款、點數調整超過門檻等高風險操作，需第二位管理員覆核。</p>
      <div class="agrid" style="margin-top:0"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>人員</th><th>角色</th><th>MFA</th><th>最後登入</th></tr></thead><tbody>
      ${S.staff.map(s => `<tr><td>${s.n}</td><td>${s.role}</td><td>${s.mfa?'<span class="tag ok">已啟用</span>':'<span class="tag warn">未啟用</span>'}</td><td class="dim">${s.last}</td></tr>`).join('')}</tbody></table></div>
      <div class="panel"><h3>操作日誌</h3>${S.audit.map(a => `<div class="risk"><span class="dot" style="background:var(--info)"></span><div><b>${a.a}</b><div class="dim">${a.who} ・ ${a.t}</div></div></div>`).join('')}</div></div>`; },
  set: () => { const c = S.cfg, f = (k, label, unit, attrs='') => `<div class="field"><label for="cf_${k}">${label}</label><div class="row" style="gap:8px"><input class="input num" type="number" id="cf_${k}" data-cfg="${k}" value="${c[k]}" ${attrs} style="max-width:160px"><span class="dim" style="font-size:13px">${unit}</span></div></div>`;
    return `<form data-act="x-cfgsave" class="cfg">
      <div class="panel"><h3>公告</h3><div class="field"><label for="cf_notice">首頁公告文字</label><input class="input" id="cf_notice" data-cfg="notice" value="${c.notice}"></div></div>
      <div class="panel"><h3>保管與抽賞</h3><div class="cfg-g">${f('storeDays','免費保管天數','天','min="1"')}${f('warnDays','到期前提醒','天','min="1"')}${f('holdSec','鎖籤保留時間','秒','min="60"')}${f('ageMin','付費抽賞年齡門檻','歲','min="18"')}</div></div>
      <div class="panel"><h3>運費與退還</h3><div class="cfg-g">${f('homeMin','宅配運費下限','代幣')}${f('homeMax','宅配運費上限','代幣')}${f('cvsMin','超商交貨便下限','代幣')}${f('cvsMax','超商交貨便上限','代幣')}${f('refundDiv','回收小獎：每件退還 運費 ÷','件','min="1" max="100"')}</div></div>
      <div class="panel"><h3>邀請好友</h3><div class="cfg-g">${f('inviteGoal','達標人數','人','min="1"')}${f('inviteReward','贈送平台代幣','代幣','min="0"')}</div></div>
      <div class="panel"><h3>金流與物流</h3><div class="kv"><span>綠界商店代號</span><b class="num">30•••07</b></div><div class="kv"><span>綠界環境</span><span class="tag warn">測試環境</span></div><div class="kv"><span>物流商</span><b>黑貓、新竹、郵局、7-ELEVEN 交貨便、全家店到店</b></div></div>
      <button class="btn gold" type="submit">儲存設定</button></form>`; },
  ext: () => `<div class="panel"><h3>官方社群連結</h3>${[['Instagram',LINKS.ig],['LINE 社群',LINKS.line],['Facebook',LINKS.fb]].map(([n,u],i) => `<div class="field" style="margin-bottom:12px"><label for="lk${i}">${n}</label><input class="input" id="lk${i}" value="${u}"></div>`).join('')}<button class="btn s" data-act="x-toast" data-v="社群連結已儲存">儲存</button></div>
    <div class="panel" style="margin-top:24px"><h3>開放 API 金鑰</h3>${S.apiKeys.map((k,i) => `<div class="kv"><span>${k.n}<br><span class="dim num" style="font-size:12px">${k.k} ・ 建立 ${k.at}</span></span><button class="btn s" data-act="x-apirev" data-k="${i}">${k.on?'撤銷':'已撤銷'}</button></div>`).join('')}<button class="btn s" style="margin-top:12px" data-act="x-apiadd">${ic('plus','width:16px;height:16px')}產生新金鑰</button></div>
    <div class="panel" style="margin-top:24px"><h3>合作商家入駐 <span class="tag info">第四階段開放</span></h3>${S.merchants.map(m => `<div class="kv"><span>${m.n}<br><span class="dim" style="font-size:12px">申請日 ${m.at}</span></span><span class="tag">${m.st}</span></div>`).join('')}<p class="dim" style="font-size:12px;margin:12px 0 0">寄售、平台抽成與分潤結算於商家功能開放時啟用；資料表已預留商家欄位。</p></div>`,
  spec: () => `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>素材類型</th><th>建議尺寸</th><th>最小尺寸</th><th>格式</th><th class="r">檔案上限</th><th>規範與用途</th></tr></thead><tbody>
    ${Object.keys(IMG_SPEC).map(specRow).join('')}</tbody></table></div>
    <div class="panel" style="margin-top:24px"><h3>共通規範</h3><ol class="spec-ol"><li>色彩空間使用 sRGB；不得有浮水印（CHIAKI 品牌標誌除外）。</li><li>上傳前須確認擁有圖片使用權或取得授權；官方商品圖須標示來源。</li><li>每張圖片須填寫替代文字（alt），供螢幕閱讀器使用。</li><li>檔名規則：<span class="num">賞池代號_類型_序號</span>，例如 <span class="num">gk01_cover_01.webp</span>。</li><li>商品圖須與實品一致，不得過度修圖；示意圖須於圖上或說明標註「示意」。</li><li>系統會自動產生縮圖並轉為 WebP；原始檔保留 1 年。</li></ol></div>
    <div class="panel" style="margin-top:24px"><h3>上傳檢查工具</h3><div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px"><label class="sr" for="spK">素材類型</label><select class="input" id="spK" data-act="x-speck" style="height:40px;width:auto;padding:0 40px 0 16px">${Object.entries(IMG_SPEC).map(([k,s]) => `<option value="${k}">${s.n}</option>`).join('')}</select></div>
      <div id="spU">${uploader('cover','spFile')}</div></div>`
});

/* ---------- pool editor ---------- */
function poolEditor(id){
  const dr = String(id || '').startsWith('draft:') ? S.poolDrafts[+id.slice(6)] : null;
  const p = dr ? {title:dr.title, ip:dr.ip, src:dr.src, play:dr.play, price:dr.price, ship:{home:dr.home, cvs:dr.cvs}, sets:Array(dr.sets).fill(0)} : poolById(id) || {title:'', ip:S.ips[0].n, src:'s', play:'std', price:300, ship:{home:200, cvs:100}, sets:[1]};
  const c = S.cfg;
  openModal(`<h3 id="mdlT">${id ? '編輯賞池' : '建立賞池'}</h3>
    <form data-act="x-poolsave" data-k="${id || ''}" class="cfg" style="gap:16px" novalidate>
      <div class="field"><label for="pe_t">賞池名稱</label><input class="input" id="pe_t" value="${p.title}" required></div>
      <div class="cfg-g"><div class="field"><label for="pe_ip">IP</label><select class="input" id="pe_ip" style="width:100%">${S.ips.map(x => `<option ${x.n===p.ip?'selected':''}>${x.n}</option>`).join('')}</select></div>
        <div class="field"><label for="pe_src">商品來源</label><select class="input" id="pe_src" style="width:100%">${Object.entries(SRC).map(([k,v]) => `<option value="${k}" ${k===p.src?'selected':''}>${v.t}</option>`).join('')}</select></div>
        <div class="field"><label for="pe_play">玩法</label><select class="input" id="pe_play" style="width:100%">${Object.entries(PLAY).map(([k,v]) => `<option value="${k}" ${k===p.play?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="pe_price">單抽價格（代幣）</label><input class="input num" type="number" id="pe_price" min="1" value="${p.price}" required></div>
        <div class="field"><label for="pe_sets">套數</label><input class="input num" type="number" id="pe_sets" min="1" value="${p.sets.length}" required></div>
        <div class="field"><label for="pe_home">宅配運費（${c.homeMin}–${c.homeMax}）</label><input class="input num" type="number" id="pe_home" min="${c.homeMin}" max="${c.homeMax}" value="${p.ship.home}" required></div>
        <div class="field"><label for="pe_cvs">超商交貨便運費（${c.cvsMin}–${c.cvsMax}）</label><input class="input num" type="number" id="pe_cvs" min="${c.cvsMin}" max="${c.cvsMax}" value="${p.ship.cvs}" required></div></div>
      <div class="field"><span style="font-size:13px;color:var(--tx-2)">封面圖片（${IMG_SPEC.cover.w}×${IMG_SPEC.cover.h}，1:1，≤${IMG_SPEC.cover.kb}KB）</span>${uploader('cover','pe_cover')}</div>
      <div class="field"><span style="font-size:13px;color:var(--tx-2)">籤紙設計（封面、內卡各一張，${IMG_SPEC.ticket.w}×${IMG_SPEC.ticket.h}）</span>${uploader('ticket','pe_tk')}</div>
      <fieldset class="field packs-f"><legend style="font-size:13px;color:var(--tx-2);padding:0;margin-bottom:8px">快速抽可選抽數（前台「快速抽」顯示的按鈕）</legend><div class="row" style="gap:8px;flex-wrap:wrap">${[1,3,5,10,20,'all'].map(n => `<label class="chk-chip"><input type="checkbox" name="pe_pk" value="${n}" ${(p.packs || [1,5,10]).includes(n) ? 'checked' : ''}><span>${n === 'all' ? '全包' : n + ' 抽'}</span></label>`).join('')}</div></fieldset>
      <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn gold" type="submit">${id ? '儲存變更' : '建立草稿'}</button><button class="btn" type="button" data-act="x-poolsubmit" data-k="${id || ''}">送審</button></div>
      <p class="dim" style="font-size:12px;margin:0">已發布之規則與籤表不可修改，修改將產生新版本並公告；送審後需第二位管理員覆核才會上架。</p>
    </form>`, {wide:true});
}

/* read + validate the editor; live pools are versioned, new ones become drafts */
function poolSave(id, st){
  const c = S.cfg, v = x => $('#pe_' + x).value.trim(), n = x => Number(v(x));
  const f = {title:v('t'), ip:v('ip'), src:v('src'), play:v('play'), price:n('price'), sets:n('sets'), home:n('home'), cvs:n('cvs')};
  f.packs = [...document.querySelectorAll('input[name="pe_pk"]:checked')].map(x => x.value === 'all' ? 'all' : +x.value);
  if (!f.packs.length){ toast('快速抽至少要提供一種抽數'); return false; }
  const bad = (msg, el) => { toast(msg); $('#pe_' + el).focus(); return false; };
  if (f.title.length < 2) return bad('請填寫賞池名稱（至少 2 字）', 't');
  if (!Number.isInteger(f.price) || f.price < 1) return bad('單抽價格需為正整數', 'price');
  if (!Number.isInteger(f.sets) || f.sets < 1) return bad('套數需為正整數', 'sets');
  if (!(f.home >= c.homeMin && f.home <= c.homeMax)) return bad(`宅配運費需介於 ${c.homeMin}–${c.homeMax}`, 'home');
  if (!(f.cvs >= c.cvsMin && f.cvs <= c.cvsMax)) return bad(`超商運費需介於 ${c.cvsMin}–${c.cvsMax}`, 'cvs');
  S.poolDrafts = S.poolDrafts || [];
  const live = poolById(id);
  if (live){
    const sold = soldAll(live) > 0, changed = live.price !== f.price;
    if (sold && changed && st === '草稿') return bad('已開抽的賞池不可直接改價；請改為「送審」建立新版本，覆核後套用於下一套', 'price');
    if (st === '待覆核'){ S.poolDrafts.unshift({...f, st, of:live.id}); S.audit.unshift({t:'剛剛', who:'輝', a:`送審：${f.title}（新版本）`}); closeModal(); render(true); toast('已送審新版本，待第二位管理員覆核'); return true; }
    Object.assign(live, {title:f.title, ip:f.ip, play:f.play, packs:f.packs}); live.ship = {home:f.home, cvs:f.cvs};
    S.audit.unshift({t:'剛剛', who:'輝', a:`更新賞池資訊：${f.title}`}); closeModal(); render(true); toast('已儲存（名稱、IP、運費、快速抽選項等非規則欄位）'); return true;
  }
  const di = String(id || '').startsWith('draft:') ? +id.slice(6) : -1;
  if (di >= 0) S.poolDrafts[di] = {...S.poolDrafts[di], ...f, st}; else S.poolDrafts.unshift({...f, st});
  S.audit.unshift({t:'剛剛', who:'輝', a:`${st === '待覆核' ? '送審' : '儲存草稿'}：${f.title}`});
  closeModal(); render(true); toast(st === '待覆核' ? '已送審，待第二位管理員覆核' : '賞池草稿已儲存');
  return true;
}

/* ---------- events ---------- */
document.addEventListener('change', async e => {
  const el = e.target, k = el.dataset.k;
  if (el.matches('[data-act="x-upl"]') && el.files[0]){
    const box = el.closest('.upl'), out = $('.upl-out', box), key = el.dataset.spec, r = await checkImage(el.files[0], key), s = IMG_SPEC[key];
    out.innerHTML = `<div class="upl-res">${r.url ? `<div class="upl-prev" style="aspect-ratio:${s.h ? s.w + '/' + s.h : 'auto'}"><img src="${r.url}" alt="預覽"><i style="inset:${(1 - (s.safe || 1)) / 2 * 100}%" title="安全區"></i></div>` : ''}
      <ul>${r.rows.map(([n, ok, d]) => `<li class="${ok?'ok':'no'}">${ok ? ic('check','width:14px;height:14px') : ic('x','width:14px;height:14px')}<b>${n}</b><span>${d}</span></li>`).join('')}</ul>
      <span class="tag ${r.ok?'ok':'bad'}">${r.ok ? '符合規範，可上傳' : '不符合規範，請修正後重新上傳'}</span></div>`;
  }
  if (el.matches('[data-act="x-speck"]')) $('#spU').innerHTML = uploader(el.value, 'spFile');
  if (el.matches('[data-act="x-admpool"]')){ S.admPool = el.value; render(true); }
  const p = poolById(S.admPool) || POOLS[0];
  if (el.matches('[data-act="x-prn"]')){ p.prizes[+k].name = el.value; toast('已更新獎品名稱'); }
  if (el.matches('[data-act="x-prv"]')){ p.prizes[+k].rv = Math.max(0, +el.value || 0); toast('已更新回收值'); }
  if (el.matches('[data-act="x-prg"]')){ const pr = p.prizes[+k]; pr.g = el.value; pr.tier = GRADE[pr.g].tier; toast('已更新等級'); }
  if (el.matches('[data-act="x-vipmin"]')){ const v = Math.max(0, Math.floor(+el.value || 0)); el.value = v; S.vipT[+k].min = v; toast('已更新門檻'); }
  if (el.matches('[data-act="x-vipperk"]')){ S.vipT[+k].perk = el.value; toast('已更新權益'); }
});
document.addEventListener('input', e => { if (e.target.matches('[data-act="x-drq"]')){ S.drawQ = e.target.value; clearTimeout(window.__dq); window.__dq = setTimeout(() => { const pos = e.target.selectionStart; render(true); const n = $('#drQ'); if (n){ n.focus(); n.setSelectionRange(pos, pos); } }, 250); } });
document.addEventListener('submit', e => {
  if (e.target.matches('[data-act="x-cfgsave"]')){ e.preventDefault(); $$('[data-cfg]', e.target).forEach(i => { S.cfg[i.dataset.cfg] = i.type === 'number' ? +i.value : i.value; });
    S.audit.unshift({t:'剛剛', who:'輝', a:'更新系統設定'}); toast('設定已儲存，並寫入操作日誌'); }
  if (e.target.matches('[data-act="x-poolsave"]')){ e.preventDefault(); poolSave(e.target.dataset.k, '草稿'); }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act^="x-"]'); if (!el || el.tagName === 'FORM' || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const a = el.dataset.act, k = el.dataset.k;
  const A = {
    'x-pooled': () => poolEditor(k),
    'x-poolsubmit': () => poolSave(k, '待覆核'),
    'x-adm-go': () => { S.admin = k; if (el.dataset.p) S.admPool = el.dataset.p; render(true); scrollTo(0,0); },
    'x-csv': () => { const rows = drawRows(), csv = '﻿時間,交易編號,會員,賞池,套,籤號,結果\n' + rows.map(r => [r.at,r.tx,r.user,r.pool,r.set,r.no,r.res].map(x => `"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');
      const u = URL.createObjectURL(new Blob([csv], {type:'text/csv'})), l = document.createElement('a'); l.href = u; l.download = 'chiaki-draws.csv'; l.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); toast('已匯出 CSV'); },
    'x-mfreeze': () => { const m = S.members[+k]; m.st = m.st === '正常' ? '凍結' : '正常'; S.audit.unshift({t:'剛剛', who:'輝', a:`${m.st==='凍結'?'凍結':'解除凍結'}會員 ${m.uid}`}); render(true); toast(`已${m.st==='凍結'?'凍結':'解除凍結'}帳號`); },
    'x-madj': () => toast('點數調整已送出，超過 1,000 點需第二位管理員覆核'),
    'x-recon': () => { S.topups.forEach(t => { if (t.st === '已入帳') t.rc = '相符'; }); toast('對帳完成：已入帳款項與綠界紀錄相符'); render(true); },
    'x-cpadd': () => { S.coupons.push({code:'NEW' + (S.coupons.length + 1), d:'新優惠券（請編輯內容）', used:0, exp:'2026-12-31', on:false}); render(true); toast('已新增，預設為停用'); },
    'x-cpon': () => { S.coupons[+k].on = !S.coupons[+k].on; render(true); },
    'x-apiadd': () => { S.apiKeys.push({k:'ck_live_••••' + Math.random().toString(16).slice(2,6), n:'新金鑰', at:'2026-10-23', on:true}); render(true); toast('已產生新金鑰，完整金鑰僅顯示一次'); },
    'x-apirev': () => { S.apiKeys[+k].on = false; render(true); toast('金鑰已撤銷'); },
    'x-toast': () => toast(el.dataset.v)
  };
  if (A[a]){ e.preventDefault(); A[a](); }
});
/* register the new admin module */
ADM.splice(ADM.findIndex(a => a[1] === 'set') + 1, 0, ['系統','spec','素材規範','doc']);
</script>
