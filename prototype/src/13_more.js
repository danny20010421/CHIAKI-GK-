<script>
/* =========================================================
   13 — 個人資料、討論區（發文需審核）、Banner／優惠券管理、
        物流更正、賞池整合編輯
   ========================================================= */
const hx = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MIMG = k => ({bnfriend:'__DEMO_bnfriend__', bnhalloween:'__DEMO_bnhalloween__'}[k] || '').replace(/^__DEMO_.*__$/, '');
const todayTW = () => twDate();
/* downscale an uploaded image to a data URL (keeps pages light) */
function readImage(file, max, cb){
  if (!file || !/^image\//.test(file.type)) return toast('請選擇圖片檔');
  if (file.size > 8 * 1024 * 1024) return toast('圖片請小於 8MB');
  const r = new FileReader(); r.onload = () => { const im = new Image(); im.onload = () => { const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas');
    c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height); cb(c.toDataURL('image/jpeg', .85)); }; im.src = r.result; }; r.readAsDataURL(file);
}

/* ---------- 個人資料 ---------- */
S.profile = {nick:'Chiaki 玩家', name:'陳小明', email:'player@chiaki.tw', phone:'0912345321', birth:'1995-05-05', avatar:'',
  addrs:[{id:'a1', m:'home', name:'陳小明', phone:'0912345321', addr:'臺北市中山區南京東路二段 100 號 5 樓', def:true},
         {id:'a2', m:'c711', name:'陳小明', phone:'0912345321', addr:'7-ELEVEN 台北車站門市（店號 123456）'}]};
const AD_M = {home:'宅配到府', c711:'7-11 交貨便', fami:'全家店到店'};
const avatarIn = () => S.profile.avatar ? `<img class="avimg" src="${S.profile.avatar}" alt="">` : hx((S.profile.nick || 'C').slice(0, 1));
const phoneFmt = p => String(p).replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3');
const _meRoute = routes.me;
routes.me = r => _meRoute(r)
  .replace('<span class="avatar" aria-hidden="true">C</span>', `<span class="avatar" aria-hidden="true">${avatarIn()}</span>`)
  .replace('<div class="who"><b>Chiaki 玩家</b>', `<div class="who"><div class="row" style="gap:12px;flex-wrap:wrap"><b>${hx(S.profile.nick)}</b><button class="btn s" data-act="y-prof">${ic('gear','width:16px;height:16px')}編輯個人資料</button></div>`);
function profileModal(){
  const P = S.profile, locked = S.verified;
  openModal(`<h3 id="mdlT">編輯個人資料</h3>
    <form class="cfg prof" data-act="y-profsave" novalidate>
      <div class="prof-av"><span class="avatar big" id="pfAv">${avatarIn()}</span>
        <div class="row" style="gap:8px;flex-wrap:wrap"><label class="btn s" for="pfFile">${ic('plus','width:16px;height:16px')}更換頭像</label><input class="sr" type="file" id="pfFile" accept="image/*">
          ${P.avatar ? '<button class="btn s ghost" type="button" data-act="y-avdel">移除</button>' : ''}<span class="dim" style="font-size:12px">建議 400×400 以上，系統會自動裁成圓形</span></div></div>
      <div class="cfg-g">
        <div class="field"><label for="pfNick">暱稱（討論區與中獎動態顯示）</label><input class="input" id="pfNick" value="${hx(P.nick)}" maxlength="16"></div>
        <div class="field"><label for="pfName">真實姓名（出貨核對用）</label><input class="input" id="pfName" value="${hx(P.name)}" autocomplete="name"></div>
        <div class="field"><label for="pfEmail">Email</label><input class="input" id="pfEmail" type="email" value="${hx(P.email)}" autocomplete="email"></div>
        <div class="field"><label for="pfPhone">手機（變更需簡訊驗證）</label><input class="input" id="pfPhone" inputmode="tel" value="${phoneFmt(P.phone)}" autocomplete="tel"></div>
        <div class="field" id="pfOtpF" hidden><label for="pfOtp">新手機驗證碼（示範碼 123456）</label><input class="input" id="pfOtp" inputmode="numeric" maxlength="6"></div>
        <div class="field"><label for="pfBirth">出生年月日</label><input class="input" id="pfBirth" type="date" value="${P.birth}" ${locked ? 'disabled' : ''}>${locked ? '<span class="dim" style="font-size:12px">已完成年齡驗證，如需更正請聯絡客服</span>' : ''}</div>
      </div>
      <div class="row between"><b>收件資料</b><button class="btn s" type="button" data-act="y-addr" data-k="">${ic('plus','width:16px;height:16px')}新增收件資料</button></div>
      <div class="addrs">${P.addrs.map(a => `<div class="addr ${a.def ? 'def' : ''}"><div><div class="row" style="gap:8px"><span class="tag ${a.m === 'home' ? 'info' : ''}">${AD_M[a.m]}</span>${a.def ? '<span class="tag ok">預設</span>' : ''}</div>
          <b>${hx(a.name)}・${phoneFmt(a.phone)}</b><span class="dim">${hx(a.addr)}</span></div>
          <div class="row" style="gap:8px">${a.def ? '' : `<button class="btn s ghost" type="button" data-act="y-addrdef" data-k="${a.id}">設為預設</button>`}<button class="btn s" type="button" data-act="y-addr" data-k="${a.id}">編輯</button><button class="btn s ghost" type="button" data-act="y-addrdel" data-k="${a.id}">刪除</button></div></div>`).join('') || '<p class="dim" style="margin:0">尚未建立收件資料</p>'}</div>
      <button class="btn gold block" type="submit">儲存</button>
    </form>`, {wide:true});
}
function addrModal(id){
  const a = S.profile.addrs.find(x => x.id === id) || {m:'home', name:S.profile.name, phone:S.profile.phone, addr:''};
  openModal(`<h3 id="mdlT">${id ? '編輯' : '新增'}收件資料</h3>
    <form class="cfg" data-act="y-addrsave" data-k="${id || ''}" novalidate>
      <div class="pays" role="radiogroup" aria-label="配送方式" style="grid-template-columns:repeat(3,minmax(0,1fr))">${Object.entries(AD_M).map(([k,t]) => `<button class="pay" type="button" role="radio" data-act="y-adm" data-k="${k}" aria-pressed="${a.m === k}" aria-checked="${a.m === k}"><span class="pl">${t}</span></button>`).join('')}</div>
      <input type="hidden" id="adM" value="${a.m}">
      <div class="field"><label for="adName">收件人</label><input class="input" id="adName" value="${hx(a.name)}"></div>
      <div class="field"><label for="adPhone">手機</label><input class="input" id="adPhone" inputmode="tel" value="${phoneFmt(a.phone)}"></div>
      <div class="field"><label for="adAddr" id="adAddrL">${a.m === 'home' ? '地址' : '取貨門市'}</label><input class="input" id="adAddr" value="${hx(a.addr)}" placeholder="${a.m === 'home' ? '縣市／區／路段門牌' : '門市名稱與店號'}"></div>
      <label class="chk-chip" style="align-self:flex-start"><input type="checkbox" id="adDef" ${a.def || !S.profile.addrs.length ? 'checked' : ''}><span>設為預設</span></label>
      <div class="row" style="gap:8px"><button class="btn" type="button" data-act="y-prof" style="flex:1">返回</button><button class="btn gold" type="submit" style="flex:1">儲存</button></div>
    </form>`);
}
/* ---------- 討論區（發文、留言都要官方審核） ---------- */
S.forum = {cats:['開箱分享','閒聊','情報','求助'], posts:[
  {id:'F1006', cat:'開箱分享', title:'宮崎駿池 10 抽開箱，第 7 抽出卡西法！', body:'本來只想抽個盲盒，結果第 7 張撕到一半就開始發金光，手都在抖。實物比照片更透，晚上開燈超美。', by:'k***a', at:'10/23 13:20', st:'已發布', likes:42, comments:[{by:'r***n', t:'恭喜！金光那段真的會心跳加速', at:'10/23 13:41', st:'已發布'}]},
  {id:'F1005', cat:'情報', title:'烙印勇士 B 賞凱茲實物照分享', body:'狂戰士版本細節超多，披風質感很好。有人知道下一套什麼時候補貨嗎？', by:'r***n', at:'10/23 10:05', st:'已發布', likes:18, comments:[]},
  {id:'F1004', cat:'求助', title:'超商取貨的大獎可以改宅配嗎？', body:'我抽到 GK 大獎，獎項表寫宅配到府，可以改成超商取貨嗎？', by:'w***l', at:'10/22 21:48', st:'已發布', likes:3, comments:[{by:'CHIAKI 官方', t:'您好，每件獎品的寄送方式在上架時就已設定，大件獎品因超商材積限制只能宅配，運費於送達時到付。', at:'10/22 22:10', st:'已發布', staff:true}]},
  {id:'F1003', cat:'閒聊', title:'大家都是一抽一抽撕還是全部自動？', body:'我覺得慢慢撕比較有感覺，大家呢？', by:'y***i', at:'10/22 18:30', st:'已發布', likes:27, comments:[]},
  {id:'F1002', cat:'閒聊', title:'想問有沒有人要交換明信片', body:'私訊我 LINE xxxx', by:'t***2', at:'10/22 15:02', st:'審核中', likes:0, comments:[]}
]};
const ME = () => S.profile.nick;
const forumPending = () => S.forum.posts.filter(p => p.st === '審核中').length + S.forum.posts.reduce((n, p) => n + p.comments.filter(c => c.st === '審核中').length, 0);
const canSee = x => x.st === '已發布' || x.by === ME();
const stTagF = st => `<span class="tag ${st === '已發布' ? 'ok' : st === '審核中' ? 'warn' : 'bad'}">${st}</span>`;
routes.forum = r => r.arg ? forumPost(r.arg) : forumList(r.q.get('c') || '');
function forumList(c){
  const list = S.forum.posts.filter(p => canSee(p) && (!c || p.cat === c));
  return `<div class="wrap fwrap">
    <div class="page-h row between" style="flex-wrap:wrap;gap:16px"><div><h1>討論區</h1><p>分享開箱、交流情報。為維護品質，<b style="color:var(--gold-2)">發文與留言都需經官方審核後才會公開</b>，通常 24 小時內完成。</p></div>
      <button class="btn gold" data-act="y-fnew">${ic('plus','width:18px;height:18px')}發表文章</button></div>
    <div class="ipf" style="margin-bottom:24px"><a class="chip ${c ? '' : 'on'}" href="#/forum">全部</a>${S.forum.cats.map(k => `<a class="chip ${c === k ? 'on' : ''}" href="#/forum?c=${encodeURIComponent(k)}">${k}</a>`).join('')}</div>
    <div class="flist">${list.map(p => `<a class="fpost" href="#/forum/${p.id}">
        <div class="row" style="gap:8px;flex-wrap:wrap"><span class="tag">${p.cat}</span>${p.st !== '已發布' ? stTagF(p.st) : ''}</div>
        <h3>${hx(p.title)}</h3><p>${hx(p.body).slice(0, 80)}${p.body.length > 80 ? '…' : ''}</p>
        <div class="fmeta"><span>${hx(p.by)}・${p.at}</span><span>${ic('heart','width:14px;height:14px')}${p.likes}</span><span>${ic('chat','width:14px;height:14px')}${p.comments.filter(canSee).length}</span></div></a>`).join('') || '<div class="empty">這個分類還沒有文章，來當第一個吧！</div>'}</div>
    <p class="dim" style="font-size:12px;margin-top:24px">版規：禁止私下交易、廣告、人身攻擊與未經授權的圖片；違規內容將不予通過或下架。</p></div>`;
}
function forumPost(id){
  const p = S.forum.posts.find(x => x.id === id);
  if (!p || !canSee(p)) return `<div class="wrap"><div class="empty" style="margin-top:48px">文章不存在或尚未公開。<br><br><a class="btn" href="#/forum">回討論區</a></div></div>`;
  return `<div class="wrap fwrap">
    <nav class="crumb" aria-label="麵包屑"><a href="#/forum">討論區</a>${ic('right','width:14px;height:14px')}<span>${p.cat}</span></nav>
    <article class="fart">
      <div class="row" style="gap:8px;flex-wrap:wrap"><span class="tag">${p.cat}</span>${p.st !== '已發布' ? stTagF(p.st) + (p.why ? `<span class="dim" style="font-size:12px">原因：${hx(p.why)}</span>` : '') : ''}</div>
      <h1>${hx(p.title)}</h1><div class="fmeta"><span>${hx(p.by)}・${p.at}</span></div>
      <div class="fbody">${hx(p.body).replace(/\n/g, '<br>')}</div>${p.img ? `<img class="fimg" src="${p.img}" alt="">` : ''}
      <div class="row" style="gap:8px;margin-top:24px"><button class="btn s ${p.liked ? 'gold' : ''}" data-act="y-flike" data-k="${p.id}" aria-pressed="${!!p.liked}" ${p.st !== '已發布' ? 'disabled' : ''}>${ic('heart','width:16px;height:16px')}${p.likes}</button><button class="btn s ghost" data-act="y-freport" data-k="${p.id}">檢舉</button></div>
    </article>
    <section class="fcom"><h2>留言 ${p.comments.filter(canSee).length}</h2>
      ${p.comments.filter(canSee).map(c => `<div class="fc ${c.staff ? 'staff' : ''}"><div class="row between"><b>${hx(c.by)}${c.staff ? ' <span class="tag info">官方</span>' : ''}</b><span class="dim">${c.at}</span></div><p>${hx(c.t)}</p>${c.st !== '已發布' ? stTagF(c.st) : ''}</div>`).join('') || '<p class="dim">還沒有留言</p>'}
      ${p.st === '已發布' ? `<form class="freply" data-act="y-fcomment" data-k="${p.id}"><label class="sr" for="fcT">留言</label><textarea class="input" id="fcT" rows="3" maxlength="300" placeholder="留言需經審核後才會公開"></textarea><button class="btn gold" type="submit">送出留言</button></form>` : ''}
    </section></div>`;
}
function forumComposer(){
  S.fImg = '';
  openModal(`<h3 id="mdlT">發表文章</h3>
    <form class="cfg" data-act="y-fpost" novalidate>
      <div class="field"><label for="fpCat">分類</label><select class="input" id="fpCat">${S.forum.cats.map(c => `<option>${c}</option>`).join('')}</select></div>
      <div class="field"><label for="fpTitle">標題（4–40 字）</label><input class="input" id="fpTitle" maxlength="40"></div>
      <div class="field"><label for="fpBody">內容（10–1000 字）</label><textarea class="input" id="fpBody" rows="6" maxlength="1000"></textarea></div>
      <div class="field"><span style="font-size:13px;color:var(--tx-2)">圖片（選填，1 張）</span><div class="row" style="gap:8px"><label class="btn s" for="fpFile">${ic('plus','width:16px;height:16px')}選擇圖片</label><input class="sr" type="file" id="fpFile" accept="image/*"><span class="dim" id="fpImgN" style="font-size:12px">未選擇</span></div></div>
      <label class="check"><input type="checkbox" id="fpOk"><span>我已閱讀版規，內容不含私下交易、廣告或未經授權的圖片。</span></label>
      <button class="btn gold block" type="submit">送出審核</button></form>`);
}
/* admin: moderation */
ADM.splice(ADM.findIndex(a => a[1] === 'cs') + 1, 0, ['會員','forum','討論區審核','chat']);
ADM_VIEWS.forum = () => {
  const f = S.fTab || '待審核';
  const rows = [];
  S.forum.posts.forEach(p => { if (f === '待審核' ? p.st === '審核中' : f === '已發布' ? p.st === '已發布' : p.st === '已退回' || p.st === '已下架') rows.push({kind:'文章', p, x:p});
    p.comments.forEach((c, i) => { if (f === '待審核' ? c.st === '審核中' : f === '已發布' ? c.st === '已發布' : c.st === '已退回' || c.st === '已下架') rows.push({kind:'留言', p, x:c, i}); }); });
  const cnt = t => { let n = 0; S.forum.posts.forEach(p => { if (t === '待審核' ? p.st === '審核中' : t === '已發布' ? p.st === '已發布' : /退回|下架/.test(p.st)) n++; p.comments.forEach(c => { if (t === '待審核' ? c.st === '審核中' : t === '已發布' ? c.st === '已發布' : /退回|下架/.test(c.st)) n++; }); }); return n; };
  return `<div class="adm-bar">${['待審核','已發布','已退回／下架'].map(t => `<button class="chip ${f === t ? 'on' : ''}" data-act="y-ftab" data-k="${t}">${t}<span class="cn">${cnt(t === '已退回／下架' ? '退' : t)}</span></button>`).join('')}</div>
    <div class="modq">${rows.map(r => `<div class="modi"><div class="row" style="gap:8px;flex-wrap:wrap"><span class="tag ${r.kind === '文章' ? 'info' : ''}">${r.kind}</span><span class="tag">${r.p.cat}</span>${stTagF(r.x.st)}<span class="dim" style="font-size:12px">${hx(r.x.by)}・${r.x.at}</span></div>
        ${r.kind === '文章' ? `<b>${hx(r.p.title)}</b>` : `<span class="dim" style="font-size:12px">於「${hx(r.p.title)}」</span>`}<p>${hx(r.kind === '文章' ? r.p.body : r.x.t)}</p>${r.kind === '文章' && r.p.img ? `<img class="fimg s" src="${r.p.img}" alt="">` : ''}${r.x.why ? `<span class="dim" style="font-size:12px">原因：${hx(r.x.why)}</span>` : ''}
        <div class="row" style="gap:8px">${r.x.st === '審核中' ? `<button class="btn s gold" data-act="y-fok" data-k="${r.p.id}" data-i="${r.i == null ? '' : r.i}">通過</button><button class="btn s" data-act="y-fno" data-k="${r.p.id}" data-i="${r.i == null ? '' : r.i}">退回</button>`
          : r.x.st === '已發布' ? `<button class="btn s" data-act="y-fno" data-k="${r.p.id}" data-i="${r.i == null ? '' : r.i}" data-down="1">下架</button>` : `<button class="btn s" data-act="y-fok" data-k="${r.p.id}" data-i="${r.i == null ? '' : r.i}">重新發布</button>`}</div></div>`).join('') || '<div class="empty">沒有項目</div>'}</div>
    <p class="dim" style="font-size:12px;margin-top:12px">退回或下架需填寫原因，作者會在文章頁看到原因。</p>`;
};

/* ---------- 首頁 Banner（可排程、編輯、刪除、排序） ---------- */
S.banners = [
  {id:'b3', t:'CHIAKI 萬聖百鬼夜', img:MIMG('bnhalloween'), imgM:'', link:'#/lobby', from:'2026-10-23', to:'2026-12-31', on:true},
  {id:'b2', t:'品牌好友強力推薦・追蹤按讚抽 1000 UC幣', img:MIMG('bnfriend'), imgM:'', link:LINKS.ig, from:'2026-10-23', to:'2026-12-31', on:true},
];
const bnState = b => !b.on ? '已停用' : todayTW() < b.from ? '排程中' : todayTW() > b.to ? '已結束' : '刊登中';
const liveBanners = () => S.banners.filter(b => bnState(b) === '刊登中' && b.img);
const _homeR = routes.home, _homeA = routes.home.after;
routes.home = r => { let h = _homeR(r); const L = liveBanners(); if (!L.length) return h;
  const i = h.indexOf('<section class="sec" aria-label="活動 Banner">'), j = h.indexOf('</section>', i) + 10; if (i < 0) return h;
  const car = `<section class="sec" aria-label="活動 Banner"><div class="carousel imgb" id="car" aria-roledescription="carousel">
      ${L.map((b, k) => `<a class="slide bslide ${k === 0 ? 'on' : ''}" href="${hx(b.link || '#/lobby')}"${/^https?:/.test(b.link || '') ? ' target="_blank" rel="noopener"' : ''} role="group" aria-roledescription="slide" aria-label="${k + 1} / ${L.length}：${hx(b.t)}"><picture>${b.imgM ? `<source media="(max-width:599px)" srcset="${b.imgM}">` : ''}<img src="${b.img}" alt="${hx(b.t)}"></picture></a>`).join('')}
      ${L.length > 1 ? `<div class="dots">${L.map((b, k) => `<button data-slide="${k}" aria-label="第 ${k + 1} 張" aria-current="${k === 0}"><i></i></button>`).join('')}</div>` : ''}</div></section>`;
  return h.slice(0, i) + car + h.slice(j); };
routes.home.after = _homeA;

/* ---------- 優惠券 ---------- */
S.coupons = [
  {code:'WELCOME90', d:'新會員首抽 9 折', kind:'pct', val:10, min:1000, used:128, limit:1000, exp:'2026-11-30', on:true},
  {code:'VALLEY200', d:'雲頂終結谷 滿 1,000 折 200', kind:'amt', val:200, min:1000, used:0, limit:300, exp:'2026-12-31', on:true}];
const CP_K = {pct:'折扣 %', amt:'折抵 UC幣'};
const cpVal = c => c.kind === 'pct' ? `${c.val}% off` : `折 ${fmt(c.val)} UC幣`;
const cpState = c => !c.on ? '已停用' : todayTW() > c.exp ? '已過期' : c.limit && c.used >= c.limit ? '已用完' : '啟用';
const _mkt = ADM_VIEWS.mkt;
ADM_VIEWS.mkt = () => { const old = _mkt(), inv = old.slice(old.indexOf('<div class="row between" style="margin:32px 0 16px"><b>邀請好友成效</b>'));
  return `<div class="row between" style="margin-bottom:16px"><b>首頁 Banner</b><button class="btn s gold" data-act="y-bn" data-k="">${ic('plus','width:16px;height:16px')}新增 Banner</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>預覽</th><th>標題</th><th>連結</th><th>期間</th><th>狀態</th><th>排序</th><th>操作</th></tr></thead><tbody>
    ${S.banners.map((b, i) => `<tr><td>${b.img ? `<img class="bnthumb" src="${b.img}" alt="">` : '<span class="bnthumb none">未上傳</span>'}</td><td style="white-space:normal;min-width:180px">${hx(b.t)}</td><td class="num dim">${hx(b.link)}</td><td class="num">${b.from} ～ ${b.to}</td><td>${stTagT(bnState(b) === '刊登中' ? '啟用' : bnState(b) === '排程中' ? '排程' : bnState(b))}</td>
      <td><span class="row" style="gap:8px"><button class="ibtn" data-act="y-bnmv" data-k="${i}" data-d="-1" aria-label="上移" ${i ? '' : 'disabled'}>${ic('down','transform:rotate(180deg)')}</button><button class="ibtn" data-act="y-bnmv" data-k="${i}" data-d="1" aria-label="下移" ${i < S.banners.length - 1 ? '' : 'disabled'}>${ic('down')}</button></span></td>
      <td><span class="row" style="gap:8px"><button class="btn s" data-act="y-bn" data-k="${b.id}">編輯</button><button class="btn s" data-act="y-bnon" data-k="${b.id}">${b.on ? '停用' : '啟用'}</button><button class="btn s ghost" data-act="y-del" data-t="bn" data-k="${b.id}">刪除</button></span></td></tr>`).join('') || '<tr><td colspan="7" class="dim">尚無 Banner</td></tr>'}
    </tbody></table></div>
    <p class="dim" style="font-size:12px;margin:8px 0 0">刊登中且有上傳圖片的 Banner 會依排序輪播；沒有可刊登的 Banner 時首頁顯示預設賞池輪播。</p>
    <div class="row between" style="margin:32px 0 16px"><b>優惠券</b><button class="btn s gold" data-act="y-cp" data-k="">${ic('plus','width:16px;height:16px')}新增優惠券</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>代碼</th><th>內容</th><th>優惠</th><th class="r">門檻</th><th class="r">已使用</th><th>到期</th><th>狀態</th><th>操作</th></tr></thead><tbody>
    ${S.coupons.map(c => `<tr><td class="num"><b>${hx(c.code)}</b></td><td>${hx(c.d)}</td><td>${cpVal(c)}</td><td class="r">${c.min ? fmt(c.min) + ' UC幣' : '—'}</td><td class="r">${fmt(c.used)}${c.limit ? ' / ' + fmt(c.limit) : ''}</td><td class="num">${c.exp}</td><td>${stTagT(cpState(c))}</td>
      <td><span class="row" style="gap:8px"><button class="btn s" data-act="y-cp" data-k="${c.code}">編輯</button><button class="btn s" data-act="y-cpon" data-k="${c.code}">${c.on ? '停用' : '啟用'}</button><button class="btn s ghost" data-act="y-del" data-t="cp" data-k="${c.code}">刪除</button></span></td></tr>`).join('') || '<tr><td colspan="8" class="dim">尚無優惠券</td></tr>'}
    </tbody></table></div>` + inv; };
function bannerEditor(id){
  const b = S.banners.find(x => x.id === id) || {t:'', img:'', imgM:'', link:'#/lobby', from:todayTW(), to:todayTW(), on:true};
  S.bnDraft = {img:b.img, imgM:b.imgM};
  openModal(`<h3 id="mdlT">${id ? '編輯' : '新增'} Banner</h3><form class="cfg" data-act="y-bnsave" data-k="${id || ''}" novalidate>
    <div class="field"><label for="bnT">標題（替代文字，必填）</label><input class="input" id="bnT" value="${hx(b.t)}"></div>
    <div class="field"><label for="bnL">點擊連結</label><input class="input" id="bnL" value="${hx(b.link)}" placeholder="#/lobby、#/pool/bk 或 https://…"></div>
    <div class="cfg-g"><div class="field"><label for="bnF">開始日期</label><input class="input" type="date" id="bnF" value="${b.from}"></div><div class="field"><label for="bnTo">結束日期</label><input class="input" type="date" id="bnTo" value="${b.to}"></div></div>
    <div class="field"><span style="font-size:13px;color:var(--tx-2)">電腦版圖片（必填，${IMG_SPEC.banner.w}×${IMG_SPEC.banner.h}，3:1）</span><div class="bnprev" id="bnPv">${b.img ? `<img src="${b.img}" alt="">` : '<span class="dim">尚未上傳</span>'}</div>${uploader('banner','bnImg')}</div>
    <div class="field"><span style="font-size:13px;color:var(--tx-2)">手機版圖片（選填，${IMG_SPEC.bannerM.w}×${IMG_SPEC.bannerM.h}；未上傳則沿用電腦版）</span><div class="bnprev m" id="bnPvM">${b.imgM ? `<img src="${b.imgM}" alt="">` : '<span class="dim">沿用電腦版</span>'}</div>${uploader('bannerM','bnImgM')}</div>
    <label class="chk-chip" style="align-self:flex-start"><input type="checkbox" id="bnOn" ${b.on ? 'checked' : ''}><span>啟用</span></label>
    <button class="btn gold block" type="submit">儲存</button></form>`, {wide:true});
}
function couponEditor(code){
  const c = S.coupons.find(x => x.code === code) || {code:'', d:'', kind:'pct', val:10, min:0, limit:0, exp:todayTW(), on:true, used:0};
  openModal(`<h3 id="mdlT">${code ? '編輯' : '新增'}優惠券</h3><form class="cfg" data-act="y-cpsave" data-k="${code || ''}" novalidate>
    <div class="cfg-g"><div class="field"><label for="cpC">代碼（英數 4–16 碼）</label><input class="input num" id="cpC" value="${hx(c.code)}" ${code && c.used ? 'disabled' : ''} style="text-transform:uppercase"></div>
      <div class="field"><label for="cpK">類型</label><select class="input" id="cpK">${Object.entries(CP_K).map(([k,t]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label for="cpV">面額（折扣 % 或折抵 UC幣）</label><input class="input num" type="number" id="cpV" min="0" value="${c.val}"></div>
      <div class="field"><label for="cpMin">最低消費（UC幣，0 為不限）</label><input class="input num" type="number" id="cpMin" min="0" value="${c.min}"></div>
      <div class="field"><label for="cpLim">發放上限（0 為不限）</label><input class="input num" type="number" id="cpLim" min="0" value="${c.limit}"></div>
      <div class="field"><label for="cpExp">到期日</label><input class="input" type="date" id="cpExp" value="${c.exp}"></div></div>
    <div class="field"><label for="cpD">顯示說明</label><input class="input" id="cpD" value="${hx(c.d)}" placeholder="例如：新會員首抽 9 折"></div>
    ${code && c.used ? '<p class="dim" style="font-size:12px;margin:0">此券已被使用，代碼不可修改；修改面額只影響之後的使用。</p>' : ''}
    <label class="chk-chip" style="align-self:flex-start"><input type="checkbox" id="cpOn" ${c.on ? 'checked' : ''}><span>啟用</span></label>
    <button class="btn gold block" type="submit">儲存</button></form>`, {wide:true});
}

/* ---------- 物流：選貨運、更正單號與進度、異常處理 ---------- */
Object.assign(CARRIERS, {kerry:{n:'嘉里大榮物流', url:'https://www.kerrytj.com/'}, pelican:{n:'宅配通', url:'https://www.e-can.com.tw/'}});
const HOME_C = ['tcat','hct','kerry','pelican','post'];
const SHIP_EX = ['配送異常','退件','遺失','破損'];
function shipLog(s, st, note, by){ (s.log = s.log || []).push({st, at:twNow(), by:by || '輝', note:note || ''}); }
S.shipments.forEach(s => { if (!s.log) s.log = [{st:s.st, at:'—', by:'系統', note:'既有資料'}]; s.rcv = s.rcv || (s.user === 'Chiaki 玩家' ? '陳小明' : s.user); s.phone = s.phone || '0912345321'; s.to = s.to || (s.m === 'home' ? '臺北市中山區南京東路二段 100 號' : '台北車站門市'); });
function shipFix(id){
  const s = S.shipments.find(x => x.id === id), cs = s.m === 'home' ? HOME_C : [s.m];
  openModal(`<h3 id="mdlT">更正出貨單・${s.id}</h3><form class="cfg" data-act="y-shipsave" data-k="${s.id}" novalidate>
    <div class="row" style="gap:8px;flex-wrap:wrap">${stTagT(s.st)}<span class="dim" style="font-size:13px">${s.user}・${s.items} 件${s.bulky ? '・<b style="color:var(--warn)">含大件</b>' : ''}</span></div>
    <div class="cfg-g">
      <div class="field"><label for="sfM">配送方式</label><select class="input" id="sfM" data-act="y-sfm">${Object.entries(SHIP_M).map(([k,t]) => `<option value="${k}" ${s.m === k ? 'selected' : ''}>${t}</option>`).join('')}</select>${s.bulky ? '<span class="dim" style="font-size:12px">含大件獎品時只能宅配</span>' : ''}</div>
      <div class="field"><label for="sfC">物流商</label><select class="input" id="sfC">${cs.map(c => `<option value="${c}" ${s.carrier === c ? 'selected' : ''}>${CARRIERS[c].n}</option>`).join('')}</select></div>
      <div class="field"><label for="sfN">物流單號</label><input class="input num" id="sfN" value="${hx(s.no)}" placeholder="出貨後必填" autocomplete="off"></div>
      <div class="field"><label for="sfS">目前進度</label><select class="input" id="sfS">${[...SHIP_FLOW, ...SHIP_EX].map(t => `<option ${s.st === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label for="sfR">收件人</label><input class="input" id="sfR" value="${hx(s.rcv)}"></div>
      <div class="field"><label for="sfP">收件手機</label><input class="input" id="sfP" value="${phoneFmt(s.phone)}"></div></div>
    <div class="field"><label for="sfA">${s.m === 'home' ? '收件地址' : '取貨門市'}</label><input class="input" id="sfA" value="${hx(s.to)}"></div>
    <div class="field"><label for="sfWhy">更正原因／備註（倒退進度、異常、改單號時必填）</label><input class="input" id="sfWhy" placeholder="例如：單號輸入錯誤、收件人要求改地址" autocomplete="off"></div>
    <label class="chk-chip" style="align-self:flex-start"><input type="checkbox" id="sfNotify" checked><span>以站內通知／簡訊告知會員</span></label>
    <div class="slog"><b style="font-size:13px">進度紀錄</b>${(s.log || []).slice().reverse().map(l => `<div class="sl"><span class="dot ${tone(l.st)}"></span><div><b>${l.st}</b>${l.note ? `・${hx(l.note)}` : ''}<div class="dim">${l.at}・${l.by}</div></div></div>`).join('')}</div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="y-shipprint" data-k="${s.id}">${ic('doc','width:16px;height:16px')}列印出貨單</button><span style="flex:1"></span><button class="btn gold" type="submit">儲存更正</button></div>
  </form>`, {wide:true});
}
/* member side: carrier, number and the progress trail */
trackHTML = function(sh){
  if (!sh) return '';
  const last = (sh.log || []).slice(-1)[0], c = sh.carrier && CARRIERS[sh.carrier];
  return `<span class="row" style="gap:8px;flex-wrap:wrap;font-size:12px">${stTagT(sh.st)}${c && sh.no ? `${c.n}・<b class="num">${hx(sh.no)}</b>
      <button class="btn s ghost" style="height:28px;padding:0 8px" data-act="x-copy" data-v="${hx(sh.no)}">複製</button><a class="btn s ghost" style="height:28px;padding:0 8px" href="${c.url}" target="_blank" rel="noopener">查詢物流</a>` : '<span class="dim">出貨後顯示物流單號</span>'}</span>
    ${sh.log && sh.log.length > 1 ? `<details class="mlog"><summary>出貨進度（${sh.log.length}）</summary>${sh.log.slice().reverse().map(l => `<div><b>${l.st}</b><span class="dim">${l.at}</span></div>`).join('')}</details>` : ''}${last && SHIP_EX.includes(sh.st) ? `<span class="bad-t" style="font-size:12px">${sh.st}：客服會主動與您聯繫${last.note ? '（' + hx(last.note) + '）' : ''}</span>` : ''}`;
};

/* ---------- 賞池整合編輯：基本資訊、規則、獎項、說明、寄送方式、圖片一次處理 ---------- */
ADM.splice(ADM.findIndex(a => a[1] === 'pool') + 1, 0, ['營運','pooledit','編輯賞池','ticketbox']);
ADM_VIEWS.pooledit = () => {
  const p = poolById(S.editPool); if (!p) return '<div class="empty">找不到賞池</div>';
  S.admPool = p.id; const sold = soldAll(p), c = S.cfg, lk = sold ? 'disabled' : '';
  let prize = ADM_VIEWS.prize(); prize = prize.slice(prize.indexOf('</div>') + 6);
  const sec = (id, t, body) => `<section class="pe-sec" id="pe-${id}"><h2>${t}</h2>${body}</section>`;
  return `<div class="pe-top"><button class="btn s ghost" data-act="adm" data-k="pool">${ic('right','width:16px;height:16px;transform:rotate(180deg)')}返回賞池管理</button>
      <b>${hx(p.title)}</b>${stTagT(p.off ? '已下架' : sold ? '上架中' : '未開抽')}<span class="dim" style="font-size:12px">已售 ${sold} 抽</span><span style="flex:1"></span><a class="btn s" href="#/pool/${p.id}" target="_blank" rel="noopener">前台預覽</a></div>
    <nav class="pe-nav" aria-label="編輯區段">${[['base','基本資訊'],['rule','規則與玩法'],['prize','獎項（1～9 等）'],['info','說明與揭露'],['ship','寄送方式'],['img','圖片']].map(([k,t]) => `<button class="chip" data-act="scroll" data-to="pe-${k}">${t}</button>`).join('')}</nav>
    <div id="peForm" class="cfg">
    ${sec('base', '基本資訊', `<div class="cfg-g">
      <div class="field"><label for="pe2t">賞池名稱</label><input class="input" id="pe2t" value="${hx(p.title)}"></div>
      <div class="field"><label for="pe2ip">IP（作品）</label><select class="input" id="pe2ip">${sortedIps(S.ips).map(x => `<option ${x.n === p.ip ? 'selected' : ''}>${hx(x.n)}</option>`).join('')}</select></div>
      <div class="field"><label for="pe2src">商品來源</label><select class="input" id="pe2src" ${lk}>${Object.entries(SRC).map(([k,v]) => `<option value="${k}" ${k === p.src ? 'selected' : ''}>${v.t}</option>`).join('')}</select></div>
      <div class="field"><label for="pe2price">單抽價格（UC幣）</label><input class="input num" type="number" min="1" id="pe2price" value="${p.price}" ${lk}>${sold ? '<span class="dim" style="font-size:12px">已開抽，改價請送審建立新版本</span>' : ''}</div></div>`)}
    ${sec('rule', '規則與玩法', `<div class="cfg-g">
      <div class="field"><label for="pe2play">玩法</label><select class="input" id="pe2play" ${lk}>${Object.entries(PLAY).map(([k,v]) => `<option value="${k}" ${k === p.play ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label for="pe2last">最後賞（留空為無）</label><input class="input" id="pe2last" value="${hx(p.last || '')}" ${lk}></div>
      ${p.play === 'guar' && p.guar ? `<div class="field"><label for="pe2ge">保底：每幾抽</label><input class="input num" type="number" min="2" id="pe2ge" value="${p.guar.every}"></div>
        <div class="field"><label for="pe2gr">保底專用庫存</label><input class="input num" type="number" min="0" id="pe2gr" value="${p.guar.reserve}"></div>` : ''}</div>
      ${p.play === 'prob' ? '<p class="dim" style="font-size:12px;margin:0">機率賞：在下方各等級設定「固定機率 %」，留空的等級依剩餘數量隨機。</p>' : ''}
      <fieldset class="field"><legend style="font-size:13px;color:var(--tx-2);padding:0;margin-bottom:8px">可選抽數</legend><div class="row" style="gap:8px;flex-wrap:wrap">${[1,3,5,10,20,'all'].map(n => `<label class="chk-chip"><input type="checkbox" name="pe2pk" value="${n}" ${(p.packs || [1,5,10]).includes(n) ? 'checked' : ''}><span>${n === 'all' ? '全包' : n + ' 抽'}</span></label>`).join('')}</div></fieldset>`)}
    ${sec('prize', '獎項（1～9 等）', `<p class="dim" style="font-size:12px;margin:0 0 12px">獎項的修改會即時套用（已開賣時結構與數量鎖定）。</p>${prize}`)}
    ${sec('info', '說明與揭露（顯示在前台賞池頁）', `<div class="field"><label for="pe2desc">賞池介紹</label><textarea class="input" id="pe2desc" rows="3" maxlength="400" placeholder="例如：系列特色、限量說明">${hx(p.desc || '')}</textarea></div>
      <div class="cfg-g"><div class="field"><label for="pe2sn">商品來源說明</label><input class="input" id="pe2sn" value="${hx(p.srcNote || '')}" placeholder="留空使用預設文字"></div>
      <div class="field"><label for="pe2cond">商品狀況</label><input class="input" id="pe2cond" value="${hx(p.cond || '')}" placeholder="全新未拆，外盒可能有運輸輕微壓痕"></div>
      <div class="field"><label for="pe2sh">出貨時程</label><input class="input" id="pe2sh" value="${hx(p.shipNote || '')}" placeholder="依平台公告之出貨時程"></div></div>`)}
    ${sec('ship', '寄送方式（逐件預設・運費到付）', `<p class="dim" style="font-size:12px;margin:0 0 12px">上架時為每件獎品設定寄送方式，會員出貨時無法自行選擇；不同方式會自動分成不同出貨單。運費一律到付。${sold ? '<br>已開抽：寄送方式已鎖定，個別出貨單請到「物流管理」更正。' : ''}</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>等級</th><th>獎品</th><th>寄送方式</th></tr></thead><tbody>${p.levels.map((L, li) => L.items.map((it, ii) => { const pr = p.prizes.find(x => x.lv === li + 1 && x.name === it.n) || {}; return `<tr><td>${hx(L.name || (li + 1) + ' 等')}</td><td>${hx(it.n)}</td><td><label class="sr" for="pesm_${li}_${ii}">${hx(it.n)} 寄送方式</label><select class="input" id="pesm_${li}_${ii}" data-act="y-pesm" data-l="${li}" data-i="${ii}" ${lk} style="min-width:160px">${Object.entries(SHIP_M).map(([k, t]) => `<option value="${k}" ${(pr.ship || it.ship) === k ? 'selected' : ''}>${t}</option>`).join('')}</select></td></tr>`; }).join('')).join('')}</tbody></table></div>`)}
    ${sec('img', '圖片', `<div class="field"><span style="font-size:13px;color:var(--tx-2)">封面圖片（${IMG_SPEC.cover.w}×${IMG_SPEC.cover.h}，1:1）</span><div class="bnprev sq" id="peCovPv">${p.img && !String(p.img).startsWith('<svg') ? `<img src="${p.img}" alt="">` : '<span class="dim">使用預設圖</span>'}</div>${uploader('cover','peCov')}</div>
      <div class="field"><span style="font-size:13px;color:var(--tx-2)">籤紙設計（${IMG_SPEC.ticket.w}×${IMG_SPEC.ticket.h}）</span>${uploader('ticket','peTk')}</div>`)}
    <div class="pe-save"><div class="field" style="flex:1;min-width:200px"><label class="sr" for="pe2why">修改原因</label><input class="input" id="pe2why" placeholder="${sold ? '修改原因（必填，寫入操作日誌）' : '修改原因（選填）'}"></div><button class="btn gold" type="button" data-act="y-pesave">儲存變更</button></div>
    </div>`;
};
document.addEventListener('click', e => { const el = e.target.closest('[data-act="x-pooled"]'); if (!el) return; const k = el.dataset.k;
  if (k && poolById(k)){ e.stopPropagation(); e.preventDefault(); S.editPool = k; S.admin = 'pooledit'; render(true); scrollTo(0, 0); } }, true);

/* ---------- events ---------- */
document.addEventListener('change', e => { const el = e.target;
  if (el.id === 'pfFile') readImage(el.files[0], 320, d => { S.pfAv = d; $('#pfAv').innerHTML = `<img class="avimg" src="${d}" alt="">`; });
  if (el.id === 'pfPhone'){ const v = el.value.replace(/\D/g, ''); $('#pfOtpF').hidden = v === S.profile.phone; }
  if (el.id === 'fpFile') readImage(el.files[0], 1080, d => { S.fImg = d; $('#fpImgN').textContent = '已選擇 1 張'; });
  if (el.id === 'bnImg') readImage(el.files[0], 2400, d => { S.bnDraft.img = d; $('#bnPv').innerHTML = `<img src="${d}" alt="">`; });
  if (el.id === 'bnImgM') readImage(el.files[0], 1200, d => { S.bnDraft.imgM = d; $('#bnPvM').innerHTML = `<img src="${d}" alt="">`; });
  if (el.id === 'peCov') readImage(el.files[0], 1600, d => { S.peCov = d; $('#peCovPv').innerHTML = `<img src="${d}" alt="">`; });
  if (el.matches('[data-act="y-pesm"]')){ const p = poolById(S.editPool), it = p.levels[+el.dataset.l].items[+el.dataset.i], pr = p.prizes.find(x => x.lv === +el.dataset.l + 1 && x.name === it.n);
    it.ship = el.value; if (pr) pr.ship = el.value; toast(`${it.n}：${SHIP_M[el.value]}`); }
  if (el.matches('[data-act="y-shad"]')){ const a = S.profile.addrs.find(x => x.id === el.value), f = $('#addr_' + el.dataset.m); if (f){ f.value = a ? a.addr : ''; if (!a) f.focus(); } }
  if (el.matches('[data-act="y-sfm"]')){ const s = S.shipments.find(x => x.id === $('[data-act="y-shipsave"]').dataset.k); if (s.bulky && el.value !== 'home'){ el.value = 'home'; return toast('含大件獎品，只能宅配'); }
    const cs = el.value === 'home' ? HOME_C : [el.value]; $('#sfC').innerHTML = cs.map(c => `<option value="${c}">${CARRIERS[c].n}</option>`).join(''); }
});
const needOk = (cond, msg, id) => { if (cond) return true; toast(msg); if (id) $('#' + id).focus(); return false; };
document.addEventListener('submit', e => { const f = e.target, a = f.dataset.act; if (!a || !a.startsWith('y-')) return; e.preventDefault();
  if (a === 'y-profsave'){ const P = S.profile, nick = $('#pfNick').value.trim(), email = $('#pfEmail').value.trim(), ph = $('#pfPhone').value.replace(/\D/g, '');
    if (!needOk(nick.length >= 2 && nick.length <= 16, '暱稱需 2–16 字', 'pfNick') || !needOk(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), '請輸入正確的 Email', 'pfEmail') || !needOk(/^09\d{8}$/.test(ph), '請輸入正確的手機號碼', 'pfPhone')) return;
    if (ph !== P.phone && !needOk($('#pfOtp').value === '123456', '請輸入正確的簡訊驗證碼', 'pfOtp')) return;
    Object.assign(P, {nick, name:$('#pfName').value.trim(), email, phone:ph}); if (!S.verified) P.birth = $('#pfBirth').value; if (S.pfAv) P.avatar = S.pfAv; S.pfAv = '';
    closeModal(); render(true); toast('個人資料已更新'); }
  if (a === 'y-addrsave'){ const id = f.dataset.k, m = $('#adM').value, name = $('#adName').value.trim(), ph = $('#adPhone').value.replace(/\D/g, ''), ad = $('#adAddr').value.trim();
    if (!needOk(name, '請填寫收件人', 'adName') || !needOk(/^09\d{8}$/.test(ph), '請輸入正確的手機', 'adPhone') || !needOk(ad.length >= (m === 'home' ? 6 : 2), m === 'home' ? '請填寫完整地址' : '請填寫取貨門市', 'adAddr')) return;
    const L = S.profile.addrs, x = L.find(z => z.id === id) || (L.push({id:'a' + Date.now()}), L[L.length - 1]);
    Object.assign(x, {m, name, phone:ph, addr:ad}); if ($('#adDef').checked || L.length === 1) L.forEach(z => z.def = z === x);
    profileModal(); toast('收件資料已儲存'); }
  if (a === 'y-fpost'){ const t = $('#fpTitle').value.trim(), b = $('#fpBody').value.trim();
    if (!needOk(t.length >= 4, '標題至少 4 個字', 'fpTitle') || !needOk(b.length >= 10, '內容至少 10 個字', 'fpBody') || !needOk($('#fpOk').checked, '請勾選同意版規', 'fpOk')) return;
    S.forum.posts.unshift({id:'F' + (1007 + S.forum.posts.length), cat:$('#fpCat').value, title:t, body:b, img:S.fImg || '', by:ME(), at:twNow().slice(5), st:'審核中', likes:0, comments:[]});
    closeModal(); if (location.hash === '#/forum') render(true); else location.hash = '#/forum'; toast('已送出，官方審核通過後會公開'); }
  if (a === 'y-fcomment'){ const t = $('#fcT').value.trim(); if (!needOk(t.length >= 2, '請輸入留言', 'fcT')) return;
    S.forum.posts.find(p => p.id === f.dataset.k).comments.push({by:ME(), t, at:twNow().slice(5), st:'審核中'}); render(true); toast('留言已送出，審核通過後公開'); }
  if (a === 'y-freason'){ const why = $('#frWhy').value.trim(); if (!needOk(why.length >= 2, '請填寫原因', 'frWhy')) return;
    const {k, i, down} = S.fPend, p = S.forum.posts.find(x => x.id === k), x = i === '' ? p : p.comments[+i]; x.st = down ? '已下架' : '已退回'; x.why = why;
    S.audit.unshift({t:'剛剛', who:'輝', a:`討論區${down ? '下架' : '退回'}：${p.title}（${why}）`}); closeModal(); render(true); toast(down ? '已下架' : '已退回，作者會看到原因'); }
  if (a === 'y-bnsave'){ const id = f.dataset.k, t = $('#bnT').value.trim(), from = $('#bnF').value, to = $('#bnTo').value;
    if (!needOk(t, '請填寫標題', 'bnT') || !needOk(S.bnDraft.img, '請上傳電腦版圖片') || !needOk(from && to && from <= to, '結束日期需晚於開始日期', 'bnTo')) return;
    const b = S.banners.find(x => x.id === id) || (S.banners.unshift({id:'b' + Date.now()}), S.banners[0]);
    Object.assign(b, {t, link:$('#bnL').value.trim() || '#/lobby', from, to, on:$('#bnOn').checked, img:S.bnDraft.img, imgM:S.bnDraft.imgM});
    S.audit.unshift({t:'剛剛', who:'輝', a:`${id ? '編輯' : '新增'} Banner：${t}`}); closeModal(); render(true); toast('Banner 已儲存'); }
  if (a === 'y-cpsave'){ const old = f.dataset.k, code = ($('#cpC').value || old).trim().toUpperCase(), kind = $('#cpK').value, val = Math.floor(+$('#cpV').value || 0);
    if (!needOk(/^[A-Z0-9]{4,16}$/.test(code), '代碼需為英數 4–16 碼', 'cpC') || !needOk(code === old || !S.coupons.some(c => c.code === code), '代碼已存在', 'cpC')
      || !needOk(kind !== 'pct' || (val >= 1 && val <= 90), '折扣需介於 1–90%', 'cpV') || !needOk(kind !== 'amt' || val >= 1, '折抵金額需大於 0', 'cpV') || !needOk($('#cpExp').value >= todayTW(), '到期日不可早於今天', 'cpExp')) return;
    const c = S.coupons.find(x => x.code === old) || (S.coupons.unshift({used:0}), S.coupons[0]);
    Object.assign(c, {code, kind, val, d:$('#cpD').value.trim() || cpVal({kind, val}), min:Math.max(0, +$('#cpMin').value || 0), limit:Math.max(0, +$('#cpLim').value || 0), exp:$('#cpExp').value, on:$('#cpOn').checked});
    S.audit.unshift({t:'剛剛', who:'輝', a:`${old ? '編輯' : '新增'}優惠券：${code}`}); closeModal(); render(true); toast('優惠券已儲存'); }
  if (a === 'y-shipsave'){ const s = S.shipments.find(x => x.id === f.dataset.k), st = $('#sfS').value, no = $('#sfN').value.trim(), m = $('#sfM').value, why = $('#sfWhy').value.trim();
    const back = SHIP_FLOW.includes(st) && SHIP_FLOW.includes(s.st) && SHIP_FLOW.indexOf(st) < SHIP_FLOW.indexOf(s.st), changedNo = s.no && no !== s.no;
    if (!needOk(!['已出貨','已送達'].includes(st) || no, '已出貨的單需填寫物流單號', 'sfN') || !needOk(!(back || SHIP_EX.includes(st) || changedNo || m !== s.m) || why.length >= 2, '請填寫更正原因', 'sfWhy') || !needOk(!(s.bulky && m !== 'home'), '含大件獎品，只能宅配', 'sfM')) return;
    const notes = []; if (m !== s.m) notes.push(`配送方式改為${SHIP_M[m]}`); if ($('#sfC').value !== s.carrier || no !== s.no) notes.push(`物流 ${CARRIERS[$('#sfC').value].n} ${no || '—'}`);
    Object.assign(s, {m, carrier:$('#sfC').value, no, rcv:$('#sfR').value.trim(), phone:$('#sfP').value.replace(/\D/g, ''), to:$('#sfA').value.trim()});
    if (st !== s.st || notes.length || why) shipLog(s, st, [why, ...notes].filter(Boolean).join('；'));
    s.st = st; S.audit.unshift({t:'剛剛', who:'輝', a:`更正出貨單 ${s.id}：${st}${why ? '（' + why + '）' : ''}`});
    closeModal(); render(true); toast($('#sfNotify') && $('#sfNotify').checked !== false ? '已儲存，並通知會員' : '已儲存'); }
  if (a === 'y-pesave') peSave();
});
function peSave(){ { const p = poolById(S.editPool), sold = soldAll(p), c = S.cfg, why = $('#pe2why').value.trim();
    const price = Math.floor(+$('#pe2price').value), packs = [...document.querySelectorAll('input[name="pe2pk"]:checked')].map(x => x.value === 'all' ? 'all' : +x.value), t = $('#pe2t').value.trim();
    if (!needOk(t.length >= 2, '請填寫賞池名稱', 'pe2t') || !needOk(sold || price >= 1, '單抽價格需為正整數', 'pe2price')
      || !needOk(packs.length, '至少提供一種抽數') || !needOk(!sold || why.length >= 2, '已開抽的賞池修改需填寫原因', 'pe2why')) return;
    Object.assign(p, {title:t, ip:$('#pe2ip').value, packs, desc:$('#pe2desc').value.trim(), srcNote:$('#pe2sn').value.trim(), cond:$('#pe2cond').value.trim(), shipNote:$('#pe2sh').value.trim()});
    if (!sold){ p.price = price; p.src = $('#pe2src').value; p.play = $('#pe2play').value; p.last = $('#pe2last').value.trim() || null; p.prizes.forEach(pr => pr.custom = p.src === 's'); }
    if (p.guar && $('#pe2ge')){ p.guar.every = Math.max(2, +$('#pe2ge').value || p.guar.every); p.guar.reserve = Math.max(0, +$('#pe2gr').value || 0); }
    if (S.peCov){ p.img = S.peCov; S.peCov = ''; }
    S.audit.unshift({t:'剛剛', who:'輝', a:`編輯賞池：${t}${why ? '（' + why + '）' : ''}`}); render(true); toast('賞池已儲存'); }
}
document.addEventListener('click', e => { const el = e.target.closest('[data-act^="y-"]'); if (!el || el.disabled || el.tagName === 'FORM' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox')) return;
  const a = el.dataset.act, k = el.dataset.k;
  const A = {
    'y-prof': () => profileModal(), 'y-avdel': () => { S.profile.avatar = ''; S.pfAv = ''; profileModal(); },
    'y-addr': () => addrModal(k), 'y-addrdef': () => { S.profile.addrs.forEach(z => z.def = z.id === k); profileModal(); },
    'y-addrdel': () => { const L = S.profile.addrs, i = L.findIndex(z => z.id === k), was = L[i].def; L.splice(i, 1); if (was && L[0]) L[0].def = true; profileModal(); toast('已刪除收件資料'); },
    'y-adm': () => { $('#adM').value = k; $$('[data-act="y-adm"]').forEach(b => { b.setAttribute('aria-pressed', b === el); b.setAttribute('aria-checked', b === el); }); $('#adAddrL').textContent = k === 'home' ? '地址' : '取貨門市'; $('#adAddr').placeholder = k === 'home' ? '縣市／區／路段門牌' : '門市名稱與店號'; },
    'y-fnew': () => forumComposer(),
    'y-flike': () => { const p = S.forum.posts.find(x => x.id === k); p.liked = !p.liked; p.likes += p.liked ? 1 : -1; render(true); },
    'y-freport': () => toast('已收到檢舉，管理員會盡快處理'),
    'y-ftab': () => { S.fTab = k; render(true); },
    'y-fok': () => { const p = S.forum.posts.find(x => x.id === k), x = el.dataset.i === '' ? p : p.comments[+el.dataset.i]; x.st = '已發布'; x.why = ''; S.audit.unshift({t:'剛剛', who:'輝', a:`討論區通過：${p.title}`}); render(true); toast('已通過並公開'); },
    'y-fno': () => { S.fPend = {k, i:el.dataset.i, down:!!el.dataset.down}; openModal(`<h3 id="mdlT">${el.dataset.down ? '下架' : '退回'}${el.dataset.i === '' ? '文章' : '留言'}</h3><form class="cfg" data-act="y-freason" novalidate><div class="field"><label for="frWhy">原因（作者會看到）</label><input class="input" id="frWhy" placeholder="例如：含私下交易資訊"></div><button class="btn gold block" type="submit">確認</button></form>`); },
    'y-bn': () => bannerEditor(k), 'y-bnon': () => { const b = S.banners.find(x => x.id === k); b.on = !b.on; render(true); toast(b.on ? '已啟用' : '已停用'); },
    'y-bnmv': () => { const i = +k, j = i + +el.dataset.d; [S.banners[i], S.banners[j]] = [S.banners[j], S.banners[i]]; render(true); },
    'y-cp': () => couponEditor(k), 'y-cpon': () => { const c = S.coupons.find(x => x.code === k); c.on = !c.on; render(true); toast(c.on ? '已啟用' : '已停用'); },
    'y-del': () => { S.delPend = {t:el.dataset.t, k}; openModal(`<h3 id="mdlT">確認刪除</h3><p class="muted" style="font-size:14px">刪除「${hx(k)}」後無法在前台使用；${el.dataset.t === 'cp' ? '已發出的券會一併失效。' : '首頁將不再顯示此 Banner。'}</p><div class="row" style="gap:8px"><button class="btn" data-act="close-modal" style="flex:1">取消</button><button class="btn danger" data-act="y-delgo" style="flex:1">確認刪除</button></div>`); },
    'y-delgo': () => { const {t, k} = S.delPend; if (t === 'bn'){ const i = S.banners.findIndex(x => x.id === k); S.audit.unshift({t:'剛剛', who:'輝', a:`刪除 Banner：${S.banners[i].t}`}); S.banners.splice(i, 1); }
      else { const i = S.coupons.findIndex(x => x.code === k); S.coupons.splice(i, 1); S.audit.unshift({t:'剛剛', who:'輝', a:`刪除優惠券：${k}`}); } closeModal(); render(true); toast('已刪除'); },
    'y-shipfix': () => shipFix(k), 'y-pesave': () => peSave(),
    'y-shipprint': () => { const s = S.shipments.find(x => x.id === k), w = window.open('', '_blank'); if (!w) return toast('請允許彈出視窗以列印');
      w.document.write(`<title>${s.id} 出貨單</title><body style="font-family:sans-serif;padding:24px"><h2>CHIAKI 出貨單 ${s.id}</h2><p>收件人：${hx(s.rcv)}　${phoneFmt(s.phone)}<br>${SHIP_M[s.m]}：${hx(s.to)}<br>物流：${s.carrier ? CARRIERS[s.carrier].n : '—'} ${hx(s.no || '')}</p><ol>${(s.names || []).map(n => `<li>${hx(n)}</li>`).join('')}</ol><p>件數：${s.items}${s.bulky ? '（含大件）' : ''}</p><script>print()<\/script></body>`); w.document.close(); }
  };
  if (A[a]){ e.preventDefault(); A[a](); }
});
</script>
