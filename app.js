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
let undoGroup = null;
const collapsed = new Set();          // collapsed category names (survive re-render)
let bootPromise = null;

const saveQueue = new Map();    // key => timeoutId
let saveState = 'Ready';
function setSaveState(s){
  saveState = s;
  const el = $('#saveState'); if(el) el.textContent = s;
}

function keyFor(category, name){ return `${category}__${name}`; }

// Cake pops and egg bites always get their own sections, even if they are still filed under Pastries / Sandwiches
function effCat(cat, name){
  const n = String(name || '').toLowerCase();
  const c = String(cat || '').toLowerCase().replace(/[^a-z]/g, '');
  if(/cake\s*-?pop/.test(n) || c.includes('cakepop')) return 'Cake Pops';
  if(/egg\s*-?bite/.test(n) || c.includes('eggbite')) return 'Egg Bites';
  return cat;
}
// Top sections first: Pastries, Sandwiches, Cake Pops, Egg Bites, then everything else A-Z
function catRank(c){
  const n = String(c).toLowerCase().replace(/[^a-z]/g, '');
  if(/^paste?r/.test(n)) return 0;
  if(n.startsWith('sandw')) return 1;
  if(n.includes('cakepop')) return 2;
  if(n.includes('eggbite')) return 3;
  return 4;
}
function sortCats(a, b){ return catRank(a) - catRank(b) || String(a).localeCompare(String(b)); }

// Shelf life in days: Pastries 2, Sandwiches 3, Cake Pops 3, Egg Bites 7 (otherwise the item's own shelf field)
function shelfDays(it){
  const n = String(it.name || '').toLowerCase();
  const c = String(it.category || '').toLowerCase().replace(/[^a-z]/g, '');
  if(/cake\s*-?pop/.test(n) || c.includes('cakepop')) return 3;
  if(/egg\s*-?bite/.test(n) || c.includes('eggbite')) return 7;
  if(/^paste?r/.test(c)) return 2;
  if(c.startsWith('sandw')) return 3;
  const m = String(it.shelf || '').match(/(\d+)\s*(days?|d|weeks?|wks?|w)\b/i);
  return m ? parseInt(m[1], 10) * (/^w/i.test(m[2]) ? 7 : 1) : 0;
}

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
    category: effCat(r.category || 'Uncategorized', r.name),
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
    const key = keyFor(effCat(r.category, r.item_name), r.item_name);
    const old = qtyMap.get(key);
    if(old && old.ts > (r.updated_at || '')) continue;   // two old rows now map to one item: keep the newest
    qtyMap.set(key, {
      ts: r.updated_at || '',
      qty: clamp0(Number(r.qty || 0)),
      restock: !!r.restock
    });
  }
  for(const r of Object.values(getPend())){            // unsent changes from this phone win
    if(r.user_id === u.id) qtyMap.set(keyFor(r.category, r.item_name), { qty: clamp0(Number(r.qty || 0)), restock: !!r.restock });
  }
  flushPending();
}

// ---------- offline-safe pending writes ----------
const PEND_KEY = 'phx_pending';
function getPend(){ try{ return JSON.parse(localStorage.getItem(PEND_KEY) || '{}'); }catch{ return {}; } }
function setPend(o){ try{ localStorage.setItem(PEND_KEY, JSON.stringify(o)); }catch{} }
async function flushPending(){
  const u = session?.user; if(!u || !navigator.onLine) return;
  const rows = Object.values(getPend()).filter(r=>r.user_id === u.id);
  if(!rows.length) return;
  const { error } = await supa.from('quantities').upsert(rows, { onConflict: 'user_id,category,item_name' });
  if(error) return;
  const p = getPend(); for(const r of rows) delete p[keyFor(r.category, r.item_name)]; setPend(p);
  setSaveState('Synced'); setTimeout(()=>{ if(!saveQueue.size) setSaveState('Ready'); }, 1200);
}

// ---------- saving (debounced per item) ----------
function queueSave(category, name, next){
  const k = keyFor(category, name);
  const prev = saveQueue.get(k);
  if(prev) clearTimeout(prev);

  setSaveState('Saving…');

  const tid = setTimeout(async ()=>{
    saveQueue.delete(k);
    const ok = await persistRow(category, name, next);
    if(!ok){ setSaveState('Saved on phone, will sync'); return; }
    if(saveQueue.size === 0) setSaveState('Saved');
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
  const k = keyFor(category, name);
  const pend = getPend(); pend[k] = row; setPend(pend);        // write-ahead: survives signal loss or closing the app
  if(!navigator.onLine) return false;
  const { error } = await supa.from('quantities').upsert(row, { onConflict: 'user_id,category,item_name' });
  if(error){ console.error('upsert error', error); return false; }
  const p2 = getPend(); if(p2[k] && p2[k].updated_at === row.updated_at){ delete p2[k]; setPend(p2); }
  return true;
}

// ---------- undo ----------
function pushUndo(k, prev, next){
  if(suppressUndo) return;
  const now = Date.now();
  const last = undoStack[undoStack.length-1];
  if(last && !undoGroup && !last.group && last.key === k && now - last.t < 700){
    last.next = {...next}; last.t = now;          // merge rapid taps / hold-repeat into one step
  }else{
    undoStack.push({ key: k, prev: {...prev}, next: {...next}, t: now, group: undoGroup });
    if(undoStack.length > 100) undoStack.shift();
  }
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
  const first = undoStack.pop();
  if(!first) return;
  const ops = [first];
  while(first.group && undoStack.length && undoStack[undoStack.length-1].group === first.group) ops.push(undoStack.pop());
  $('#undoBtn').disabled = undoStack.length === 0;
  for(const o of ops){
    const it = itemsByKey.get(o.key); if(!it) continue;
    qtyMap.set(o.key, { ...o.prev });
    applyStateToUI(o.key, o.prev);
    queueSave(it.category, it.name, o.prev);
  }
  updateTotals();
  await log('undo', { steps: ops.length });
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
  const cats = Array.from(new Set(items.map(i=>i.category))).sort(sortCats);
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

function getPar(it){
  if(!it) return 0;
  if(it.par !== null && it.par !== undefined && it.par !== '') return clamp0(Number(it.par));
  // only trust an explicit range in the note, e.g. "6–8" (never a stray number like a shelf or temperature)
  const m = (it.note || '').match(/(\d+)\s*[–-]\s*(\d+)/);
  return m ? parseInt(m[2], 10) : 0;
}

const _qtyLogTimers = new Map();
function logQtyDebounced(k, category, name, qty){
  clearTimeout(_qtyLogTimers.get(k));
  _qtyLogTimers.set(k, setTimeout(()=>log('qty_change', { category, item: name, qty }), 700));
}

function sectionTemplate(category, listHtml, sectionTotal){
  const c = collapsed.has(category);
  return `
    <section class="sec${c ? ' is-collapsed' : ''}">
      <div class="sec-head">
        <button class="sec-toggle" type="button" data-sec-toggle="${escapeHtml(category)}" aria-expanded="${!c}">
          <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          <span>${escapeHtml(category)}</span>
        </button>
        <span class="sec-total muted">Total: <b>${sectionTotal}</b></span>
        <button class="btn small-btn" type="button" data-fill="${escapeHtml(category)}">Fill to PAR</button>
      </div>
      <div class="list" data-sec-list="${escapeHtml(category)}">${listHtml}</div>
    </section>`;
}

function itemCardTemplate(it, st){
  const k = keyFor(it.category, it.name);
  const qty = clamp0(st?.qty || 0);
  const restock = !!st?.restock;
  const note = [it.note, shelfDays(it) ? `Shelf life: ${shelfDays(it)} days` : ''].filter(Boolean).join(' • ');
  const par = getPar(it);
  return `
    <div class="item-card" data-key="${escapeHtml(k)}" data-category="${escapeHtml(it.category)}" data-name="${escapeHtml(it.name)}">
      <div class="item-info" title="Tap for +5 / +10">
        <div class="item-name">${escapeHtml(it.name)}</div>
        ${note ? `<div class="item-meta">${escapeHtml(note)}</div>` : ''}
        <div class="par-note"></div>
      </div>
      <div class="item-controls">
        <button class="par-btn" type="button" data-par="${escapeHtml(k)}" ${par ? '' : 'disabled'} title="Set quantity to PAR">PAR ${par || '–'}</button>
        <label class="flag" title="Needs restock"><input class="restock" type="checkbox" ${restock ? 'checked' : ''} /><span>Restock</span></label>
        <div class="stepper">
          <button class="step" type="button" data-step="-1" aria-label="Decrease">−</button>
          <input class="qty-input" inputmode="numeric" type="number" min="0" value="${qty}" aria-label="Quantity" />
          <button class="step" type="button" data-step="1" aria-label="Increase">+</button>
        </div>
      </div>
      <div class="quick">
        <button class="btn small-btn" type="button" data-step="-5">−5</button>
        <button class="btn small-btn" type="button" data-step="5">+5</button>
        <button class="btn small-btn" type="button" data-step="10">+10</button>
      </div>
    </div>`;
}

function hasQty(s){ return /^\s*\d+\s+\S/.test(s) || /\S\s*[xX]\s*\d+\s*$/.test(s) || /\S\s+\d+\s*$/.test(s); }

function getFilters(){
  const raw = $('#search')?.value || '';
  const s = hasQty(raw) ? '' : raw.trim().toLowerCase();   // "2 croissant" is quick-add, not a search
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

  const cats = Array.from(byCat.keys()).sort(sortCats);
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
    host.innerHTML = `<div class="empty">No items match. Clear the search or filters to see everything.</div>`;
  }

  updateTotals();
  wireSectionToggles();
}

function updateTotals(){
  let total = 0;
  $$('[data-sec-list]').forEach(list=>{
    let sum = 0;
    $$('.item-card', list).forEach(card=>{
      const q = clamp0((qtyMap.get(card.dataset.key) || {}).qty || 0);
      sum += q;
      const par = getPar(itemsByKey.get(card.dataset.key));
      const note = card.querySelector('.par-note');
      if(par){
        const d = par - q;
        card.dataset.status = d > 0 ? 'low' : d === 0 ? 'ok' : 'over';
        note.textContent = d > 0 ? `Need ${d} more` : d === 0 ? 'At PAR' : `${-d} over PAR`;
      }else{ delete card.dataset.status; note.textContent = ''; }
    });
    total += sum;
    const b = list.closest('.sec')?.querySelector('.sec-total b');
    if(b) b.textContent = sum;
  });
  $('#totalAll').textContent = total;
}

function wireSectionToggles(){
  $$('[data-sec-toggle]').forEach(btn=>{
    btn.onclick = ()=>{
      const cat = btn.dataset.secToggle;
      const isC = btn.closest('.sec').classList.toggle('is-collapsed');
      if(isC) collapsed.add(cat); else collapsed.delete(cat);
      btn.setAttribute('aria-expanded', String(!isC));
    };
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
    logQtyDebounced(k, category, name, next.qty);

    updateTotals();
  }

  let held = false;
  root.addEventListener('pointerdown', (e)=>{
    const btn = e.target.closest('button[data-step]');
    if(!btn) return;
    const card = btn.closest('.item-card'); if(!card) return;
    const delta = Number(btn.dataset.step || 0);
    holdBtn = btn; held = false;
    holdTimer = setTimeout(()=>{
      held = true;
      step(card, delta);
      holdInterval = setInterval(()=>{ if(holdBtn) step(card, delta); }, 110);
    }, 450);
  });
  root.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-step]');
    if(!btn) return;
    if(held){ held = false; return; }      // a long-press already stepped
    const card = btn.closest('.item-card'); if(!card) return;
    step(card, Number(btn.dataset.step || 0));
  });
  window.addEventListener('pointerup', stopHold);
  window.addEventListener('pointercancel', stopHold);   // fires when the finger starts scrolling
  window.addEventListener('blur', stopHold);
  root.addEventListener('pointermove', (e)=>{
    if(holdBtn && !holdBtn.contains(document.elementFromPoint(e.clientX, e.clientY))) stopHold();
  });
  root.addEventListener('contextmenu', (e)=>{ if(e.target.closest('button[data-step]')) e.preventDefault(); });

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
    const par = getPar(it);
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
  const el = $('#search');
  el.addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    if(!hasQty(el.value)) return;          // plain text = search only
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
    el.dispatchEvent(new Event('input'));
    updateTotals();
    toast(`+${parsed.qty} • ${it.name}`);
  });
}

// ---------- pull sheet ----------
let pulled = new Set();
const pulledKey = ()=>`phx_pulled_${session?.user?.id || 'x'}_${new Date().toISOString().slice(0,10)}`;
function loadPulled(){ try{ pulled = new Set(JSON.parse(localStorage.getItem(pulledKey()) || '[]')); }catch{ pulled = new Set(); } }
function savePulled(){ try{ localStorage.setItem(pulledKey(), JSON.stringify([...pulled])); }catch{} }

function orderCats(cats){
  let o = []; try{ o = JSON.parse(localStorage.getItem('phx_cat_order') || '[]'); }catch{}
  return cats.slice().sort((a,b)=>{
    const ia = o.indexOf(a), ib = o.indexOf(b);
    if(ia < 0 && ib < 0) return sortCats(a, b);
    if(ia < 0) return 1; if(ib < 0) return -1; return ia - ib;
  });
}
function moveCat(cat, dir){
  const cats = orderCats(Array.from(pullGroups().byCat.keys()));
  const i = cats.indexOf(cat), j = i + dir;
  if(i < 0 || j < 0 || j >= cats.length) return;
  [cats[i], cats[j]] = [cats[j], cats[i]];
  try{ localStorage.setItem('phx_cat_order', JSON.stringify(cats)); }catch{}
  renderPullSheet();
}
function useByDate(it){ const d = shelfDays(it); return d ? new Date(Date.now() + d * 864e5) : null; }
function fmtDate(d){ return d.toLocaleDateString(undefined, { weekday:'short', month:'numeric', day:'numeric' }); }
function useByLabel(it){ const d = useByDate(it); return d ? 'Use by ' + fmtDate(d) : ''; }

// one sticker per item pulled, grouped by the date that goes on it
function stickerGroups(){
  const { restock, byCat } = pullGroups();
  const all = restock.concat(...byCat.values());
  const g = new Map();
  for(const x of all){
    if(x.qty <= 0) continue;
    const d = useByDate(x.it); if(!d) continue;
    const key = d.toDateString();
    if(!g.has(key)) g.set(key, { date: d, total: 0, parts: new Map() });
    const e = g.get(key);
    e.total += x.qty;
    e.parts.set(x.it.category, (e.parts.get(x.it.category) || 0) + x.qty);
  }
  return Array.from(g.values()).sort((a, b)=>a.date - b.date);
}

function updateSheetProg(){
  const rows = $$('#sheetBody .sheet-row'), done = $$('#sheetBody .sheet-row.done').length;
  $('#sheetProg').textContent = `${done} of ${rows.length} pulled`;
  $('#sheetBar').style.width = rows.length ? `${Math.round(done / rows.length * 100)}%` : '0%';
}

function pullGroups(){
  const restock = [];
  const byCat = new Map();
  for(const it of items){
    const st = qtyMap.get(keyFor(it.category, it.name)) || { qty:0, restock:false };
    const qty = clamp0(st.qty);
    if(st.restock){ restock.push({ it, qty }); continue; }
    if(qty <= 0) continue;
    if(!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category).push({ it, qty });
  }
  return { restock, byCat };
}

function renderPullSheet(){
  const { restock, byCat } = pullGroups();
  const cats = orderCats(Array.from(byCat.keys()));
  if(!restock.length && !cats.length){
    $('#sheetBody').innerHTML = `<div class="empty">Nothing to pull yet. Add quantities first.</div>`;
    updateSheetProg();
    return;
  }
  const row = (x, withCat) => {
    const k = keyFor(x.it.category, x.it.name);
    const sub = [withCat ? x.it.category : '', useByLabel(x.it)].filter(Boolean).join(' • ');
    return `<div class="sheet-row${pulled.has(k) ? ' done' : ''}" data-pk="${escapeHtml(k)}"><span class="tick"></span><b>${x.qty}</b><span class="nm">${escapeHtml(x.it.name)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span></div>`;
  };
  const block = (title, rows, withCat, cls, movable) => `
    <section class="sheet-sec ${cls}">
      <div class="sheet-head"><span>${escapeHtml(title)}</span><span class="mvs">${rows.length}${movable ? `
        <button type="button" class="mv" data-mv="-1" data-cat="${escapeHtml(title)}" aria-label="Move up">▲</button>
        <button type="button" class="mv" data-mv="1" data-cat="${escapeHtml(title)}" aria-label="Move down">▼</button>` : ''}</span></div>
      ${rows.map(x=>row(x, withCat)).join('')}
    </section>`;
  let html = '';
  const stk = stickerGroups();
  if(stk.length){
    html += `<section class="sheet-sec stickers">
      <div class="sheet-head"><span>Stickers to print</span><span>${stk.reduce((n, e)=>n + e.total, 0)}</span></div>
      ${stk.map(e=>`<div class="stk-row"><b>${e.total}</b><span class="nm">${escapeHtml(fmtDate(e.date))}<small>${[...e.parts].map(([c, n])=>`${escapeHtml(c)} ${n}`).join(' • ')}</small></span></div>`).join('')}
    </section>`;
  }
  if(restock.length) html += block('Restock', restock, true, 'restock', false);
  for(const c of cats) html += block(c, byCat.get(c), false, '', true);
  $('#sheetBody').innerHTML = html;
  updateSheetProg();
}

async function openPullSheet(){
  loadPulled();
  renderPullSheet();
  $('#sheetDlg').showModal();
  await log('pull_sheet_open', {});
}

// ---------- bulk tools ----------
async function setCardsToPar(cards, onlyRaise){
  if(!cards.length){ toast('Nothing visible'); return; }
  let changed = 0;
  undoGroup = 'g' + Date.now();
  for(const card of cards){
    const k = card.dataset.key;
    const par = getPar(itemsByKey.get(k));
    if(!par) continue;
    const prev = qtyMap.get(k) || { qty:0, restock:false };
    if(onlyRaise ? prev.qty >= par : prev.qty === par) continue;
    const next = { ...prev, qty: par };
    qtyMap.set(k, next);
    applyStateToUI(k, next);
    pushUndo(k, prev, next);
    queueSave(card.dataset.category, card.dataset.name, next);
    changed++;
  }
  undoGroup = null;
  updateTotals();
  await log('set_par', { bulk: true, changed });
  toast(changed ? `Set ${changed} items to PAR` : 'Already at PAR');
}
function setVisibleItemsToPar(){ return setCardsToPar($$('.item-card'), false); }

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
  pulled.clear(); savePulled();
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
    if(id === session?.user?.id){ toast("You can't change your own account here"); return; }
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
  const { error } = await supa.from('interactions').delete().not('created_at', 'is', null); // delete all rows (works for uuid or int ids)
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
  if(profile && profile.active === false){
    await supa.auth.signOut(); session = null; profile = null;
    throw new Error('This account is deactivated. Ask an admin to reactivate it.');
  }
  $('#whoBadge').textContent = `${profile?.display_name || session.user.email} • ${profile?.role || 'user'}`;
  $('#roleBadge').textContent = `role: ${profile?.role || 'user'}`;
  $('#adminOpen').style.display = isAdmin() ? 'inline-flex' : 'none';
}

// single shared entry so password login and the auth listener never boot twice
function enterApp(){
  if(!bootPromise){
    bootPromise = (async()=>{ await afterLogin(); await bootApp(); show('app'); })().finally(()=>{ bootPromise = null; });
  }
  return bootPromise;
}

async function bootApp(){
  await loadItems();
  await loadQuantities();

  renderAll();
  updateTotals();
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
        await enterApp();
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
    await log('logout', {});   // log BEFORE signing out (needs the session)
    await supa.auth.signOut();
    session=null; profile=null; items=[]; qtyMap=new Map(); undoStack=[];
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
    try{ await navigator.clipboard.writeText(text); toast('Copied'); }
    catch{
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); toast('Copied'); }catch{ toast('Copy failed'); }
      ta.remove();
    }
  };

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

  $('#logUserFilter').addEventListener('change', adminRenderLogs);
  $('#logActionFilter').addEventListener('change', adminRenderLogs);
  $('#exportCSV').onclick = adminExportCSV;
  $('#clearLogs').onclick = adminClearLogs;

  wireListInteractions();
  wireQuickAdd();
}

function sheetToText(){
  const { restock, byCat } = pullGroups();
  const lines = [];
  const stk = stickerGroups();
  if(stk.length){
    lines.push('== STICKERS ==');
    for(const e of stk) lines.push(`${e.total}  ${fmtDate(e.date)}  (${[...e.parts].map(([c, n])=>`${c} ${n}`).join(', ')})`);
    lines.push('');
  }
  if(restock.length){
    lines.push('== RESTOCK ==');
    for(const x of restock) lines.push(`${x.qty}  ${x.it.name} (${x.it.category})`);
    lines.push('');
  }
  for(const c of orderCats(Array.from(byCat.keys()))){
    lines.push(`== ${c} ==`);
    for(const x of byCat.get(c)) lines.push(`${x.qty}  ${x.it.name}${useByLabel(x.it) ? '  (' + useByLabel(x.it) + ')' : ''}`);
    lines.push('');
  }
  return lines.join('\n').trim() || 'Nothing to pull yet.';
}

function setAdminTab(tab){
  $('#tab-items').classList.toggle('hidden', tab !== 'items');
  $('#tab-users').classList.toggle('hidden', tab !== 'users');
  $('#tab-logs').classList.toggle('hidden', tab !== 'logs');
  $$('[data-tab]').forEach(b=>b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
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
      await enterApp();
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
  supa.auth.onAuthStateChange((_event, newSession)=>{ setTimeout(async ()=>{
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
        await enterApp();
        toast('Welcome ✨');
      }catch(err){
        console.warn(err);
        await supa.auth.signOut();
        session=null; profile=null;
        show('login');
      }
    }
  }, 0);
  });
})();


// ---------- UI wiring (layout v6) ----------
(function wireUi(){
  const box = $('#search');
  // one box: plain text filters; "2 croissant" / "muffin x3" shows what Enter will add
  box.addEventListener('input', ()=>{
    const hint = $('#qaHint');
    if(!hasQty(box.value)){ hint.classList.add('hidden'); return; }
    const p = parseQuickAdd(box.value), it = p && bestItemMatch(p.query);
    hint.textContent = it ? `Press Enter to add ${p.qty} × ${it.name}` : 'No matching item';
    hint.classList.remove('hidden');
  });

  $('#sections').addEventListener('click', (e)=>{
    const f = e.target.closest('[data-fill]');
    if(f){
      const list = document.querySelector(`[data-sec-list="${CSS.escape(f.dataset.fill)}"]`);
      if(list) setCardsToPar($$('.item-card', list), true);   // only raises items that are below PAR
      return;
    }
    const info = e.target.closest('.item-info');
    if(info) info.closest('.item-card').classList.toggle('open');   // reveals −5 / +5 / +10
  });

  // pull sheet checklist
  $('#sheetBody').addEventListener('click', (e)=>{
    const mv = e.target.closest('[data-mv]');
    if(mv){ moveCat(mv.dataset.cat, Number(mv.dataset.mv)); return; }
    const r = e.target.closest('.sheet-row');
    if(!r) return;
    const k = r.dataset.pk;
    if(pulled.has(k)) pulled.delete(k); else pulled.add(k);
    r.classList.toggle('done', pulled.has(k));
    savePulled(); updateSheetProg();
  });
  $('#clearPulled').onclick = ()=>{ pulled.clear(); savePulled(); renderPullSheet(); };
  $('#printSheet').onclick = ()=>window.print();
  $('#shareSheet').onclick = async ()=>{
    const text = sheetToText();
    try{ if(navigator.share) await navigator.share({ title: 'Pull sheet', text }); else $('#copySheet').click(); }
    catch{ /* share cancelled */ }
  };

  // keep the screen awake while pulling (needs https)
  let wl = null;
  async function keepAwake(){
    try{
      if('wakeLock' in navigator && document.visibilityState === 'visible' && !wl){
        wl = await navigator.wakeLock.request('screen');
        wl.addEventListener('release', ()=>{ wl = null; });
      }
    }catch{}
  }
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('pointerdown', keepAwake, { passive: true });

  // retry unsent changes when signal returns
  window.addEventListener('online', flushPending);
  setInterval(flushPending, 20000);

  document.addEventListener('focusin', (e)=>{ if(e.target.matches && e.target.matches('.qty-input')) e.target.select(); });
  $$('dialog').forEach(d=>d.addEventListener('click', (e)=>{ if(e.target === d) d.close(); }));
  window.addEventListener('beforeunload', (e)=>{ if(saveQueue.size){ e.preventDefault(); e.returnValue = ''; } });
})();
