// 最小可玩版視覺小說引擎：章節按需載入、選項分支、立繪 / CG / BGM、存檔、跳過、歷史
(() => {
'use strict';
const $ = s => document.querySelector(s);
const P = 'gal_';
const LS = {
  get(k, d) { try { const v = localStorage.getItem(P + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(P + k); } catch (e) {} }
};
const clone = o => JSON.parse(JSON.stringify(o));
const DIR = { bg: 'assets/bg/', cg: 'assets/cg/', chars: 'assets/chars/', bgm: 'assets/bgm/', se: 'assets/se/' };
const SLOTS = 6;
const POS = ['left', 'center', 'right'];

let cfg, chars;
const cache = {};            // 章節 id -> {ops, labels}
let cur = null;              // 目前章節
let S = null;                // 遊戲狀態 {chapter, idx, flags, V, history}
let lastBlock = null;        // 最近一次停下來等玩家時的快照（存檔用）
let waiting = null;          // 'say' | 'choice' | 'banner' | null
let busy = false;
let typing = null;
let skipMode = false, holding = false, suppressClick = false;
let bannerCb = null;
let read = LS.get('read', {});
let muted = LS.get('mute', false);

const blankV = () => ({ bg: null, cg: null, bgm: null, spr: { left: null, center: null, right: null } });

// ---------- 載入與解析 ----------
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }

async function loadChapter(id) {
  if (cache[id]) return cache[id];
  const r = await fetch(`chapters/${id}.txt`);
  if (!r.ok) throw new Error('找不到章節 ' + id);
  cache[id] = parse(await r.text());
  return cache[id];
}

function parse(text) {
  const ops = [], labels = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line[0] === '*') { labels[line.slice(1).trim()] = ops.length; continue; }
    if (line[0] === '@') {
      const m = line.match(/^@(\w+)\s*(.*)$/);
      if (!m) continue;
      const cmd = m[1], arg = m[2].trim();
      if (cmd === 'choice') {
        const opts = [];
        while (++i < lines.length) {
          const l = lines[i].trim();
          if (l.startsWith('@endchoice')) break;
          const o = l.match(/^-\s*(.+?)\s*->\s*(\S+)$/);
          if (o) opts.push({ text: o[1], target: o[2] });
        }
        ops.push({ t: 'choice', opts });
      } else ops.push({ t: cmd, arg });
      continue;
    }
    const d = line.match(/^([^：:]{1,12})[：:]\s*(.*)$/);
    if (d) {
      const key = Object.keys(chars).find(k => k === d[1] || chars[k].name === d[1]);
      if (key) { ops.push({ t: 'say', who: key, text: d[2] }); continue; }
    }
    ops.push({ t: 'say', who: null, text: line });
  }
  return { ops, labels };
}

function assetsOf(ch) {
  const list = [];
  for (const op of ch.ops) {
    const a = (op.arg || '').split(/\s+/);
    if (op.t === 'bg' && a[0]) list.push(DIR.bg + a[0]);
    else if (op.t === 'cg' && a[0] && a[0] !== 'off') list.push(DIR.cg + a[0]);
    else if (op.t === 'bgm' && a[0] && a[0] !== 'off') list.push(DIR.bgm + a[0]);
    else if (op.t === 'se' && a[0]) list.push(DIR.se + a[0]);
    else if (op.t === 'show' && chars[a[0]] && chars[a[0]].sprites[a[1]]) list.push(DIR.chars + chars[a[0]].sprites[a[1]]);
  }
  return [...new Set(list)];
}
const preloaded = new Set();
async function preload(id) {
  if (!id || preloaded.has(id)) return;
  preloaded.add(id);
  try {
    const ch = await loadChapter(id);
    assetsOf(ch).forEach(u => fetch(u).catch(() => {}));
  } catch (e) {}
}
const chapterIds = () => cfg.chapters.map(c => c.id);
const nextChapterId = id => chapterIds()[chapterIds().indexOf(id) + 1] || null;
const chapterTitle = id => (cfg.chapters.find(c => c.id === id) || {}).title || id;

// ---------- 視覺 ----------
const el = { bg: $('#bg'), cg: $('#cg'), name: $('#name'), text: $('#text'), box: $('#textbox'), mark: $('#next-mark'),
  menubar: $('#menubar'), choices: $('#choices'), banner: $('#banner'), ctitle: $('#chapter-title'),
  title: $('#title-screen'), panel: $('#panel'), pbody: $('#panel-body'), ptitle: $('#panel-title'),
  spr: { left: $('#spr-left'), center: $('#spr-center'), right: $('#spr-right') } };

function setBg(n) { S.V.bg = n; el.bg.style.backgroundImage = n ? `url(${DIR.bg + n})` : ''; }
function setCg(n) {
  S.V.cg = n;
  if (n) { el.cg.style.backgroundImage = `url(${DIR.cg + n})`; el.cg.style.opacity = 1; }
  else el.cg.style.opacity = 0;
}
function setSpr(pos, c, e) {
  S.V.spr[pos] = c ? { c, e } : null;
  const img = el.spr[pos];
  if (c && chars[c] && chars[c].sprites[e]) { img.src = DIR.chars + chars[c].sprites[e]; img.style.opacity = 1; }
  else img.style.opacity = 0;
}
function applyV(V) {
  setBg(V.bg); setCg(V.cg);
  for (const p of POS) setSpr(p, V.spr[p] && V.spr[p].c, V.spr[p] && V.spr[p].e);
  setBgm(V.bgm);
}

// ---------- 音訊 ----------
const bgmEl = new Audio(); bgmEl.loop = true;
let fadeT = null;
const targetVol = () => (muted ? 0 : 0.6);
function setBgm(n) {
  if (S) S.V.bgm = n;
  const src = n ? new URL(DIR.bgm + n, location.href).href : null;
  if (n && bgmEl.src === src && !bgmEl.paused) { bgmEl.volume = targetVol(); return; }
  clearInterval(fadeT);
  const start = () => {
    if (!n) { bgmEl.pause(); return; }
    bgmEl.src = src; bgmEl.volume = 0;
    const p = bgmEl.play(); if (p) p.catch(() => {});
    fadeT = setInterval(() => {
      bgmEl.volume = Math.min(targetVol(), bgmEl.volume + 0.05);
      if (bgmEl.volume >= targetVol()) clearInterval(fadeT);
    }, 60);
  };
  if (bgmEl.paused || !bgmEl.src) { start(); return; }
  fadeT = setInterval(() => {
    bgmEl.volume = Math.max(0, bgmEl.volume - 0.1);
    if (bgmEl.volume <= 0) { clearInterval(fadeT); start(); }
  }, 40);
}
function playSe(n) { const a = new Audio(DIR.se + n); a.volume = muted ? 0 : 0.8; a.play().catch(() => {}); }
function setMute(m) {
  muted = m; LS.set('mute', m);
  bgmEl.volume = targetVol();
  $('#btn-mute').textContent = '音樂 ' + (m ? '關' : '開');
}

// ---------- 執行流程 ----------
function run() {
  while (true) {
    const op = cur.ops[S.idx];
    if (!op) { chapterEnd(); return; }
    S.idx++;
    if (exec(op)) return;
  }
}

function snapshot() { lastBlock = { idx: S.idx - 1, V: clone(S.V), flags: clone(S.flags) }; autosave(); }

// 回傳 true 表示流程在此暫停（等玩家或非同步動作自行呼叫 run）
function exec(op) {
  const a = (op.arg || '').split(/\s+/);
  switch (op.t) {
    case 'say': showSay(op); return true;
    case 'choice': showChoice(op); return true;
    case 'title': showTitleCard(op.arg); return true;
    case 'bg': setBg(a[0]); break;
    case 'cg': setCg(a[0] === 'off' ? null : a[0]); break;
    case 'bgm': setBgm(a[0] === 'off' ? null : a[0]); break;
    case 'se': playSe(a[0]); break;
    case 'show': {
      const pos = a[2] || 'center';
      for (const p of POS) if (p !== pos && S.V.spr[p] && S.V.spr[p].c === a[0]) setSpr(p, null);
      setSpr(pos, a[0], a[1]); break;
    }
    case 'hide':
      for (const p of POS)
        if (p === a[0] || (S.V.spr[p] && S.V.spr[p].c === a[0])) setSpr(p, null);
      break;
    case 'set': {
      const m = op.arg.match(/^(\w+)\s*(\+=|-=|=)\s*(.+)$/);
      if (m) {
        const v = /^-?\d+(\.\d+)?$/.test(m[3]) ? Number(m[3]) : m[3];
        if (m[2] === '=') S.flags[m[1]] = v;
        else S.flags[m[1]] = (S.flags[m[1]] || 0) + (m[2] === '+=' ? v : -v);
      }
      break;
    }
    case 'if': {
      const m = op.arg.match(/^(\w+)\s*(==|!=|>=|<=|>|<)\s*(\S+)\s*->\s*(\S+)$/);
      if (m) {
        const l = S.flags[m[1]] === undefined ? 0 : S.flags[m[1]];
        const r = /^-?\d+(\.\d+)?$/.test(m[3]) ? Number(m[3]) : m[3];
        const ok = { '==': l == r, '!=': l != r, '>=': l >= r, '<=': l <= r, '>': l > r, '<': l < r }[m[2]];
        if (ok) return goto(m[4]);
      }
      break;
    }
    case 'jump': return goto(a[0]);
    case 'chapter': enterChapter(a[0], a[1]); return true;
    case 'ending': {
      const list = LS.get('endings', []);
      if (!list.includes(op.arg)) { list.push(op.arg); LS.set('endings', list); }
      showBanner(`結局：${op.arg}`, '點擊繼續', () => run());
      return true;
    }
    case 'end': showBanner('— 完 —', '感謝遊玩', toTitle); return true;
  }
  return false;
}

// 同章節內跳轉回傳 false（讓 run 繼續）；跨章節回傳 true（非同步載入後自行 run）
function goto(target) {
  if (target.includes('/')) { const [c, l] = target.split('/'); enterChapter(c, l); return true; }
  if (target in cur.labels) { S.idx = cur.labels[target]; return false; }
  console.warn('找不到標籤', target);
  return false;
}

async function enterChapter(id, label) {
  busy = true;
  try {
    cur = await loadChapter(id);
    S.chapter = id; S.idx = label && label in cur.labels ? cur.labels[label] : 0;
    const un = LS.get('unlocked', []);
    if (!un.includes(id)) { un.push(id); LS.set('unlocked', un); }
    preload(nextChapterId(id));
  } catch (e) { busy = false; alert('載入章節失敗：' + e.message + '\n請用本機伺服器開啟（見 start.bat）。'); return; }
  busy = false;
  run();
}

function chapterEnd() {
  const n = nextChapterId(S.chapter);
  if (n) enterChapter(n);
  else showBanner('未完待續', '敬請期待下一章', toTitle);
}

// ---------- 文字與選項 ----------
function showSay(op) {
  el.choices.style.display = 'none';
  el.box.style.display = 'block';
  const c = op.who ? chars[op.who] : null;
  el.name.style.display = c ? 'block' : 'none';
  if (c) { el.name.textContent = c.name; el.name.style.color = c.color || '#fff'; }
  const key = S.chapter + ':' + (S.idx - 1);
  const last = S.history[S.history.length - 1];
  if (!(last && last.key === key)) {
    S.history.push({ key, name: c ? c.name : '', text: op.text });
    if (S.history.length > 80) S.history.shift();
  }
  const wasRead = !!read[key];
  if (!wasRead) { read[key] = 1; LS.set('read', read); }
  waiting = 'say';
  snapshot();
  if (typing) clearInterval(typing.timer);
  el.mark.style.display = 'none';
  if (holding || (skipMode && wasRead)) {
    el.text.textContent = op.text; typing = null; el.mark.style.display = 'block'; return;
  }
  let i = 0;
  el.text.textContent = '';
  typing = { full: op.text, timer: setInterval(() => {
    el.text.textContent = op.text.slice(0, ++i);
    if (i >= op.text.length) finishTyping();
  }, 30) };
}
function finishTyping() {
  if (!typing) return;
  clearInterval(typing.timer);
  el.text.textContent = typing.full; typing = null; el.mark.style.display = 'block';
}

function showChoice(op) {
  waiting = 'choice';
  snapshot();
  skipMode = false; syncSkipBtn();
  el.choices.innerHTML = '';
  op.opts.forEach(o => {
    const b = document.createElement('button');
    b.textContent = o.text;
    b.onclick = e => {
      e.stopPropagation();
      el.choices.style.display = 'none';
      S.history.push({ key: '', name: '選擇', text: o.text });
      waiting = null;
      if (!goto(o.target)) run();
    };
    el.choices.appendChild(b);
  });
  el.choices.style.display = 'flex';
}

function showTitleCard(text) {
  busy = true; waiting = null;
  el.box.style.display = 'none';
  el.ctitle.textContent = text; el.ctitle.style.display = 'flex';
  requestAnimationFrame(() => { el.ctitle.style.opacity = 1; });
  const quick = holding || skipMode;
  setTimeout(() => {
    el.ctitle.style.opacity = 0;
    setTimeout(() => { el.ctitle.style.display = 'none'; busy = false; run(); }, quick ? 50 : 600);
  }, quick ? 150 : 1800);
}

function showBanner(big, small, cb) {
  waiting = 'banner'; bannerCb = cb; skipMode = false; syncSkipBtn();
  el.banner.innerHTML = `<div>${big}</div><small>${small}</small>`;
  el.banner.style.display = 'flex';
}
el.banner.onclick = () => {
  if (waiting !== 'banner') return;
  el.banner.style.display = 'none'; waiting = null;
  const cb = bannerCb; bannerCb = null; if (cb) cb();
};

function advance() {
  if (busy || !S) return;
  if (waiting === 'say') {
    if (typing) finishTyping();
    else { waiting = null; run(); }
  }
}

// ---------- 輸入：點擊 / 長按快進 / 鍵盤 ----------
const stage = $('#stage');
const ignoreSel = 'button,#panel,#title-screen,#choices,#banner';
let pressT = null;
stage.addEventListener('pointerdown', e => {
  if (e.target.closest(ignoreSel)) return;
  pressT = setTimeout(() => { holding = true; suppressClick = true; }, 450);
});
const release = () => {
  clearTimeout(pressT);
  if (holding) { holding = false; setTimeout(() => { suppressClick = false; }, 50); }
};
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => stage.addEventListener(ev, release));
stage.addEventListener('click', e => {
  if (e.target.closest(ignoreSel) || suppressClick) return;
  advance();
});
document.addEventListener('keydown', e => {
  if (!el.panel.classList.contains('hidden') || !el.title.classList.contains('hidden')) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance(); }
  if (e.key === 'Control') holding = true;
});
document.addEventListener('keyup', e => { if (e.key === 'Control') holding = false; });

// 快進計時器：長按 / Ctrl 全部快進；「跳過」鈕只跳已讀
setInterval(() => {
  if (waiting !== 'say' || busy) return;
  if (holding) { advance(); return; }
  if (skipMode) {
    if (typing) { finishTyping(); return; }
    const nextOp = cur.ops[S.idx];
    if (nextOp && nextOp.t === 'say' && !read[S.chapter + ':' + S.idx]) { skipMode = false; syncSkipBtn(); return; }
    advance();
  }
}, 60);
function syncSkipBtn() { $('#btn-skip').classList.toggle('on', skipMode); }

// ---------- 存檔 ----------
function packSave() {
  const line = S.history[S.history.length - 1];
  return { chapter: S.chapter, idx: lastBlock.idx, flags: lastBlock.flags, V: lastBlock.V,
    history: S.history, time: Date.now(),
    label: chapterTitle(S.chapter), preview: line ? line.text.slice(0, 24) : '' };
}
function autosave() { if (lastBlock) LS.set('save_auto', packSave()); }
function saveTo(slot) { if (lastBlock) LS.set('save_' + slot, packSave()); }
async function loadSave(slot) {
  const d = LS.get('save_' + slot, null);
  if (!d) return;
  busy = true;
  try { cur = await loadChapter(d.chapter); } catch (e) { busy = false; alert('載入失敗：' + e.message); return; }
  busy = false;
  S = { chapter: d.chapter, idx: d.idx, flags: clone(d.flags), V: blankV(), history: clone(d.history || []) };
  closePanel(); startPlay();
  applyV(clone(d.V));
  preload(nextChapterId(d.chapter));
  run();
}

// ---------- 畫面切換 ----------
function startPlay() {
  el.title.classList.add('hidden');
  el.menubar.style.display = 'flex';
  el.box.style.display = 'none'; el.choices.style.display = 'none';
  waiting = null; skipMode = false; syncSkipBtn();
}
function toTitle() {
  waiting = null; skipMode = false; syncSkipBtn(); closePanel();
  el.menubar.style.display = 'none'; el.box.style.display = 'none';
  el.choices.style.display = 'none'; el.banner.style.display = 'none';
  if (typing) clearInterval(typing.timer);
  typing = null;
  setBgm(null);
  el.title.classList.remove('hidden');
  $('#btn-continue').disabled = !LS.get('save_auto', null);
}
function newGame(chapterId) {
  S = { chapter: chapterId, idx: 0, flags: {}, V: blankV(), history: [] };
  lastBlock = null;
  applyV(S.V); startPlay();
  enterChapter(chapterId);
}

// ---------- 面板 ----------
function openPanel(title, build) {
  el.ptitle.textContent = title; el.pbody.innerHTML = ''; build(el.pbody);
  el.panel.classList.remove('hidden');
}
function closePanel() { el.panel.classList.add('hidden'); }
function fmt(t) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function slotList(body, mode) {
  body.innerHTML = '';
  const keys = mode === 'save' ? [] : ['auto'];
  for (let i = 1; i <= SLOTS; i++) keys.push(i);
  keys.forEach(k => {
    const d = LS.get('save_' + k, null);
    const b = document.createElement('button'); b.className = 'slot';
    b.textContent = (k === 'auto' ? '自動存檔' : '存檔 ' + k) + '　' + (d ? `${d.label}　${fmt(d.time)}　${d.preview}…` : '（空）');
    b.onclick = () => {
      if (mode === 'save') { saveTo(k); slotList(body, mode); }
      else if (d) loadSave(k);
    };
    body.appendChild(b);
  });
}
function panelEmpty(body, msg) { body.innerHTML = `<p class="empty">${msg}</p>`; }

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  switch (b.dataset.act) {
    case 'new': newGame(chapterIds()[0]); break;
    case 'continue': loadSave('auto'); break;
    case 'save': openPanel('存檔', body => slotList(body, 'save')); break;
    case 'load': openPanel('讀檔', body => slotList(body, 'load')); break;
    case 'history': openPanel('歷史', body => {
      if (!S || !S.history.length) return panelEmpty(body, '尚無紀錄');
      S.history.forEach(h => {
        const d = document.createElement('div'); d.className = 'hist-line';
        if (h.name) { const n = document.createElement('b'); n.textContent = h.name; d.appendChild(n); }
        const t = document.createElement('span'); t.textContent = h.text; d.appendChild(t);
        body.appendChild(d);
      });
      body.scrollTop = body.scrollHeight;
    }); break;
    case 'skip': skipMode = !skipMode; syncSkipBtn(); break;
    case 'mute': setMute(!muted); break;
    case 'title': toTitle(); break;
    case 'chapters': openPanel('章節選擇', body => {
      const un = LS.get('unlocked', []);
      cfg.chapters.forEach(c => {
        const btn = document.createElement('button'); btn.className = 'item';
        const ok = un.includes(c.id);
        btn.textContent = ok ? c.title : '？？？（未解鎖）'; btn.disabled = !ok;
        btn.onclick = () => { closePanel(); newGame(c.id); };
        body.appendChild(btn);
      });
    }); break;
    case 'endings': openPanel('結局列表', body => {
      const list = LS.get('endings', []);
      if (!list.length) return panelEmpty(body, '還沒有達成任何結局');
      list.forEach(n => { const d = document.createElement('div'); d.className = 'hist-line'; d.textContent = '✔ ' + n; body.appendChild(d); });
    }); break;
    case 'clear':
      if (confirm('這會刪除所有存檔、已讀與章節解鎖記錄，無法復原。（結局列表會保留）')) {
        ['read', 'unlocked', 'save_auto', ...Array.from({ length: SLOTS }, (_, i) => 'save_' + (i + 1))].forEach(LS.del);
        read = {}; toTitle();
      }
      break;
    case 'closepanel': closePanel(); break;
  }
});

// ---------- 初始化 ----------
function fit() {
  const s = Math.min(innerWidth / 1280, innerHeight / 720);
  stage.style.transform = `translate(-50%,-50%) scale(${s})`;
}
addEventListener('resize', fit); fit();

(async function init() {
  try {
    cfg = await getJSON('chapters/index.json');
    chars = await getJSON('chars.json');
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend',
      '<p style="color:#fff;padding:24px;position:absolute;z-index:99">載入失敗：請不要直接雙擊 index.html，改用 start.bat 開啟本機伺服器。<br>' + e.message + '</p>');
    return;
  }
  document.title = cfg.title;
  $('#game-title').textContent = cfg.title;
  $('#game-subtitle').textContent = cfg.subtitle || '';
  setMute(muted);
  S = { chapter: null, idx: 0, flags: {}, V: blankV(), history: [] };   // 標題畫面階段也要有可用狀態
  toTitle();
  preload(chapterIds()[0]);
})();
})();
