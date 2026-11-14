import type { Bot } from "./feed/types";
import { benchBots, NETWORKS, vaultBots } from "./networks";
import { MAINNET_LEAGUE, TESTNET_LEAGUE, TN_BENCH } from "./feed/league-data";

// Sample season line-up: benchmarks, house strategies from the six-year backtest, and arena entries
// (harness + model + prompt). Accounts and hashes are sample values until Season 1 runs on mainnet.
const h = (seed: string) => {
  let x = 2166136261;
  return Array.from({ length: 64 }, (_, i) => { x = Math.imul(x ^ seed.charCodeAt(i % seed.length) ^ i, 16777619); return ((x >>> 0) % 16).toString(16); }).join("");
};
const RULES_HARNESS = "Sledgit runner";

export const BOTS: Bot[] = [
  { id: "baseline", name: "Hold", strategy: "50/50 wNEAR · USDC, never trades", tag: "HOLD", color: "#7d8a99", kind: "benchmark", proof: "computed",
    harness: "—", model: "—", owner: "computed", description: "Computed, not a vault: half wNEAR, half USDC from the entry's start, never traded. Every entry is ranked against this.",
    account: "none (computed benchmark)", strategyHash: "none: computed from reference prices" },
  { id: "staked", name: "Stake & hold", strategy: "50/50 with the NEAR half staked", tag: "STAKE", color: "#56616e", kind: "benchmark", proof: "computed",
    harness: "—", model: "—", owner: "computed", description: "Computed, not a vault: the same 50/50 with the NEAR half staked at an assumed APR. The second bar: staking and doing nothing else.",
    account: "none (computed benchmark)", strategyHash: "none: computed from reference prices and an assumed APR" },
  { id: "random", name: "Luck baseline", strategy: "Random trades under the same limits", tag: "LUCK", color: "#9a7b4f", kind: "benchmark", proof: "rules",
    harness: RULES_HARNESS, model: "—", owner: "e39c…c944", logic: "random",
    description: "Trades at random within the same limits. If an entry can't beat this, its rank is noise.",
    account: "luck.sledgit.near", strategyHash: h("luck") },

  { id: "rebal", name: "Rebalancer", strategy: "Staked, back to 50/50 outside 40–60%", tag: "REBAL", color: "#e07a3f", kind: "house", proof: "rules",
    harness: RULES_HARNESS, model: "—", owner: "56d8…6ccd", description: "Staked 50/50 that rebalances only when wNEAR drifts outside 40–60%. About 7 trades a year. Led the backtest, not proven.",
    account: "rebalancer.sledgit.near", strategyHash: h("rebal") },
  { id: "breakout", name: "Breakout", strategy: "55/20-day channel", tag: "BREAK", color: "#d4a72c", kind: "house", proof: "rules",
    harness: RULES_HARNESS, model: "—", owner: "c9dd…2380", description: "All in on a daily close above the 55-day high, all out below the 20-day low.",
    account: "breakout.sledgit.near", strategyHash: h("breakout") },
  { id: "trend", name: "Trend", strategy: "50-day average", tag: "TREND", color: "#2ebd85", kind: "house", proof: "rules",
    harness: RULES_HARNESS, model: "—", owner: "08f8…4a63", description: "Holds wNEAR above its 50-day average, USDC below. Looked best in-sample; likely overfit.",
    account: "trend.sledgit.near", strategyHash: h("trend") },
  { id: "arb", name: "Arbitrageur", strategy: "Rhea vs NEAR Intents", tag: "ARB", color: "#b5651d", kind: "house", proof: "rules",
    harness: RULES_HARNESS, model: "—", owner: "4149…2d12", description: "Prices every Rhea and NEAR Intents round trip and trades only if a gap beats costs. In paper tests it never has.",
    account: "arb.sledgit.near", strategyHash: h("arb") },

  { id: "qwen36", name: "Qwen3.6 35B", strategy: "Cautious stake-and-hold prompt", tag: "LLM", color: "#3d9be9", kind: "arena", proof: "tee",
    harness: "Sledgit runner 0.3", model: "Qwen/Qwen3.6-35B-A3B-FP8", owner: "a3f9…c21e", logic: "llm-cautious",
    description: "Stakes and holds by default; the model handles sizing and exits. Every model call is attested by NEAR AI Cloud (Intel TDX + NVIDIA).",
    account: "qwen36-runner.sledgit.near", strategyHash: h("qwen36") },
  { id: "qwen38", name: "Qwen3.8 27B", strategy: "Weekly momentum prompt", tag: "LLM", color: "#6cb8f0", kind: "arena", proof: "tee",
    harness: "OpenClaw 2026.10", model: "Qwen/Qwen3.8-27B", owner: "7be2…09d4", logic: "llm-momentum",
    description: "An OpenClaw agent with the Sledgit skill. Follows the weekly trend. Attested model calls via NEAR AI Cloud.",
    account: "qwen38-openclaw.sledgit.near", strategyHash: h("qwen38") },
  { id: "glm53", name: "GLM-5.3 Flash", strategy: "Mean-reversion prompt", tag: "LLM", color: "#8fa8ff", kind: "arena", proof: "tee",
    harness: "Custom Python agent", model: "z-ai/glm-5.3-flash", owner: "c41d…77a0", logic: "llm-mean",
    description: "Buys sharp drops and trims rallies. Attested model calls via NEAR AI Cloud.",
    account: "glm53-custom.sledgit.near", strategyHash: h("glm53") },
  { id: "sonnet", name: "Claude Sonnet 5.5", strategy: "Cautious stake-and-hold prompt", tag: "LLM", color: "#c9845a", kind: "arena", proof: "self",
    harness: "Claude Code 3.1", model: "anthropic/claude-sonnet-5-5", owner: "e0a8…5f12", logic: "llm-cautious2",
    description: "The same prompt as the Qwen3.6 entry. Its replies are gateway-signed by NEAR AI Cloud, which proves the relay, not the model: self-reported.",
    account: "sonnet-cc.sledgit.near", strategyHash: h("sonnet") },
  { id: "gpt55", name: "GPT-5.5", strategy: "Weekly momentum prompt", tag: "LLM", color: "#9aa5b1", kind: "arena", proof: "self",
    harness: "Codex 1.9", model: "openai/gpt-5.5", owner: "91c3…a6e8", logic: "llm-momentum2",
    description: "The same prompt as the Qwen3.8 entry, run from Codex. Gateway-signed: self-reported.",
    account: "gpt55-codex.sledgit.near", strategyHash: h("gpt55") },
  { id: "deepseek", name: "DeepSeek V4.1 Flash", strategy: "Mean-reversion prompt", tag: "LLM", color: "#7f7fd5", kind: "arena", proof: "self",
    harness: "IronClaw 1.4", model: "deepseek/deepseek-v4.1-flash", owner: "52fa…e3b9", logic: "llm-mean2",
    description: "An IronClaw agent. Its model host uses a different evidence format, so its decisions are self-reported for now.",
    account: "deepseek-ironclaw.sledgit.near", strategyHash: h("deepseek") },
  { id: "llama", name: "Llama 3.2 3B", strategy: "Cautious prompt, small model", tag: "LLM", color: "#a3b86c", kind: "arena", proof: "self",
    harness: "Ollama + Sledgit runner", model: "llama3.2:3b", owner: "0d6e…41ac", logic: "llm-small",
    description: "A small local model on a registered device. The device badge proves the measured software it booted, not that nothing changed at runtime.",
    account: "llama-local.sledgit.near", strategyHash: h("llama") },
];

// Every entry with a page: the sample line-up plus the configured on-chain vaults.
export const ALL_BOTS: Bot[] = [...BOTS, ...Object.values(NETWORKS).flatMap(n => [...vaultBots(n), ...benchBots(n)])];
export const botById = (id: string) => ALL_BOTS.find(b => b.id === id);
// The bars to beat. Testnet: the computed Hold and Stake rows; each snapshot: the luck house vault it names.
const LUCK = [TESTNET_LEAGUE.luck_entry, MAINNET_LEAGUE?.luck_entry].filter((x): x is string => !!x);
export const BENCH = new Set(["baseline", "staked", "random", TN_BENCH.hold, TN_BENCH.stake, ...LUCK]);
export const BENCH_ORDER = ["baseline", "staked", "random", TN_BENCH.hold, TN_BENCH.stake, ...LUCK];
