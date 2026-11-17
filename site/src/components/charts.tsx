"use client";
import { useEffect, useRef, useState } from "react";
import { relSeries } from "@/lib/board";
import { entryName, leagueOf, type LeagueEntry } from "@/lib/feed/league-data";
import { NETWORKS, type NetworkConfig } from "@/lib/networks";
import { cssVar } from "@/lib/format";
import type { LeagueState } from "@/lib/league";
import { barAt, closeBars, HOUR, marksOf, type Mark as TradeMark, type PriceFile } from "@/lib/trades";
import priceData from "@/data/league-candles.json";

function useCanvas(height: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = ref.current;
      if (c) {
        const r = devicePixelRatio || 1, w = c.clientWidth;
        if (c.width !== Math.round(w * r) || c.height !== Math.round(height * r)) { c.width = Math.round(w * r); c.height = Math.round(height * r); }
        const g = c.getContext("2d");
        if (g) { g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, height); drawRef.current(g, w, height); }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [height]);
  return <canvas ref={ref} style={{ width: "100%", height }} />;
}

export function CandleChart({ s, height = 320, botId }: { s: LeagueState; height?: number; botId?: string }) {
  return useCanvas(height, (g, w, h) => {
    const all = s.live ? [...s.candles, s.live] : s.candles;
    const view = all.slice(-72);
    if (!view.length) return;
    const hi = Math.max(...view.map(c => c.h)), lo = Math.min(...view.map(c => c.l));
    const pad = (hi - lo) * 0.14 || 0.01;
    const y = (p: number) => 10 + ((hi + pad - p) / (hi - lo + 2 * pad)) * (h - 28);
    const plotW = w - 58, cw = plotW / Math.max(view.length + 2, 40);
    g.font = `10px ${cssVar("--mono")}`; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const p = lo - pad + ((hi - lo + 2 * pad) * i) / 4;
      g.strokeStyle = cssVar("--line"); g.beginPath(); g.moveTo(0, y(p)); g.lineTo(plotW, y(p)); g.stroke();
      g.fillStyle = cssVar("--faint"); g.fillText(p.toFixed(3), plotW + 6, y(p) + 3);
    }
    const up = cssVar("--up"), down = cssVar("--down");
    const xOf = (i: number) => 4 + i * cw + cw / 2;
    view.forEach((c, i) => {
      const col = c.c >= c.o ? up : down, x = xOf(i);
      g.strokeStyle = col; g.fillStyle = col;
      g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
      g.fillRect(x - cw * 0.34, y(Math.max(c.o, c.c)), cw * 0.68, Math.max(1.5, Math.abs(y(c.o) - y(c.c))));
    });
    // 50-day average, the trend bot's line
    const off = all.length - view.length, n = Math.round(50 * 86_400 / s.feed.candleSec);
    g.strokeStyle = cssVar("--sky"); g.setLineDash([4, 4]); g.beginPath();
    let started = false;
    view.forEach((_, i) => {
      const k = off + i; if (k < n - 1) return;
      const avg = all.slice(k - n + 1, k + 1).reduce((a, b) => a + b.c, 0) / n;
      if (started) g.lineTo(xOf(i), y(avg)); else { g.moveTo(xOf(i), y(avg)); started = true; }
    });
    g.stroke(); g.setLineDash([]);
    // trade markers, placed on the candle that contains the trade
    const t0 = view[0].t, step = view.length > 1 ? view[1].t - view[0].t : 300;
    for (const d of s.decisions) {
      if (d.kind !== "trade" || d.price == null || d.side === "stake" || d.side === "unstake" || (botId && d.botId !== botId)) continue;
      const i = Math.floor((d.at - t0) / step); if (i < 0 || i >= view.length) continue;
      const bot = s.feed.bots.find(b => b.id === d.botId);
      const x = xOf(i), buy = d.side === "buy", yy = y(d.price) + (buy ? 15 : -15);
      g.fillStyle = bot?.color ?? up; g.beginPath();
      if (buy) { g.moveTo(x, yy - 6); g.lineTo(x - 5, yy + 3); g.lineTo(x + 5, yy + 3); }
      else { g.moveTo(x, yy + 6); g.lineTo(x - 5, yy - 3); g.lineTo(x + 5, yy - 3); }
      g.fill();
    }
    if (s.price != null) {
      const py = y(s.price), col = s.prevPrice != null && s.price < s.prevPrice ? down : up;
      g.strokeStyle = col; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(0, py); g.lineTo(plotW, py); g.stroke(); g.setLineDash([]);
      g.fillStyle = col; g.fillRect(plotW + 2, py - 8, 54, 16);
      g.fillStyle = cssVar("--volt-ink"); g.fillText(s.price.toFixed(4), plotW + 6, py + 3);
    }
  });
}

// An entry's value against the two benchmarks, each from the same start.
export function EquityChart({ s, botId, color, height = 260 }: { s: LeagueState; botId: string; color: string; height?: number }) {
  return useCanvas(height, (g, w, h) => {
    const series = [
      { id: "staked", color: cssVar("--faint"), dash: [2, 3], width: 1.2 },
      { id: "baseline", color: cssVar("--muted"), dash: [5, 4], width: 1.2 },
      { id: botId, color, dash: [] as number[], width: 2 },
    ].map(x => ({ ...x, data: s.equityHistory[x.id] ?? [] })).filter(x => x.data.length > 1);
    if (!series.length) return;
    const all = series.flatMap(x => x.data);
    const lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo) * 0.12 || 1;
    const plotW = w - 56;
    const y = (v: number) => 8 + ((hi + pad - v) / (hi - lo + 2 * pad)) * (h - 24);
    g.font = `10px ${cssVar("--mono")}`; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = lo - pad + ((hi - lo + 2 * pad) * i) / 4;
      g.strokeStyle = cssVar("--line"); g.beginPath(); g.moveTo(0, y(v)); g.lineTo(plotW, y(v)); g.stroke();
      g.fillStyle = cssVar("--faint"); g.fillText(v.toFixed(2), plotW + 6, y(v) + 3);
    }
    for (const x of series) {
      g.strokeStyle = x.color; g.lineWidth = x.width; g.setLineDash(x.dash); g.beginPath();
      x.data.forEach((v, i) => { const px = (i / (x.data.length - 1)) * (plotW - 4) + 2; if (i) g.lineTo(px, y(v)); else g.moveTo(px, y(v)); });
      g.stroke();
    }
    g.setLineDash([]); g.lineWidth = 1;
    const main = series.find(x => x.id === botId);
    if (main) {
      const v = main.data[main.data.length - 1], py = y(v);
      g.fillStyle = color; g.fillRect(plotW + 2, py - 8, 52, 16);
      g.fillStyle = cssVar("--bg"); g.fillText(v.toFixed(2), plotW + 6, py + 3);
    }
  });
}

// ---------- SVG charts for the testnet snapshot, drawn at the container's real width so text stays legible on phones.

const PAL = Array.from({ length: 10 }, (_, i) => `var(--p${i})`);
const DAY = 86_400_000;
const sign = (v: number) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + "%";
const utc = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ") + " UTC";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const path = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

function dayTicks(t0: number, t1: number, x: (t: number) => number, y: number, every: number) {
  const out = [];
  for (let d = 0; d <= Math.floor((t1 - t0) / DAY); d += every) out.push(<text key={d} className="axis" x={x(t0 + d * DAY)} y={y} textAnchor="middle">day {d}</text>);
  return out;
}

/** A tiny vs-hold path: the centre line is holding; lime when ahead at the end, red when behind. `more` adds paths on the same scale. */
export function VsSpark({ data, more = [], width = 110, height = 26 }: { data: number[]; more?: number[][]; width?: number; height?: number }) {
  const all = [data, ...more].filter(d => d.length > 1);
  if (!all.length) return <svg width={width} height={height} aria-hidden />;
  const m = Math.max(0.01, ...all.flat().map(Math.abs));
  const line = (d: number[]) => path(d.map((v, i) => [(i / (d.length - 1)) * width, height / 2 - (v / m) * (height / 2 - 2)] as [number, number]));
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke="var(--line2)" />
      {all.map((d, k) => <path key={k} d={line(d)} fill="none" stroke={d[d.length - 1] >= 0 ? "var(--up)" : "var(--down)"} strokeWidth="1.6" opacity={k ? 0.6 : 1} />)}
    </svg>);
}

/** The vs-hold bar: the centre line is holding; lime grows right, red grows left. `faded` marks a provisional value. */
export function VsBar({ v, max, faded }: { v: number | null; max: number; faded?: boolean }) {
  if (v == null || !Number.isFinite(v)) return <div className="vsbar" aria-hidden />;
  const w = Math.min(Math.abs(v) / max, 1) * 50;
  return <div className={`vsbar ${faded ? "prov" : ""}`} role="img" aria-label={`${sign(v)} against holding${faded ? ", provisional" : ""}`}><i className={v >= 0 ? "up" : "down"} style={{ width: `${w}%` }} /></div>;
}

/** Each entry's lead or deficit against holding, hour by hour. Zero is the HOLD line. */
export function RaceChart({ entries, height = 300 }: { entries: LeagueEntry[]; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const rs = entries.map((e, i) => ({ e, r: relSeries(e), c: PAL[i % PAL.length], i })).filter(o => o.r.length > 1);
  const narrow = W > 0 && W < 560;
  let body = null;
  if (W > 0 && rs.length) {
    const P = { l: 46, r: narrow ? 40 : 172, t: 12, b: 24 };
    const ts = rs.flatMap(o => o.r.map(p => p.t)), t0 = Math.min(...ts), t1 = Math.max(...ts);
    const vs = rs.flatMap(o => o.r.map(p => p.v)), lo = Math.min(...vs, -0.01), hi = Math.max(...vs, 0.01);
    const x = (t: number) => P.l + ((t - t0) / (t1 - t0 || 1)) * (W - P.l - P.r), y = (v: number) => P.t + ((hi - v) / (hi - lo)) * (height - P.t - P.b);
    // End labels for the leaders, nudged apart so they never overlap.
    const labels = rs.slice(0, narrow ? 0 : 5).map(o => ({ o, y: y(o.r[o.r.length - 1].v) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < labels.length; k++) labels[k].y = Math.max(labels[k].y, labels[k - 1].y + 12);
    body = (
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Each agent against holding NEAR over the season">
        {[hi, lo].map(v => <text key={v} className="axis" x={P.l - 6} y={y(v) + 3} textAnchor="end">{sign(v)}</text>)}
        {dayTicks(t0, t1, x, height - 6, narrow ? 2 : 1)}
        {[...rs].reverse().map(o => {
          const last = o.r[o.r.length - 1], top = o.i < 3;
          return <path key={o.e.id} d={path(o.r.map(p => [x(p.t), y(p.v)]))} fill="none" stroke={o.c} strokeWidth={top ? 2.2 : 1.2} opacity={top ? 1 : 0.55}>
            <title>{`${entryName(o.e)}: ${sign(last.v)} vs hold`}</title></path>;
        })}
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="var(--strong)" strokeWidth="1.5" opacity=".85" />
        <text className="axis" x={W - P.r + 5} y={y(0) + 3} style={{ fill: "var(--strong)", fontWeight: 600 }}>HOLD</text>
        {labels.map(({ o, y: ly }) => <text key={o.e.id} className="axis" x={W - P.r + 42} y={ly + 3} style={{ fill: o.c }}>{entryName(o.e).slice(0, 18)}</text>)}
      </svg>);
  }
  return (
    <div className="chart" ref={ref} style={{ minHeight: height }}>
      {body}
      {narrow && <div className="lg">{rs.slice(0, 5).map(o => <span key={o.e.id}><i style={{ background: o.c }} />{entryName(o.e)}</span>)}</div>}
    </div>);
}

type Mark = { x: number; y: number; sym: string; c: string; dy: number; label: string };

/** An entry's vault value against the same money just held and staked, with its on-chain decisions marked. */
export function EntryEquity({ e, height = 300 }: { e: LeagueEntry; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const s = e.series;
  let body = null;
  if (W > 0 && s.length > 1) {
    const P = { l: 54, r: 14, t: 16, b: 24 };
    const t0 = s[0].t, t1 = s[s.length - 1].t;
    const vals = s.flatMap(p => [p.value, p.hold, p.stake]), lo = Math.min(...vals) * 0.98, hi = Math.max(...vals) * 1.02;
    const x = (t: number) => P.l + ((t - t0) / (t1 - t0 || 1)) * (W - P.l - P.r), y = (v: number) => P.t + ((hi - v) / (hi - lo || 1)) * (height - P.t - P.b);
    const line = (k: "value" | "hold" | "stake") => path(s.map(p => [x(p.t), y(p[k])]));
    const at = (t: number) => { let b = s[0]; for (const p of s) { if (p.t <= t) b = p; else break; } return b.value; };
    const marks: Mark[] = e.decisions.filter(d => (d.event === "trade" || d.event === "refuse" || String(d.note ?? "").startsWith("refused")) && d.side !== "stake" && d.side !== "unstake")
      .filter(d => d.block_time_ms >= t0 && d.block_time_ms <= t1).map(d => {
        const no = d.event !== "trade", buy = d.side === "buy";
        const label = no ? `#${d.seq} refused ${d.code ?? String(d.note).replace(/^refused:?/, "")}`
          : `#${d.seq} ${buy ? "buy" : "sell"} ${(Number(d.amount_in ?? 0) / 1e24).toFixed(2)} ${buy ? "USDC" : "wNEAR"}${d.fill_price ? ` @ ${d.fill_price.toFixed(3)}` : ""}`;
        return { x: x(d.block_time_ms), y: y(at(d.block_time_ms)), sym: no ? "✗" : buy ? "▲" : "▼", c: no ? "var(--down)" : buy ? "var(--up)" : "var(--sky)",
          dy: no ? -10 : buy ? 16 : -8, label: `${label} · ${utc(d.block_time_ms)}` };
      });
    body = (
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`${entryName(e)}: vault value against holding and staking`}>
        {[0, 1, 2, 3, 4].map(k => { const v = lo + ((hi - lo) * k) / 4; return <g key={k}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          <text className="axis" x={P.l - 6} y={y(v) + 3} textAnchor="end">${v.toFixed(2)}</text></g>; })}
        {dayTicks(t0, t1, x, height - 6, W < 560 ? 2 : 1)}
        <path d={`${line("value")}L${x(t1)},${height - P.b}L${x(t0)},${height - P.b}Z`} fill="var(--up)" opacity=".08" />
        <path d={line("stake")} fill="none" stroke="var(--muted)" strokeWidth="1.2" />
        <path d={line("hold")} fill="none" stroke="var(--strong)" strokeWidth="1.4" strokeDasharray="5 4" opacity=".8" />
        <path d={line("value")} fill="none" stroke="var(--up)" strokeWidth="2.4" />
        {marks.map((m, k) => <text key={k} className="mk" x={m.x} y={m.y + m.dy} textAnchor="middle" fill={m.c}><title>{m.label}</title>{m.sym}</text>)}
      </svg>);
  }
  const first = s[0]?.value, last = s[s.length - 1]?.value;
  return (
    <div className="chart" ref={ref} style={{ minHeight: height }}>
      {body}
      <div className="lg">
        <span><i style={{ background: "var(--up)" }} />vault{first ? ` ${sign(last / first - 1)}` : ""}</span>
        <span><i className="dash" />just holding</span>
        <span><i style={{ background: "var(--muted)" }} />staked</span>
        <span style={{ color: "var(--up)" }}>▲ buy</span><span style={{ color: "var(--sky)" }}>▼ sell</span><span style={{ color: "var(--down)" }}>✗ refused</span>
      </div>
    </div>);
}

const PRICES = priceData as unknown as PriceFile;
const M = { buy: { sym: "▲", c: "var(--up)", label: "Buy" }, sell: { sym: "▼", c: "var(--sky)", label: "Sell" }, refuse: { sym: "✗", c: "var(--down)", label: "Refused" } };
const tok = (raw: string | undefined, decimals = 24) => (Number(raw ?? 0) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: 4 });

/** Marker hover card: what the vault recorded, the fill against the reference price, and the receipt. */
function MarkCard({ m, n, left, top, below }: { m: TradeMark; n: NetworkConfig; left: number; top: number; below: boolean }) {
  const d = m.d, buy = d.side === "buy", [inSym, outSym] = buy ? ["USDC", "wNEAR"] : ["wNEAR", "USDC"];
  const [inDec, outDec] = (buy ? [n.tokens[1], n.tokens[0]] : [n.tokens[0], n.tokens[1]]).map(t => t?.decimals);
  const gap = d.fill_price && d.ref_price ? d.fill_price / d.ref_price - 1 : null;
  return (
    <div className={`mkcard ${below ? "below" : ""}`} style={{ left, top }} role="tooltip">
      <div className="mh"><b style={{ color: M[m.kind].c }}>{M[m.kind].label}</b><span>#{d.seq}</span></div>
      {m.kind === "refuse" ? <div>{d.amount_in ? `asked ${tok(d.amount_in, inDec)} ${inSym} → ${outSym}` : "asked for a trade"} · <code>{d.code ?? (String(d.note ?? "").replace(/^refused:?\s*/, "") || "refused")}</code></div>
        : <div>{tok(d.amount_in, inDec)} {inSym} → {tok(d.amount_out, outDec)} {outSym}</div>}
      {m.kind !== "refuse" && <div className="dim">fill {d.fill_price?.toFixed(4) ?? "—"} · ref {d.ref_price?.toFixed(4) ?? "—"}{gap != null ? ` (${gap >= 0 ? "+" : "−"}${Math.abs(gap * 100).toFixed(1)}%)` : ""}</div>}
      <div className="dim">{utc(d.block_time_ms)}</div>
      <a href={`/receipt/?id=${encodeURIComponent(`${d.tx}-${d.seq}`)}&net=${n.id}`}>receipt →</a>
    </div>);
}

/** Hourly reference candles over the season with an entry's buys, sells and refusals. Falls back to the closes as a line. */
export function TradeChart({ e, height = 300 }: { e: LeagueEntry; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hot, setHot] = useState<{ k: number; pin: boolean } | null>(null);
  const candles = PRICES.candles.length > 0, bars = candles ? PRICES.candles : closeBars(PRICES.closes);
  const t0 = PRICES.from_ms, t1 = Math.max(PRICES.to_ms, ...bars.map(b => b.t + HOUR));
  const marks = marksOf(e.decisions, t0, t1), n = NETWORKS[leagueOf(e.id)?.network ?? "testnet"];
  let body = null, card = null;
  if (W > 0 && bars.length) {
    const P = { l: 6, r: 50, t: 14, b: 24 };
    const lo = Math.min(...bars.map(b => b.l)), hi = Math.max(...bars.map(b => b.h)), pad = (hi - lo) * 0.16 || 0.05;
    const x = (t: number) => P.l + ((t - t0) / (t1 - t0 || 1)) * (W - P.l - P.r);
    const y = (v: number) => P.t + ((hi + pad - v) / (hi - lo + 2 * pad)) * (height - P.t - P.b);
    const bw = Math.max(1, (x(t0 + HOUR) - x(t0)) * 0.66), last = bars[bars.length - 1];
    const pos = (m: TradeMark) => {
      const b = barAt(bars, m.t)!, below = m.kind === "buy";
      // stacks stay inside the plot; a burst past 4 overlaps on the last slot
      const k = Math.min(m.stack, 3);
      return { x: x(m.t), y: below ? Math.min(height - P.b - 2, y(b.l) + 13 + k * 12) : Math.max(P.t + 8, y(b.h) - 5 - k * 12) };
    };
    body = (
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Hourly NEAR reference price with ${entryName(e)}'s trades and refusals`}>
        {[0, 1, 2, 3, 4].map(k => { const v = lo - pad + ((hi - lo + 2 * pad) * k) / 4; return <g key={k}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          {Math.abs(y(v) - y(last.c)) > 14 && <text className="axis" x={W - P.r + 6} y={y(v) + 3}>{v.toFixed(3)}</text>}</g>; })}
        {dayTicks(t0, t1, x, height - 6, W < 560 ? 2 : 1)}
        {candles ? bars.map(b => {
          const col = b.c >= b.o ? "var(--up)" : "var(--down)", cx = x(b.t + HOUR / 2);
          return <g key={b.t}><line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} stroke={col} />
            <rect x={cx - bw / 2} y={y(Math.max(b.o, b.c))} width={bw} height={Math.max(1, Math.abs(y(b.o) - y(b.c)))} fill={col} /></g>;
        }) : <path d={path(PRICES.closes.map(([t, c]) => [x(t), y(c)]))} fill="none" stroke="var(--strong)" strokeWidth="1.5" />}
        <line x1={P.l} x2={W - P.r} y1={y(last.c)} y2={y(last.c)} stroke="var(--muted)" strokeDasharray="2 3" />
        <rect x={W - P.r + 2} y={y(last.c) - 8} width={P.r - 2} height={16} fill="var(--strong)" />
        <text className="axis" x={W - P.r + 6} y={y(last.c) + 3} style={{ fill: "var(--bg)" }}>{last.c.toFixed(3)}</text>
        {marks.map((m, k) => { const p = pos(m), on = hot?.k === k;
          return <g key={`${m.d.tx}-${m.d.seq}`} className={`mkg ${on ? "on" : ""}`} tabIndex={0} role="button" aria-label={`${M[m.kind].label} #${m.d.seq}, ${utc(m.t)}`}
            onMouseEnter={() => setHot(h => (h?.pin ? h : { k, pin: false }))} onFocus={() => setHot({ k, pin: false })}
            onClick={() => setHot(h => (h?.k === k && h.pin ? null : { k, pin: true }))}>
            <circle cx={p.x} cy={p.y - 4} r={9} fill="transparent" />
            <text className="mk" x={p.x} y={p.y} textAnchor="middle" fill={M[m.kind].c}>{M[m.kind].sym}</text>
          </g>; })}
      </svg>);
    if (hot && marks[hot.k]) {
      const m = marks[hot.k], p = pos(m), below = p.y < height / 2;
      card = <MarkCard m={m} n={n} left={Math.max(0, Math.min(p.x - 128, W - 256))} top={below ? p.y + 10 : p.y - 16} below={below} />;
    }
  }
  return (
    <div className="chart" ref={ref} style={{ minHeight: height }} onMouseLeave={() => setHot(h => (h?.pin ? h : null))}>
      {body}
      {card}
      {!bars.length && <div className="empty">No reference prices in this build</div>}
      <div className="lg">
        <span style={{ color: M.buy.c }}>▲ buy</span><span style={{ color: M.sell.c }}>▼ sell</span><span style={{ color: M.refuse.c }}>✗ refused</span>
        <span>{marks.length ? `${marks.length} on chart · hover or tap one` : "no trades or refusals this season"}</span>
      </div>
      <p className="note chart-src">{candles ? "Hourly candles" : "Hourly closes"}: reference price (Binance NEARUSDT), the price the league values at.{n.id === "testnet" ? " Testnet fills happen at testnet pool prices, far from it: each marker shows its fill." : " Each marker shows its fill."}</p>
    </div>);
}

const shortDate = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** A wider-board record's cumulative return against holding USDC (the zero line) and holding BTC, same window. */
/** Dollar axis label: −$1.2M, +$40k, $0. */
const usdTick = (x: number) => { const a = Math.abs(x), s = x > 0 ? "+" : x < 0 ? "−" : "";
  return s + (a >= 1e6 ? `$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}k` : `$${Math.round(a)}`); };

/** Cumulative return (unit "pct", a fraction) or cumulative PnL in dollars (unit "usd") against holding USDC and, where given, BTC. */
export function WiderEquity({ series, name, height = 280, unit = "pct" }: { series: [number, number, number | null][]; name: string; height?: number; unit?: "pct" | "usd" }) {
  const fmt = unit === "usd" ? usdTick : sign;
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hov, setHov] = useState<number | null>(null);
  const btc = series.filter((p): p is [number, number, number] => p[2] !== null);
  let body = null, card = null;
  if (W > 0 && series.length > 1) {
    const P = { l: 54, r: 14, t: 14, b: 24 };
    const t0 = series[0][0], t1 = series[series.length - 1][0];
    const vals = [0, ...series.map(p => p[1]), ...btc.map(p => p[2])], lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.08 || 0.01;
    const x = (t: number) => P.l + ((t - t0) / (t1 - t0 || 1)) * (W - P.l - P.r), y = (v: number) => P.t + ((hi + pad - v) / (hi - lo + 2 * pad)) * (height - P.t - P.b);
    const ticks = Math.max(2, Math.min(6, Math.floor(W / 120)));
    const end = series[series.length - 1][1];
    // Hover or drag: the nearest sampled point to the pointer.
    const near = (px: number) => { let k = 0; for (let i = 1; i < series.length; i++) if (Math.abs(x(series[i][0]) - px) < Math.abs(x(series[k][0]) - px)) k = i; return k; };
    const move = (ev: React.PointerEvent<SVGSVGElement>) => setHov(near(ev.clientX - ev.currentTarget.getBoundingClientRect().left));
    const h = hov !== null && hov < series.length ? series[hov] : null;
    if (h) {
      const hx = x(h[0]), right = hx > W / 2;
      card = (
        <div className="mkcard below" role="tooltip" style={{ left: right ? undefined : hx + 10, right: right ? W - hx + 10 : undefined, top: P.t, width: 200, pointerEvents: "none" }}>
          <div className="mh">{new Date(h[0]).toISOString().slice(0, 10)}<span>UTC</span></div>
          <div>{unit === "usd" ? "PnL" : "vault"} <b className={h[1] >= 0 ? "up" : "down"}>{fmt(h[1])}</b></div>
          <div>hold USDC <b>{unit === "usd" ? "$0" : "+0.0%"}</b></div>
          {h[2] !== null && <><div>hold BTC <b className={h[2] >= 0 ? "up" : "down"}>{sign(h[2])}</b></div>
            <div>vault vs BTC <b className={h[1] - h[2] >= 0 ? "up" : "down"}>{sign((1 + h[1]) / (1 + h[2]) - 1)}</b></div></>}
        </div>);
    }
    body = (
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`${name}: cumulative ${unit === "usd" ? "PnL in dollars" : "return"} against holding USDC${btc.length ? " and holding BTC" : ""}`}
        onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHov(null)} style={{ touchAction: "pan-y", cursor: "crosshair" }}>
        {[0, 1, 2, 3, 4].map(k => { const v = lo - pad + ((hi - lo + 2 * pad) * k) / 4; return <g key={k}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          <text className="axis" x={P.l - 6} y={y(v) + 3} textAnchor="end">{fmt(v)}</text></g>; })}
        {Array.from({ length: ticks + 1 }, (_, k) => t0 + ((t1 - t0) * k) / ticks).map((t, k) =>
          <text key={k} className="axis" x={x(t)} y={height - 6} textAnchor={k === 0 ? "start" : k === ticks ? "end" : "middle"}>{shortDate(t)}</text>)}
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="var(--strong)" strokeWidth="1.4" strokeDasharray="5 4" opacity=".8" />
        {btc.length > 1 && <path d={path(btc.map(p => [x(p[0]), y(p[2])]))} fill="none" stroke="var(--sky)" strokeWidth="1.4" />}
        <path d={path(series.map(p => [x(p[0]), y(p[1])]))} fill="none" stroke={end >= 0 ? "var(--up)" : "var(--down)"} strokeWidth="2.2" />
        {h && <g pointerEvents="none">
          <line x1={x(h[0])} x2={x(h[0])} y1={P.t} y2={height - P.b} stroke="var(--muted)" strokeDasharray="3 3" />
          <circle cx={x(h[0])} cy={y(h[1])} r="4" fill={end >= 0 ? "var(--up)" : "var(--down)"} stroke="var(--panel)" strokeWidth="2" />
          {h[2] !== null && <circle cx={x(h[0])} cy={y(h[2])} r="3.5" fill="var(--sky)" stroke="var(--panel)" strokeWidth="2" />}
        </g>}
      </svg>);
  }
  return (
    <div className="chart" ref={ref} style={{ minHeight: height }}>
      {body}{card}
      <div className="lg">
        <span><i style={{ background: series.length && series[series.length - 1][1] < 0 ? "var(--down)" : "var(--up)" }} />{unit === "usd" ? "PnL" : "vault"}</span>
        <span><i className="dash" />hold USDC ({unit === "usd" ? "$0" : "0%"})</span>
        {btc.length > 0 && <span><i style={{ background: "var(--sky)" }} />hold BTC</span>}
      </div>
    </div>);
}
