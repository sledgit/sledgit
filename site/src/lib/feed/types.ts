// Event shapes shared by the simulated feed and the NEAR feeds.
import type { NetworkId } from "../networks";

// How an entry's decisions are proven. tee: model call attested via NEAR AI Cloud; tpm: registered device;
// rules: deterministic strategy anyone can rerun; self: the operator's word (incl. gateway-signed closed models);
// computed: a benchmark calculated from prices, with no vault and no decisions.
export type Proof = "tee" | "tpm" | "rules" | "self" | "computed";
export type EntryKind = "benchmark" | "house" | "arena" | "vault";

export interface Bot {
  id: string;
  name: string;
  strategy: string;
  description: string;
  color: string;
  tag: string;
  kind: EntryKind;
  proof: Proof;
  harness: string;      // agent software
  model: string;        // model id, or "—" for rules
  logic?: string;       // simulated behaviour (defaults to id)
  owner: string;
  account: string;      // vault sub-account on NEAR
  strategyHash: string; // sha256 of prompt + config, registered before the first trade
}

export interface Candle { o: number; h: number; l: number; c: number; t: number }

export type DecisionKind = "trade" | "skip" | "refuse";

export interface Decision {
  type: "decision";
  id: string;           // receipt id
  kind: DecisionKind;
  botId: string;
  at: number;           // league seconds
  reason: string;
  side?: "buy" | "sell";
  usd?: number;
  price?: number;
  tx?: string;
  venue?: string;                          // where the trade filled
  costUsd?: number;                        // all-in cost above the fair (Binance) price
  alt?: { venue: string; costUsd: number }; // cheapest other allowed venue at that moment
  chain?: ChainRef;                        // set for decisions read from NEAR
  code?: string;                           // refusal code (simulated decisions)
}

// One vault NEP-297 event as logged by a vault, with where it was found.
export interface ChainEvent {
  event: string;
  data: Record<string, unknown>;
  txHash: string;
  receiptId: string;
  blockHeight: number;
  time: number;         // unix seconds
}

export interface ChainRef {
  txHash: string;
  receiptId: string;
  seq?: number;
  receiptHash?: string;
  venue?: string;       // raw venue: "rhea" | "intents"
  tokenIn?: string; amountIn?: string; tokenOut?: string; amountOut?: string;
  code?: string;
}

export interface VaultBalance { token: string; wallet: string; exchange: string; intents: string }

// What a NEAR feed knows about one vault: its views, balances, events and valuation.
export interface VaultView {
  botId: string;
  account: string;
  config?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  intents?: Record<string, unknown>;
  balances: VaultBalance[];
  events: ChainEvent[];
  price: number | null;      // reference price: quote units per traded token
  deposited: number;         // deposits valued at the reference price
  value: number | null;      // on-chain balances at the reference price
  replayValue: number;       // balances rebuilt from events, at the reference price
  holdValue: number;         // deposits minus withdrawals, held untouched, at the reference price
  errors: string[];
  league?: import("./league-data").LeagueEntry; // set when the view comes from the committed snapshot
}

export type FeedState = "loading" | "ready" | "error" | "offline";
export interface FeedStatus { state: FeedState; message: string; errors: string[]; updated?: number }

export interface Standing {
  botId: string; equity: number; trades: number; refused: number; decisions: number;
  vsHold: number;   // return relative to holding 50/50
  vsStake: number;  // return relative to stake and hold
  ci: number;       // 95% half-width of vsHold, from per-candle excess returns
  execPct: number;  // average cost paid above the fair price, % of traded value
  ranked: boolean;  // false until the minimum sample (7 days)
}

export type FeedEvent =
  | { type: "tick"; price: number; candle: Candle; at: number }
  | { type: "candle"; candle: Candle }
  | Decision
  | { type: "standings"; rows: Standing[] }
  | { type: "status"; status: FeedStatus }
  | { type: "vault"; vault: VaultView };

export interface Feed {
  name: string;
  network: NetworkId;
  simulated: boolean;
  candleSec: number;
  bots: Bot[];
  subscribe(fn: (e: FeedEvent) => void): () => void;
  start(): void;
  stop(): void;
  setSpeed(x: number): void;
}
