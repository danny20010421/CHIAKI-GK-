<script>
/* =========================================================
   賞池／套組管理：調整、編輯、刪除、下架
   - 下架：前台立即看不到、不能再抽；已售出的紀錄保留，可隨時重新上架
   - 刪除：只限「完全沒有銷售」的賞池或套組；刪除後 30 天內可在「最近刪除」復原
   - 每個動作都要填原因，寫入操作日誌
   ========================================================= */
const setSold = s => s.tickets.filter(t => t.taken).length;
const setState = s => s.off ? '已下架' : !s.tickets.some(t => !t.taken) ? '已完售' : setSold(s) ? '進行中' : '未開抽';
function fixSetIdx(p){ if (p.sets[p.setIdx] && !p.sets[p.setIdx].off) return; const k = p.sets.findIndex(s => !s.off && s.tickets.some(t => !t.taken)); p.setIdx = k >= 0 ? k : Math.max(0, p.sets.findIndex(s => !s.off)); }
S.trash = S.trash || [];
const auditAdd = a => S.audit.unshift({t:'剛剛', who:'輝', a});

/* pool page for a pool that was taken down */
const _poolR = routes.pool, _poolA = routes.pool.after;
routes.pool = r => { const p = poolById(r.arg); if (p && p.demoOnly){ setTimeout(() => { location.hash = '#/play'; }, 0); return ''; } if (p && p.off) return `<div class="wrap"><div class="empty" style="margin-top:48px">「${p.title}」已下架，暫停抽賞。<br>已抽中的獎品仍保留在中獎倉庫。<br><br><a class="btn gold" href="#/lobby">回抽賞大廳</a></div></div>`; if (p) fixSetIdx(p); return _poolR(r); };
routes.pool.after = r => { const p = poolById(r.arg); if (p && !p.off && _poolA) _poolA(r); };

/* ---------- 賞池管理 ---------- */
ADM_VIEWS.pool = () => {
  const open = S.setsOpen;
  return `<div class="adm-bar"><span class="muted" style="font-size:13px;flex:1">流程：草稿 → 送審 → 第二位管理員覆核 → 上架 → 完售揭露。誤操作可「下架」立即停止販售；尚未售出的可刪除，並可從「最近刪除」復原。</span>
      <button class="btn s gold" data-act="x-pooled">${ic('plus','width:16px;height:16px')}建立賞池</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>賞池</th><th>來源</th><th class="r">單價</th><th class="r">套組</th><th class="r">已抽 / 總數</th><th>狀態</th><th>操作</th></tr></thead><tbody>
    ${(S.poolDrafts || []).map((d,i) => `<tr><td>${d.title}</td><td><span class="tag ${SRC[d.src].c}">${SRC[d.src].t.slice(0,2)}</span></td><td class="r">${fmt(d.price)}</td><td class="r">${d.sets}</td><td class="r dim">—</td><td>${stTagT(d.st)}</td>
      <td><span class="row" style="gap:8px"><button class="btn s" data-act="x-pooled" data-k="draft:${i}">編輯</button><button class="btn s ghost" data-act="x-ask" data-op="draftdel" data-k="${i}">刪除</button></span></td></tr>`).join('')}
    ${POOLS.map(p => { const sold = soldAll(p), st = p.off ? '已下架' : p.soon ? '排程上架' : remaining(p) || p.sets.some(s => !s.off && s.tickets.some(t => !t.taken)) ? '上架中' : '已完售';
      return `<tr class="${open === p.id ? 'hl' : ''}"><td><b style="font-weight:500">${p.title.split(' ～')[0]}</b><div class="dim" style="font-size:12px">${p.ip}</div></td><td><span class="tag ${SRC[p.src].c}">${SRC[p.src].t.slice(0,2)}</span></td>
      <td class="r">${fmt(p.price)}</td><td class="r">${p.sets.length}</td><td class="r">${sold} / ${totalAll(p)}</td><td>${stTagT(st)}</td>
      <td><span class="row" style="gap:8px"><button class="btn s ${open === p.id ? 'gold' : ''}" data-act="x-setsopen" data-k="${p.id}" aria-expanded="${open === p.id}">套組</button><button class="btn s" data-act="x-pooled" data-k="${p.id}">編輯</button>
        <button class="btn s" data-act="x-ask" data-op="${p.off ? 'poolon' : 'pooloff'}" data-k="${p.id}">${p.off ? '重新上架' : '下架'}</button>
        <button class="btn s ghost" data-act="x-ask" data-op="pooldel" data-k="${p.id}" ${sold ? 'disabled title="已有銷售紀錄，只能下架"' : ''}>刪除</button></span></td></tr>
      ${open === p.id ? `<tr class="sets-row"><td colspan="7">${setsPanel(p)}</td></tr>` : ''}`; }).join('')}
    </tbody></table></div>
    ${S.trash.length ? `<div class="panel" style="margin-top:24px"><h3>最近刪除 <span class="dim" style="font-size:12px;font-weight:400">30 天內可復原</span></h3>
      ${S.trash.map((t,i) => `<div class="kv"><span>${t.kind === 'pool' ? '賞池' : t.kind === 'set' ? '套組' : '草稿'}：${t.label}<br><span class="dim" style="font-size:12px">${t.at}・原因：${t.why}</span></span><button class="btn s" data-act="x-restore" data-k="${i}">復原</button></div>`).join('')}</div>` : ''}`;
};
function setsPanel(p){
  return `<div class="setsp"><div class="row between" style="margin-bottom:12px;flex-wrap:wrap;gap:8px"><b>${p.title.split(' ～')[0]}・套組</b>
      <button class="btn s gold" data-act="x-ask" data-op="setadd" data-k="${p.id}">${ic('plus','width:16px;height:16px')}新增套組</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>套組</th><th>狀態</th><th class="r">已抽 / 總數</th><th class="r">收益</th><th>備註</th><th>操作</th></tr></thead><tbody>
    ${p.sets.map((s,k) => { const sold = setSold(s); return `<tr><td>${s.name || `第 ${k+1} 套`}${p.setIdx === k && !s.off ? ' <span class="tag info">前台目前</span>' : ''}</td><td>${stTagT(setState(s))}</td>
      <td class="r">${sold} / ${s.total}</td><td class="r">${fmt(sold * p.price)}</td><td class="dim cell-ell">${s.note || '—'}</td>
      <td><span class="row" style="gap:8px"><button class="btn s" data-act="x-setedit" data-p="${p.id}" data-k="${k}">編輯</button>
        <button class="btn s" data-act="x-ask" data-op="${s.off ? 'seton' : 'setoff'}" data-p="${p.id}" data-k="${k}">${s.off ? '重新上架' : '下架'}</button>
        <button class="btn s ghost" data-act="x-ask" data-op="setdel" data-p="${p.id}" data-k="${k}" ${sold || p.sets.length < 2 ? `disabled title="${sold ? '已有銷售紀錄，只能下架' : '至少保留一套；要整個移除請刪除賞池'}"` : ''}>刪除</button></span></td></tr>`; }).join('')}
    </tbody></table></div></div>`;
}

/* every risky action asks for a reason first */
const OPS = {
  pooloff:{t:'下架賞池', d:'前台立即看不到、不能再抽；已售出的紀錄與會員獎品都保留，之後可重新上架。', btn:'確認下架'},
  poolon:{t:'重新上架賞池', d:'賞池會重新出現在前台並開放抽賞。', btn:'確認上架'},
  pooldel:{t:'刪除賞池', d:'此賞池沒有任何銷售紀錄，刪除後前台與後台都看不到；30 天內可在「最近刪除」復原。', btn:'確認刪除', bad:true},
  setoff:{t:'下架套組', d:'這一套在前台停止販售；已抽出的紀錄保留，可隨時重新上架。', btn:'確認下架'},
  seton:{t:'重新上架套組', d:'這一套會重新開放抽賞。', btn:'確認上架'},
  setdel:{t:'刪除套組', d:'這一套沒有任何銷售紀錄，刪除後 30 天內可復原。', btn:'確認刪除', bad:true},
  setadd:{t:'新增套組', d:'依目前的獎項設定（等級與數量）產生一套新的籤表，並計算新的承諾雜湊。', btn:'確認新增'},
  draftdel:{t:'刪除草稿', d:'草稿刪除後 30 天內可復原。', btn:'確認刪除', bad:true}
};
function askOp(op, pid, k){
  const o = OPS[op]; S.pendOp = {op, pid, k: +k};
  openModal(`<h3 id="mdlT">${o.t}</h3><p class="muted" style="font-size:14px;margin:0 0 16px">${o.d}</p>
    <div class="field" style="margin-bottom:24px"><label for="opWhy">原因（必填，寫入操作日誌）</label><input class="input" id="opWhy" placeholder="例如：獎品數量設定錯誤" autocomplete="off"></div>
    <div class="row" style="gap:8px"><button class="btn" data-act="close-modal" style="flex:1">取消</button><button class="btn ${o.bad ? 'danger' : 'gold'}" data-act="x-opgo" style="flex:1">${o.btn}</button></div>`);
  setTimeout(() => { const i = $('#opWhy'); i && i.focus(); }, 60);
}
function doOp(){
  const why = ($('#opWhy').value || '').trim(); if (why.length < 2){ toast('請填寫原因'); $('#opWhy').focus(); return; }
  const {op, pid, k} = S.pendOp, p = poolById(pid), at = twNow(), name = p ? p.title.split(' ～')[0] : '';
  if (op === 'pooloff'){ p.off = true; clearHold(); auditAdd(`下架賞池：${name}（${why}）`); }
  if (op === 'poolon'){ p.off = false; fixSetIdx(p); auditAdd(`重新上架賞池：${name}（${why}）`); }
  if (op === 'pooldel'){ if (soldAll(p)){ closeModal(); return toast('已有銷售紀錄，只能下架'); } const i = POOLS.indexOf(p); POOLS.splice(i, 1); S.trash.unshift({kind:'pool', obj:p, idx:i, label:name, why, at}); if (S.setsOpen === pid) S.setsOpen = null; auditAdd(`刪除賞池：${name}（${why}）`); }
  if (op === 'setoff'){ p.sets[k].off = true; if (p.setIdx === k) fixSetIdx(p); auditAdd(`下架套組：${name} ${p.sets[k].name || '第 ' + (k+1) + ' 套'}（${why}）`); }
  if (op === 'seton'){ p.sets[k].off = false; fixSetIdx(p); auditAdd(`重新上架套組：${name} ${p.sets[k].name || '第 ' + (k+1) + ' 套'}（${why}）`); }
  if (op === 'setdel'){ const s = p.sets[k]; if (setSold(s) || p.sets.length < 2){ closeModal(); return toast('無法刪除：已有銷售或只剩一套'); } p.sets.splice(k, 1); if (p.setIdx >= p.sets.length || p.setIdx === k) p.setIdx = 0; fixSetIdx(p);
    S.trash.unshift({kind:'set', obj:s, pid, idx:k, label:`${name} ${s.name || '第 ' + (k+1) + ' 套'}`, why, at}); auditAdd(`刪除套組：${name} 第 ${k+1} 套（${why}）`); }
  if (op === 'setadd'){ const n = p.sets.length; p.sets.push(buildSet(p, p.seed + n * 7919 + Date.now() % 997, 0)); fixSetIdx(p); auditAdd(`新增套組：${name} 第 ${n+1} 套（${why}）`); }
  if (op === 'draftdel'){ const d = S.poolDrafts.splice(k, 1)[0]; S.trash.unshift({kind:'draft', obj:d, label:d.title, why, at}); auditAdd(`刪除草稿：${d.title}（${why}）`); }
  closeModal(); render(true); toast(OPS[op].t + '完成，已寫入操作日誌');
}
function setEditor(pid, k){
  const p = poolById(pid), s = p.sets[k], sold = setSold(s);
  openModal(`<h3 id="mdlT">編輯套組・${p.title.split(' ～')[0]} 第 ${k+1} 套</h3>
    <form data-act="x-setsave" data-p="${pid}" data-k="${k}" class="cfg" style="gap:16px" novalidate>
      <div class="field"><label for="se_n">套組名稱（前台顯示）</label><input class="input" id="se_n" value="${(s.name || '').replace(/"/g,'&quot;')}" placeholder="第 ${k+1} 套"></div>
      <div class="field"><label for="se_note">備註（僅後台）</label><input class="input" id="se_note" value="${(s.note || '').replace(/"/g,'&quot;')}" placeholder="例如：補貨批次、活動限定"></div>
      ${sold ? `<p class="dim" style="font-size:12px;margin:0">此套已售出 ${sold} 抽，籤表已鎖定，不能重新產生；如設定錯誤請先「下架」，再由客服處理已購買的會員。</p>`
        : `<label class="chk-chip" style="align-self:flex-start"><input type="checkbox" id="se_re"><span>依目前獎項設定重新產生籤表（尚未售出才可）</span></label>`}
      <div class="field"><label for="se_why">修改原因（必填）</label><input class="input" id="se_why" placeholder="例如：名稱打錯" autocomplete="off"></div>
      <button class="btn gold" type="submit">儲存</button></form>`);
}
document.addEventListener('submit', e => { if (!e.target.matches('[data-act="x-setsave"]')) return; e.preventDefault();
  const f = e.target, p = poolById(f.dataset.p), k = +f.dataset.k, s = p.sets[k], why = $('#se_why').value.trim();
  if (why.length < 2){ toast('請填寫修改原因'); $('#se_why').focus(); return; }
  s.name = $('#se_n').value.trim(); s.note = $('#se_note').value.trim();
  if ($('#se_re') && $('#se_re').checked && !setSold(s)){ const nb = buildSet(p, p.seed + k * 7919 + Date.now() % 997, 0); s.tickets = nb.tickets; s.total = nb.total; s.hash = null; }
  auditAdd(`編輯套組：${p.title.split(' ～')[0]} 第 ${k+1} 套（${why}）`); closeModal(); render(true); toast('套組已更新'); });
document.addEventListener('click', e => { const el = e.target.closest('[data-act="x-setsopen"],[data-act="x-ask"],[data-act="x-opgo"],[data-act="x-restore"],[data-act="x-setedit"]'); if (!el || el.disabled) return; e.preventDefault();
  const a = el.dataset.act;
  if (a === 'x-setsopen'){ S.setsOpen = S.setsOpen === el.dataset.k ? null : el.dataset.k; render(true); }
  if (a === 'x-ask') askOp(el.dataset.op, el.dataset.p || el.dataset.k, el.dataset.p ? el.dataset.k : el.dataset.k);
  if (a === 'x-opgo') doOp();
  if (a === 'x-setedit') setEditor(el.dataset.p, +el.dataset.k);
  if (a === 'x-restore'){ const t = S.trash.splice(+el.dataset.k, 1)[0];
    if (t.kind === 'pool') POOLS.splice(Math.min(t.idx, POOLS.length), 0, t.obj);
    if (t.kind === 'set'){ const p = poolById(t.pid); if (p) p.sets.splice(Math.min(t.idx, p.sets.length), 0, t.obj); else { S.trash.unshift(t); return toast('原賞池已刪除，請先復原賞池'); } }
    if (t.kind === 'draft') S.poolDrafts.unshift(t.obj);
    auditAdd(`復原：${t.label}`); render(true); toast(`已復原：${t.label}`); } });
</script>
