import { BOTS } from "../bots";
import type { Bot, Candle, Feed, FeedEvent, Standing } from "./types";

// Simulated season on 4-hour candles. Strategies match the backtested line-up and decide on daily closes.
// Emits the same events the mainnet feed will.
const GAS_USD = 0.01, START_USD = 100;
// Cost above the fair price per venue, in % of trade value: ranges measured with dry quotes on 28 Oct 2026.
const VENUES = [{ name: "NEAR Intents", lo: 0.13, hi: 0.21 }, { name: "Rhea", lo: 0.24, hi: 0.34 }];
export const RULES = { perTrade: 50, perDay: 100 };     // the vault's limits, in USDC
const TICK_SEC = 480, TICKS_PER_CANDLE = 30;            // 4-hour candles
const CANDLE_SEC = TICK_SEC * TICKS_PER_CANDLE, PER_DAY = 6;
const HISTORY_CANDLES = 60 * PER_DAY;                    // pre-season price history for the 55-day and 50-day rules
const PRIME_CANDLES = 54;                                // the page opens 9 days into the season, after ranking starts
const MIN_RANK_CANDLES = 7 * PER_DAY;                    // unranked until 7 days of decisions
const STAKE_APR = 0.045;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const STAKED = new Set(["staked", "rebal", "qwen36", "sonnet", "llama"]);

interface BotState { usdc: number; near: number; trades: number; refused: number; decisions: number; spentToday: number; excess: number[]; costPaid: number; traded: number }

export function createSimFeed(): Feed {
  const subs = new Set<(e: FeedEvent) => void>();
  const emit = (e: FeedEvent) => subs.forEach(f => f(e));
  let price = 4.2, drift = 0, tick = -HISTORY_CANDLES * TICKS_PER_CANDLE, speed = 10;
  let timer: ReturnType<typeof setInterval> | undefined;
  let candle: Candle | null = null;
  const closes: number[] = [], highs: number[] = [], lows: number[] = [];
  const daily = { c: [] as number[], h: [] as number[], l: [] as number[] };
  let st: Record<string, BotState> = {};
  const prevEq: Record<string, number> = {};
  const equity = (id: string) => st[id].usdc + st[id].near * price;
  const at = () => tick * TICK_SEC;
  const inSeason = () => tick >= 0;
  const receipt = () => "rcpt_" + hex(8);

  function openSeason() {
    st = Object.fromEntries(BOTS.map(b => [b.id, {
      usdc: START_USD / 2, near: (START_USD / 2) * (1 - 0.0015) / price, trades: 0, refused: 0, decisions: 0, spentToday: 0, excess: [],
      costPaid: 0, traded: 0 }]));
    for (const b of BOTS) prevEq[b.id] = equity(b.id);
  }

  // Every request passes the vault's fixed rules before anything is signed.
  function trade(b: Bot, side: "buy" | "sell", usd: number, reason: string) {
    const s = st[b.id];
    const breach: [string, string] | null = usd > RULES.perTrade ? ["trade_cap", `per-trade cap is ${RULES.perTrade} USDC`]
      : s.spentToday + usd > RULES.perDay ? ["daily_cap", `daily cap is ${RULES.perDay} USDC, ${s.spentToday.toFixed(0)} used`] : null;
    if (breach) return refuse(b, breach[0], `asked to ${side} ${usd.toFixed(2)} USDC; ${breach[1]}`, usd, side);
    s.decisions++;
    if (side === "buy") { usd = Math.min(usd, s.usdc - GAS_USD); if (usd < 1) return; }
    else { usd = Math.min(usd, s.near * price); if (usd < 1) return; }
    // Quote every allowed venue, fill on the cheapest, keep the runner-up for the receipt.
    const quotes = VENUES.map(v => ({ venue: v.name, costUsd: usd * rnd(v.lo, v.hi) / 100 + GAS_USD })).sort((a, z) => a.costUsd - z.costUsd);
    const fill = quotes[0];
    if (side === "buy") { s.usdc -= usd; s.near += (usd - fill.costUsd) / price; }
    else { s.near -= usd / price; s.usdc += usd - fill.costUsd; }
    s.trades++; s.spentToday += usd; s.costPaid += fill.costUsd; s.traded += usd;
    emit({ type: "decision", id: receipt(), kind: "trade", botId: b.id, at: at(), side, usd, price, reason, tx: hex(5) + "…" + hex(5),
      venue: fill.venue, costUsd: fill.costUsd, alt: quotes[1] });
  }
  function refuse(b: Bot, code: string, reason: string, usd?: number, side?: "buy" | "sell") {
    const s = st[b.id];
    s.decisions++; s.refused++;
    emit({ type: "decision", id: receipt(), kind: "refuse", botId: b.id, at: at(), usd, side, reason, code });
  }
  function skip(b: Bot, reason: string) {
    st[b.id].decisions++;
    emit({ type: "decision", id: receipt(), kind: "skip", botId: b.id, at: at(), reason });
  }
  // Step toward a wNEAR weight, one capped trade per decision.
  function toward(b: Bot, w: number, reason: string) {
    const s = st[b.id], delta = w * equity(b.id) - s.near * price;
    if (Math.abs(delta) < 1) return skip(b, `on target · ${reason}`);
    trade(b, delta > 0 ? "buy" : "sell", Math.min(Math.abs(delta), RULES.perTrade), reason);
  }

  function decide(b: Bot, dayClose: boolean) {
    const s = st[b.id], dc = daily.c, n = dc.length;
    if (STAKED.has(b.id)) s.near *= 1 + STAKE_APR / (365 * PER_DAY);
    const weight = () => (s.near * price) / equity(b.id);
    const wait = () => undefined;          // daily strategies only decide at the daily close
    const week = n > 7 ? dc[n - 1] / dc[n - 8] - 1 : 0;
    switch (b.logic ?? b.id) {
      case "baseline": case "staked": return;
      case "random": {
        if (!dayClose || Math.random() < 0.5) return wait();
        return Math.random() < 0.5 ? skip(b, "coin says hold") : trade(b, Math.random() < 0.5 ? "buy" : "sell", rnd(5, 45), "coin says trade");
      }
      case "llm-momentum": case "llm-momentum2": {
        if (!dayClose) return wait();
        const hot = b.logic === "llm-momentum2" ? 1.6 : 1;
        if (week > 0.03) {
          if (Math.random() < 0.12 * hot) return refuse(b, "pair_not_allowed", "asked to buy ETH via NEAR Intents; this vault allows wNEAR ↔ USDC only");
          return trade(b, "buy", Math.min(equity(b.id) * 0.3 * hot, 80), `up ${(week * 100).toFixed(1)}% this week, adding`);
        }
        if (week < -0.03) return trade(b, "sell", Math.min(equity(b.id) * 0.3 * hot, 80), `down ${(-week * 100).toFixed(1)}% this week, reducing`);
        return skip(b, "no clear weekly trend");
      }
      case "llm-mean": case "llm-mean2": {
        const last = n > 1 ? dc[n - 1] / dc[n - 2] - 1 : 0;
        if (!dayClose) return wait();
        if (last < -0.04) return trade(b, "buy", b.logic === "llm-mean2" ? 60 : 35, `fell ${(-last * 100).toFixed(1)}% today, buying the drop`);
        if (last > 0.04) return trade(b, "sell", b.logic === "llm-mean2" ? 60 : 35, `rose ${(last * 100).toFixed(1)}% today, trimming`);
        if (Math.random() < 0.06) return refuse(b, "rate_limit", "asked for a second trade this hour; the limit is 1 per hour");
        return skip(b, "move within normal range");
      }
      case "arb":
        return skip(b, `Rhea vs Intents best round trip ${(rnd(-0.75, -0.11)).toFixed(2)}% after costs, no gap`);
      case "rebal": {
        if (!dayClose) return wait();
        const w = weight();
        if (Math.abs(w - 0.5) < 0.1) return skip(b, `wNEAR weight ${(w * 100).toFixed(1)}%, band is 40–60%`);
        return toward(b, 0.5, `wNEAR weight ${(w * 100).toFixed(1)}%, back to 50/50`);
      }
      case "breakout": {
        if (!dayClose) return wait();
        const hi = Math.max(...daily.h.slice(n - 56, n - 1)), lo = Math.min(...daily.l.slice(n - 21, n - 1)), w = weight();
        if (dc[n - 1] > hi) return toward(b, 1, `closed above the 55-day high ${hi.toFixed(3)}`);
        if (dc[n - 1] < lo) return toward(b, 0, `closed below the 20-day low ${lo.toFixed(3)}`);
        if (w > 0.02 && w < 0.98 && Math.abs(w - 0.5) > 0.05) return toward(b, w > 0.5 ? 1 : 0, "finishing the last move");
        return skip(b, `inside the channel ${lo.toFixed(3)}–${hi.toFixed(3)}`);
      }
      case "trend": {
        if (!dayClose) return wait();
        const sma = dc.slice(-50).reduce((a, x) => a + x, 0) / 50;
        return price > sma ? toward(b, 1, `daily close above the 50-day average ${sma.toFixed(3)}`)
          : toward(b, 0, `daily close below the 50-day average ${sma.toFixed(3)}`);
      }
      case "llm-cautious": case "llm-cautious2": case "llm-small": {
        const w = weight();
        if (b.logic === "llm-small" && Math.random() < 0.01) return refuse(b, "busy", "asked for a second swap while one was still in flight");
        if (week < -0.08 && w > 0.3) {
          const ask = Math.random() < 0.4 ? equity(b.id) * 0.6 : equity(b.id) * 0.25;
          return trade(b, "sell", ask, `down ${(week * -100).toFixed(0)}% this week, cutting exposure`);
        }
        if (week > 0.04 && w < 0.45) return toward(b, 0.5, "drawdown over, back to stake and hold");
        return skip(b, pick(["staked and holding, nothing to do", "no reason to act this candle", "volatility normal, staying put"]));
      }
    }
  }

  function standings(): Standing[] {
    const base = equity("baseline"), stake = equity("staked");
    return BOTS.map(b => {
      const s = st[b.id], x = s.excess, m = x.length;
      const mean = m ? x.reduce((a, v) => a + v, 0) / m : 0;
      const sd = m > 2 ? Math.sqrt(x.reduce((a, v) => a + (v - mean) ** 2, 0) / (m - 1)) : 0;
      return { botId: b.id, equity: equity(b.id), vsHold: equity(b.id) / base - 1, vsStake: equity(b.id) / stake - 1,
        ci: 1.96 * sd * Math.sqrt(m), execPct: s.traded ? s.costPaid / s.traded * 100 : 0, decisions: s.decisions, ranked: m >= MIN_RANK_CANDLES, trades: s.trades, refused: s.refused };
    });
  }

  function closeCandle(c: Candle) {
    closes.push(c.c); highs.push(c.h); lows.push(c.l);
    const dayClose = closes.length % PER_DAY === 0;
    if (dayClose) {
      daily.c.push(c.c); daily.h.push(Math.max(...highs.slice(-PER_DAY))); daily.l.push(Math.min(...lows.slice(-PER_DAY)));
    }
    if (!inSeason()) return;
    if (dayClose) for (const b of BOTS) st[b.id].spentToday = 0;
    BOTS.forEach(b => decide(b, dayClose));
    const hold = equity("baseline") / prevEq["baseline"];
    for (const b of BOTS) { st[b.id].excess.push(Math.log(equity(b.id) / prevEq[b.id] / hold)); prevEq[b.id] = equity(b.id); }
    emit({ type: "standings", rows: standings() });
  }

  function step() {
    tick++;
    if (tick === 0) openSeason();
    if (tick % 600 === 0) drift = rnd(-0.00012, 0.00013);
    price *= Math.exp(drift + rnd(-1, 1) * 0.0055);
    if (!candle) candle = { o: price, h: price, l: price, c: price, t: at() };
    candle.h = Math.max(candle.h, price); candle.l = Math.min(candle.l, price); candle.c = price;
    emit({ type: "tick", price, candle: { ...candle }, at: Math.max(0, at()) });
    if (tick % TICKS_PER_CANDLE === 0) {
      emit({ type: "candle", candle: { ...candle } });
      closeCandle(candle);
      candle = null;
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { for (let i = 0; i < Math.max(1, speed / 10); i++) step(); }, 1000 / Math.min(speed, 10));
  }

  return {
    name: "simulated", network: "sim", simulated: true, bots: BOTS, candleSec: CANDLE_SEC,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    start() { for (let i = 0; i < (HISTORY_CANDLES + PRIME_CANDLES) * TICKS_PER_CANDLE; i++) step(); schedule(); },
    stop() { if (timer) clearInterval(timer); },
    setSpeed(x) { speed = x; schedule(); },
  };
}
