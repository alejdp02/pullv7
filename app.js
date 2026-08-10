/* Phoenix Pull v4 (fresh build)
   - Supabase Auth + profiles
   - Items from public.items (admin CRUD)
   - Per-user quantities in public.quantities
   - Quick Add, PAR tools, Pull Sheet, Undo, debounced writes
*/
const { supabaseUrl, supabaseAnonKey } = window.PHX_CONFIG || {};
if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config in config.js (PHX_CONFIG).");
}
const supa = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

// ---------- tiny utils ----------
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const clamp0 = (n) => Math.max(0, Number.isFinite(n) ? n : 0);

function toast(msg, ms=1900){
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>el.classList.remove('show'), ms);
}
function escapeHtml(s=''){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- app state ----------
let session = null;
let profile = null;

let items = [];                 // active items (from DB)
let itemsByKey = new Map();     // key => item
let qtyMap = new Map();         // key => {qty, restock, ...}
let currentCategory = 'all';

let undoStack = [];             // {key, prev:{qty,restock}, next:{qty,restock}}
let suppressUndo = false;

const saveQueue = new Map();    // key => timeoutId
let saveState = 'Ready';
function setSaveState(s){
  saveState = s;
  const el = $('#saveState'); if(el) el.textContent = s;
}

function keyFor(category, name){ return `${category}__${name}`; }

// ---------- logging ----------
async function log(action, payload){
  try{
    const u = session?.user;
    await supa.from('interactions').insert({
      user_id: u?.id,
      user_email: u?.email,
      action,
      payload
    });
  }catch{ /* ignore */ }
}

// ---------- auth/profile ----------
async function refreshSession(){
  const { data } = await supa.auth.getSession();
  session = data.session || null;
  return session;
}

async function ensureProfileForCurrentUser(display_name_if_new){
  const u = session?.user; if(!u) return null;

  // 1) normal: id == auth uid
  let { data, error } = await supa.from('profiles').select('*').eq('id', u.id).maybeSingle();
  if(error) throw error;

  // 2) fallback: email match (helps if profiles table got hand-edited)
  if(!data && u.email){
    const res = await supa.from('profiles').select('*').eq('email', u.email).maybeSingle();
    if(res.error) throw res.error;
    data = res.data || null;

    // If row exists but id mismatch, we do NOT auto-fix id (could be dangerous).
    // We just use it to resolve role for the UI.
  }

  // 3) create if missing
  if(!data){
    const row = {
      id: u.id,
      email: u.email,
      display_name: display_name_if_new || (u.email ? u.email.split('@')[0] : 'user'),
      role: 'user',
      active: true
    };
    const up = await supa.from('profiles').upsert(row);
    if(up.error) throw up.error;
    const again = await supa.from('profiles').select('*').eq('id', u.id).maybeSingle();
    if(again.error) throw again.error;
    data = again.data;
  }
  profile = data;
  return data;
}

function isAdmin(){ return profile?.role === 'admin'; }

// ---------- data: items ----------
async function loadItems(){
  // Items schema is flexible. We read what exists.
  const { data, error } = await supa
    .from('items')
    .select('*')
    .order('category', { ascending: true })
    .order('name', { ascending: true });

  if(error){
    console.warn('items load error', error);
    items = [];
    itemsByKey = new Map();
    return;
  }

  const all = (data || []).map(r => ({
    id: r.id,
    category: r.category || 'Uncategorized',
    name: r.name,
    note: r.note || '',
    shelf: r.shelf || '',
    par: (r.par ?? null),
    active: (r.active ?? true),
    updated_at: r.updated_at || null
  })).filter(r => !!r.name);

  items = all.filter(r => r.active);
  itemsByKey = new Map();
  for(const it of items){
    itemsByKey.set(keyFor(it.category, it.name), it);
  }
}

// ---------- data: quantities ----------
async function loadQuantities(){
  const u = session?.user; if(!u) { qtyMap = new Map(); return; }
  const { data, error } = await supa.from('quantities').select('*').eq('user_id', u.id);
  if(error){
    console.warn('quantities load error', error);
    qtyMap = new Map();
    return;
  }
  qtyMap = new Map();
  for(const r of (data || [])){
    const key = keyFor(r.category, r.item_name);
    qtyMap.set(key, {
      qty: clamp0(Number(r.qty || 0)),
      restock: !!r.restock
    });
  }
}

// ---------- saving (debounced per item) ----------
function queueSave(category, name, next){
  const k = keyFor(category, name);
  const prev = saveQueue.get(k);
  if(prev) clearTimeout(prev);

  setSaveState('Saving…');

  const tid = setTimeout(async ()=>{
    saveQueue.delete(k);
    await persistRow(category, name, next);
    if(saveQueue.size === 0) setSaveState('Saved ✅');
    setTimeout(()=>{ if(saveQueue.size===0) setSaveState('Ready'); }, 900);
  }, 320);

  saveQueue.set(k, tid);
}

async function persistRow(category, name, next){
  const u = session?.user; if(!u) return;
  const row = {
    user_id: u.id,
    category,
    item_name: name,
    qty: clamp0(Number(next.qty || 0)),
    restock: !!next.restock,
    updated_at: new Date().toISOString()
  };
  const { error } = await supa.from('quantities').upsert(row, { onConflict: 'user_id,category,item_name' });
  if(error) console.error('upsert error', error);
}

// ---------- undo ----------
function pushUndo(k, prev, next){
  if(suppressUndo) return;
  undoStack.push({ key: k, prev: {...prev}, next: {...next} });
  if(undoStack.length > 50) undoStack.shift();
  $('#undoBtn').disabled = undoStack.length === 0;
}

function applyStateToUI(k, st){
  const el = document.querySelector(`[data-key="${CSS.escape(k)}"]`);
  if(!el) return;
  const num = el.querySelector('.qty-input');
  const chk = el.querySelector('.restock');
  if(num) num.value = clamp0(st.qty);
  if(chk) chk.checked = !!st.restock;
}

async function undo(){
  const op = undoStack.pop();
  $('#undoBtn').disabled = undoStack.length === 0;
  if(!op) return;

  suppressUndo = true;
  try{
    qtyMap.set(op.key, { qty: op.prev.qty, restock: op.prev.restock });
    applyStateToUI(op.key, op.prev);

    const [category, name] = op.key.split('__');
    queueSave(category, name, op.prev);
    await log('undo', { key: op.key, to: op.prev });
    updateTotals();
  } finally {
    suppressUndo = false;
  }
}

// ---------- quick add parsing ----------
function parseQuickAdd(s){
  // supports:
  // "2 croissant"  | "croissant x2" | "croissant 2"
  const raw = (s || '').trim();
  if(!raw) return null;

  let qty = 1;
  let text = raw;

  // leading number
  const m1 = raw.match(/^\s*(\d+)\s+(.+)$/);
  if(m1){ qty = parseInt(m1[1],10); text = m1[2].trim(); }

  // trailing "xN"
  const m2 = raw.match(/^(.+?)\s*[xX]\s*(\d+)\s*$/);
  if(m2){ text = m2[1].trim(); qty = parseInt(m2[2],10); }

  // trailing number
  const m3 = raw.match(/^(.+?)\s+(\d+)\s*$/);
  if(m3){ text = m3[1].trim(); qty = parseInt(m3[2],10); }

  qty = clamp0(qty);
  return { query: text.toLowerCase(), qty: Math.max(1, qty) };
}

function bestItemMatch(q){
  // match by includes, then startsWith, then levenshtein-ish by token overlap
  const needle = (q||'').trim().toLowerCase();
  if(!needle) return null;

  const pool = items.map(it => ({
    it,
    hay: (it.name || '').toLowerCase()
  }));

  let exact = pool.find(x => x.hay === needle);
  if(exact) return exact.it;

  let starts = pool.find(x => x.hay.startsWith(needle));
  if(starts) return starts.it;

  // contains
  let contains = pool.find(x => x.hay.includes(needle));
  if(contains) return contains.it;

  // token overlap
  const tokens = needle.split(/\s+/).filter(Boolean);
  let best = null, bestScore = -1;
  for(const x of pool){
    const hTokens = x.hay.split(/\s+/);
    let score = 0;
    for(const t of tokens){
      if(hTokens.includes(t)) score += 2;
      else if(x.hay.includes(t)) score += 1;
    }
    if(score > bestScore){
      bestScore = score;
      best = x.it;
    }
  }
  return bestScore > 0 ? best : null;
}

// ---------- rendering ----------
function show(view){
  $('#view-login').classList.toggle('hidden', view !== 'login');
  $('#view-app').classList.toggle('hidden', view !== 'app');
}

function renderCategoryChips(){
  const cats = Array.from(new Set(items.map(i=>i.category))).sort((a,b)=>a.localeCompare(b));
  const el = $('#categoryChips');
  el.innerHTML = '';
  const mk = (label, value) => {
    const c = document.createElement('button');
    c.className = 'chip' + (currentCategory===value ? ' active':'');
    c.innerHTML = `<span>${escapeHtml(label)}</span>`;
    c.onclick = ()=>{ currentCategory=value; renderAll(); };
    return c;
  };
  el.appendChild(mk('All', 'all'));
  for(const c of cats) el.appendChild(mk(c, c));
}

function sectionTemplate(category, listHtml, sectionTotal){
  return `
    <div class="card" style="padding:14px; background:rgba(255,255,255,.04)">
      <div class="section-head">
        <h2>${escapeHtml(category)}</h2>
        <span class="pill">Total: <b>${sectionTotal}</b></span>
        <div class="spacer"></div>
        <button class="btn small-btn" data-sec-toggle="${escapeHtml(category)}">Collapse</button>
      </div>
      <div class="list" data-sec-list="${escapeHtml(category)}">
        ${listHtml || `<div class="muted">No items.</div>`}
      </div>
    </div>
  `;
}

function itemCardTemplate(it, st){
  const k = keyFor(it.category, it.name);
  const qty = clamp0(st?.qty || 0);
  const restock = !!st?.restock;
  const noteBits = [];
  if(it.note) noteBits.push(it.note);
  if(it.shelf) noteBits.push(`Shelf: ${it.shelf}`);
  const note = noteBits.join(' • ');
  const par = (it.par ?? null);
  const parLabel = par !== null && par !== undefined && par !== '' ? `PAR ${par}` : 'PAR';
  return `
    <div class="item-card" data-key="${escapeHtml(k)}" data-category="${escapeHtml(it.category)}" data-name="${escapeHtml(it.name)}">
      <div class="item-top">
        <div class="grow">
          <div class="item-name">${escapeHtml(it.name)}</div>
          <div class="item-meta">${escapeHtml(note)}</div>
        </div>
        <div class="row" style="gap:8px; align-items:center">
          <button class="btn small-btn" data-par="${escapeHtml(k)}">${escapeHtml(parLabel)}</button>
          <label class="pill" title="Needs restock">
            <input class="restock" type="checkbox" ${restock?'checked':''} />
            Restock
          </label>
        </div>
      </div>
      <div class="qty-wrap">
        <button class="btn qty-btn" data-step="-1">−</button>
        <input class="qty-input" inputmode="numeric" pattern="[0-9]*" type="number" min="0" value="${qty}" />
        <button class="btn qty-btn" data-step="1">+</button>
      </div>
    </div>
  `;
}

function getFilters(){
  const s = ($('#search')?.value || '').trim().toLowerCase();
  const onlyQty = !!$('#onlyQty')?.checked;
  const onlyRestock = !!$('#onlyRestock')?.checked;
  return { s, onlyQty, onlyRestock };
}

function renderAll(){
  renderCategoryChips();

  const { s, onlyQty, onlyRestock } = getFilters();

  const filtered = items.filter(it=>{
    if(currentCategory !== 'all' && it.category !== currentCategory) return false;
    if(s && !(`${it.name} ${it.note||''} ${it.shelf||''}`.toLowerCase().includes(s))) return false;

    const st = qtyMap.get(keyFor(it.category, it.name)) || { qty:0, restock:false };
    if(onlyQty && clamp0(st.qty) <= 0) return false;
    if(onlyRestock && !st.restock) return false;
    return true;
  });

  const byCat = new Map();
  for(const it of filtered){
    const arr = byCat.get(it.category) || [];
    arr.push(it);
    byCat.set(it.category, arr);
  }

  const cats = Array.from(byCat.keys()).sort((a,b)=>a.localeCompare(b));
  const host = $('#sections');
  host.innerHTML = '';

  for(const cat of cats){
    const list = byCat.get(cat) || [];
    let total = 0;
    const listHtml = list.map(it=>{
      const st = qtyMap.get(keyFor(it.category, it.name)) || { qty:0, restock:false };
      total += clamp0(st.qty);
      return itemCardTemplate(it, st);
    }).join('');
    const wrap = document.createElement('div');
    wrap.innerHTML = sectionTemplate(cat, listHtml, total);
    host.appendChild(wrap.firstElementChild);
  }

  if(cats.length === 0){
    host.innerHTML = `<div class="card" style="padding:16px;background:rgba(255,255,255,.04)"><div class="muted">No items match your filters.</div></div>`;
  }

  updateTotals();
  wireSectionToggles();
}

function updateTotals(){
  let total = 0;

  // only count visible item cards
  $$('.item-card').forEach(card=>{
    const k = card.dataset.key;
    const st = qtyMap.get(k) || { qty:0 };
    total += clamp0(st.qty);
  });

  $('#totalAll').textContent = total;
}

function wireSectionToggles(){
  $$('[data-sec-toggle]').forEach(btn=>{
    if(btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', ()=>{
      const cat = btn.getAttribute('data-sec-toggle');
      const list = document.querySelector(`[data-sec-list="${CSS.escape(cat)}"]`);
      if(!list) return;
      const isHidden = list.classList.toggle('hidden');
      btn.textContent = isHidden ? 'Expand' : 'Collapse';
    });
  });
}

// ---------- interactions (delegated) ----------
function wireListInteractions(){
  const root = $('#sections');

  // pointer repeat for +/- buttons
  let holdTimer = null;
  let holdInterval = null;
  let holdBtn = null;

  function stopHold(){
    if(holdTimer) clearTimeout(holdTimer);
    if(holdInterval) clearInterval(holdInterval);
    holdTimer = null;
    holdInterval = null;
    holdBtn = null;
  }

  function step(card, delta){
    const k = card.dataset.key;
    const category = card.dataset.category;
    const name = card.dataset.name;

    const prev = qtyMap.get(k) || { qty:0, restock:false };
    const next = { ...prev, qty: clamp0((prev.qty || 0) + delta) };

    qtyMap.set(k, next);
    card.querySelector('.qty-input').value = next.qty;

    pushUndo(k, prev, next);
    queueSave(category, name, next);
    log('qty_change', { category, item: name, qty: next.qty });

    updateTotals();
  }

  root.addEventListener('pointerdown', (e)=>{
    const btn = e.target.closest('button[data-step]');
    if(!btn) return;

    const card = e.target.closest('.item-card');
    if(!card) return;

    e.preventDefault();
    const delta = Number(btn.dataset.step || 0);

    holdBtn = btn;
    step(card, delta);

    holdTimer = setTimeout(()=>{
      holdInterval = setInterval(()=>{
        if(!holdBtn) return;
        step(card, delta);
      }, 85);
    }, 320);
  });

  root.addEventListener('pointerup', stopHold);
  root.addEventListener('pointercancel', stopHold);
  root.addEventListener('pointerleave', stopHold);

  // qty input change
  root.addEventListener('change', (e)=>{
    const inp = e.target.closest('.qty-input');
    if(!inp) return;
    const card = inp.closest('.item-card');
    const k = card.dataset.key;
    const category = card.dataset.category;
    const name = card.dataset.name;

    const v = clamp0(parseInt(inp.value || '0', 10));
    inp.value = v;

    const prev = qtyMap.get(k) || { qty:0, restock:false };
    const next = { ...prev, qty: v };

    qtyMap.set(k, next);
    pushUndo(k, prev, next);
    queueSave(category, name, next);
    log('qty_change', { category, item: name, qty: v });

    updateTotals();
  });

  // restock toggle
  root.addEventListener('change', (e)=>{
    const chk = e.target.closest('.restock');
    if(!chk) return;
    const card = chk.closest('.item-card');
    const k = card.dataset.key;
    const category = card.dataset.category;
    const name = card.dataset.name;

    const prev = qtyMap.get(k) || { qty:0, restock:false };
    const next = { ...prev, restock: !!chk.checked };

    qtyMap.set(k, next);
    pushUndo(k, prev, next);
    queueSave(category, name, next);
    log('restock_toggle', { category, item: name, restock: next.restock });

    updateTotals();
  });

  // PAR button
  root.addEventListener('click', async (e)=>{
    const b = e.target.closest('button[data-par]');
    if(!b) return;
    const k = b.dataset.par;
    const card = document.querySelector(`[data-key="${CSS.escape(k)}"]`);
    if(!card) return;
    const category = card.dataset.category;
    const name = card.dataset.name;

    const it = itemsByKey.get(k);
    const prev = qtyMap.get(k) || { qty:0, restock:false };

    // choose par: explicit par or guess from note "6–8" / "6-8"
    let par = it?.par;
    if(par === null || par === undefined || par === ''){
      const note = (it?.note || '') + ' ' + (it?.shelf || '');
      const m = note.match(/(\d+)\s*[–\-]\s*(\d+)/);
      if(m) par = parseInt(m[2],10);
      else{
        const m2 = note.match(/(\d+)/);
        if(m2) par = parseInt(m2[1],10);
      }
    }
    par = clamp0(Number(par || 0));
    if(!par){ toast('No PAR set for this item'); return; }

    const next = { ...prev, qty: par };
    qtyMap.set(k, next);
    applyStateToUI(k, next);

    pushUndo(k, prev, next);
    queueSave(category, name, next);
    updateTotals();
    await log('set_par', { category, item: name, qty: par });
    toast(`Set to PAR: ${par}`);
  });
}

// ---------- quick add behavior ----------
function wireQuickAdd(){
  const el = $('#quickAdd');
  el.addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    e.preventDefault();
    const parsed = parseQuickAdd(el.value);
    if(!parsed) return;

    const it = bestItemMatch(parsed.query);
    if(!it){ toast('No match'); return; }

    const k = keyFor(it.category, it.name);
    const prev = qtyMap.get(k) || { qty:0, restock:false };
    const next = { ...prev, qty: clamp0(prev.qty + parsed.qty) };

    qtyMap.set(k, next);
    applyStateToUI(k, next);
    pushUndo(k, prev, next);
    queueSave(it.category, it.name, next);
    log('qty_change', { category: it.category, item: it.name, qty: next.qty, via:'quick_add' });

    el.value = '';
    updateTotals();
    toast(`+${parsed.qty} • ${it.name}`);
  });
}

// ---------- pull sheet + shelf-life / sticker counts ----------
function getShelfLifeDays(category){
  const c = String(category || '').toLowerCase();
  if(c.includes('pastr')) return 2;
  if(c.includes('sandwich')) return 3;
  return null;
}

function getPullData(){
  const byCat = new Map();
  const restockByCat = new Map();
  const stickerCounts = { pastries:0, sandwiches:0, other:0 };
  let totalQty = 0;
  let totalDistinct = 0;

  for(const it of items){
    const k = keyFor(it.category, it.name);
    const st = qtyMap.get(k) || { qty:0, restock:false };
    const qty = clamp0(st.qty);
    const isRestock = !!st.restock;

    // RESTOCK is independent from the pull quantity.
    // A user can mark an item for restock even when no pull
    // quantity has been entered yet. It should still appear
    // in the RESTOCK section of the Pull Sheet.
    if(isRestock){
      const restockEntry = { it, qty, restock: true, quantitySet: qty > 0 };
      const restockArr = restockByCat.get(it.category) || [];
      restockArr.push(restockEntry);
      restockByCat.set(it.category, restockArr);
    }

    // The normal PULL section only contains items with an actual
    // quantity to pull.
    if(qty <= 0) continue;

    const entry = { it, qty, restock: isRestock, quantitySet: true };
    const arr = byCat.get(it.category) || [];
    arr.push(entry);
    byCat.set(it.category, arr);
    totalQty += qty;
    totalDistinct++;

    const shelfDays = getShelfLifeDays(it.category);
    if(shelfDays === 2) stickerCounts.pastries += qty;
    else if(shelfDays === 3) stickerCounts.sandwiches += qty;
    else stickerCounts.other += qty;
  }

  return { byCat, restockByCat, stickerCounts, totalQty, totalDistinct };
}

function pullSectionHtml(title, list, options={}){
  const { restock=false } = options;
  const qty = list.reduce((sum, x)=>sum + x.qty, 0);
  const distinct = list.length;
  return `<section class="sheet-section ${restock ? 'sheet-restock-section':''}">
    <div class="sheet-section-head">
      <div>
        <div class="sheet-section-title">${escapeHtml(title)}</div>
        <div class="sheet-section-sub">${distinct} item${distinct===1?'':'s'} • ${qty} total unit${qty===1?'':'s'}</div>
      </div>
      ${restock ? '<span class="sheet-restock-badge">↻ RESTOCK</span>' : ''}
    </div>
    <div class="sheet-table-wrap">
      <table class="table sheet-table">
        <thead><tr><th>Item</th><th class="right">Qty</th>${restock ? '<th>Action</th>' : '<th>Shelf life</th>'}</tr></thead>
        <tbody>${list.map(x=>{
          const days = getShelfLifeDays(x.it.category);
          const third = restock ? '<td><span class="restock-mark">Restock</span></td>' : `<td>${days ? `${days}-day` : '—'}</td>`;
          const qtyDisplay = restock && !x.quantitySet ? '<span class="qty-unset">Not set</span>' : `<b>${x.qty}</b>`;
          return `<tr><td><b>${escapeHtml(x.it.name)}</b></td><td class="right">${qtyDisplay}</td>${third}</tr>`;
        }).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function renderPullSheet(){
  const { byCat, restockByCat, stickerCounts, totalQty, totalDistinct } = getPullData();
  const cats = Array.from(byCat.keys()).sort((a,b)=>a.localeCompare(b));

  const summary = `
    <div class="sheet-hero">
      <div>
        <div class="sheet-kicker">TODAY'S PULL</div>
        <div class="sheet-hero-title">${totalQty} <span>units</span></div>
        <div class="sheet-hero-sub">${totalDistinct} different item${totalDistinct===1?'':'s'}</div>
      </div>
      <div class="sticker-grid">
        <div class="sticker-card sticker-2"><span class="sticker-days">2 DAYS</span><b>${stickerCounts.pastries}</b><span>Pastry stickers</span></div>
        <div class="sticker-card sticker-3"><span class="sticker-days">3 DAYS</span><b>${stickerCounts.sandwiches}</b><span>Sandwich stickers</span></div>
        ${stickerCounts.other ? `<div class="sticker-card"><span class="sticker-days">OTHER</span><b>${stickerCounts.other}</b><span>Other units</span></div>` : ''}
      </div>
    </div>`;

  if(cats.length === 0){
    $('#sheetBody').innerHTML = summary + `<div class="sheet-empty">Nothing to pull yet. Add quantities first.</div>`;
    return;
  }

  let html = summary + `<div class="sheet-group-label">PULL BY CATEGORY</div>`;
  for(const c of cats) html += pullSectionHtml(c, byCat.get(c));

  const restockCats = Array.from(restockByCat.keys()).sort((a,b)=>a.localeCompare(b));
  if(restockCats.length){
    html += `<div class="sheet-restock-header"><div><div class="sheet-group-label">RESTOCK</div><div class="sheet-restock-note">Items marked Restock, separated by category.</div></div><span class="sheet-restock-total">${restockCats.reduce((n,c)=>n+restockByCat.get(c).reduce((a,x)=>a+x.qty,0),0)} units</span></div>`;
    for(const c of restockCats) html += pullSectionHtml(c, restockByCat.get(c), {restock:true});
  }

  $('#sheetBody').innerHTML = html;
}

async function openPullSheet(){
  renderPullSheet();
  $('#sheetDlg').showModal();
  await log('pull_sheet_open', {});
}

function printPullSheet(){
  renderPullSheet();
  const body = $('#sheetBody')?.innerHTML || '';
  const { stickerCounts, totalQty, totalDistinct } = getPullData();
  const printWin = window.open('', '_blank', 'noopener,noreferrer,width=1100,height=800');
  if(!printWin){ toast('Allow pop-ups to print the sheet'); return; }
  printWin.document.write(`<!doctype html><html><head><title>Phoenix Pull Sheet</title><style>
    *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:28px;background:#fff}h1{margin:0 0 4px;font-size:28px}.sub{color:#666;margin-bottom:22px}.print-summary{display:flex;gap:12px;margin:0 0 24px}.box{border:1px solid #ddd;border-radius:10px;padding:12px 16px;min-width:150px}.box b{display:block;font-size:22px;margin-top:4px}.sheet-section{border:1px solid #ddd;border-radius:10px;margin:0 0 14px;overflow:hidden}.sheet-section-head{padding:12px 14px;background:#f4f5f7;display:flex;justify-content:space-between;align-items:center}.sheet-section-title{font-size:17px;font-weight:800}.sheet-section-sub{font-size:12px;color:#666;margin-top:3px}.sheet-table{width:100%;border-collapse:collapse}.sheet-table th,.sheet-table td{padding:9px 12px;border-bottom:1px solid #eee;text-align:left}.sheet-table th{font-size:12px;color:#666;text-transform:uppercase}.sheet-table .right{text-align:right}.sheet-table tr:last-child td{border-bottom:0}.sheet-restock-section .sheet-section-head{background:#fff4e5}.sheet-restock-badge{font-size:11px;font-weight:800}.restock-mark{font-weight:700}.sheet-group-label{font-size:11px;font-weight:800;letter-spacing:.12em;color:#777;margin:22px 0 8px}.sheet-restock-header{display:flex;justify-content:space-between;align-items:end;margin-top:22px}.sheet-restock-note{color:#666;font-size:12px}.sheet-restock-total{font-weight:800}.sheet-hero{display:flex;justify-content:space-between;gap:20px;border:1px solid #ddd;border-radius:12px;padding:16px;margin-bottom:18px}.sheet-kicker{font-size:11px;letter-spacing:.14em;font-weight:800;color:#777}.sheet-hero-title{font-size:34px;font-weight:900}.sheet-hero-title span{font-size:14px;font-weight:600;color:#666}.sheet-hero-sub{color:#666;font-size:12px}.sticker-grid{display:flex;gap:10px;flex-wrap:wrap}.sticker-card{border:1px solid #ddd;border-radius:9px;padding:9px 12px;min-width:120px}.sticker-card b{display:block;font-size:22px}.sticker-days{font-size:10px;font-weight:800;color:#666}.sheet-empty{padding:18px;border:1px dashed #ccc;border-radius:10px;color:#666}.sheet-restock-header{break-before:auto}@media print{body{padding:16px}.sheet-section{break-inside:avoid}.sheet-restock-section{break-inside:avoid}}
  </style></head><body><h1>Phoenix Pull</h1><div class="sub">Pull sheet • ${new Date().toLocaleString()}</div><div class="print-summary"><div class="box">Total units<b>${totalQty}</b></div><div class="box">Different items<b>${totalDistinct}</b></div><div class="box">2-day pastry stickers<b>${stickerCounts.pastries}</b></div><div class="box">3-day sandwich stickers<b>${stickerCounts.sandwiches}</b></div></div>${body}<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300)};<\/script></body></html>`);
  printWin.document.close();
  log('pull_sheet_print', {});
}

// ---------- bulk tools ----------
async function setVisibleItemsToPar(){
  const cards = $$('.item-card');
  if(cards.length === 0){ toast('Nothing visible'); return; }

  let changed = 0;

  for(const card of cards){
    const k = card.dataset.key;
    const it = itemsByKey.get(k);
    const prev = qtyMap.get(k) || { qty:0, restock:false };

    // compute par (same rules as per-card)
    let par = it?.par;
    if(par === null || par === undefined || par === ''){
      const note = (it?.note || '') + ' ' + (it?.shelf || '');
      const m = note.match(/(\d+)\s*[–\-]\s*(\d+)/);
      if(m) par = parseInt(m[2],10);
      else{
        const m2 = note.match(/(\d+)/);
        if(m2) par = parseInt(m2[1],10);
      }
    }
    par = clamp0(Number(par || 0));
    if(!par) continue;

    const next = { ...prev, qty: par };
    qtyMap.set(k, next);
    applyStateToUI(k, next);

    pushUndo(k, prev, next);
    queueSave(card.dataset.category, card.dataset.name, next);
    changed++;
  }

  updateTotals();
  await log('set_par', { bulk: true, changed });
  toast(changed ? `Set ${changed} items to PAR` : 'No PAR values found');
}

async function resetShift(){
  const ok = confirm("Start fresh shift? This will set all quantities to 0 (items stay).");
  if(!ok) return;

  // only reset items in your list
  let changed = 0;
  for(const it of items){
    const k = keyFor(it.category, it.name);
    const prev = qtyMap.get(k) || { qty:0, restock:false };
    const next = { ...prev, qty: 0, restock: false };
    if(prev.qty === 0 && prev.restock === false) continue;

    qtyMap.set(k, next);
    applyStateToUI(k, next);
    queueSave(it.category, it.name, next);
    changed++;
  }

  undoStack = [];
  $('#undoBtn').disabled = true;
  updateTotals();
  await log('reset_shift', { changed });
  toast('Fresh shift ✅');
}

// ---------- admin: users + logs + items ----------
async function adminRenderUsers(){
  const { data, error } = await supa.from('profiles').select('id,email,display_name,role,active,created_at').order('created_at',{ascending:false});
  if(error){
    $('#usersTableWrap').innerHTML = `<div class="muted">Error loading users.</div>`;
    return;
  }
  const rows = (data||[]).map(u=>`
    <tr>
      <td><b>${escapeHtml(u.display_name || u.email || '')}</b><div class="muted2">${escapeHtml(u.email || '')}</div></td>
      <td>${escapeHtml(u.role || 'user')}</td>
      <td>${u.active ? '✅' : '⛔'}</td>
      <td class="right">
        <button class="btn small-btn" data-uact="toggle" data-id="${escapeHtml(u.id)}">${u.active?'Deactivate':'Activate'}</button>
        <button class="btn small-btn" data-uact="role" data-id="${escapeHtml(u.id)}">Role</button>
      </td>
    </tr>
  `).join('');
  $('#usersTableWrap').innerHTML = `
    <table class="table">
      <thead><tr><th>User</th><th>Role</th><th>Active</th><th class="right">Actions</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">No users</td></tr>`}</tbody>
    </table>
  `;

  $('#usersTableWrap').onclick = async (e)=>{
    const b = e.target.closest('button'); if(!b) return;
    const id = b.dataset.id;
    const act = b.dataset.uact;
    if(act === 'toggle'){
      const { data } = await supa.from('profiles').select('active').eq('id', id).maybeSingle();
      if(!data) return;
      await supa.from('profiles').update({ active: !data.active }).eq('id', id);
      await adminRenderUsers();
    }
    if(act === 'role'){
      const role = prompt('Set role (admin/user):', 'user');
      if(!role || !['admin','user'].includes(role)) return;
      await supa.from('profiles').update({ role }).eq('id', id);
      await adminRenderUsers();
    }
  };
}

async function adminCreateUser(){
  const email = prompt('New user email:');
  if(email === null) return;
  const cleanEmail = email.trim().toLowerCase();
  if(!cleanEmail || !/^\S+@\S+\.\S+$/.test(cleanEmail)) return toast('Enter a valid email');

  const displayName = prompt('Display name (optional):', '') || '';
  const roleInput = (prompt('Role (user/admin):', 'user') || 'user').trim().toLowerCase();
  if(!['user','admin'].includes(roleInput)) return toast('Role must be user or admin');

  const { data, error } = await supa.functions.invoke('admin-create-user', {
    body: { email: cleanEmail, display_name: displayName.trim(), role: roleInput }
  });
  if(error){
    console.error(error);
    toast(error.message || 'Could not create user');
    return;
  }
  if(data?.error) return toast(data.error);
  toast(`Invitation sent to ${cleanEmail} ✉️`);
  await adminRenderUsers();
}

async function adminRenderLogFilters(){
  const { data } = await supa.from('profiles').select('email').order('email');
  const el = $('#logUserFilter');
  el.innerHTML = ['<option value="all">All users</option>'].concat((data||[]).map(u=>`<option value="${escapeHtml(u.email)}">${escapeHtml(u.email)}</option>`)).join('');
}

async function adminRenderLogs(){
  const who = $('#logUserFilter')?.value || 'all';
  const act = $('#logActionFilter')?.value || 'all';
  let q = supa.from('interactions').select('*').order('created_at',{ascending:false}).limit(800);
  if(who !== 'all') q = q.eq('user_email', who);
  if(act !== 'all') q = q.eq('action', act);

  const { data, error } = await q;
  if(error){
    $('#logsTableWrap').innerHTML = `<div class="muted">Error loading logs.</div>`;
    return;
  }
  const rows = (data||[]).map(l=>`
    <tr>
      <td>${new Date(l.created_at).toLocaleString()}</td>
      <td>${escapeHtml(l.user_email || '')}</td>
      <td><b>${escapeHtml(l.action || '')}</b></td>
      <td class="mono muted2">${escapeHtml(JSON.stringify(l.payload||{}))}</td>
    </tr>
  `).join('');
  $('#logsTableWrap').innerHTML = `
    <table class="table">
      <thead><tr><th>When</th><th>User</th><th>Action</th><th>Payload</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">No logs</td></tr>`}</tbody>
    </table>
  `;
}

function csvEscape(v){
  const s = String(v ?? '');
  if(/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

async function adminExportCSV(){
  const { data, error } = await supa.from('interactions').select('*').order('created_at',{ascending:false}).limit(5000);
  if(error){ toast('Export failed'); return; }
  const rows = (data||[]).map(l=>[
    new Date(l.created_at).toISOString(),
    l.user_email || '',
    l.action || '',
    JSON.stringify(l.payload||{})
  ]);
  const out = [
    ['created_at','user_email','action','payload_json'].map(csvEscape).join(',')
  ].concat(rows.map(r=>r.map(csvEscape).join(','))).join('\n');

  const blob = new Blob([out], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `phoenix_pull_logs_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function adminClearLogs(){
  const ok = confirm("Clear ALL logs? (Admin only)");
  if(!ok) return;
  const { error } = await supa.from('interactions').delete().neq('id', 0); // delete all rows
  if(error){ toast('Clear failed'); return; }
  await adminRenderLogs();
  toast('Logs cleared');
}

// ---- items CRUD ----
async function adminRenderItems(){
  const { data, error } = await supa.from('items').select('*').order('category',{ascending:true}).order('name',{ascending:true});
  if(error){
    $('#itemsTableWrap').innerHTML = `<div class="muted">Error loading items.</div><div class="hint">If this is your first time: create the items table + RLS in Supabase.</div>`;
    return;
  }
  const rows = (data||[]).map(r=>`
    <tr>
      <td><b>${escapeHtml(r.name||'')}</b><div class="muted2">${escapeHtml(r.category||'')}</div></td>
      <td>${escapeHtml(r.note||'')}</td>
      <td>${escapeHtml(r.shelf||'')}</td>
      <td>${r.par ?? ''}</td>
      <td>${(r.active ?? true) ? '✅' : '⛔'}</td>
      <td class="right">
        <button class="btn small-btn" data-item-edit="${escapeHtml(r.id)}">Edit</button>
      </td>
    </tr>
  `).join('');
  $('#itemsTableWrap').innerHTML = `
    <table class="table">
      <thead><tr><th>Item</th><th>Note</th><th>Shelf</th><th>PAR</th><th>Active</th><th class="right">Action</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted">No items</td></tr>`}</tbody>
    </table>
  `;

  $('#itemsTableWrap').onclick = async (e)=>{
    const b = e.target.closest('button[data-item-edit]');
    if(!b) return;
    const id = b.dataset.itemEdit;
    await openItemEditor(id);
  };
}

async function openItemEditor(id){
  const { data, error } = await supa.from('items').select('*').eq('id', id).maybeSingle();
  if(error || !data){ toast('Could not load item'); return; }

  $('#itemEditTitle').textContent = `Edit: ${data.name || ''}`;
  $('#itemId').value = data.id;
  $('#itemCategory').value = data.category || '';
  $('#itemName').value = data.name || '';
  $('#itemNote').value = data.note || '';
  $('#itemShelf').value = data.shelf || '';
  $('#itemPar').value = (data.par ?? '');
  $('#itemActive').checked = (data.active ?? true);

  $('#deleteItemBtn').style.display = 'inline-flex';
  $('#itemEditDlg').showModal();
}

function openNewItem(){
  $('#itemEditTitle').textContent = 'Add item';
  $('#itemId').value = '';
  $('#itemCategory').value = '';
  $('#itemName').value = '';
  $('#itemNote').value = '';
  $('#itemShelf').value = '';
  $('#itemPar').value = '';
  $('#itemActive').checked = true;
  $('#deleteItemBtn').style.display = 'none';
  $('#itemEditDlg').showModal();
}

async function saveItemFromForm(){
  const id = ($('#itemId').value || '').trim();
  const category = $('#itemCategory').value.trim();
  const name = $('#itemName').value.trim();
  const note = $('#itemNote').value.trim();
  const shelf = $('#itemShelf').value.trim();
  const parRaw = $('#itemPar').value.trim();
  const active = !!$('#itemActive').checked;

  if(!category || !name){ toast('Category + name required'); return; }

  const par = parRaw === '' ? null : clamp0(parseInt(parRaw, 10));

  const row = { category, name, note, shelf, par, active, updated_at: new Date().toISOString() };

  if(id){
    const { error } = await supa.from('items').update(row).eq('id', id);
    if(error){ toast(error.message || 'Save failed'); return; }
    await log('admin_item_update', { id, name });
  }else{
    const { error } = await supa.from('items').insert(row);
    if(error){ toast(error.message || 'Add failed'); return; }
    await log('admin_item_add', { name });
  }

  $('#itemEditDlg').close();
  toast('Saved');

  // refresh app lists
  await loadItems();
  renderAll();

  // refresh admin table
  await adminRenderItems();
}

async function deleteItem(){
  const id = ($('#itemId').value || '').trim();
  if(!id) return;
  const ok = confirm('Delete this item forever? (Not recommended — deactivate is better.)');
  if(!ok) return;

  const { error } = await supa.from('items').delete().eq('id', id);
  if(error){ toast(error.message || 'Delete failed'); return; }

  $('#itemEditDlg').close();
  toast('Deleted');

  await loadItems();
  renderAll();
  await adminRenderItems();
  await log('admin_item_delete', { id });
}

// ---------- routing / init ----------
async function afterLogin(){
  await ensureProfileForCurrentUser();
  $('#whoBadge').textContent = `${profile?.display_name || session.user.email} • ${profile?.role || 'user'}`;
  $('#roleBadge').textContent = `role: ${profile?.role || 'user'}`;
  $('#adminOpen').style.display = isAdmin() ? 'inline-flex' : 'none';
}

async function bootApp(){
  await loadItems();
  await loadQuantities();

  renderAll();
  updateTotals();
}

function bind(id, event, handler){
  const el = document.getElementById(id);
  if(!el){
    console.error(`[Phoenix Pull] Missing element #${id}; ${event} handler not attached.`);
    return null;
  }
  el.addEventListener(event, handler);
  return el;
}

function wireGlobal(){
  // login view
  $('#openSignup').onclick = ()=>$('#signupDlg').showModal();
  $('#closeSignup').onclick = ()=>$('#signupDlg').close();

  $('#loginForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    try{
      $('#loginMsg').textContent = '';
      const email = $('#loginEmail').value.trim();
      const pass = $('#loginPass').value;
      if(pass && pass.trim() !== ''){
        const { data, error } = await supa.auth.signInWithPassword({ email, password: pass });
        if(error) throw error;
        session = data.session;
        await afterLogin();
        await bootApp();
        show('app');
        toast('Welcome ✨');
        await log('login', { method: 'password' });
      }else{
        // Magic link / OTP login (best for teams that don't want passwords)
        const { error } = await supa.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin }
        });
        if(error) throw error;
        $('#loginMsg').textContent = 'Check your email for the sign-in link.';
        toast('Magic link sent');
        await log('login_link_sent', {});
      }
    }catch(err){
      $('#loginMsg').textContent = err?.message || 'Could not sign in';
      toast('Sign in failed');
    }
  });

  $('#magicLinkBtn').onclick = async ()=>{
    try{
      $('#loginMsg').textContent = '';
      const email = ($('#loginEmail').value || '').trim();
      if(!email) return toast('Type your email first');
      const { error } = await supa.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin }
      });
      if(error) throw error;
      $('#loginMsg').textContent = 'Check your email for the sign-in link.';
      toast('Magic link sent');
      await log('login_link_sent', {});
    }catch(err){
      $('#loginMsg').textContent = err?.message || 'Could not send link';
      toast('Could not send link');
    }
  };

  $('#signupForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    try{
      const email = $('#signupEmail').value.trim();
      const pass = $('#signupPass').value;
      const name = $('#signupName').value.trim();
      const { data, error } = await supa.auth.signUp({ email, password: pass });
      if(error) throw error;
      session = data.session;
      await ensureProfileForCurrentUser(name || undefined);
      $('#signupDlg').close();
      toast('Account created. You can sign in now.');
    }catch(err){
      toast(err?.message || 'Sign up failed');
    }
  });

  $('#resetPw').onclick = async ()=>{
    const email = ($('#loginEmail').value || '').trim();
    if(!email){ toast('Type your email first'); return; }
    const { error } = await supa.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    if(error){ toast(error.message || 'Reset failed'); return; }
    toast('Password reset email sent');
  };

  // app view
  $('#logoutBtn').onclick = async ()=>{
    // Log while the authenticated session still exists, then sign out.
    await log('logout', {});
    const { error } = await supa.auth.signOut();
    if(error){ toast(error.message || 'Could not log out'); return; }
    session=null; profile=null;
    show('login');
  };

  $('#search').addEventListener('input', renderAll);
  $('#onlyQty').addEventListener('change', renderAll);
  $('#onlyRestock').addEventListener('change', renderAll);

  $('#undoBtn').onclick = undo;
  $('#undoBtn').disabled = true;

  // keyboard undo
  window.addEventListener('keydown', (e)=>{
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'){
      e.preventDefault();
      undo();
    }
  });

  $('#pullSheetBtn').onclick = openPullSheet;
  $('#closeSheet').onclick = ()=>$('#sheetDlg').close();
  $('#copySheet').onclick = async ()=>{
    const text = sheetToText();
    await navigator.clipboard.writeText(text);
    toast('Copied');
  };
  $('#printSheet').onclick = printPullSheet;

  $('#setVisibleToPar').onclick = setVisibleItemsToPar;
  $('#resetShift').onclick = resetShift;

  // admin modal
  $('#adminOpen').onclick = async ()=>{
    if(!isAdmin()){ toast('Admins only'); return; }
    await adminOpen();
  };
  $('#closeAdmin').onclick = ()=>$('#adminDlg').close();

  $('#adminDlg').addEventListener('click', (e)=>{
    const tabBtn = e.target.closest('button[data-tab]');
    if(!tabBtn) return;
    const tab = tabBtn.dataset.tab;
    setAdminTab(tab);
  });

  $('#addItemBtn').onclick = ()=>{
    if(!isAdmin()) return toast('Admins only');
    openNewItem();
  };

  $('#closeItemEdit').onclick = ()=>$('#itemEditDlg').close();
  $('#itemEditForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin()) return toast('Admins only');
    await saveItemFromForm();
  });
  $('#deleteItemBtn').onclick = async ()=>{
    if(!isAdmin()) return toast('Admins only');
    await deleteItem();
  };

  $('#createUserBtn').onclick = async ()=>{
    if(!isAdmin()) return toast('Admins only');
    await adminCreateUser();
  };

  $('#logUserFilter').addEventListener('change', adminRenderLogs);
  $('#logActionFilter').addEventListener('change', adminRenderLogs);
  $('#exportCSV').onclick = adminExportCSV;
  $('#clearLogs').onclick = adminClearLogs;

  wireListInteractions();
  wireQuickAdd();
}

function sheetToText(){
  const { byCat, restockByCat, stickerCounts, totalQty } = getPullData();
  const lines = [
    'PHOENIX PULL SHEET',
    `Total units: ${totalQty}`,
    `2-day pastry stickers: ${stickerCounts.pastries}`,
    `3-day sandwich stickers: ${stickerCounts.sandwiches}`,
    ''
  ];
  for(const c of Array.from(byCat.keys()).sort((a,b)=>a.localeCompare(b))){
    lines.push(`== ${c} ==`);
    for(const x of byCat.get(c)) lines.push(`${x.qty}  ${x.it.name}${x.restock ? '  [restock]' : ''}`);
    lines.push('');
  }
  const restockCats = Array.from(restockByCat.keys()).sort((a,b)=>a.localeCompare(b));
  if(restockCats.length){
    lines.push('== RESTOCK ==');
    for(const c of restockCats){
      lines.push(`-- ${c} --`);
      for(const x of restockByCat.get(c)) lines.push(`${x.qty}  ${x.it.name}`);
      lines.push('');
    }
  }
  return lines.join('\n').trim() || 'Nothing to pull yet.';
}

function setAdminTab(tab){
  $('#tab-items').classList.toggle('hidden', tab !== 'items');
  $('#tab-users').classList.toggle('hidden', tab !== 'users');
  $('#tab-logs').classList.toggle('hidden', tab !== 'logs');
}

async function adminOpen(){
  setAdminTab('items');
  $('#adminDlg').showModal();

  // Items + users + logs (lazy-ish but fast enough)
  await Promise.allSettled([
    adminRenderItems(),
    adminRenderUsers(),
    adminRenderLogFilters()
  ]);
  await adminRenderLogs();
}

// ---------- start ----------
(async function init(){
  wireGlobal();
  await refreshSession();
  if(session){
    try{
      await afterLogin();
      await bootApp();
      show('app');
    }catch(err){
      console.warn(err);
      await supa.auth.signOut();
      session=null; profile=null;
      show('login');
    }
  }else{
    show('login');
  }

  // keep session fresh
  supa.auth.onAuthStateChange(async (_event, newSession)=>{
    session = newSession;
    if(!session){
      profile=null;
      show('login');
      return;
    }

    // If a magic-link sign-in completes (or a session is restored), boot into the app.
    const loginVisible = !$('#view-login').classList.contains('hidden');
    if(loginVisible){
      try{
        await afterLogin();
        await bootApp();
        show('app');
        toast('Welcome ✨');
      }catch(err){
        console.warn(err);
        await supa.auth.signOut();
        session=null; profile=null;
        show('login');
      }
    }
  });
})();
