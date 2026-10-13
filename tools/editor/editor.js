// 場景編輯器：點一行劇情 → 預覽那一句的畫面 → 點素材套用，自動改寫劇情檔的 @ 指令
(() => {
'use strict';
const $ = s => document.querySelector(s);
const POS = ['left', 'center', 'right'];
const POS_NAME = { left: '左', center: '中', right: '右' };
const DIRS = { bg: '/assets/bg/', cg: '/assets/cg/', chars: '/assets/chars/', bgm: '/assets/bgm/', se: '/assets/se/' };
const url = (dir, name) => DIRS[dir] + name.split('/').map(encodeURIComponent).join('/');

let cfg, chars = {}, assets = {};
let chapterId = null, lines = [], trailingNL = true, savedText = '';
let sel = 0, tab = 'bg', pvReady = false;
let editIdx = null, editNew = false;     // 正在編輯的那一行（editNew = 剛新增、還沒填內容）
const undoStack = [];
let kinds = [];

// ---------- 解析 ----------
function classify() {
  kinds = []; let inChoice = false;
  for (const l of lines) {
    const t = l.trim(); let k;
    if (!t) k = 'blank';
    else if (t[0] === '#') k = 'comment';
    else if (t[0] === '*') k = 'label';
    else if (/^@choice\b/.test(t)) { k = 'choiceStart'; inChoice = true; }
    else if (/^@endchoice\b/.test(t)) { k = 'choiceEnd'; inChoice = false; }
    else if (inChoice && t[0] === '-') k = 'opt';
    else if (t[0] === '@') k = 'cmd';
    else k = 'say';
    kinds.push(k);
  }
}
function parseCmd(line) {
  const m = line.trim().match(/^@(\w+)\s*(.*)$/);
  return m ? { name: m[1], args: m[2].split(/\s+/).filter(Boolean) } : { name: '', args: [] };
}
function sayInfo(line) {
  const d = line.trim().match(/^([^：:]{1,12})[：:]\s*(.*)$/);
  if (d) {
    const key = Object.keys(chars).find(k => k === d[1] || chars[k].name === d[1]);
    if (key) return { who: key, text: d[2] };
  }
  return { who: null, text: line.trim() };
}
const blankV = () => ({ bg: null, cg: null, pic: null, bgm: null, spr: { left: null, center: null, right: null } });
function applyCmd(V, c) {
  const a = c.args;
  switch (c.name) {
    case 'bg': V.bg = a[0] || null; break;
    case 'cg': V.cg = !a[0] || a[0] === 'off' ? null : a[0]; break;
    case 'pic': V.pic = !a[0] || a[0] === 'off' ? null : { name: a[0], pos: a[1] && a[1] !== 'above' ? a[1] : 'center', above: a.includes('above') }; break;
    case 'bgm': V.bgm = !a[0] || a[0] === 'off' ? null : a[0]; break;
    case 'show': {
      const pos = a[2] || 'center';
      for (const p of POS) if (p !== pos && V.spr[p] && V.spr[p].c === a[0]) V.spr[p] = null;
      V.spr[pos] = { c: a[0], e: a[1] };
      break;
    }
    case 'hide':
      for (const p of POS) if (a[0] === 'all' || p === a[0] || (V.spr[p] && V.spr[p].c === a[0])) V.spr[p] = null;
      break;
  }
}

// 目前選取的行對應的「顯示行」：玩家真正會看到畫面的那句台詞或選項
function displayIndex(i) {
  if (kinds[i] === 'opt' || kinds[i] === 'choiceEnd') {
    for (let k = i; k >= 0; k--) if (kinds[k] === 'choiceStart') return k;
  }
  for (let k = i; k < lines.length; k++) if (kinds[k] === 'say' || kinds[k] === 'choiceStart') return k;
  return lines.length;
}
function stateAt(j) {
  const V = blankV();
  for (let i = 0; i < j && i < lines.length; i++) if (kinds[i] === 'cmd') applyCmd(V, parseCmd(lines[i]));
  return V;
}

// ---------- 修改劇情 ----------
function mutate(fn) {
  undoStack.push({ lines: lines.slice(), sel });
  if (undoStack.length > 200) undoStack.shift();
  fn();
  classify(); renderAll();
}
function undo() {
  const u = undoStack.pop();
  if (!u) return;
  editIdx = null; editNew = false;
  lines = u.lines; sel = Math.min(u.sel, lines.length - 1);
  classify(); renderAll();
}
// 套用一條指令：往上找「上一句台詞 / 標籤 / 選項」之後、顯示行之前的那一段（只會有指令、空行、註解），
// 裡面有同類的指令就取代，沒有就插在顯示行前面
function upsertCmd(text, matcher) {
  const j = displayIndex(sel);
  let b = j;
  while (b > 0 && (kinds[b - 1] === 'cmd' || kinds[b - 1] === 'blank' || kinds[b - 1] === 'comment')) b--;
  for (let k = b; k < j; k++) {
    if (matcher(parseCmd(lines[k]))) { lines[k] = text; return; }
  }
  lines.splice(j, 0, text);
  sel = j + 1;     // 顯示行往後挪了一格，選取跟著走
}
const apply = (text, matcher) => mutate(() => upsertCmd(text, matcher));

const setBg = n => apply(`@bg ${n}`, c => c.name === 'bg');
const setCg = n => apply(`@cg ${n}`, c => c.name === 'cg');
const setPic = (n, pos) => apply(`@pic ${n}${pos && pos !== 'center' ? ' ' + pos : ''}`, c => c.name === 'pic');
const setBgm = n => apply(`@bgm ${n}`, c => c.name === 'bgm');
const addSe = n => mutate(() => { const j = displayIndex(sel); lines.splice(j, 0, `@se ${n}`); sel = j + 1; });
function showSprite(char, expr, pos) {
  apply(`@show ${char} ${expr} ${pos}`, c =>
    (c.name === 'show' && ((c.args[2] || 'center') === pos || c.args[0] === char)) || (c.name === 'hide' && c.args[0] === pos));
}
// 全部消失：先把這一段裡舊的 @show / @hide 清掉（不然排在後面的 @show 會讓立繪又出現），再寫一行 @hide all
function hideAll() {
  mutate(() => {
    let j = displayIndex(sel), b = j;
    while (b > 0 && (kinds[b - 1] === 'cmd' || kinds[b - 1] === 'blank' || kinds[b - 1] === 'comment')) b--;
    for (let k = j - 1; k >= b; k--) {
      const c = parseCmd(lines[k]);
      if (kinds[k] === 'cmd' && (c.name === 'show' || c.name === 'hide')) { lines.splice(k, 1); j--; }
    }
    lines.splice(j, 0, '@hide all');
    sel = j + 1;
  });
}
// 讓某個位置的立繪消失：在這一句前面「加」一行 @hide（不能取代前面的 @show，否則更早之前的 @show 會冒出來）
function hideSprite(pos) {
  mutate(() => {
    let j = displayIndex(sel), b = j;
    while (b > 0 && (kinds[b - 1] === 'cmd' || kinds[b - 1] === 'blank' || kinds[b - 1] === 'comment')) b--;
    for (let k = j - 1; k >= b; k--) {
      const c = parseCmd(lines[k]);
      if (kinds[k] === 'cmd' && c.name === 'hide' && c.args[0] === pos) { lines.splice(k, 1); j--; }   // 去掉重複的
    }
    lines.splice(j, 0, `@hide ${pos}`);
    sel = j + 1;
  });
}
function deleteLine(i) { mutate(() => { lines.splice(i, 1); if (sel > i) sel--; sel = Math.max(0, Math.min(sel, lines.length - 1)); }); }

// ---------- 畫面 ----------
function curPos() { return (document.querySelector('input[name=pos]:checked') || {}).value || 'center'; }
const isDirty = () => joinText() !== savedText;
const joinText = () => lines.join('\n') + (trailingNL ? '\n' : '');

function renderAll() {
  renderLines(); renderChips(); renderAssets(); sendPreview(); updateDirty();
}
function updateDirty() {
  $('#btn-save').classList.toggle('dirty', isDirty());
  $('#btn-save').textContent = isDirty() ? '儲存（有未存的修改）' : '儲存';
  $('#btn-undo').disabled = !undoStack.length;
}

// ---------- 編輯台詞文字 ----------
function startEdit(i) {
  if (i == null || i < 0 || i >= lines.length || kinds[i] === 'blank') return;
  editIdx = i; editNew = false; sel = i; renderAll();
}
function cancelEdit() {
  if (editIdx == null) return;
  const wasNew = editNew;
  editIdx = null; editNew = false;
  if (wasNew) undo(); else renderAll();     // 新增到一半取消 → 整個還原
}
function commitEdit(i, text) {
  text = text.replace(/[\r\n]+/g, ' ');
  const wasNew = editNew;
  editIdx = null; editNew = false;
  if (wasNew && !text.replace(/^[^：:]{1,12}[：:]/, '').trim()) { undo(); return; }   // 新增但沒填字 → 當作取消
  if (text === lines[i]) { classify(); renderAll(); return; }
  if (wasNew) { lines[i] = text; classify(); renderAll(); }                         // 新增的行：復原一次就整個消失
  else mutate(() => { lines[i] = text; });
}
function editorFor(i) {
  const k = kinds[i], wrap = document.createElement('div'); wrap.className = 'ed';
  const inp = document.createElement('input'); inp.type = 'text';
  let sp = null, cnt = null;
  const compose = () => (sp && sp.value ? `${sp.value}：${inp.value}` : inp.value);
  if (k === 'say' || (k === 'blank' && editNew)) {
    const s = sayInfo(lines[i] || '');
    sp = document.createElement('select');
    const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '旁白'; sp.appendChild(o0);
    Object.keys(chars).forEach(key => { const o = document.createElement('option'); o.value = key; o.textContent = chars[key].name; sp.appendChild(o); });
    sp.value = s.who || '';
    inp.value = s.text; inp.placeholder = '台詞（一行最多約 50 字）';
    cnt = document.createElement('span'); cnt.className = 'cnt';
    const upd = () => { const n = inp.value.length; cnt.textContent = n + ' 字'; cnt.classList.toggle('over', n > 50); cnt.title = n > 50 ? '超過約 50 字，對話框可能放不下，建議拆成兩句' : ''; };
    inp.oninput = upd; upd();
    wrap.append(sp, inp, cnt);
  } else {
    inp.value = lines[i]; inp.placeholder = '指令或文字';
    wrap.append(inp);
  }
  const ok = document.createElement('button'); ok.textContent = '確定'; ok.onclick = () => commitEdit(i, compose());
  const no = document.createElement('button'); no.textContent = '取消'; no.onclick = cancelEdit;
  wrap.append(ok, no);
  inp.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(i, compose()); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  };
  return wrap;
}
// 在選取的那一行後面新增一句台詞（預設沿用目前這句的說話者）
function addSay() {
  if (editIdx != null) return;
  const j = displayIndex(sel);
  const cur = j < lines.length && kinds[j] === 'say' ? sayInfo(lines[j]) : { who: null };
  const at = Math.min(lines.length, sel + 1);
  undoStack.push({ lines: lines.slice(), sel });
  lines.splice(at, 0, cur.who ? `${cur.who}：` : '');
  classify(); sel = at; editIdx = at; editNew = true; renderAll();
}
function deleteSelected() {
  if (editIdx != null || !lines.length) return;
  mutate(() => { lines.splice(sel, 1); sel = Math.max(0, Math.min(sel, lines.length - 1)); });
}
function moveSelected(d) {
  if (editIdx != null) return;
  const to = sel + d;
  if (to < 0 || to >= lines.length) return;
  mutate(() => { [lines[sel], lines[to]] = [lines[to], lines[sel]]; sel = to; });
}

function renderLines() {
  const box = $('#lines'), keepTop = box.scrollTop;
  box.textContent = '';
  const j = displayIndex(sel);
  lines.forEach((l, i) => {
    const k = kinds[i];
    const row = document.createElement('div');
    row.className = 'ln ' + (k === 'choiceStart' || k === 'choiceEnd' || k === 'opt' ? 'choice' : k) + (i === sel ? ' sel' : '') + (i === j ? ' disp' : '');
    if (k === 'blank' && i !== editIdx) { box.appendChild(row); row.onclick = () => { sel = i; renderAll(); }; return; }
    const no = document.createElement('span'); no.className = 'no'; no.textContent = i + 1;
    if (i === editIdx) { row.className += ' editing'; row.append(no, editorFor(i)); box.appendChild(row); return; }
    const body = document.createElement('span'); body.className = 'body';
    if (k === 'say') {
      const s = sayInfo(l);
      if (s.who) { const n = document.createElement('span'); n.className = 'nm'; n.textContent = chars[s.who].name; body.appendChild(n); }
      body.appendChild(document.createTextNode(s.text));
    } else body.textContent = l.trim();
    row.append(no, body);
    if (k === 'cmd') {
      const d = document.createElement('button'); d.className = 'del'; d.textContent = '✕'; d.title = '刪除這行指令';
      d.onclick = e => { e.stopPropagation(); deleteLine(i); };
      row.appendChild(d);
    }
    row.onclick = () => { sel = i; renderAll(); };
    row.ondblclick = () => startEdit(i);
    box.appendChild(row);
  });
  box.scrollTop = keepTop;
  const el = box.querySelector('.ln.editing') || box.querySelector('.ln.sel') || box.querySelector('.ln.disp');
  if (el) el.scrollIntoView({ block: 'nearest' });
  const inp = box.querySelector('.ln.editing input[type=text]');
  if (inp && document.activeElement !== inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

function chip(label, value, actions) {
  const c = document.createElement('span'); c.className = 'chip' + (value ? '' : ' empty');
  const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
  c.append(k, document.createTextNode(value || '（無）'));
  (value ? actions || [] : []).forEach(([t, title, fn]) => { const b = document.createElement('button'); b.textContent = t; b.title = title; b.onclick = fn; c.appendChild(b); });
  return c;
}
function renderChips() {
  const j = displayIndex(sel), V = stateAt(j), box = $('#chips');
  box.textContent = '';
  $('#pv-line').textContent = j < lines.length ? `（第 ${j + 1} 行）` : '（已到檔案結尾，沒有台詞）';
  box.appendChild(chip('背景', V.bg));
  box.appendChild(chip('CG', V.cg, [['✕', '收起 CG', () => apply('@cg off', c => c.name === 'cg')]]));
  box.appendChild(chip('直式插圖', V.pic && `${V.pic.name}（${POS_NAME[V.pic.pos] || V.pic.pos}）`, [['✕', '收起插圖', () => apply('@pic off', c => c.name === 'pic')]]));
  box.appendChild(chip('音樂', V.bgm, [['✕', '停止音樂', () => apply('@bgm off', c => c.name === 'bgm')]]));
  for (const p of POS) {
    const sp = V.spr[p];
    const idx = POS.indexOf(p);
    const acts = sp ? [
      ...(idx > 0 ? [['◀', '往左移', () => showSprite(sp.c, sp.e, POS[idx - 1])]] : []),
      ...(idx < 2 ? [['▶', '往右移', () => showSprite(sp.c, sp.e, POS[idx + 1])]] : []),
      ['✕', '移除這個立繪', () => hideSprite(p)]] : [];
    box.appendChild(chip('立繪·' + POS_NAME[p], sp && `${(chars[sp.c] || {}).name || sp.c}／${sp.e}`, acts));
  }
}

// ---------- 預覽 ----------
function fitPreview() {
  const wrap = $('#pv-wrap'), k = wrap.clientWidth / 1216;
  $('#pv').style.transform = `scale(${k})`;
  wrap.style.height = Math.round(832 * k) + 'px';
}
function sendPreview() {
  if (!pvReady) return;
  const j = displayIndex(sel), V = stateAt(j), msg = { type: 'render', V };
  if (j < lines.length && kinds[j] === 'choiceStart') {
    msg.choice = [];
    for (let k = j + 1; k < lines.length && kinds[k] !== 'choiceEnd'; k++) {
      if (kinds[k] === 'opt') msg.choice.push(lines[k].trim().replace(/^-\s*/, '').replace(/\s*->.*$/, ''));
    }
  } else if (j < lines.length) msg.say = sayInfo(lines[j]);
  $('#pv').contentWindow.postMessage(msg, location.origin);
}
addEventListener('message', e => {
  if (e.origin === location.origin && e.data && e.data.type === 'ready') { pvReady = true; fitPreview(); sendPreview(); }
});
addEventListener('resize', fitPreview);

// ---------- 素材面板 ----------
const TABS = [['bg', '背景'], ['cg', 'CG／插圖'], ['chars', '立繪'], ['bgm', '音樂'], ['se', '音效']];
let player = null, playingName = null;
function stopPlayer() { if (player) { player.pause(); player = null; playingName = null; } }
function previewAudio(dir, name, btn) {
  const same = playingName === dir + name;
  stopPlayer();
  document.querySelectorAll('.row button.play').forEach(b => { b.textContent = '▶'; });
  if (same) return;
  player = new Audio(url(dir, name)); player.volume = 0.6; playingName = dir + name;
  player.play().catch(() => {});
  btn.textContent = '■';
  player.onended = () => { btn.textContent = '▶'; playingName = null; };
}
function imgCard(dir, name, size, buttons, curName, tall) {
  const c = document.createElement('div'); c.className = 'card' + (curName === name ? ' cur' : '');
  const th = document.createElement('div'); th.className = 'th' + (tall ? ' tall' : '');
  th.style.backgroundImage = `url("${url(dir, name)}")`;
  th.title = `${name}（${(size / 1024).toFixed(0)} KB）`;
  th.onclick = buttons[0][1];
  const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = name;
  c.append(th, cap);
  if (buttons.length > 1 || buttons[0][0]) {
    const acts = document.createElement('div'); acts.className = 'acts';
    buttons.forEach(([t, fn]) => { if (!t) return; const b = document.createElement('button'); b.textContent = t; b.onclick = fn; acts.appendChild(b); });
    c.appendChild(acts);
  }
  return c;
}
function renderTabs() {
  const box = $('#tabs'); box.textContent = '';
  TABS.forEach(([k, label]) => {
    const b = document.createElement('button'); b.textContent = label; b.className = tab === k ? 'on' : '';
    b.onclick = () => { tab = k; stopPlayer(); renderTabs(); renderAssets(); };
    box.appendChild(b);
  });
}
function renderAssets() {
  const box = $('#assets'), top = box.scrollTop; box.textContent = '';
  const V = stateAt(displayIndex(sel));
  const isImg = n => /\.(webp|png|jpe?g|svg|gif)$/i.test(n);
  if (tab === 'bg' || tab === 'cg') {
    const list = (assets[tab] || []).filter(a => isImg(a.name));
    if (!list.length) { box.innerHTML = '<div class="empty">這個資料夾還沒有圖片</div>'; return; }
    const g = document.createElement('div'); g.className = 'grid';
    list.forEach(a => {
      if (tab === 'bg') g.appendChild(imgCard('bg', a.name, a.size, [['', () => setBg(a.name)]], V.bg));
      else g.appendChild(imgCard('cg', a.name, a.size, [['', () => setCg(a.name)], ['當 CG', () => setCg(a.name)], ['直式插圖', () => setPic(a.name, 'center')]], V.cg || (V.pic && V.pic.name)));
    });
    box.appendChild(g);
  } else if (tab === 'chars') {
    // 讓立繪消失：左 / 中 / 右各一顆，加上「全部」。這一句畫面上沒有立繪的位置，按鈕會變灰
    const bar = document.createElement('div'); bar.className = 'row';
    const lb = document.createElement('span'); lb.className = 'nm'; lb.textContent = '讓立繪消失（寫入 @hide）';
    bar.appendChild(lb);
    POS.forEach(p => {
      const b = document.createElement('button'); b.textContent = POS_NAME[p]; b.disabled = !V.spr[p];
      b.title = V.spr[p] ? `讓${POS_NAME[p]}邊的立繪消失` : `${POS_NAME[p]}邊目前沒有立繪`; b.onclick = () => hideSprite(p);
      bar.appendChild(b);
    });
    const all = document.createElement('button'); all.textContent = '全部'; all.disabled = !POS.some(p => V.spr[p]);
    all.title = '讓所有立繪消失（@hide all）'; all.onclick = hideAll;
    bar.appendChild(all); box.appendChild(bar);
    const keys = Object.keys(chars);
    let any = false;
    keys.forEach(key => {
      const sp = chars[key].sprites || {}, names = Object.keys(sp);
      if (!names.length) return;
      any = true;
      const t = document.createElement('div'); t.className = 'group-title'; t.textContent = `${chars[key].name}（${key}）`;
      const g = document.createElement('div'); g.className = 'grid';
      names.forEach(e => {
        const size = ((assets.chars || []).find(a => a.name === sp[e]) || {}).size || 0;
        const cur = POS.some(p => V.spr[p] && V.spr[p].c === key && V.spr[p].e === e) ? sp[e] : null;
        const c = imgCard('chars', sp[e], size, [['', () => showSprite(key, e, curPos())], [`放${POS_NAME[curPos()]}`, () => showSprite(key, e, curPos())]], cur, true);
        c.querySelector('.cap').textContent = `${e}（${sp[e]}）`;
        g.appendChild(c);
      });
      box.append(t, g);
    });
    // 放在 assets/chars 但還沒登記到 chars.json 的圖片：在這裡直接登記
    const used = new Set();
    keys.forEach(k => Object.values(chars[k].sprites || {}).forEach(f => used.add(f)));
    const loose = (assets.chars || []).filter(a => isImg(a.name) && !used.has(a.name));
    if (loose.length) {
      const t = document.createElement('div'); t.className = 'group-title'; t.textContent = '尚未登記的立繪檔案（選角色、取表情名稱後按「登記」）';
      const g = document.createElement('div'); g.className = 'grid';
      loose.forEach(a => g.appendChild(looseCard(a, keys)));
      box.append(t, g);
    } else if (!any) box.innerHTML = '<div class="empty">assets/chars 裡還沒有立繪圖片。<br>把 PNG 放進去，這裡就會出現，可以直接登記。</div>';
    box.appendChild(newCharForm());
  } else {
    const dir = tab, list = assets[dir] || [];
    box.appendChild(importBar(dir));
    if (dir === 'bgm') {
      const off = document.createElement('div'); off.className = 'row';
      off.innerHTML = '<span class="nm">停止音樂（@bgm off）</span>';
      const b = document.createElement('button'); b.textContent = '套用'; b.onclick = () => apply('@bgm off', c => c.name === 'bgm');
      off.appendChild(b); box.appendChild(off);
    }
    if (!list.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = '這個資料夾還沒有檔案'; box.appendChild(d); }
    list.forEach(a => {
      const r = document.createElement('div'); r.className = 'row' + (dir === 'bgm' && V.bgm === a.name ? ' cur' : '');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = `${a.name}（${(a.size / 1024 / 1024).toFixed(2)} MB）`;
      const p = document.createElement('button'); p.className = 'play'; p.textContent = '▶'; p.title = '試聽'; p.onclick = () => previewAudio(dir, a.name, p);
      const ap = document.createElement('button'); ap.textContent = '套用'; ap.onclick = () => (dir === 'bgm' ? setBgm(a.name) : addSe(a.name));
      r.append(nm, p, ap); box.appendChild(r);
    });
  }
  box.scrollTop = top;
}

function reloadPreview() { pvReady = false; $('#pv').src = '/index.html?editor=1&t=' + Date.now(); }   // 預覽要重新載入才讀得到新的 chars.json

// 新增角色：id、名稱、名字顏色
function newCharForm() {
  const box = document.createElement('div');
  const t = document.createElement('div'); t.className = 'group-title'; t.textContent = '＋新增角色';
  const r = document.createElement('div'); r.className = 'form-row';
  const id = document.createElement('input'); id.type = 'text'; id.placeholder = '角色 id（英文）'; id.title = '劇情與設定檔用的代號，只能英文字母、數字、底線，例如 mika';
  const nm = document.createElement('input'); nm.type = 'text'; nm.placeholder = '顯示名稱'; nm.maxLength = 12; nm.title = '對話框上顯示的名字（最多 12 字、不可含冒號）';
  const col = document.createElement('input'); col.type = 'color'; col.value = '#ffd6a5'; col.title = '名字的顏色';
  const b = document.createElement('button'); b.textContent = '新增';
  b.onclick = async () => {
    try {
      await api('/api/chars/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id.value.trim(), name: nm.value, color: col.value }) });
      chars = await api('/chars.json'); reloadPreview();
      status(`已新增角色：${nm.value}`, 'ok'); renderAll();
    } catch (e) { status('新增角色失敗：' + e.message, 'err'); alert('新增角色失敗：' + e.message); }
  };
  r.append(id, nm, col, b);
  const hint = document.createElement('div'); hint.className = 'muted'; hint.textContent = '新增後，到上面「尚未登記的立繪檔案」就能替這個角色登記立繪；寫台詞時也能選這個說話者。';
  box.append(t, r, hint);
  return box;
}

// 尚未登記的立繪：選角色 + 表情名稱，寫進 chars.json
function looseCard(a, keys) {
  const c = imgCard('chars', a.name, a.size, [['', () => {}]], null, true);
  const sel = document.createElement('select');
  keys.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = chars[k].name; sel.appendChild(o); });
  const guess = a.name.replace(/\.[^.]+$/, '').replace(/^.*?[_\-]/, '') || 'normal';
  const inp = document.createElement('input'); inp.value = guess; inp.placeholder = '表情名稱'; inp.title = '表情名稱，例如 normal、smile（不可有空格）';
  const btn = document.createElement('button'); btn.textContent = '登記';
  btn.onclick = async () => {
    try {
      await api('/api/chars/sprite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ char: sel.value, expr: inp.value, file: a.name }) });
      chars = await api('/chars.json'); assets = await api('/api/assets');
      reloadPreview();
      status(`已登記：${chars[sel.value].name} / ${inp.value}`, 'ok'); renderAll();
    } catch (e) { status('登記失敗：' + e.message, 'err'); alert('登記失敗：' + e.message); }
  };
  const acts = document.createElement('div'); acts.className = 'acts'; acts.style.flexDirection = 'column';
  acts.append(sel, inp, btn); c.appendChild(acts);
  return c;
}

// ---------- 匯入音訊 ----------
const AUDIO_RE = /\.(mp3|ogg|wav|m4a)$/i;
async function uploadAudio(dir, files) {
  const list = [...files].filter(f => AUDIO_RE.test(f.name));
  if (!list.length) { status('請選擇 mp3 / ogg / wav / m4a 音訊檔', 'err'); alert('請選擇 mp3 / ogg / wav / m4a 音訊檔'); return; }
  let ok = 0; const errs = [];
  for (const f of list) {
    status(`匯入中：${f.name}（${(f.size / 1024 / 1024).toFixed(1)} MB）…`);
    try {
      await api(`/api/upload?dir=${dir}&name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      ok++;
      if (dir === 'bgm' && f.size > 5 * 1024 * 1024) errs.push(`「${f.name}」有 ${(f.size / 1024 / 1024).toFixed(1)} MB，偏大，建議壓成 128kbps 的 MP3，可以加快載入`);
    } catch (e) { errs.push(`「${f.name}」匯入失敗：${e.message}`); }
  }
  assets = await api('/api/assets');
  renderAssets();
  status(`已匯入 ${ok} 個檔案` + (errs.length ? '（有提醒）' : ''), errs.some(m => m.includes('失敗')) ? 'err' : 'ok');
  if (errs.length) alert(errs.join('\n'));
}
function importBar(dir) {
  const bar = document.createElement('div'); bar.className = 'row import';
  const lb = document.createElement('span'); lb.className = 'nm';
  lb.textContent = `匯入新的${dir === 'bgm' ? '音樂' : dir === 'se' ? '音效' : '語音'}（選檔案，或把檔案拖進這一欄）`;
  const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.mp3,.ogg,.wav,.m4a,audio/*'; inp.hidden = true;
  inp.onchange = () => { const fs = [...inp.files]; inp.value = ''; if (fs.length) uploadAudio(dir, fs); };
  const b = document.createElement('button'); b.textContent = '＋匯入'; b.onclick = () => inp.click();
  bar.append(lb, b, inp);
  return bar;
}
(() => {
  const box = $('#assets');
  box.addEventListener('dragover', e => { if (tab === 'bgm' || tab === 'se') { e.preventDefault(); box.classList.add('drop'); } });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', e => {
    box.classList.remove('drop');
    if (tab !== 'bgm' && tab !== 'se') return;
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) uploadAudio(tab, e.dataTransfer.files);
  });
})();

// ---------- 載入 / 儲存 ----------
function status(msg, cls) { const s = $('#status'); s.textContent = msg; s.className = cls || ''; }
async function api(path, opt) {
  const r = await fetch(path, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}
async function openChapter(id) {
  const d = await api('/api/chapter/' + encodeURIComponent(id));
  chapterId = id; editIdx = null; editNew = false;
  const text = d.text.replace(/\r\n/g, '\n');
  trailingNL = text.endsWith('\n');
  lines = (trailingNL ? text.slice(0, -1) : text).split('\n');
  savedText = joinText();
  undoStack.length = 0; classify();
  sel = Math.max(0, lines.findIndex((_, i) => kinds[i] === 'say'));
  status('已載入 ' + id + '.txt');
  renderAll();
}
async function save() {
  if (!chapterId) return;
  try {
    const text = joinText();
    await api('/api/chapter/' + encodeURIComponent(chapterId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    savedText = text; updateDirty();
    status('已儲存 ' + new Date().toLocaleTimeString(), 'ok');
  } catch (e) { status('儲存失敗：' + e.message, 'err'); alert('儲存失敗：' + e.message); }
}

// ---------- 章節：新增 / 管理 ----------
function fillChapterSelect() {
  const s = $('#chapter'); s.textContent = '';
  cfg.chapters.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.id}　${c.title}`; s.appendChild(o); });
  if (chapterId) s.value = chapterId;
}
async function newChapter() {
  if (isDirty() && !confirm('目前的修改還沒有儲存，確定要離開這個章節去新增嗎？（未存的修改會消失）')) return;
  const used = new Set(cfg.chapters.map(c => c.id));
  let n = cfg.chapters.length; while (used.has('ch' + n)) n++;
  const id = prompt('新章節的 id（英文字母開頭，可含數字、底線、連字號，例如 ch3）：', 'ch' + n);
  if (!id) return;
  const title = prompt('新章節的標題：', '第 ' + n + ' 章');
  if (!title) return;
  try {
    await api('/api/chapter/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id.trim(), title }) });
    cfg = await api('/chapters/index.json');
    await openChapter(id.trim());
    fillChapterSelect();
    status(`已建立章節 ${id.trim()}`, 'ok');
  } catch (e) { status('新增章節失敗：' + e.message, 'err'); alert('新增章節失敗：' + e.message); }
}
function openChapterManager() {
  const list = cfg.chapters.map(c => ({ id: c.id, title: c.title }));
  const box = $('#ch-list');
  const draw = () => {
    box.textContent = '';
    list.forEach((c, i) => {
      const r = document.createElement('div'); r.className = 'row';
      const id = document.createElement('span'); id.className = 'id'; id.textContent = c.id;
      const inp = document.createElement('input'); inp.value = c.title; inp.oninput = () => { c.title = inp.value; };
      const up = document.createElement('button'); up.textContent = '↑'; up.disabled = i === 0; up.onclick = () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); };
      const dn = document.createElement('button'); dn.textContent = '↓'; dn.disabled = i === list.length - 1; dn.onclick = () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); };
      r.append(id, inp, up, dn); box.appendChild(r);
    });
  };
  draw();
  $('#ch-save').onclick = async () => {
    try {
      await api('/api/chapters/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chapters: list }) });
      cfg = await api('/chapters/index.json'); fillChapterSelect();
      $('#modal').hidden = true; status('章節順序與標題已儲存', 'ok');
    } catch (e) { alert('儲存失敗：' + e.message); }
  };
  $('#ch-cancel').onclick = () => { $('#modal').hidden = true; };
  $('#modal').hidden = false;
}

// ---------- 事件 ----------
$('#btn-edit').onclick = () => startEdit(sel);
$('#btn-add').onclick = addSay;
$('#btn-del').onclick = deleteSelected;
$('#btn-up').onclick = () => moveSelected(-1);
$('#btn-down').onclick = () => moveSelected(1);
$('#btn-newch').onclick = newChapter;
$('#btn-chs').onclick = openChapterManager;
$('#btn-save').onclick = save;
$('#btn-undo').onclick = undo;
$('#chapter').onchange = async e => {
  if (isDirty() && !confirm('目前的修改還沒有儲存，確定要切換章節嗎？（未存的修改會消失）')) { e.target.value = chapterId; return; }
  try { await openChapter(e.target.value); } catch (err) { status('載入失敗：' + err.message, 'err'); }
};
document.querySelectorAll('input[name=pos]').forEach(r => r.onchange = renderAssets);
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (['SELECT', 'INPUT', 'TEXTAREA'].includes((e.target || {}).tagName)) return;
  if ((e.key === 'Enter' && e.target.tagName !== 'BUTTON') || e.key === 'F2') { e.preventDefault(); startEdit(sel); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const d = e.key === 'ArrowDown' ? 1 : -1;
    let i = sel + d;
    while (i >= 0 && i < lines.length && kinds[i] === 'blank') i += d;
    if (i >= 0 && i < lines.length) { sel = i; renderAll(); }
  }
});
addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  try {
    cfg = await api('/chapters/index.json');
    chars = await api('/chars.json');
    assets = await api('/api/assets');
  } catch (e) { status('初始化失敗：' + e.message + '（請用「啟動編輯器.bat」開啟）', 'err'); return; }
  fillChapterSelect();
  $('#pv').src = '/index.html?editor=1';
  renderTabs();
  try { await openChapter(cfg.chapters[0].id); } catch (e) { status('載入失敗：' + e.message, 'err'); }
  fitPreview();
})();
})();
