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
const DIR = { bg: 'assets/bg/', cg: 'assets/cg/', chars: 'assets/chars/', bgm: 'assets/bgm/', se: 'assets/se/', voice: 'assets/voice/' };
const SLOTS = 6;
// 場景編輯器（tools/editor）會把遊戲嵌成預覽畫面並傳入要顯示的狀態，這個模式不播放任何聲音
const EDITOR = new URLSearchParams(location.search).has('editor');
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
const vol = Object.assign({ master: 0.8, bgm: 0.75, voice: 1 }, LS.get('vol', {}));

const blankV = () => ({ bg: null, cg: null, pic: null, bgm: null, spr: { left: null, center: null, right: null } });

// ---------- 載入與解析 ----------
async function getJSON(url) { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }

async function loadChapter(id) {
  if (cache[id]) return cache[id];
  const r = await fetch(`chapters/${id}.txt`, { cache: 'no-cache' });
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

function assetOf(op) {
  const a = (op.arg || '').split(/\s+/);
  if (op.t === 'bg' && a[0]) return DIR.bg + a[0];
  if ((op.t === 'cg' || op.t === 'pic') && a[0] && a[0] !== 'off') return DIR.cg + a[0];
  if (op.t === 'bgm' && a[0] && a[0] !== 'off') return DIR.bgm + a[0];
  if (op.t === 'se' && a[0]) return DIR.se + a[0];
  if (op.t === 'voice' && a[0] && a[0] !== 'off') return DIR.voice + a[0];
  if (op.t === 'show' && chars[a[0]] && chars[a[0]].sprites[a[1]]) return DIR.chars + chars[a[0]].sprites[a[1]];
  return null;
}
// 章節用到的素材；from / count 可只取某一段（例如開頭的 30 個指令）
function assetsOf(ch, from = 0, count = Infinity) {
  const list = [];
  for (const op of ch.ops.slice(from, from + count)) { const u = assetOf(op); if (u) list.push(u); }
  return [...new Set(list)];
}
// 存檔 / 場景目前畫面上的素材
function assetsOfV(V) {
  const l = [];
  if (V.bg) l.push(DIR.bg + V.bg);
  if (V.cg) l.push(DIR.cg + V.cg);
  if (V.pic) l.push(DIR.cg + V.pic.name);
  if (V.bgm) l.push(DIR.bgm + V.bgm);
  for (const p of POS) { const sp = V.spr && V.spr[p]; if (sp && chars[sp.c] && chars[sp.c].sprites[sp.e]) l.push(DIR.chars + chars[sp.c].sprites[sp.e]); }
  return l;
}

// ---------- 素材載入（含進度）----------
// 每個檔案只下載一次（結果進瀏覽器快取，之後 <img> / <audio> 直接用）；失敗不會卡住遊戲
const assetJobs = new Map();
function loadAsset(url) {
  let j = assetJobs.get(url);
  if (j) return j;
  j = { loaded: 0, total: 0, done: false };
  j.promise = (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      j.total = Number(r.headers.get('content-length')) || 0;
      if (r.body && r.body.getReader) {
        const rd = r.body.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; j.loaded += value.length; }
      } else await r.arrayBuffer();
    } catch (e) { console.warn('素材載入失敗：', url); }
    j.done = true;
  })();
  assetJobs.set(url, j);
  return j;
}
// 整體進度：已知各檔大小時按「位元組」計算（大檔案佔比較多，進度才平順）；還不知道大小時退回按檔案數
function overallProgress(jobs) {
  if (!jobs.length) return 1;
  const known = jobs.every(j => j.done || j.total);
  if (known) {
    let got = 0, all = 0;
    for (const j of jobs) { const t = Math.max(j.total, j.loaded, 1); all += t; got += j.done ? t : Math.min(j.loaded, t * 0.99); }
    return got / all;
  }
  return jobs.reduce((n, j) => n + (j.done ? 1 : 0), 0) / jobs.length;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const loadingEl = $('#loading');
function showLoading(label) {
  if (!loadingEl) return;
  $('#loading-label').textContent = label || '載入中';
  $('#loading-bar').style.width = '0%'; $('#loading-pct').textContent = '0%';
  loadingEl.style.display = 'flex'; loadingEl.style.opacity = 1;
}
function setLoading(f) {
  if (!loadingEl) return;
  const pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
  $('#loading-bar').style.width = pct + '%'; $('#loading-pct').textContent = pct + '%';
}
async function hideLoading() {
  if (!loadingEl) return;
  loadingEl.style.opacity = 0;
  await sleep(350);
  loadingEl.style.display = 'none';
}
// 等這批素材載完。很快載完就不顯示進度條；超過 250ms 才跳出（immediate 則一開始就顯示）。最多等 25 秒，不會卡死。
async function withLoading(urls, label, immediate) {
  const jobs = [...new Set(urls)].map(loadAsset);
  if (!immediate && jobs.every(j => j.done)) return;
  let shown = !!immediate;
  if (shown) showLoading(label);
  const t = shown ? null : setTimeout(() => { shown = true; showLoading(label); }, 250);
  const tick = setInterval(() => { if (shown) setLoading(overallProgress(jobs)); }, 80);
  await Promise.race([Promise.all(jobs.map(j => j.promise)), sleep(25000)]);
  clearTimeout(t); clearInterval(tick);
  if (shown) { setLoading(1); await sleep(180); if (!immediate) await hideLoading(); }
}

// 背景預載整章素材（不阻擋遊戲）
const preloaded = new Set();
async function preload(id) {
  if (!id || preloaded.has(id)) return;
  preloaded.add(id);
  try { assetsOf(await loadChapter(id)).forEach(loadAsset); } catch (e) {}
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
// 直式插圖：pos = center | left | right，opts 含 'above' 時縮放在對話框上方的區域內
function setPic(name, pos, above) {
  const box = $('#pic'), img = $('#pic-img');
  S.V.pic = name ? { name, pos: pos || 'center', above: !!above } : null;
  if (!name) { box.classList.remove('on'); return; }
  img.src = DIR.cg + name;
  box.className = 'on ' + (pos || 'center') + (above ? ' above' : '');
}
function applyV(V) {
  setBg(V.bg); setCg(V.cg);
  setPic(V.pic && V.pic.name, V.pic && V.pic.pos, V.pic && V.pic.above);
  for (const p of POS) setSpr(p, V.spr[p] && V.spr[p].c, V.spr[p] && V.spr[p].e);
  setBgm(V.bgm);
}

// ---------- 音訊 ----------
// 音量改用 Web Audio 的 GainNode 控制：iOS Safari 會忽略 <audio>.volume，只有 GainNode 才調得動。
// 瀏覽器要求先有使用者操作才能啟動音訊，所以在第一次點擊 / 按鍵時才建立。
const bgmEl = new Audio(); bgmEl.loop = true;
const voiceEl = new Audio();
let fadeT = null;
let actx = null, bgmGain = null, voiceGain = null, seGain = null;
const targetVol = () => (muted ? 0 : vol.master * vol.bgm);
const voiceVol = () => (muted ? 0 : vol.master * vol.voice);
const seVol = () => (muted ? 0 : vol.master * 0.9);

function initAudio() {
  if (actx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    actx = new AC();
    const mk = el => { const g = actx.createGain(); actx.createMediaElementSource(el).connect(g); g.connect(actx.destination); return g; };
    bgmGain = mk(bgmEl); voiceGain = mk(voiceEl);
    seGain = actx.createGain(); seGain.connect(actx.destination);
    bgmEl.volume = voiceEl.volume = 1;
    bgmGain.gain.value = bgmEl._lvl || 0;
    applyVolumes();
  } catch (e) { actx = null; bgmGain = voiceGain = seGain = null; }
}
function resumeAudio() {
  initAudio();
  if (actx && actx.state === 'suspended') actx.resume();
  // 瀏覽器擋掉自動播放時（例如一進網頁的標題音樂），第一次操作後補播
  if (wantBgm && bgmEl.paused) setBgm(wantBgm);
}
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, resumeAudio, true));

const getBgmLevel = () => (bgmGain ? bgmGain.gain.value : bgmEl.volume);
function setBgmLevel(v) { bgmEl._lvl = v; if (bgmGain) bgmGain.gain.value = v; else bgmEl.volume = v; }
function applyVolumes() {
  setBgmLevel(targetVol());
  if (voiceGain) voiceGain.gain.value = voiceVol(); else voiceEl.volume = voiceVol();
}
function playVoice(n) {
  if (EDITOR) return;
  voiceEl.pause(); if (!n || n === 'off') return;
  voiceEl.src = DIR.voice + n;
  if (voiceGain) voiceGain.gain.value = voiceVol(); else voiceEl.volume = voiceVol();
  voiceEl.play().catch(() => {});
}
let wantBgm = null;
function setBgm(n) {
  if (EDITOR) return;
  wantBgm = n;
  if (S) S.V.bgm = n;
  const src = n ? new URL(DIR.bgm + n, location.href).href : null;
  if (n && bgmEl.src === src && !bgmEl.paused) { setBgmLevel(targetVol()); return; }
  clearInterval(fadeT);
  const start = () => {
    if (!n) { bgmEl.pause(); return; }
    bgmEl.src = src; setBgmLevel(0);
    const p = bgmEl.play(); if (p) p.catch(() => {});
    fadeT = setInterval(() => {
      setBgmLevel(Math.min(targetVol(), getBgmLevel() + 0.05));
      if (getBgmLevel() >= targetVol()) clearInterval(fadeT);
    }, 60);
  };
  if (bgmEl.paused || !bgmEl.src) { start(); return; }
  fadeT = setInterval(() => {
    setBgmLevel(Math.max(0, getBgmLevel() - 0.1));
    if (getBgmLevel() <= 0) { clearInterval(fadeT); start(); }
  }, 40);
}
function playSe(n) {
  if (EDITOR) return;
  const a = new Audio(DIR.se + n);
  if (actx && seGain) { try { actx.createMediaElementSource(a).connect(seGain); seGain.gain.value = seVol(); } catch (e) { a.volume = seVol(); } }
  else a.volume = seVol();
  a.play().catch(() => {});
}
function setMute(m) {
  muted = m; LS.set('mute', m);
  applyVolumes();
  $('#btn-mute').textContent = (m ? '🔇 音樂 關' : '🔊 音樂 開');
  if (!m && wantBgm && bgmEl.paused) setBgm(wantBgm);
}

// ---------- 執行流程 ----------
function run() {
  voiceEl.pause();
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
    case 'pic': setPic(a[0] === 'off' ? null : a[0], a[1] === 'above' ? 'center' : a[1], a.includes('above')); break;
    case 'bgm': setBgm(a[0] === 'off' ? null : a[0]); break;
    case 'se': playSe(a[0]); break;
    case 'voice': playVoice(a[0]); break;
    case 'show': {
      const pos = a[2] || 'center';
      for (const p of POS) if (p !== pos && S.V.spr[p] && S.V.spr[p].c === a[0]) setSpr(p, null);
      setSpr(pos, a[0], a[1]); break;
    }
    case 'hide':
      for (const p of POS)
        if (a[0] === 'all' || p === a[0] || (S.V.spr[p] && S.V.spr[p].c === a[0])) setSpr(p, null);
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
    // 先等「開頭 30 個指令」用到的素材；其餘在背景載入，下一章也提前預載
    await withLoading(assetsOf(cur, S.idx, 30), chapterTitle(id));
    preload(id); preload(nextChapterId(id));
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
  S = { chapter: d.chapter, idx: d.idx, flags: clone(d.flags), V: blankV(), history: clone(d.history || []) };
  await withLoading([...assetsOfV(d.V), ...assetsOf(cur, d.idx, 30)], '讀取存檔');
  busy = false;
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
// 量出圖片「真正有內容」的範圍（忽略四周的透明留白與極淡的雜點），回傳原圖像素座標
function contentBox(img) {
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const cols = new Uint16Array(c.width), rows = new Uint16Array(c.height), rowsL = new Uint16Array(c.height);
  // 略過最外圈 4px：有些匯出的圖四周會有一圈不透明的細框，不能算進內容
  const E = 4;
  for (let y = E; y < c.height - E; y++) for (let xx = E; xx < c.width - E; xx++) if (d[(y * c.width + xx) * 4 + 3] > 60) { cols[xx]++; rows[y]++; }
  const first = a => a.findIndex(v => v >= 2), last = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] >= 2) return i; return -1; };
  const l = first(cols), r = last(cols);
  // 另外只統計內容左側 84% 的列：右端常有滴落的裝飾，會把上下兩段內容連在一起
  const lim = l + Math.floor((r - l + 1) * 0.84);
  for (let y = E; y < c.height - E; y++) for (let xx = E; xx < lim; xx++) if (d[(y * c.width + xx) * 4 + 3] > 60) rowsL[y]++;
  return { l, r, t: first(rows), b: last(rows), rows, rowsL, w: c.width, h: c.height };
}
// 標題 logo：不改圖檔，用 CSS 把四周透明留白「藏起來」，讓有內容的部分剛好等於指定寬度
function fitLogo(img, width) {
  try {
    const bx = contentBox(img);
    if (bx.r < bx.l || bx.b < bx.t) return null;
    const sc = width / (bx.r - bx.l + 1);
    img.style.width = Math.round(img.naturalWidth * sc) + 'px';
    img.style.marginLeft = -Math.round(bx.l * sc) + 'px';
    img.style.marginTop = -Math.round(bx.t * sc) + 'px';
    img.style.marginBottom = -Math.round((bx.h - 1 - bx.b) * sc) + 'px';
    // 裁掉內容範圍以外的部分（含四周的細框或雜點），只留下真正的 logo
    img.style.clipPath = `inset(${bx.t * sc}px ${(bx.w - 1 - bx.r) * sc}px ${(bx.h - 1 - bx.b) * sc}px ${bx.l * sc}px)`;
    return bx;
  } catch (e) { return null; }
}
let subBox = null;
function fitTitleLogos() {
  const m = $('#game-logo'), sl = $('#game-sublogo'), W = 400;
  if (m && !m.hidden && m.naturalWidth) fitLogo(m, W);
  if (sl && !sl.hidden && sl.naturalWidth) subBox = fitLogo(sl, W);
  alignTitle();
}
// 副標題文字那一行的垂直中心（原圖像素）：把有內容的列合併成區段（容許 3 列空隙），取內容最多的那段
function subTextCenter(bx) {
  const runs = []; let cur = null;
  for (let y = bx.t; y <= bx.b; y++) {
    if (bx.rowsL[y] < 2) continue;
    if (cur && y - cur.end <= 3) { cur.end = y; cur.sum += bx.rowsL[y]; } else { cur = { start: y, end: y, sum: bx.rowsL[y] }; runs.push(cur); }
  }
  const best = runs.reduce((a, r) => (r.sum > a.sum ? r : a));
  return (best.start + best.end) / 2;
}
// 讓副標題文字的中心，和右邊選單按鈕文字的中心在同一條水平線上（量出現在的差距後修正 bottom）
function alignTitle() {
  const sub = $('#game-sublogo');
  if (!sub || sub.hidden || !sub.naturalHeight || !subBox || el.title.classList.contains('hidden')) return;
  const k = stage.getBoundingClientRect().width / stage.offsetWidth;
  const r = sub.getBoundingClientRect();
  const textY = r.top + subTextCenter(subBox) * (r.height / sub.naturalHeight);
  const b = document.querySelector('.menu button').getBoundingClientRect();
  const delta = (textY - (b.top + b.bottom) / 2) / k;
  const brand = $('#title-brand');
  const cur = parseFloat(brand.style.bottom) || parseFloat(getComputedStyle(brand).bottom) || 0;
  if (Math.abs(delta) > 0.3) brand.style.bottom = (cur + delta) + 'px';
}
addEventListener('resize', () => requestAnimationFrame(alignTitle));

function toTitle() {
  waiting = null; skipMode = false; syncSkipBtn(); closePanel();
  el.menubar.style.display = 'none'; el.box.style.display = 'none';
  el.choices.style.display = 'none'; el.banner.style.display = 'none';
  if (typing) clearInterval(typing.timer);
  typing = null;
  setBgm(cfg.titleBgm || null);
  el.title.classList.remove('hidden');
  requestAnimationFrame(fitTitleLogos);
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
// ---------- 存檔匯出 / 匯入 ----------
const SAVE_KEY = /^(save_(auto|\d+)|read|unlocked|endings|mute)$/;
function exportSaves() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(P) && SAVE_KEY.test(k.slice(P.length))) data[k.slice(P.length)] = LS.get(k.slice(P.length), null);
  }
  const blob = new Blob([JSON.stringify({ game: cfg.title, version: 1, time: Date.now(), data })], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `存檔_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importSaves(file) {
  const r = new FileReader();
  r.onload = () => {
    let obj;
    try { obj = JSON.parse(r.result); } catch (e) { alert('這不是有效的存檔檔案。'); return; }
    if (!obj || obj.version !== 1 || !obj.data || typeof obj.data !== 'object') { alert('這不是有效的存檔檔案。'); return; }
    const keys = Object.keys(obj.data).filter(k => SAVE_KEY.test(k));
    if (!keys.length) { alert('檔案裡沒有可匯入的存檔。'); return; }
    if (!confirm('匯入會覆蓋目前同名的存檔格，確定要繼續嗎？')) return;
    for (const k of keys) {
      const v = obj.data[k];
      if (k === 'endings' || k === 'unlocked') LS.set(k, [...new Set([...(LS.get(k, [])), ...(Array.isArray(v) ? v : [])])]);
      else if (k === 'read') LS.set(k, Object.assign(LS.get(k, {}), v && typeof v === 'object' ? v : {}));
      else LS.set(k, v);
    }
    read = LS.get('read', {});
    setMute(LS.get('mute', false));
    $('#btn-continue').disabled = !LS.get('save_auto', null);
    alert(`已匯入 ${keys.length} 項記錄。`);
  };
  r.readAsText(file);
}
$('#import-file').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) importSaves(f);
});

function settingsPanel(body) {
  const g1 = document.createElement('div'); g1.className = 'set-group';
  g1.innerHTML = '<h3>音量設定</h3>';
  [['master', '全部音量'], ['bgm', '背景音量'], ['voice', '語音音量']].forEach(([k, name]) => {
    const row = document.createElement('div'); row.className = 'set-row';
    const lb = document.createElement('label'); lb.textContent = name;
    const rg = document.createElement('input'); rg.type = 'range'; rg.min = 0; rg.max = 100; rg.value = Math.round(vol[k] * 100);
    const out = document.createElement('output'); out.textContent = rg.value + '%';
    rg.oninput = () => { vol[k] = rg.value / 100; out.textContent = rg.value + '%'; LS.set('vol', vol); applyVolumes(); };
    row.append(lb, rg, out); g1.appendChild(row);
  });
  const note = document.createElement('p'); note.className = 'set-note';
  note.textContent = '全部音量也會影響音效。';
  g1.appendChild(note);
  const g2 = document.createElement('div'); g2.className = 'set-group';
  g2.innerHTML = '<h3>存檔管理</h3><div class="set-btns"><button data-act="export">匯出存檔</button><button data-act="import">匯入存檔</button><button data-act="clear">清除記錄</button></div><p class="set-note">存檔只存在這個瀏覽器裡，換裝置或清除瀏覽器資料前請先匯出。</p>';
  body.append(g1, g2);
}

function openHistory() {
  openPanel('歷史', body => {
    if (!S || !S.history.length) return panelEmpty(body, '尚無紀錄');
    S.history.forEach(h => {
      const d = document.createElement('div'); d.className = 'hist-line';
      if (h.name) { const n = document.createElement('b'); n.textContent = h.name; d.appendChild(n); }
      const t = document.createElement('span'); t.textContent = h.text; d.appendChild(t);
      body.appendChild(d);
    });
    body.scrollTop = body.scrollHeight;
  });
}
const panelIsHistory = () => !el.panel.classList.contains('hidden') && el.ptitle.textContent === '歷史';
// 滑鼠滾輪：遊戲中往上滾 = 開歷史；在歷史底部再往下滾 = 關閉
document.addEventListener('wheel', e => {
  if (!el.panel.classList.contains('hidden')) {
    if (panelIsHistory() && e.deltaY > 0 && el.pbody.scrollTop + el.pbody.clientHeight >= el.pbody.scrollHeight - 2) closePanel();
    return;
  }
  if (e.deltaY < 0 && el.title.classList.contains('hidden') && waiting !== 'banner' && !busy) openHistory();
}, { passive: true });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el.panel.classList.contains('hidden')) closePanel(); });

function panelEmpty(body, msg) { body.innerHTML = `<p class="empty">${msg}</p>`; }

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  switch (b.dataset.act) {
    case 'new': newGame(chapterIds()[0]); break;
    case 'continue': loadSave('auto'); break;
    case 'save': openPanel('存檔', body => slotList(body, 'save')); break;
    case 'load': openPanel('讀檔', body => slotList(body, 'load')); break;
    case 'history': openHistory(); break;
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
    case 'settings': openPanel('遊戲設定', settingsPanel); break;
    case 'export': exportSaves(); break;
    case 'import': $('#import-file').click(); break;
    case 'closepanel': closePanel(); break;
  }
});

// ---------- 初始化 ----------
function fit() {
  const s = Math.min(innerWidth / 1216, innerHeight / 832);
  stage.style.transform = `translate(-50%,-50%) scale(${s})`;
}
addEventListener('resize', fit); fit();

// ---------- 場景編輯器預覽 ----------
// 編輯器傳來 {type:'render', V, say:{who,text} | choice:[文字…]}，這裡只負責把畫面畫出來
function previewRender(m) {
  S.V = blankV();
  applyV(m.V || blankV());
  el.choices.style.display = 'none'; el.box.style.display = 'none'; el.mark.style.display = 'none';
  if (m.choice) {
    el.choices.innerHTML = '';
    m.choice.forEach(t => { const b = document.createElement('button'); b.textContent = t; el.choices.appendChild(b); });
    el.choices.style.display = 'flex';
  } else if (m.say) {
    const c = m.say.who ? chars[m.say.who] : null;
    el.box.style.display = 'block';
    el.name.style.display = c ? 'block' : 'none';
    if (c) { el.name.textContent = c.name; el.name.style.color = c.color || '#fff'; }
    el.text.textContent = m.say.text;
    el.mark.style.display = 'block';
  }
}
if (EDITOR) addEventListener('message', e => {
  if (e.origin !== location.origin || !e.data || e.data.type !== 'render' || !S) return;
  previewRender(e.data);
});

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
  if (cfg.titleBg) el.title.style.backgroundImage = `url(${DIR.bg + cfg.titleBg})`;
  const sl = $('#game-sublogo');   // 舊版快取的 index.html 可能沒有這個元素，不要因此中斷
  if (cfg.titleSubLogo && sl) { sl.onload = fitTitleLogos; sl.src = DIR.bg + cfg.titleSubLogo; sl.hidden = false; }
  if (cfg.titleLogo) { const lg = $('#game-logo'); lg.onload = fitTitleLogos; lg.src = DIR.bg + cfg.titleLogo; lg.hidden = false; $('#game-title').hidden = true; }
  setMute(muted);
  S = { chapter: null, idx: 0, flags: {}, V: blankV(), history: [] };   // 標題畫面階段也要有可用狀態
  if (EDITOR) {   // 編輯器預覽：不走標題畫面與載入流程
    document.body.classList.add('editor');
    el.title.classList.add('hidden');
    if (loadingEl) loadingEl.style.display = 'none';
    parent.postMessage({ type: 'ready' }, location.origin);
    return;
  }
  // 首次載入：先等標題畫面的圖（有進度條），標題音樂與第一章在背景載入
  $('#loading-title').textContent = cfg.title;
  await withLoading([cfg.titleBg, cfg.titleLogo, cfg.titleSubLogo].filter(Boolean).map(n => DIR.bg + n), '載入中', true);
  toTitle();
  await hideLoading();
  if (cfg.titleBgm) loadAsset(DIR.bgm + cfg.titleBgm);
  preload(chapterIds()[0]);
})();
})();
