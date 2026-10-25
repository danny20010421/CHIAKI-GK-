<script>
/* 結算頁「返回上一頁」：關閉結算畫面，回到原本的賞池頁 */
(function(){
  const css = document.createElement('style');
  css.textContent = `.rs-top{display:flex;justify-content:flex-start;width:100%;margin:0 0 8px}
  .rs-back{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 16px;border-radius:20px;border:1px solid rgba(230,199,127,.4);background:rgba(0,0,0,.35);color:#e6c77f;font-size:15px;font-weight:600;cursor:pointer;line-height:1}
  .rs-back:hover{background:rgba(230,199,127,.12)}
  .rs-back svg{width:16px;height:16px;flex:none}`;
  document.head.appendChild(css);
  const btn = `<div class="rs-top"><button type="button" class="rs-back" data-act="close-stage" aria-label="返回上一頁"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>返回上一頁</button></div>`;
  const _s = showSummary; showSummary = function(){ _s.apply(this, arguments); const s = $('#sum'); if (s && !s.querySelector('.rs-back')) s.insertAdjacentHTML('afterbegin', btn); };
  const _v = vSummary; vSummary = function(){ _v.apply(this, arguments); const b = $('#vsum .vs-in'); if (b && !b.querySelector('.rs-back')) b.insertAdjacentHTML('afterbegin', btn); };
})();
</script>
