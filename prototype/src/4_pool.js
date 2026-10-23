<script>
/* =========================================================
   POOL DETAIL + TICKET BOARD
   ========================================================= */
const holdSec = () => Math.max(60, +((typeof S !== 'undefined' && S.cfg && S.cfg.holdSec) || 180));
async function commitHash(p){
  const set = p.sets[p.setIdx];
  if (set.hash) return set.hash;
  const payload = JSON.stringify(p.tickets.map(t => [t.no, p.prizes[t.pi].name])) + '|salt:' + p.seed + ':' + p.setIdx;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    set.hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
  } catch(e){ let h = 0; for (const c of payload) h = (h*31 + c.charCodeAt(0))|0; set.hash = 'demo-' + (h>>>0).toString(16); }
  return set.hash;
}
function boardHTML(p){
  return p.tickets.map(t => {
    if (t.taken){ const pr = p.prizes[t.pi]; return `<button class="tk taken" disabled aria-label="${t.no} 號，已抽出 ${labelOf(pr)}">${tagOf(pr, true)}</button>`; }
    if (t.held) return `<button class="tk held" disabled aria-label="${t.no} 號，其他玩家鎖籤中"><span>${pad(t.no)}</span></button>`;
    const on = S.sel.includes(t.no);
    return `<button class="tk" data-tk="${t.no}" aria-pressed="${on}" aria-label="${t.no} 號籤"><span>${pad(t.no)}</span></button>`;
  }).join('');
}
function buybarHTML(p){
  const n = S.sel.length, total = n * p.price;
  const left = remaining(p) - p.tickets.filter(t => t.held && !t.taken).length;
  const holdLeft = Math.max(0, Math.ceil((S.holdUntil - Date.now())/1000));
  return `
    <div class="sel">
      ${n ? `<b><span class="coin" style="width:20px;height:20px;font-size:11px">C</span><span class="num">${fmt(total)}</span><span class="dim" style="font-size:13px;font-weight:400">（${n} 抽）</span></b>
             <span>已選：${S.sel.slice().sort((a,b)=>a-b).slice(0,8).map(pad).join('、')}${n>8?' …':''}</span>`
          : `<b style="font-size:14px">請點選籤號，或使用隨機選籤</b><span>可選 ${left} 籤 ・ 單抽 ${fmt(p.price)} CC幣</span>`}
    </div>
    ${n ? `<span class="hold" id="holdT" role="timer" aria-label="鎖籤保留時間">${ic('lock','width:14px;height:14px')}<span>${pad(Math.floor(holdLeft/60))}:${pad(holdLeft%60)}</span></span>` : ''}
    <div class="qty" role="group" aria-label="隨機選籤">
      ${[1,3,5,10].map(k => `<button class="btn s" data-act="quick" data-n="${k}" ${k>left?'disabled':''}>隨機 ${k}</button>`).join('')}
      <button class="btn s" data-act="quick" data-n="all" title="包下所有剩餘籤號">全包</button>
    </div>
    <button class="btn gold" data-act="buy" ${n?'':'disabled'}>${ic('ticket')}抽賞</button>`;
}
function refreshPick(p){
  const ae = document.activeElement, k = focusKey(ae), scope = $('#modalRoot').contains(ae) ? '#modalRoot ' : '#app ';
  $$('.board').forEach(b => b.innerHTML = boardHTML(p));
  const bb = $('#buybar'); if (bb) bb.innerHTML = buybarHTML(p);
  const fs = $('#fsBar'); if (fs) fs.innerHTML = buybarHTML(p);
  if (k){ const t = $(scope + k); if (t && t !== document.activeElement) t.focus({preventScroll:true}); }
}
function startHold(p){
  if (S.holdTimer) return;
  S.holdUntil = Date.now() + holdSec()*1000;
  S.holdTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((S.holdUntil - Date.now())/1000));
    $$('#holdT span').forEach(e => e.textContent = `${pad(Math.floor(left/60))}:${pad(left%60)}`);
    if (left <= 0){ clearHold(); if ($('[data-act="confirm-buy"]') || $('#fsBar')) closeModal(); refreshPick(p); toast('鎖籤時間已到，籤號已釋出，請重新選籤'); }
  }, 1000);
}
function clearHold(){ clearInterval(S.holdTimer); S.holdTimer = null; S.sel = []; S.holdUntil = 0; }

routes.pool = (r) => {
  const p = poolById(r.arg) || POOLS[0];
  if (S.selPool !== p.id){ clearHold(); S.selPool = p.id; }
  const live = !p.soon;
  const left = remaining(p), pct = left / p.total * 100;
  const tops = topLeft(p);
  const totalLeft = left || 1;
  const g = p.guar, gc = S.guar[p.id] || 0;
  const reserveLeft = g ? g.reserve - (p.reserveUsed || 0) : 0;
  return `<div class="wrap">
    <nav class="crumb" aria-label="麵包屑"><a href="#/home">首頁</a>${ic('right','width:14px;height:14px')}<a href="#/lobby">抽賞大廳</a>${ic('right','width:14px;height:14px')}<span>${p.ip}</span></nav>
    <div class="pd">
      <div>
        <div style="position:relative">${art(p.hue, p.play==='guar'?'保':'A', 'main', p.title + ' 主視覺', p.img)}${p.imgNote?`<span class="tag warn" style="position:absolute;left:16px;top:16px;z-index:3">${p.imgNote}</span>`:''}</div>
        <div class="thumbs">${p.prizes.slice(0,5).map(pr => art(p.hue, glyphOf(pr), '', '', pr.img)).join('')}</div>
      </div>
      <div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <span class="tag ${SRC[p.src].c}">${SRC[p.src].t}</span><span class="tag play">${PLAY[p.play]}</span>
          ${live ? (left ? '<span class="tag ok">進行中</span>' : '<span class="tag">已完售</span>') : '<span class="tag info">即將登場</span>'}
        </div>
        <h1>${p.title}</h1>${p.desc ? `<p class="pdesc">${p.desc}</p>` : ''}
        ${p.sets.length > 1 ? `<div class="sets" role="group" aria-label="選擇套數">${p.sets.map((s,k) => { const l = s.tickets.filter(t=>!t.taken).length; return s.off ? `<button class="setb out" disabled><b>${s.name || `第 ${k+1} 套`}</b><span>已下架</span></button>` : `<button class="setb ${l?'':'out'}" data-act="set" data-k="${k}" aria-pressed="${p.setIdx===k}"><b>${s.name || `第 ${k+1} 套`}</b><span>${l ? (l===s.total?'未開抽':'剩 '+l) : '已完售'}</span></button>`; }).join('')}</div>
          <p class="dim" style="font-size:12px;margin:8px 0 16px">共 ${p.sets.length} 套，每套 ${p.total} 抽獨立計算；各套籤表與承諾雜湊分別公開。</p>` : ''}
        <div class="row" style="gap:8px;align-items:baseline">
          <span class="coin" style="width:28px;height:28px;font-size:14px;align-self:center">C</span>
          <b class="num" style="font-size:32px;line-height:1">${fmt(p.price)}</b><span class="muted">CC幣 / 抽</span>
        </div>
        ${live ? `
        <div class="stats" style="margin-top:24px">
          <div class="stat"><span>剩餘抽數</span><b class="num">${left}<small>/ ${p.total}</small></b></div>
          <div class="stat gold"><span>${p.src==='s'?'大獎・中獎剩餘':'大賞剩餘'}</span><b>${p.src==='s' ? `${tops.reduce((s,t)=>s+t.n,0)}<small>件</small>` : tops.map(t => `${(t.lvName || RK[t.rk].label).replace(/賞$/,'')}<small>${t.n}</small>`).join(' ')}</b></div>
          <div class="stat"><span>最後賞</span><b style="font-size:16px">${p.last ? (left ? '未出' : '已出') : '無'}</b></div>
        </div>
        <div class="meter ${pct<=20?'low':''}" style="margin-top:16px" role="img" aria-label="剩餘 ${Math.round(pct)}%"><i style="width:${pct}%"></i></div>
        ${g ? `<div class="panel" style="margin-top:16px;padding:16px;border-color:rgba(201,164,92,.4)">
            <div class="row between"><b style="font-size:14px">${ic('lock','width:16px;height:16px;vertical-align:-3px;color:var(--gold-2)')} 我的保底進度</b><span class="num" style="color:var(--gold-2);font-weight:700">${gc} / ${g.every}</span></div>
            <div class="meter" style="margin:12px 0"><i style="width:${gc/g.every*100}%"></i></div>
            <p class="muted" style="margin:0;font-size:12px">累計 ${g.every} 抽未獲得中獎以上獎品，第 ${g.every} 抽額外獲得「${g.name}」。保底專用庫存剩餘 <b class="num">${reserveLeft}</b> 件，用罄即停止保底並公告。</p>
          </div>` : ''}
        <div class="row" style="margin-top:24px;flex-wrap:wrap">
          ${left ? `<button class="btn gold" data-act="scroll" data-to="packs" style="flex:1;min-width:160px">${ic('ticket')}立即抽賞</button>` : `<button class="btn" disabled style="flex:1;min-width:160px">${p.sets.length > 1 && p.sets.some(s => s.tickets.some(t => !t.taken)) ? '本套已完售，請選擇其他套' : '本賞池已完售'}</button>`}
          <button class="btn" data-act="follow" data-ip="${p.ip}" aria-pressed="${S.follow.includes(p.ip)}">${ic('heart','width:18px;height:18px')}${S.follow.includes(p.ip)?'已追蹤':'追蹤 IP'}</button>
        </div>` : `
        <div class="panel" style="margin-top:24px"><div class="row between"><span class="muted">開賣倒數</span><div class="cd" data-cd="${p.soon}"></div></div>
          <button class="btn block" style="margin-top:16px" data-act="notify">${ic('bell')}開賣提醒</button></div>`}

        <details class="disclose" open>
          <summary><span class="row">${ic('shield','width:18px;height:18px;color:var(--gold-2)')}來源與授權揭露</span>${ic('down','width:16px;height:16px')}</summary>
          <div class="in"><dl>
            <dt>商品來源</dt><dd>${p.srcNote || (p.src==='o'?'日本官方正版套組，均附正式進貨憑證':p.src==='s'?'CHIAKI 自行規劃之獎品、數量與價格，大獎／中獎／小獎由平台設定並公開':'官方正版、CHIAKI 自製與合作工坊商品組合，來源逐項標示於獎項表')}</dd>
            <dt>平台授權</dt><dd>${p.src==='o'?'本賞池為正版商品之線上抽賞服務，非品牌官方舉辦之活動':'CHIAKI 自有企劃'}</dd>
            <dt>商品狀況</dt><dd>${p.cond || '全新未拆，外盒可能有運輸輕微壓痕'}</dd>
          </dl></div>
        </details>
        <details class="disclose">
          <summary><span class="row">${ic('lock','width:18px;height:18px;color:var(--gold-2)')}公平性與規則版本</span>${ic('down','width:16px;height:16px')}</summary>
          <div class="in"><dl>
            <dt>抽取方式</dt><dd>${p.play === 'prob' ? `機率賞：每抽獨立依公布機率決定等級（${p.levels.map((L,i) => L.odds ? `${L.name} ${(L.odds*100).toFixed(2)}%` : '').filter(Boolean).join('、')}），其餘依剩餘數量隨機；某等級抽完後，其機率併入其餘獎項。獎品數量有限、抽完即止；` : '固定獎品清單、無放回抽取；'}${p.last?'最後一籤額外獲得最後賞；':''}結果由伺服器原子確定</dd>
            <dt>規則版本</dt><dd>v1.0.3 ・ 2026-10-20 發布（發布後不可修改，異動須另開新版本並公告）</dd>
            <dt>事前承諾</dt><dd><span class="hash" id="hash">計算中…</span></dd>
            <dt>驗證方式</dt><dd>完售後公開完整籤表與 salt，任何人可重新計算 SHA-256 比對</dd>
          </dl></div>
        </details>
        <details class="disclose">
          <summary><span class="row">${ic('truck','width:18px;height:18px;color:var(--gold-2)')}出貨與保管</span>${ic('down','width:16px;height:16px')}</summary>
          <div class="in"><dl>
            <dt>寄送方式</dt><dd>每件獎品的寄送方式由平台預先設定並標示於獎項表，無法自行變更</dd>
            <dt>運費</dt><dd><b>運費到付</b>：抽賞時不收運費，由物流業者於收件或取件時向收件人收取</dd>
            <dt>出貨時程</dt><dd>${p.shipNote || (p.src==='o'?'依官方出貨時程':p.src==='m'?'官方商品依官方出貨時程；平台商品依平台公告時程':'依平台公告之出貨時程')}</dd>
            <dt>保管期限</dt><dd>入庫後免費保管 ${storeDays()} 天，到期前 7 天及到期當天提醒；逾期未申請出貨者，可回收之獎品依回收值自動轉為不可退款 CC幣，不可回收之獎品由客服通知後續處理</dd>
          </dl></div>
        </details>
      </div>
    </div>

    <section class="prizes" aria-labelledby="h-pz">
      <div class="sec-h"><h2 id="h-pz"><small>PRIZE LIST</small>獎項與即時機率</h2><span class="dim" style="font-size:12px">${p.play === 'prob' ? '固定機率等級依設定；其餘依剩餘數量隨機' : '機率 = 該賞剩餘數 ÷ 總剩餘數，每抽即時更新'}</span></div>
      <table class="ptable">
        <thead><tr><th>等級</th><th>獎品</th><th class="r">剩餘 / 總數</th><th class="r">目前機率</th></tr></thead>
        <tbody>
          ${[...new Set(p.prizes.map(x => x.lv))].map(lv => { const its = p.prizes.map((pr,i) => ({pr,i})).filter(x => x.pr.lv === lv), ln = its.reduce((s,x) => s + remainOf(p,x.i), 0), lq = its.reduce((s,x) => s + x.pr.qty, 0);
            return its.map(({pr,i}, k) => { const n = remainOf(p,i); return `
          <tr class="${n?'':'soldout'} ${k === its.length - 1 ? 'lv-end' : ''}">
            ${k === 0 ? `<td rowspan="${its.length}" class="lv-cell">${pr.lvName === lv + ' 等' ? `<span class="lv-no">${lv}</span>` : ''}${tagOf(pr)}${its.length > 1 ? `<small>${its.length} 種・剩 ${ln}/${lq}</small>` : ''}</td>` : ''}
            <td><div class="row" style="gap:12px">${art(p.hue, glyphOf(pr), 'pthumb', '', pr.img)}<div class="pname">${pr.name}<small>${p.src==='m'?(pr.name.includes('官方')?'來源：官方正版':pr.name.includes('自製')?'來源：CHIAKI 自製':'來源：合作工坊'):(p.src==='o'?'全新未拆封・正版商品':'CHIAKI 原創設計')}</small><small class="shipm">${ic(pr.ship === 'home' ? 'truck' : 'store', 'width:14px;height:14px')}${SHIP_M[pr.ship]}<span class="hide-s">・運費到付</span></small></div></div></td>
            <td class="r"><b>${n}</b> / ${pr.qty}</td>
            <td class="r">${!(live && left) ? '—' : vipCan('odds') ? probPct(p, i) : oddsLock()}</td>
          </tr>`; }).join(''); }).join('')}
          ${p.last ? `<tr><td class="lv-cell">${rankTag('LAST')}</td><td><div class="row" style="gap:12px">${art(p.hue,'L','pthumb','',p.lastImg)}<div class="pname">${p.last}<small>抽出本賞池最後一籤者獲得</small><small class="shipm">${ic('truck','width:14px;height:14px')}宅配到府<span class="hide-s">・運費到付</span></small></div></div></td><td class="r"><b>${left?1:0}</b> / 1</td><td class="r dim">最後一籤</td></tr>` : ''}
        </tbody>
      </table>
    </section>

    ${live && left ? packsSection(p) : ''}
  </div>`;
};
routes.pool.after = (r) => {
  const p = poolById(r.arg) || POOLS[0];
  commitHash(p).then(h => { const e = $('#hash'); if (e) e.textContent = h; });
};

/* --- selection + purchase --- */
function curPool(){ const r = parseHash(); return ['pool','quick'].includes(r.name) ? (poolById(r.arg) || POOLS[0]) : null; }
function toggleTicket(no){
  const p = curPool(); if (!p) return;
  const i = S.sel.indexOf(no);
  if (i >= 0) S.sel.splice(i, 1); else S.sel.push(no);
  if (S.sel.length) startHold(p); else clearHold();
  refreshPick(p);
}
function quickPick(n){
  const p = curPool(); if (!p) return;
  const free = p.tickets.filter(t => !t.taken && !t.held).map(t => t.no);
  const k = n === 'all' ? free.length : Math.min(+n, free.length);
  S.sel = shuffle(free.slice(), Math.random).slice(0, k);
  startHold(p); refreshPick(p);
  if (n === 'all') toast('已選取全部可選籤號' + (p.last ? '，抽完即得最後賞' : ''));
}
function buyDialog(){
  const p = curPool(); if (!p || !S.sel.length) return;
  const n = S.sel.length, total = n * p.price, after = S.coins - total;
  if (!S.verified){
    openModal(`<h3 id="mdlT">首次付費抽賞：年齡與身分驗證</h3>
      <p class="muted" style="margin:0 0 16px;font-size:14px">依本平台《未成年保護》規範，付費抽賞服務限年滿 18 歲之會員使用。首次抽賞前請完成以下驗證。</p>
      <div class="field" style="margin-bottom:16px"><label for="vPhone">手機號碼（OTP 驗證）</label><input class="input" id="vPhone" inputmode="tel" placeholder="09xx-xxx-xxx"></div>
      <div class="field" style="margin-bottom:16px"><label for="vBirth">出生年月日</label><input class="input" id="vBirth" type="date" max="${twDate()}" min="1900-01-01"></div>
      <label class="check"><input type="checkbox" id="vOk"><span>我確認已年滿 18 歲，並了解抽賞為付費隨機取得商品之服務。</span></label>
      <button class="btn gold block" data-act="verify">完成驗證</button>`);
    return;
  }
  const hasLast = p.last && n >= remaining(p);
  openModal(`<h3 id="mdlT">確認抽賞</h3>
    <div class="sumrow"><span class="muted">賞池</span><b style="text-align:right;max-width:65%">${p.title}</b></div>
    <div class="sumrow"><span class="muted">籤號</span><b style="text-align:right;max-width:65%">系統隨機配籤・付款後揭曉</b></div>
    <div class="sumrow"><span class="muted">單價 × 數量</span><b>${fmt(p.price)} × ${n}</b></div>
    ${hasLast ? `<div class="sumrow"><span class="muted">最後賞</span><b style="color:var(--gold-2)">${p.last}</b></div>` : ''}
    <div class="sumrow"><span class="muted">運費</span><b class="dim" style="font-weight:500">到付・寄送方式依各獎品預設</b></div>
    <div class="sumrow"><span class="muted">優惠券</span><b class="dim">未使用</b></div>
    <div class="sumrow" style="border-bottom:0;min-height:56px"><span>應付</span><b style="font-size:22px;color:var(--gold-2)">${fmt(total)} CC幣</b></div>
    <div class="sumrow" style="border-bottom:0"><span class="muted">扣款後餘額</span><b class="${after<0?'':'muted'}" style="${after<0?'color:var(--bad)':''}">${fmt(after)} CC幣</b></div>
    <label class="check"><input type="checkbox" id="ruleOk" ${S.rulesOk?'checked':''}><span>我已閱讀並同意本賞池之<a href="#/rules" data-act="close-modal">遊戲規則與注意事項</a>及<a href="#/support" data-doc="rules">抽賞規則與機率揭露（v1.0.3）</a>，了解結果於付款後由伺服器確定，動畫僅為呈現。</span></label>
    ${after < 0
      ? `<a class="btn gold block" href="#/wallet" data-act="close-modal">餘額不足，前往儲值</a>`
      : `<button class="btn gold block" data-act="confirm-buy">${ic('ticket')}確認付款並抽賞</button>`}
    <p class="dim" style="font-size:12px;margin:12px 0 0;text-align:center">交易編號將於付款後產生，可於「消費紀錄」查詢</p>`);
}
function fullBoard(){
  const p = curPool(); if (!p) return;
  openModal(`<h3 id="mdlT">選擇籤號 ・ ${p.ip}</h3>
    <div class="board" role="group" aria-label="籤號" style="margin-top:0">${boardHTML(p)}</div>
    <div class="buybar" id="fsBar" style="bottom:0;margin-top:16px">${buybarHTML(p)}</div>`, {wide:true});
}

/* server-side (simulated): atomically settle results */
function settle(p, nos){
  const results = [];
  if (p.play === 'prob'){ const used = new Set(); nos = nos.map(() => { const t = probPick(p, used); used.add(t.no); return t.no; }); }   // 機率賞：每抽依公布機率決定等級
  nos.sort((a,b)=>a-b).forEach(no => {
    const t = p.tickets[no-1];
    if (t.taken) return;            // race lost — in production the API rejects & refunds
    t.taken = true; t.by = 'me';
    const pr = p.prizes[t.pi];
    results.push({no, rk:pr.rk, g:pr.g, lv:pr.lv, lvName:pr.lvName, small:pr.small, tag:pr.tag, img:pr.img, ship:pr.ship, custom:pr.custom, tier:pr.tier, rv:pr.rv, name:pr.name, pname:pr.name, hue:p.hue});
    if (p.guar){
      if (pr.tier >= p.guar.minTier) S.guar[p.id] = 0;
      else {
        S.guar[p.id] = (S.guar[p.id]||0) + 1;
        if (S.guar[p.id] >= p.guar.every && (p.reserveUsed||0) < p.guar.reserve){
          p.reserveUsed = (p.reserveUsed||0) + 1; S.guar[p.id] = 0;
          results.push({no, g:p.guar.g, lv:p.guar.lv || 2, lvName:p.guar.lvName || GRADE[p.guar.g].label, small:false, rk:'B', custom:p.src==='s', tier:GRADE[p.guar.g].tier, rv:p.guar.rv, name:p.guar.name, pname:p.guar.name, hue:p.hue, bonus:'保底獎勵'});
        }
      }
    }
  });
  if (p.last && remaining(p) === 0 && results.length) results.push({no:results[results.length-1].no, rk:'LAST', g:'G', custom:p.src==='s', tier:4, rv:0, name:p.last, pname:p.last, img:p.lastImg || null, ship:'home', hue:p.hue, bonus:'最後一籤'});
  return results;
}
function confirmBuy(){
  const p = curPool(); if (!p) return;
  if (!S.sel.length || p.tickets.some(t => S.sel.includes(t.no) && (t.taken || t.held))){ clearHold(); closeModal(); refreshPick(p); toast('鎖籤已失效，本次未扣款，請重新選籤'); return; }
  if (!$('#ruleOk').checked){ toast('請先勾選同意抽賞規則'); $('#ruleOk').focus(); return; }
  S.rulesOk = true;
  const nos = S.sel.slice(), total = nos.length * p.price;
  if (total > S.coins){ closeModal(); location.hash = '#/wallet'; return; }
  S.coins -= total; S.coinsNR = Math.max(0, S.coinsNR - total); syncBal();   // 先扣不可退款 CC幣
  const results = settle(p, nos);
  const today = twDate();
  results.forEach((x,i) => S.wh.unshift({id:'n'+Date.now()+i, no:x.no, txn:null, pool:p.id, set:p.setIdx, rk:x.rk, g:x.g, lv:x.lv, lvName:x.lvName, small:x.small, img:x.img, custom:x.custom, rv:x.rv, pname:x.pname, sm:x.ship, name:x.custom ? x.name : `${p.ip} ${x.name}`, hue:p.hue, at:today, st:'stored'}));
  S.tx.unshift({t:`抽賞 ・ ${p.title} ×${nos.length}`, d:twNow(), a:-(nos.length * p.price), ic:'ticket'});
  results.filter(x => x.tier >= 2).forEach(x => drawLog.unshift({u:'c***i', pool:p.ip, txt:labelOf(x)}));
  clearHold(); closeModal();
  runDraw(p, results);
  if (D){ D.paid = nos.length * p.price; }
}

/* =========================================================
   DRAW STAGE v2 — CHIAKI GK paper ticket (peel to reveal)
   Honest tension: the colour cues only climb up to the ACTUAL tier.
   ========================================================= */
const TIER = [
  {c:'rgba(233,233,239,.0)', foil:'#d7dfe0', cue:''},
  {c:'rgba(91,140,255,.55)', foil:'#b9d0ff', cue:'好 機'},
  {c:'rgba(176,123,255,.6)', foil:'#d9c4ff', cue:'熱'},
  {c:'rgba(230,199,127,.7)', foil:'#e6c77f', cue:'激 熱'},
  {c:'rgba(255,120,190,.7)', foil:'rainbow', cue:'確 定'}
];
const CUE_C = ['', '#9cbcff', '#cfb0ff', '#f0d595', '#ff9ccc'];
/* ticket frame — scalloped top/bottom, notched sides (after CHIAKI GK print design) */
function kujiFrame(stroke, sw){
  const top = [40,84,128,172,216,260].map((x,i,a)=> i ? `Q ${(a[i-1]+x)/2} 10 ${x} 16 v 5 m 0 -5` : `M ${x} 16`).join(' ');
  const bot = [260,216,172,128,84,40].map((x,i,a)=> i ? `Q ${(a[i-1]+x)/2} 194 ${x} 188 v -5 m 0 5` : '').join(' ');
  return `<path d="${top} L 272 34 L 272 60 L 286 74 L 286 130 L 272 144 L 272 170 L 260 188 ${bot} L 28 170 L 28 128 L 16 102 L 28 76 L 28 34 Z" fill="none" stroke="${stroke}" stroke-width="${sw||1.1}" stroke-linejoin="round"/>
    <path d="M 278 80 L 290 92 L 290 112 L 278 124" fill="none" stroke="${stroke}" stroke-width="${sw||1.1}" opacity=".7"/>`;
}
let _kid = 0;
function kujiCover(){
  const id = 'kc' + (++_kid);
  const vt = [...'請從此處撕開兌獎'].map((c,i)=>`<text x="21" y="${46+i*15.5}" text-anchor="middle" font-size="11" font-weight="700" fill="#3d3836" font-family="Noto Serif TC,serif">${c}</text>`).join('');
  return `<svg viewBox="0 0 300 204" role="img" aria-label="CHIAKI GK 籤紙封面">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#524c49"/><stop offset=".55" stop-color="#47423f"/><stop offset="1" stop-color="#3c3735"/></linearGradient>
      <pattern id="${id}n" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="transparent"/><circle cx="1" cy="1" r=".35" fill="rgba(255,255,255,.05)"/></pattern></defs>
    <rect width="300" height="204" fill="url(#${id})"/><rect width="300" height="204" fill="url(#${id}n)"/>
    ${kujiFrame('rgba(215,223,224,.55)')}
    <path d="M 32 54 C 86 62 92 142 32 150 Z" fill="#f4f1ec"/>
    <path d="M 52 116 v -20 a 9 9 0 0 1 18 0 v 6 m -6 -6 l 6 -7 l 6 7" fill="none" stroke="#8a827d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="11" y="30" width="20" height="144" rx="10" fill="#f4f1ec"/>${vt}
    <text x="172" y="109" text-anchor="middle" font-family="Noto Serif TC,Noto Serif CJK TC,serif" font-weight="700" font-size="20" letter-spacing="1" fill="#f2eee8">CHIAKI GK</text>
  </svg>`;
}
function kujiInner(r, opts = {}){
  const id = 'ki' + (++_kid);
  const t = r.tier != null ? r.tier : (r.rk ? RK[r.rk].tier : 0), foil = TIER[t].foil;
  const rainbow = foil === 'rainbow';
  const lm = (r.lvName || '').match(/^([A-Z])賞$/), letter = r.rk === 'LAST' ? 'LAST' : r.rk === 'P' ? '參加' : lm ? lm[1] : r.rk;
  const lsize = r.rk === 'LAST' ? 46 : r.rk === 'P' ? 44 : 66;
  const fill = t >= 1 ? `url(#${id}g)` : '#f4f6f6';
  const stroke = rainbow ? `url(#${id}r)` : (t >= 1 ? foil : 'rgba(215,223,224,.75)');
  const named = r.custom && r.rk !== 'LAST';
  const nm = named ? r.name : '';
  let cut = Math.ceil(nm.length / 2);   // break at the space nearest the middle so words stay whole
  const sp = [...nm].map((c, i) => c === ' ' ? i : -1).filter(i => i > 0); if (sp.length) cut = sp.reduce((b, i) => Math.abs(i - nm.length / 2) < Math.abs(b - nm.length / 2) ? i : b, sp[0]);
  const lines = nm.length > 11 ? [nm.slice(0, cut).trim(), nm.slice(cut).trim()] : [nm];
  const nsize = lines.length > 1 ? 19 : nm.length <= 5 ? 32 : nm.length <= 8 ? 24 : 20;
  const centre = named
    ? lines.map((l,k) => `<text x="150" y="${lines.length>1 ? 112 + k*28 : 124}" text-anchor="middle" font-family="Noto Serif TC,Noto Serif CJK TC,serif" font-weight="700" font-size="${nsize}" letter-spacing="1" fill="${fill}">${l}</text>`).join('')
    : `<text x="${r.rk==='LAST'||r.rk==='P'?140:142}" y="134" text-anchor="middle" font-family="Cormorant Garamond,Noto Serif TC,serif" font-weight="700" font-size="${lsize}" fill="${fill}">${letter}</text>
    <text x="${r.rk==='LAST'?200:r.rk==='P'?194:176}" y="134" text-anchor="middle" font-family="Noto Serif TC,serif" font-weight="700" font-size="20" fill="${fill}">賞</text>`;
  const foot = named ? lvLabel(r) : opts.foot;
  return `<svg viewBox="0 0 300 204" role="img" aria-label="${labelOf(r)}">
    <defs>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">${rainbow
        ? '<stop offset="0" stop-color="#ffe1f0"/><stop offset=".5" stop-color="#ffd56b"/><stop offset="1" stop-color="#8fd3ff"/>'
        : `<stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="${foil}"/><stop offset="1" stop-color="${t>=3?'#9b7330':foil}"/>`}</linearGradient>
      <linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff8a8a"/><stop offset=".33" stop-color="#ffd56b"/><stop offset=".66" stop-color="#7fe0ff"/><stop offset="1" stop-color="#c79bff"/></linearGradient>
      <radialGradient id="${id}b" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="${t>=3?'#26363a':'#223238'}"/><stop offset="1" stop-color="#1b272b"/></radialGradient>
    </defs>
    <rect width="300" height="204" fill="url(#${id}b)"/>
    ${kujiFrame(stroke, t >= 2 ? 1.6 : 1.1)}
    <text x="150" y="52" text-anchor="middle" font-family="Noto Serif TC,serif" font-weight="700" font-size="12" fill="#f4f6f6" letter-spacing="1">${opts.head || 'CHIAKI GK'}</text>
    <text x="150" y="69" text-anchor="middle" font-family="Noto Serif TC,serif" font-size="9.5" fill="#c9d3d5">${opts.sub || ''}</text>
    ${centre}
    <text x="150" y="${named && lines.length > 1 ? 168 : 162}" text-anchor="middle" font-family="Noto Serif TC,serif" font-weight="${foot?700:400}" font-size="${foot?12.5:9.5}" fill="${foot?(named && t>=2 ? foil : '#f4f6f6'):'#c9d3d5'}" letter-spacing="${foot?2:0}">${foot ? (foot.length > 20 ? foot.slice(0,19) + '…' : foot) : '僅限線上抽賞・結果已於發布時鎖定'}</text>
  </svg>`;
}

let D = null;
function runDraw(p, results){
  D = {p, results, i:0, auto:false, busy:false, f:0, tier:0, done:false, txn:'CK' + twDate().replace(/-/g,'') + '-' + String(Math.floor(Math.random()*1e6)).padStart(6,'0')};
  $('#toastRoot').innerHTML = '';
  $('#stageRoot').innerHTML = `<div class="stage" id="stage" role="dialog" aria-modal="true" aria-label="抽賞演出">
    <div class="amb"></div><div class="rays"></div><canvas id="fxCv"></canvas>
    <div class="top">
      <span class="tl"><button class="btn s ghost" data-act="rm-toggle" aria-pressed="${document.body.classList.contains('rm')}" aria-label="減少動態">${ic('motion','width:16px;height:16px')}<span class="lbl">減少動態</span></button></span>
      <span class="ctr num" id="ctr" aria-live="polite"></span>
      <button class="btn s" data-act="skip">略過${ic('skip','width:16px;height:16px')}</button>
    </div>
    <div class="mid">
      <div class="cue" id="cue" aria-live="assertive"></div>
      <div class="tix-wrap" id="tixWrap"></div>
      <div class="drag-hint" id="hint"></div>
      <div class="res" id="res" aria-live="polite"></div>
    </div>
    <div class="bottom" id="sbtm"></div>
    <div class="summary" id="sum"></div>
  </div>`;
  document.documentElement.style.overflow = 'hidden';
  fx.init($('#fxCv'));
  nextTicket();
}
function stageTier(t){
  const st = $('#stage'); if (!st) return;
  D.tier = t;
  st.style.setProperty('--tc', TIER[t].c);
  const tx = $('.tix', st); if (tx) $('.aura', tx).style.opacity = t ? .9 : 0;
  $('.rays', st).style.opacity = t >= 3 ? .35 : 0;
  const cue = $('#cue');
  if (TIER[t].cue){ cue.style.setProperty('--cue-c', CUE_C[t]); cue.textContent = TIER[t].cue; cue.classList.remove('pop'); void cue.offsetWidth; cue.classList.add('pop'); }
}
function setPeel(f){
  D.f = f;
  const tx = $('.tix'); if (!tx) return;
  tx.style.setProperty('--f', f + '%');
  tx.style.setProperty('--fw', Math.max(0, Math.min(f, 100 - f)) + '%');
  $('.seam', tx).style.opacity = f > 1 && f < 50 && D.tier ? 1 : 0;
}
function nextTicket(){
  const st = $('#stage'); if (!st) return;
  const r = D.results[D.i];
  if (!r) return showSummary();
  D.f = 0; D.tier = 0; D.done = false; D.busy = false;
  st.style.setProperty('--tc', TIER[0].c); $('.rays', st).style.opacity = 0;
  const left = D.results.length - D.i - 1;
  const p = D.p;
  const sub = `${p.sets && p.sets.length > 1 ? `第 ${pad(p.setIdx+1)} 套 ・ ` : ''}No.${pad(r.no)}${r.bonus ? ' ・ ' + r.bonus : ''}`;
  $('#tixWrap').innerHTML = `${left > 1 ? '<div class="tix-stack s2"></div>' : ''}${left > 0 ? '<div class="tix-stack"></div>' : ''}
    <div class="tix ${RM()?'':'idle'}" id="tix" tabindex="0" role="button" aria-label="籤紙 ${sub}，按 Enter 自動撕開，或向右拖曳撕口">
      <div class="aura"></div>
      <div class="inner">${kujiInner(r, {sub, foot:r.name})}</div>
      <div class="shine"></div>
      <div class="cover">${kujiCover()}</div>
      <div class="flap"></div><div class="seam"></div><div class="tab-nudge"></div>
    </div>`;
  setPeel(0);
  $('#cue').textContent = ''; $('#cue').style.removeProperty('--cue-c');
  $('#cue').innerHTML = `<small>${r.bonus ? r.bonus : 'TICKET ' + pad(r.no)}</small>`;
  $('#hint').innerHTML = D.auto ? '' : `${ic('right','width:16px;height:16px')}按住左側撕口向右拉開・或點一下自動撕開`;
  $('#res').className = 'res'; $('#res').innerHTML = '';
  $('#ctr').innerHTML = D.results.length > 1 ? D.results.map((_,k) => `<i class="${k<D.i?'done':k===D.i?'on':''}"></i>`).join('') + `<span style="margin-left:8px">${D.i+1} / ${D.results.length}</span>` : '';
  $('#sbtm').innerHTML = D.results.length > 1 ? `<button class="btn" data-act="auto" aria-pressed="${D.auto}">${D.auto?'自動撕開中':'全部自動撕開'}</button>` : '';
  bindPeel($('#tix'));
  if (D.auto) setTimeout(autoPeel, RM() ? 150 : 600);
  else setTimeout(() => { const t = $('#tix'); t && t.focus({preventScroll:true}); }, 60);
}
/* drag to peel — fold line follows half the finger travel (physical fold) */
function bindPeel(el){
  let sx = null, rect = null, moved = false;
  el.addEventListener('pointerdown', e => { if (D.busy || D.done) return; sx = e.clientX; rect = el.getBoundingClientRect(); moved = false; el.setPointerCapture(e.pointerId); el.classList.remove('idle'); });
  el.addEventListener('pointermove', e => {
    if (sx == null || D.busy || D.done) return;
    const dx = e.clientX - sx; if (Math.abs(dx) > 6) moved = true;
    if (!moved) return;
    el.classList.add('peeling');
    const edge = Math.max(0, (e.clientX - rect.left) / rect.width * 100);   // where the torn edge is
    const f = Math.min(50, Math.max(D.f, edge / 2));
    setPeel(f); escalateByPeel(f);
    if (f >= 40) { sx = null; finishPeel(); }
  });
  const up = () => { if (sx == null) return; const wasTap = !moved; sx = null; if (wasTap && !D.busy && !D.done) autoPeel(); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', () => sx = null);
  el.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !D.busy && !D.done){ e.preventDefault(); autoPeel(); } });
}
function escalateByPeel(f){
  const tier = D.results[D.i].tier;
  const want = Math.min(tier, Math.floor(f / 8));          // thresholds 8/16/24/32 % — never above the real tier
  if (want > D.tier){ stageTier(want); cueFx(want); }
}
function cueFx(t){
  if (RM()) return;
  const tx = $('#tix'); if (!tx) return;
  const r = tx.getBoundingClientRect();
  fx.seam(r.left + r.width * D.f / 100, r.top, r.height, t);
  if (t >= 2){ tx.classList.remove('knock'); void tx.offsetWidth; tx.classList.add('knock'); }
  if (navigator.vibrate && t >= 3) try { navigator.vibrate(30); } catch(_){}
}
const tween = (from, to, ms, fn) => new Promise(res => {
  if (RM() || ms <= 0){ fn(to); return res(); }
  const t0 = performance.now();
  const step = now => { const k = Math.min(1, (now - t0) / ms); const e = 1 - Math.pow(1 - k, 3); fn(from + (to - from) * e); k < 1 ? requestAnimationFrame(step) : res(); };
  requestAnimationFrame(step);
});
async function autoPeel(){
  if (!D || D.busy || D.done) return;
  D.busy = true;
  const tx = $('#tix'); tx.classList.remove('idle'); tx.classList.add('peeling'); $('#hint').innerHTML = '';
  const tier = D.results[D.i].tier;
  await tween(D.f, Math.max(D.f, 6), 320, setPeel);
  for (let t = D.tier + 1; t <= tier; t++){
    if (!$('#stage')) return;
    await tween(D.f, Math.max(D.f, t * 8 + 2), 340, setPeel);
    stageTier(t); cueFx(t);
    await sleep(RM() ? 0 : 420);
  }
  if (!$('#stage')) return;
  if (tier >= 3 && !RM()){            // 溜め — the pause before the big one
    tx.classList.add('tremble'); await sleep(900); tx.classList.remove('tremble');
  }
  D.busy = false;
  finishPeel();
}
async function finishPeel(){
  if (!D || D.done) return;
  D.done = true; D.busy = true;
  const r = D.results[D.i], tier = r.tier;
  if (tier > D.tier){ stageTier(tier); }
  const tx = $('#tix'); if (!tx) return;
  await tween(D.f, 50, 220, setPeel);
  $('.cover', tx).style.display = 'none';
  tx.classList.add('flyoff', 'revealed'); $('.seam', tx).style.opacity = 0;
  const rc = tx.getBoundingClientRect();
  if (!RM()){
    if (tier >= 3) fx.burst(tier === 4 ? 'rainbow' : 'gold', 180, rc);
    else if (tier === 2) fx.burst('purple', 80, rc);
    else if (tier === 1) fx.burst('blue', 36, rc);
  }
  if (tier >= 3){ $('#cue').style.setProperty('--cue-c', CUE_C[tier]); $('#cue').textContent = r.custom && r.rk !== 'LAST' ? '大 獎' : [...labelOf(r)].join(' '); }
  else $('#cue').innerHTML = `<small>${r.custom && r.rk !== 'LAST' ? lvLabel(r) : labelOf(r)}</small>`;
  await sleep(RM() ? 0 : 450);
  if (!$('#stage') || $('#sum.show')) return;
  const res = $('#res');
  res.innerHTML = `${art(r.hue, glyphOf(r), '', '', r.img)}<div class="t">${tagOf(r, true)}<b>${r.name}</b><span>${r.bonus?r.bonus+' ・ ':''}${D.demo ? '免費體驗・不發放' : '已存入中獎倉庫'}</span></div>`;
  res.classList.add('show');
  D.i++;
  const more = D.i < D.results.length;
  $('#sbtm').innerHTML = more
    ? `<button class="btn gold" data-act="next">下一張（${D.i+1} / ${D.results.length}）</button><button class="btn" data-act="auto" aria-pressed="${D.auto}">${D.auto?'自動撕開中':'全部自動撕開'}</button>`
    : `<button class="btn gold" data-act="next">${D.results.length>1?'查看全部結果':'完成'}</button>`;
  D.busy = false;
  if (D.auto && more) setTimeout(() => { if (D && !D.busy && $('#stage')) nextTicket(); }, RM() ? 500 : (tier >= 3 ? 2200 : 1300));
  else if (D.auto && D.results.length > 1) setTimeout(() => { if (D && $('#stage') && !$('#sum.show')) showSummary(); }, RM() ? 600 : (tier >= 3 ? 2400 : 1500));
  else setTimeout(() => { const b = $('#sbtm .btn'); b && b.focus(); }, 60);
}
function showSummary(){
  const st = $('#stage'); if (!st) return;
  st.style.setProperty('--tc', TIER[0].c); $('.rays', st).style.opacity = 0;
  const p = D.p;
  const sorted = D.results.slice().sort((a,b) => b.tier - a.tier);
  const hi = sorted.filter(x => x.tier >= 2).length;
  const s = $('#sum');
  if (D.demo){ s.innerHTML = `<h2>體驗結果</h2><div class="sub">共 ${D.results.length} 件${hi?`，其中 <b style="color:var(--gold-2)">${hi}</b> 件為中獎以上`:''} ・ 免費體驗，獎品不會發放、也不扣CC幣</div>
    <div class="sgrid">${sorted.map((x,i) => `<div class="sitem ${x.tier>=3?'hi':''}" style="animation-delay:${i*60}ms"><div class="mini">${kujiInner(x, {sub:'體驗 No.'+pad(x.no), foot:x.name})}</div>
      ${tagOf(x, true)}<b>${x.name}</b><span>體驗模式</span></div>`).join('')}</div>
    <div class="acts"><button class="btn" data-act="close-stage">再玩一次</button><a class="btn gold" href="${p.demoOnly ? '#/lobby' : '#/quick/' + p.id}" data-act="close-stage">${ic('ticket')}${p.demoOnly ? '去抽賞大廳' : '真的去抽'}</a></div>`; }
  else {
  s.innerHTML = `<h2>抽賞結果</h2><div class="sub">共 ${D.results.length} 件獎品${hi?`，其中 <b style="color:var(--gold-2)">${hi}</b> 件為中獎以上`:''} ・ 已全數存入中獎倉庫</div>
    <div class="stub">
      <div class="hd"><b>客戶留存用</b><span class="brand" style="font-size:16px;color:#e9eeef">CHIAKI</span></div>
      <dl><dt>交易編號</dt><dd class="num">${D.txn}</dd><dt>賞池</dt><dd>${p.title}${p.sets && p.sets.length>1?` ・ <span style="white-space:nowrap">第 ${pad(p.setIdx+1)} 套</span>`:''}</dd>
        <dt>籤號</dt><dd class="num">${[...new Set(D.results.map(x=>x.no))].sort((a,b)=>a-b).map(pad).join('、')}</dd>${D.paid != null ? `<dt>扣款</dt><dd class="num">${fmt(D.paid)} CC幣</dd>` : ''}<dt>時間</dt><dd class="num">${twNow()}</dd></dl>
      <div class="links"><a href="${LINKS.line}" target="_blank" rel="noopener">${ic('users','width:16px;height:16px')}LINE 社群</a><a href="${LINKS.ig}" target="_blank" rel="noopener">${ic('ig','width:16px;height:16px')}Instagram</a><a href="${LINKS.fb}" target="_blank" rel="noopener">${ic('fb','width:16px;height:16px')}Facebook</a></div>
    </div>
    <div class="sgrid">${sorted.map((x,i) => `<div class="sitem ${x.tier>=3?'hi':''}" style="animation-delay:${i*60}ms"><div class="mini">${kujiInner(x, {sub:'No.'+pad(x.no), foot:x.name})}</div>
      ${tagOf(x, true)}<b>${x.name}</b><span>${x.bonus?x.bonus+' ・ ':''}No.${pad(x.no)}</span><span class="srv">${x.rv ? '回收值 ' + fmt(x.rv) + ' CC幣' : '不可回收'}</span></div>`).join('')}</div>
    <div class="acts"><button class="btn" data-act="close-stage">再抽一次</button><a class="btn gold" href="#/warehouse" data-act="close-stage">${ic('box')}前往中獎倉庫</a></div>`;
  }
  s.classList.add('show');
  $('#sbtm').innerHTML = '';
  setTimeout(() => { const b = $('.acts .btn', s); b && b.focus(); }, 60);
}
function closeStage(){
  fx.stop(); $('#stageRoot').innerHTML = ''; document.documentElement.style.overflow = ''; D = null;
  if (['pool','quick','play'].includes(parseHash().name)) render(true);
}

/* particles: seam sparks + reveal bursts */
const fx = {
  cv:null, ctx:null, ps:[], raf:0,
  init(cv){ this.cv = cv; this.ctx = cv.getContext('2d'); this.resize(); this.ps = []; },
  resize(){ if (!this.cv) return; const d = Math.min(devicePixelRatio||1, 2); this.cv.width = innerWidth*d; this.cv.height = innerHeight*d; this.ctx.setTransform(d,0,0,d,0,0); },
  pal(kind){ return {rainbow:['#ff8a8a','#ffd56b','#7fe0ff','#c79bff','#fff'], purple:['#b07bff','#e2d0ff','#fff'], blue:['#7fa8ff','#cfe0ff','#fff'], gold:['#fff6d6','#e6c77f','#c9a45c','#fff']}[kind]; },
  seam(x, y, h, t){
    const kind = ['gold','blue','purple','gold','rainbow'][t], pal = this.pal(kind);
    for (let i = 0; i < 10 + t*8; i++) this.ps.push({x, y:y + Math.random()*h, vx:Math.random()*3+.5, vy:(Math.random()-.5)*2, g:.02, r:1+Math.random()*2, c:pal[i%pal.length], life:1, dec:.02, dot:true});
    if (!this.raf) this.loop();
  },
  burst(kind, n, rc){
    const pal = this.pal(kind);
    const cx = rc ? rc.left + rc.width/2 : innerWidth/2, cy = rc ? rc.top + rc.height/2 : innerHeight/2;
    for (let i = 0; i < n; i++){
      const a = Math.random()*Math.PI*2, v = 3 + Math.random()*9;
      this.ps.push({x:cx + Math.cos(a)*(rc?rc.width*.3:0), y:cy + Math.sin(a)*(rc?rc.height*.3:0), vx:Math.cos(a)*v, vy:Math.sin(a)*v - 3, g:.18, r:2+Math.random()*3.5, c:pal[i%pal.length], life:1, dec:.008, rot:Math.random()*6, vr:(Math.random()-.5)*.4, dot:Math.random()<.4});
    }
    if (!this.raf) this.loop();
  },
  loop(){
    const c = this.ctx; if (!c) return;
    c.clearRect(0,0,innerWidth,innerHeight);
    this.ps.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= .985; p.life -= p.dec; p.rot = (p.rot||0) + (p.vr||0);
      c.save(); c.globalAlpha = Math.max(0,p.life); c.fillStyle = p.c; c.translate(p.x,p.y); c.rotate(p.rot);
      if (p.dot){ c.shadowColor = p.c; c.shadowBlur = 8; c.beginPath(); c.arc(0,0,p.r*.7,0,7); c.fill(); } else c.fillRect(-p.r, -p.r*.35, p.r*2, p.r*.7);
      c.restore(); });
    this.ps = this.ps.filter(p => p.life > 0 && p.y < innerHeight + 40);
    this.raf = this.ps.length ? requestAnimationFrame(() => this.loop()) : 0;
    if (!this.raf) c.clearRect(0,0,innerWidth,innerHeight);
  },
  stop(){ cancelAnimationFrame(this.raf); this.raf = 0; this.ps = []; this.cv = null; this.ctx = null; }
};
</script>
<script>
function kujiBack(){
  return `<svg viewBox="0 0 300 204"><rect width="300" height="204" fill="#203034"/>${kujiFrame('rgba(230,199,127,.7)',1.4)}
    <text x="150" y="110" text-anchor="middle" font-family="Noto Serif TC,Noto Serif CJK TC,serif" font-weight="700" font-size="20" letter-spacing="1" fill="#e6c77f">CHIAKI</text></svg>`;
}
/* GK pool uses the real ticket cover as its key art */
(() => { const g = poolById('gk'); if (g) g.img = kujiCover(); })();
</script>
