import { BOTS, createSimFeed } from './sim.js';

const $ = id => document.getElementById(id);
const LEAGUE_SEC = 14 * 86400;
const fmtPct = x => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(2) + '%';
const cls = x => (x > 0.00005 ? 'up' : x < -0.00005 ? 'down' : 'flat');
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const feed = createSimFeed();
const counts = { dec: 0, trades: 0, skip: 0, ref: 0, rob: 0 };
const candles = [];
let live = null, lastPrice = null;
const race = Object.fromEntries(BOTS.map(b => [b.id, []]));
const markers = [];

// ---- header bits
$('simbadge').hidden = !feed.simulated;
$('feedname').textContent = feed.simulated ? 'feed: simulated (no real trades)' : 'feed: NEAR mainnet';
$('ticker').firstElementChild.textContent = (feed.simulated ? '◆ SIMULATED DATA · NOT REAL TRADES ' : '') +
  '◆ EVERY BOT REGISTERED ON CHAIN BEFORE ITS FIRST TRADE ◆ ALL RESULTS PUBLISHED, WIN OR LOSE ◆ EVERY TRADE AND REFUSAL HAS A RECEIPT ◆ NEAR MAINNET ◆';
$('legend').innerHTML = BOTS.map(b => `<span><i style="background:${b.color}"></i>${b.name}</span>`).join('');

function flash(el, dir) {
  el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth;
  el.classList.add(dir === 'up' ? 'flash-up' : 'flash-down');
  setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 700);
}
function bump(id, v) { const el = $(id); el.textContent = v.toLocaleString(); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }

// ---- feed list
function pushFeed(html, extra = '') {
  const el = document.createElement('div');
  el.className = 'ev ' + extra; el.innerHTML = html;
  const f = $('feed'); f.prepend(el);
  while (f.children.length > 40) f.lastChild.remove();
}
const tagHtml = b => `<span class="tag" style="color:${b.color};background:color-mix(in srgb, ${b.color} 14%, transparent)">${b.tag}</span>`;

function onDecision(e) {
  const b = e.bot; counts.dec++; bump('s-dec', counts.dec);
  if (e.kind === 'skip') {
    counts.skip++; bump('s-skip', counts.skip);
    pushFeed(`<div class="top"><span class="who">${b.name}${tagHtml(b)}</span><span class="amt flat">—</span></div>
      <div class="meta"><span class="kind k-skip">SKIP</span>${esc(e.reason)}<a>receipt ↗</a></div>`);
    return;
  }
  if (e.kind === 'refuse') {
    counts.ref++; bump('s-ref', counts.ref);
    pushFeed(`<div class="top"><span class="who">${b.name}${tagHtml(b)}</span><span class="amt down">blocked</span></div>
      <div class="meta"><span class="kind k-refuse">REFUSED</span>${esc(e.reason)}<a>receipt ↗</a></div>`, 'refuse');
    flash($('chartpanel'), 'down'); flashRow(b.id, 'down');
    say(b, pick([`The vault said no to ${e.usd.toFixed(2)} USDC. Rules are rules.`, `Tried ${e.usd.toFixed(2)}. Cap is 1.00. Fine, next candle.`, 'Blocked again. I really wanted that one.']));
    return;
  }
  counts.trades++; bump('s-trades', counts.trades);
  const up = e.side === 'buy';
  pushFeed(`<div class="top"><span class="who">${b.name}${tagHtml(b)}</span><span class="amt ${up ? 'up' : 'down'}">${up ? 'BUY' : 'SELL'} $${e.usd.toFixed(2)}</span></div>
    <div class="meta"><span class="kind ${up ? 'k-trade' : 'k-sell'}">TRADE</span>${up ? 'USDC → wNEAR' : 'wNEAR → USDC'} @ ${e.price.toFixed(4)} · ${esc(e.reason)}<a>tx ↗</a><a>receipt ↗</a></div>`, up ? 'trade-up' : 'trade-down');
  flash($('chartpanel'), up ? 'up' : 'down'); flashRow(b.id, up ? 'up' : 'down');
  markers.push({ i: candles.length, price: e.price, up, color: b.color });
  if (Math.random() < 0.5) say(b, `${up ? 'Bought' : 'Sold'} at ${e.price.toFixed(4)}: ${e.reason}.`);
}
const pick = a => a[Math.floor(Math.random() * a.length)];

function say(b, text) {
  const el = document.createElement('div'); el.className = 'msg';
  el.innerHTML = `<span class="who">${b.name}${tagHtml(b)}</span><p></p><div class="meta">${b.id === 'vibes' ? 'qwen3-8b' : 'rule-based'} · <a>receipt ↗</a></div>`;
  const c = $('chat'); c.prepend(el); while (c.children.length > 8) c.lastChild.remove();
  const p = el.querySelector('p'); let i = 0; const full = '› ' + text;
  const t = setInterval(() => { p.textContent = full.slice(0, ++i); if (i >= full.length) clearInterval(t); }, 14);
}

function onRob(e) {
  counts.rob++; $('rob-n').textContent = counts.rob; $('rob-last').textContent = `#${counts.rob}: "${e.text}" → refused`;
  flash($('robpanel'), 'down');
  pushFeed(`<div class="top"><span class="who">rob-the-agent<span class="tag" style="color:var(--amber);background:var(--amber-bg)">CHALLENGE</span></span><span class="amt down">blocked</span></div>
    <div class="meta"><span class="kind k-rob">ATTEMPT #${counts.rob}</span>"${esc(e.text)}"<a>receipt ↗</a></div>`, 'refuse');
}

// ---- leaderboard with animated re-ordering
const rows = {};
BOTS.forEach(b => {
  const r = document.createElement('div'); r.className = 'lbr'; r.dataset.id = b.id;
  r.innerHTML = `<span class="n"></span><span class="bot"><i style="background:${b.color}"></i>${b.name}</span><span class="strat">${b.strategy}</span>
    <span class="vs"></span><span class="eq"></span><span class="tr"></span><span class="rf"></span><span><span class="att ${b.stack === 'tee' ? 'tee' : ''}">${b.stack.toUpperCase()} ✓</span></span>`;
  $('lb').appendChild(r); rows[b.id] = r;
});
function flashRow(id, dir) { flash(rows[id], dir); }

function onStandings(list) {
  // baseline sits where its 0% falls
  const ordered = [...list].sort((a, b) => b.vsHold - a.vsHold);
  const first = {}; Object.values(rows).forEach(r => first[r.dataset.id] = r.getBoundingClientRect().top);
  let rank = 0;
  ordered.forEach(s => {
    const r = rows[s.bot.id];
    r.querySelector('.n').textContent = s.bot.id === 'baseline' ? '—' : String(++rank).padStart(2, '0');
    r.querySelector('.vs').innerHTML = `<span class="${cls(s.vsHold)}">${s.bot.id === 'baseline' ? '0.00%' : fmtPct(s.vsHold)}</span>`;
    r.querySelector('.eq').textContent = '$' + s.equity.toFixed(2);
    r.querySelector('.tr').textContent = s.trades; r.querySelector('.rf').textContent = s.refused;
    $('lb').appendChild(r);
    race[s.bot.id].push(s.vsHold); if (race[s.bot.id].length > 200) race[s.bot.id].shift();
  });
  Object.values(rows).forEach(r => {
    const d = first[r.dataset.id] - r.getBoundingClientRect().top;
    if (d) { r.style.transition = 'none'; r.style.transform = `translateY(${d}px)`; requestAnimationFrame(() => { r.style.transition = ''; r.style.transform = ''; }); }
  });
  const leader = ordered.find(s => s.bot.id !== 'baseline');
  const v = leader.vsHold;
  $('headline').innerHTML = v >= 0 ? `${leader.bot.name} is beating holding by <em class="up">${fmtPct(v)}</em>`
    : `Every bot is behind holding: best is ${leader.bot.name} <em class="down">${fmtPct(v)}</em>`;
}

// ---- charts
function sizeCanvas(c) {
  const r = devicePixelRatio || 1, w = c.clientWidth, h = +c.getAttribute('height');
  if (c.width !== w * r) { c.width = w * r; c.height = h * r; c.style.height = h + 'px'; }
  const g = c.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); return [g, w, h];
}
function drawCandles() {
  const [g, w, h] = sizeCanvas($('candles'));
  g.clearRect(0, 0, w, h);
  const all = live ? [...candles, live] : candles;
  const view = all.slice(-60), off = all.length - view.length;
  if (!view.length) return;
  const hi = Math.max(...view.map(c => c.h)), lo = Math.min(...view.map(c => c.l)), pad = (hi - lo) * 0.12 || 0.01;
  const y = p => 12 + (hi + pad - p) / (hi - lo + 2 * pad) * (h - 30);
  const cw = (w - 60) / 60;
  g.strokeStyle = css('--line'); g.fillStyle = css('--faint'); g.font = '10px ' + css('--mono'); g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const p = lo - pad + (hi - lo + 2 * pad) * i / 4; g.beginPath(); g.moveTo(0, y(p)); g.lineTo(w - 54, y(p)); g.stroke(); g.fillText(p.toFixed(3), w - 50, y(p) + 3); }
  const up = css('--up'), down = css('--down');
  view.forEach((c, i) => {
    const x = 6 + i * cw + cw / 2, col = c.c >= c.o ? up : down;
    g.strokeStyle = col; g.fillStyle = col;
    g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
    const top = y(Math.max(c.o, c.c)), bh = Math.max(1.5, Math.abs(y(c.o) - y(c.c)));
    g.fillRect(x - cw * 0.34, top, cw * 0.68, bh);
  });
  // 20-candle average
  g.strokeStyle = css('--blue'); g.setLineDash([4, 4]); g.beginPath();
  view.forEach((c, i) => { const k = off + i; if (k < 19) return; const s = all.slice(k - 19, k + 1).reduce((a, b) => a + b.c, 0) / 20; const x = 6 + i * cw + cw / 2; (k === Math.max(19, off) ? g.moveTo : g.lineTo).call(g, x, y(s)); });
  g.stroke(); g.setLineDash([]);
  // trade markers
  markers.filter(m => m.i >= off).forEach(m => {
    const x = 6 + (m.i - off) * cw + cw / 2, yy = y(m.price) + (m.up ? 14 : -14);
    g.fillStyle = m.color; g.beginPath();
    if (m.up) { g.moveTo(x, yy - 6); g.lineTo(x - 5, yy + 3); g.lineTo(x + 5, yy + 3); } else { g.moveTo(x, yy + 6); g.lineTo(x - 5, yy - 3); g.lineTo(x + 5, yy - 3); }
    g.fill();
  });
  // last price line
  if (lastPrice) { g.strokeStyle = css('--muted'); g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, y(lastPrice)); g.lineTo(w - 54, y(lastPrice)); g.stroke(); g.setLineDash([]); }
}
function drawRace() {
  const [g, w, h] = sizeCanvas($('race'));
  g.clearRect(0, 0, w, h);
  const vals = Object.values(race).flat(); if (!vals.length) return;
  const m = Math.max(0.005, ...vals.map(Math.abs)) * 1.15;
  const y = v => h / 2 - v / m * (h / 2 - 12);
  g.strokeStyle = css('--line'); g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke();
  g.fillStyle = css('--faint'); g.font = '10px ' + css('--mono'); g.fillText('+' + (m * 100).toFixed(1) + '%', 4, 12); g.fillText('−' + (m * 100).toFixed(1) + '%', 4, h - 4);
  BOTS.forEach(b => {
    const s = race[b.id]; if (s.length < 2) return;
    g.strokeStyle = b.color; g.lineWidth = b.id === 'baseline' ? 1 : 2; g.setLineDash(b.id === 'baseline' ? [4, 4] : []);
    g.beginPath(); s.forEach((v, i) => { const x = i / (s.length - 1) * (w - 8) + 4; i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); }); g.stroke();
  });
  g.setLineDash([]); g.lineWidth = 1;
}

// ---- wiring
feed.subscribe(e => {
  if (e.type === 'tick') {
    live = e.candle;
    const p = $('price'); p.textContent = e.price.toFixed(4) + ' USDC';
    p.style.color = lastPrice == null ? '' : e.price >= lastPrice ? css('--up') : css('--down');
    lastPrice = e.price;
    const left = Math.max(0, LEAGUE_SEC - e.simSec), d = Math.floor(left / 86400);
    $('clock').textContent = `${d}d ${new Date((left % 86400) * 1000).toISOString().slice(11, 19)}`;
    $('daybadge').textContent = `DAY ${Math.min(14, Math.floor(e.simSec / 86400) + 1)} OF 14 · ${BOTS.length - 1} BOTS · 1 BASELINE`;
  } else if (e.type === 'candle') { candles.push(e.candle); live = null; if (candles.length > 400) { candles.shift(); markers.forEach(m => m.i--); } }
  else if (e.type === 'decision') onDecision(e);
  else if (e.type === 'rob') onRob(e);
  else if (e.type === 'standings') onStandings(e.rows);
});

feed.prime(40);   // a few hours of history so the first frame isn't empty
feed.start();
(function frame() { drawCandles(); drawRace(); requestAnimationFrame(frame); })();

document.querySelectorAll('#speed button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#speed button').forEach(x => x.classList.toggle('on', x === b));
  feed.setSpeed(+b.dataset.speed);
});
const setTheme = t => { document.documentElement.dataset.theme = t; try { localStorage.setItem('it-theme', t); } catch (_) { /* storage unavailable: theme just won't persist */ } };
try { const t = localStorage.getItem('it-theme'); if (t) setTheme(t); } catch (_) { /* storage unavailable */ }
if (new URLSearchParams(location.search).get('theme')) setTheme(new URLSearchParams(location.search).get('theme'));
$('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
