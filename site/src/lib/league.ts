"use client";
import { useSyncExternalStore } from "react";
import { createNearFeed } from "./feed/near";
import { createSimFeed } from "./feed/sim";
import { createSnapshotFeed } from "./feed/snapshot";
import type { Candle, Decision, Feed, FeedEvent, FeedStatus, Standing, VaultView } from "./feed/types";
import { leagueFor } from "./feed/league-data";
import { isNetwork, LIVE_NETWORK, type NetworkId } from "./networks";

// One league store per browser tab, shared by every page. Switching network replaces it.
export interface Pulse { kind: "up" | "down"; botId?: string; n: number }
export interface LeagueState {
  feed: Feed;
  network: NetworkId;
  status: FeedStatus;
  vaults: Record<string, VaultView>;
  price: number | null;
  prevPrice: number | null;
  at: number;
  candles: Candle[];
  live: Candle | null;
  decisions: Decision[];
  standings: Standing[];
  race: Record<string, number[]>;
  equityHistory: Record<string, number[]>;
  counts: { decisions: number; trades: number; skips: number; refused: number };
  pulse: Pulse | null;
  speed: number;
}

const MAX_DECISIONS = 300, MAX_CANDLES = 400, MAX_SERIES = 300;
// v2: the default moved from the simulation to testnet. A new live network gets its own key, so saved choices reset to it.
const NET_KEY = LIVE_NETWORK === "testnet" ? "it-net-v2" : `it-net-v3-${LIVE_NETWORK}`;
let state: LeagueState | null = null;
let unsubs: (() => void)[] = [];
let version = 0;
const listeners = new Set<() => void>();
const notify = () => { version++; listeners.forEach(l => l()); };

// Network choice: ?net= in the URL, then the saved choice, then the build default, then the live network.
function chosenNetwork(): NetworkId {
  const q = new URLSearchParams(location.search).get("net");
  if (isNetwork(q)) { saveNetwork(q); return q; }
  try {
    const saved = localStorage.getItem(NET_KEY);
    if (isNetwork(saved)) return saved;
  } catch (e) {
    console.warn("network choice not readable, using the default", e);
  }
  const env = process.env.NEXT_PUBLIC_FEED;
  return env === "near" ? LIVE_NETWORK : isNetwork(env) ? env : LIVE_NETWORK;
}

function saveNetwork(n: NetworkId) {
  try { localStorage.setItem(NET_KEY, n); } catch (e) { console.warn("network choice not saved", e); }
}

function init(network: NetworkId): LeagueState {
  // A network with a committed leaderboard snapshot (read from the chain) shows it; one without reads the chain directly.
  const feed = network === "sim" ? createSimFeed() : leagueFor(network) ? createSnapshotFeed(network) : createNearFeed(network);
  const s: LeagueState = {
    feed, network, vaults: {},
    status: network === "sim" ? { state: "ready", message: "Simulated season", errors: [] } : { state: "loading", message: "Connecting…", errors: [] },
    price: null, prevPrice: null, at: 0, candles: [], live: null, decisions: [], standings: [],
    race: Object.fromEntries(feed.bots.map(b => [b.id, []])),
    equityHistory: Object.fromEntries(feed.bots.map(b => [b.id, []])),
    counts: { decisions: 0, trades: 0, skips: 0, refused: 0 }, pulse: null, speed: 10,
  };
  let pulseN = 0;
  unsubs.push(feed.subscribe((e: FeedEvent) => {
    switch (e.type) {
      case "tick": s.prevPrice = s.price; s.price = e.price; s.live = e.candle; s.at = e.at; break;
      case "candle":
        s.candles.push(e.candle); s.live = null;
        if (s.candles.length > MAX_CANDLES) s.candles.shift();
        break;
      case "decision":
        pushDecision(s.decisions, e, MAX_DECISIONS);
        s.counts.decisions++;
        if (e.kind === "skip") s.counts.skips++;
        else if (e.kind === "refuse") { s.counts.refused++; s.pulse = { kind: "down", botId: e.botId, n: ++pulseN }; }
        else { s.counts.trades++; if (e.side === "buy" || e.side === "sell") s.pulse = { kind: e.side === "buy" ? "up" : "down", botId: e.botId, n: ++pulseN }; }
        break;
      case "standings":
        s.standings = e.rows;
        for (const r of e.rows) {
          (s.race[r.botId] ??= []).push(r.vsHold);
          (s.equityHistory[r.botId] ??= []).push(r.equity);
          if (s.race[r.botId].length > MAX_SERIES) s.race[r.botId].shift();
          if (s.equityHistory[r.botId].length > MAX_SERIES) s.equityHistory[r.botId].shift();
        }
        break;
      case "status": s.status = e.status; break;
      case "vault": s.vaults = { ...s.vaults, [e.vault.botId]: e.vault }; break;
    }
  }));
  return s;
}

let flushQueued = false;
function ensure(): LeagueState {
  if (!state) {
    state = init(chosenNetwork());
    // Coalesce bursts of events into one render per frame.
    unsubs.push(state.feed.subscribe(() => {
      if (flushQueued) return;
      flushQueued = true;
      requestAnimationFrame(() => { flushQueued = false; notify(); });
    }));
    state.feed.start();
  }
  return state;
}

/** Newest first, at most `max`. When full, the oldest hold goes first: trades and refusals are the evidence. */
export function pushDecision(list: Decision[], d: Decision, max: number): void {
  list.unshift(d);
  if (list.length <= max) return;
  let i = list.length - 1;
  while (i >= 0 && list[i].kind !== "skip") i--;
  list.splice(i >= 0 ? i : list.length - 1, 1);
}

export function useLeague(): LeagueState | null {
  const snap = useSyncExternalStore(
    l => { ensure(); listeners.add(l); return () => { listeners.delete(l); }; },
    () => version,
    () => -1,
  );
  // -1 = server render or hydration: render the empty shell, then fill in on the client
  return snap === -1 ? null : ensure();
}

export function setSpeed(x: number) { const s = ensure(); s.speed = x; s.feed.setSpeed(x); notify(); }

export function setNetwork(n: NetworkId) {
  if (state?.network === n) return;
  saveNetwork(n);
  const url = new URL(location.href);
  if (url.searchParams.has("net")) { url.searchParams.set("net", n); history.replaceState(history.state, "", url); }
  state?.feed.stop();
  unsubs.forEach(u => u());
  unsubs = [];
  state = null;
  ensure();
  notify();
}
