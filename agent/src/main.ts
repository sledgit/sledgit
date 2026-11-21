// sledgit command implementations. cli.ts is the process entry; tests call main() with fakes.
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { selectNetwork, loadAgentKey, redact, boundedInt, envOf, type Network } from "./config.js";
import { Vault, type TxResult, type Outcome } from "./vault.js";
import { toUnits, fromUnits, clipBytes, type Decision } from "./decision.js";
import { sealReceipt, appendLine, verifyFile, canonical, sha256Hex, type Json } from "./receipt.js";
import { makeModel, type Model } from "./models.js";
import { nearUsdt, type RefPrice } from "./price.js";
import { tick, loadPrompt, attestationsDir } from "./arena.js";
import { HOUSE_RULES, houseRule } from "./strategies/house.js";
import { PAIRS } from "./pairs.js";
import { dailyCandles } from "./strategies/market.js";
import { houseRerun as rerunRows, houseCheck, type RerunRow } from "./strategies/rerun.js";
import { chainState, nextSlot, SCHEDULE } from "./strategies/schedule.js";
import { verifyReceipts, readIfExists, rowPasses, type EventSource } from "./verify.js";
import { cachedProvenance } from "./provenance.js";
import { relayKey, bestQuote, publish, waitSettled } from "./solver.js";
import { nearAiModel, NEARAI_API } from "./attest/nearai.js";
import { nrasOnline, checkReport, dcapVerifyQuote, readCapped, MAX_MODEL_REPORTS, type VerifyDeps, type QuoteFacts } from "./attest/verify.js";
import { nearAiPolicy, policyDiff, type RolePolicy, type ModelPolicy } from "./attest/policy.js";
import { runVerifyAttestation } from "./attest/season.js";
import type { TeeBundle, NearReport } from "./attest/evidence.js";
import type { Receipt } from "./receipt.js";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

/** Arena bounds: a typo must not become an endless, back-to-back loop of model calls and transactions. */
export const MAX_TICKS = 1000;
export const MIN_INTERVAL_S = 30;
export const MAX_INTERVAL_S = 86_400;

export const USAGE = `sledgit <command> [options]

  status                         config, policy, usage, balances, in-flight swap, open intent
  preview <buy|sell> <amount>    dry-run the policy check (free view call)
  swap    <buy|sell> <amount>    Rhea swap: receipt -> preview -> request_swap   [--min <decimal>] [--reason <text>]
  intent  <buy|sell> <amount>    NEAR Intents swap: receipt -> preview -> request_intent_swap; prints and saves the
                                 signed multi_payload; [--publish]: sign at the best solver quote and publish it (needs a relay JWT)
  skip    <note>                 receipt -> log_skip
  settle                         intents_settle (record a finished intent); exit 1 if nothing was recorded
  cancel                         intents_cancel (burn the open intent's nonce); exit 1 unless intent_cancelled
  freeze                         stop all trading on this vault (owner must unfreeze); cancel any open intent too
  verify  <receipts.jsonl>       match every receipt to the vault's on-chain event   [--outcomes <file>]
                                 exit 1 unless every receipt is on chain; [--allow-dry-run] accepts dry runs too
  lint    <receipts.jsonl>       offline: re-hash lines and flag non-canonical ones
  attest-policy --model <id>     keyless: fetch fresh NEAR AI reports, verify them, and mark each measured value pinned or
                                 NEW against agent/src/attest/nearai-policy.json (review NEW values; never auto-added)
  verify-attestation <file>      a TEE bundle (.json) or receipts (.jsonl): verify quotes, GPU evidence and the model's
                                 signature; for receipts, check the season against the vault's on-chain decisions
                                 [--from-seq N] and print each decision and the TEE pill (exit 1 = no pill)
  arena                          [--provider anthropic|openai-compatible|echo] [--model <id>] [--ticks 1..${MAX_TICKS}]
                                 [--interval ${MIN_INTERVAL_S}..${MAX_INTERVAL_S} seconds] [--dry-run]; stops when the vault is frozen or the agent replaced
                                 [--attest tee]: call --model through NEAR AI Cloud (NEAR_AI_CLOUD_API_KEY) and keep TEE evidence
                                 [--harness <name/version>]: the agent software recorded in receipts (self-reported)
  house --strategy <id>          a published rule-based house strategy (${HOUSE_RULES.map((x) => x.id).join(" | ")}); same ticks, receipts and
                                 limits as arena, plus closed daily candles and the vault's on-chain history; prompt_sha256 =
                                 the strategy hash. Ticks once per daily slot (${SCHEDULE.slot_utc} UTC, ${SCHEDULE.window_minutes} min window);
                                 [--off-schedule] ticks anyway and the receipt says so
  house-rerun <receipts.jsonl>   offline: re-run every rules receipt with the strategy version its hash names; exit 1 on
                                 any mismatch. [--check]: also check the receipt is the vault's own on-chain decision, the
                                 vault is genuine, the on-chain event records the receipt's decision, the decision is the
                                 rule's output, the candles are the feed's, and the balances, policy, usage and config the
                                 rule read are the chain's at the decision's transaction block (archival RPC). Lines
                                 that aren't rules receipts fail, unless [--skip-non-rules] (counted)

  "buy" spends the quote token for the base token; "sell" spends base for quote. Amounts are decimals in token_in units.
  Options: --vault <id> (or SLEDGIT_VAULT), --mainnet (needs SLEDGIT_MAINNET_CONFIRM), --receipts <dir>
  Agent key: SLEDGIT_KEY_FILE=<path to JSON key file>, SLEDGIT_AGENT=<account> if the file has no account_id.
  Signing commands refuse a vault that isn't a genuine Sledgit vault (testnet only: --allow-unverified-vault).
  Use a FunctionCall access key restricted to the vault's agent methods. Mainnet: a finite allowance (1 NEAR) on an
  agent account holding ~1.5 NEAR; testnet agents may run uncapped on ~1 NEAR (see SKILL.md section 8).`;

export interface MainDeps {
  env?: NodeJS.ProcessEnv;
  log?: (s: string) => void;
  warn?: (s: string) => void;
  makeVault?: (net: Network, id: string) => Vault;
  makeModel?: (provider: string, id: string, env: NodeJS.ProcessEnv) => Model;
  price?: () => Promise<RefPrice>;
  /** Market data recorded in the inputs: daily candles for house strategies (tests), or an arena agent's own feed
   * (demo-trader's candles and Kronos signal). */
  market?: () => Promise<Json>;
  /** House strategies' on-chain state (tests); default: the chain, via strategies/schedule.ts. */
  chainState?: (vault: string, base: string, seq: number, now: number) => Promise<import("./strategies/schedule.js").ChainState>;
  /** Clock (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  makeAttested?: (id: string, env: NodeJS.ProcessEnv) => Model;
  verifyDeps?: VerifyDeps;
  /** HTTP for attest-policy (tests). */
  fetchImpl?: typeof fetch;
  /** Vault provenance for verify (tests); default: the chain, via provenance.ts. */
  provenance?: EventSource["provenance"];
}

/** The receipts file a check runs on. Missing or empty is an error, never a pass on nothing. */
function receiptsText(path: string, cmd: string): string {
  if (!existsSync(path)) throw new Error(`${cmd}: no such file ${path}`);
  const text = readFileSync(path, "utf8");
  if (!text.trim()) throw new Error(`${cmd}: ${path} has no receipts`);
  return text;
}

/** attest-policy: fresh reports for a model, verified, with each measured value marked pinned or NEW (never auto-added). */
async function attestPolicy(model: string, out: (v: unknown) => void, f: typeof fetch): Promise<number> {
  const nonce = randomBytes(32).toString("hex");
  const q = new URLSearchParams({ model, provider: "near", signing_algo: "ecdsa", include_tls_fingerprint: "false", nonce });
  const res = await f(`${NEARAI_API}/attestation/report?${q}`, { headers: { accept: "application/json", "x-no-aliasing": "true" },
    signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`attest-policy: NEAR AI report HTTP ${res.status}`);
  const rep = JSON.parse(await readCapped(res, 8 * 1024 * 1024, "NEAR AI report")) as TeeBundle["report"];
  const policy = nearAiPolicy();
  const deps = { verifyQuote: dcapVerifyQuote, nras: async () => undefined };
  const roles: { role: string; report: NearReport; pol: RolePolicy | undefined }[] = [
    { role: "gateway", report: rep.gateway_attestation, pol: policy.gateway },
    ...(rep.model_attestations ?? []).slice(0, MAX_MODEL_REPORTS).map((m, i) => ({ role: `model[${i}] ${String(m.model_name)}`, report: m, pol: policy.models[model] })),
  ];
  const rows = [];
  let allPinned = true;
  for (const { role, report, pol } of roles) {
    const sink: { facts?: QuoteFacts } = {};
    const checks = (await checkReport(role, report, nonce, deps, false, sink)).filter((c) => c.ok !== true);
    // Values from a report that failed its own checks are unverified: never shown as candidates to pin.
    if (checks.length) {
      allPinned = false;
      rows.push({ role, report_checks_failed: checks.map((c) => c.name), all_pinned: false });
      continue;
    }
    const diff = policyDiff(report, pol, sink.facts);
    const addr = String(report.signing_address).toLowerCase();
    const signer = role === "gateway" ? undefined : { value: addr, pinned: !!(pol as ModelPolicy | undefined)?.signers.includes(addr) };
    const pinned = Object.values(diff).every((l) => l.every((x) => x.pinned)) && (signer?.pinned ?? true);
    allPinned &&= pinned;
    rows.push({ role, report_checks_failed: [], all_pinned: pinned, ...diff, ...(signer ? { signer } : {}) });
  }
  out({ model, note: "Review every value marked pinned: false before adding it to agent/src/attest/nearai-policy.json (see POLICY.md).", roles: rows });
  return allPinned ? 0 : 1;
}

/** verify-attestation: one bundle, or a season checked against the vault's on-chain decisions (attest/season.ts). */
async function verifyAttestation(path: string, out: (v: unknown) => void, deps: VerifyDeps, fromSeq?: number): Promise<number> {
  return runVerifyAttestation(path, receiptsText(path, "verify-attestation"), attestationsDir(path), out, { deps, fromSeq });
}

/** Exit 0 only when the vault recorded what the command was for. */
const SUCCESS: Record<string, Outcome["status"][]> = {
  swap: ["traded"], intent: ["authorized"], skip: ["skipped"], freeze: ["frozen"],
  settle: ["traded", "expired", "failed"], cancel: ["cancelled"],
};
export const commandSucceeded = (cmd: string, r: Pick<TxResult, "ok" | "outcome">): boolean =>
  r.ok && (SUCCESS[cmd] ?? []).includes(r.outcome.status);

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((s: string) => console.log(s));
  const warn = deps.warn ?? ((s: string) => console.error(s));
  const out = (v: unknown) => log(redact(typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2)));
  const makeVault = deps.makeVault ?? ((net: Network, id: string) => new Vault(net, id));

  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      vault: { type: "string" }, mainnet: { type: "boolean", default: false }, receipts: { type: "string" },
      min: { type: "string" }, reason: { type: "string" }, provider: { type: "string", default: "anthropic" },
      model: { type: "string" }, ticks: { type: "string", default: "1" }, interval: { type: "string", default: "300" },
      prompt: { type: "string" }, "dry-run": { type: "boolean", default: false }, "from-seq": { type: "string" }, help: { type: "boolean", short: "h" },
      outcomes: { type: "string" }, attest: { type: "string" }, harness: { type: "string" }, strategy: { type: "string" },
      "allow-dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false }, "off-schedule": { type: "boolean", default: false },
      "skip-non-rules": { type: "boolean", default: false }, "allow-unverified-vault": { type: "boolean", default: false }, publish: { type: "boolean", default: false },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || o.help) { out(USAGE); return o.help ? 0 : 2; }
  if (cmd === "lint") {
    if (!args[0]) throw new Error("lint <receipts.jsonl>");
    receiptsText(args[0], "lint");
    const rows = verifyFile(args[0]);
    out(rows);
    return rows.every((r) => r.canonical) ? 0 : 1;
  }
  if (cmd === "attest-policy") {
    // Keyless: fetch fresh NEAR AI reports, check them like verify-attestation does, and show what is and isn't pinned.
    if (!o.model) throw new Error("attest-policy --model <canonical NEAR AI model id>");
    return attestPolicy(o.model, out, deps.fetchImpl ?? fetch);
  }
  if (cmd === "house-rerun") {
    if (!args[0]) throw new Error("house-rerun <receipts.jsonl> [--check]");
    const text = receiptsText(args[0], "house-rerun");
    if (o.check) {
      // Re-run, then check the inputs against chain and feed: on-chain decision, genuine vault, candles, chain state.
      // A line that isn't a rules receipt fails the check unless --skip-non-rules says to skip it (and it's counted).
      const { skipped } = rerunRows(text);
      const rows = await houseCheck(text, o.mainnet ? "mainnet" : "testnet", { skipNonRules: o["skip-non-rules"] });
      const passed = rows.filter((r) => r.pass).length;
      out({ rows, checked: rows.length, passed, failed: rows.length - passed, non_rules_lines: skipped,
        non_rules: o["skip-non-rules"] ? "skipped (--skip-non-rules)" : "failed" });
      return rows.length > 0 && passed === rows.length ? 0 : 1;
    }
    const { rows, skipped } = rerunRows(text);
    out({ rows, skipped_non_rules_lines: skipped });
    return rows.length > 0 && rows.every((r) => r.same && r.hash_match && r.decision_consistent) ? 0 : 1;
  }
  if (cmd === "verify-attestation") {
    if (!args[0]) throw new Error("verify-attestation <bundle.json | receipts.jsonl>");
    const fromSeq = o["from-seq"] === undefined ? undefined : boundedInt(o["from-seq"], "--from-seq", 1, Number.MAX_SAFE_INTEGER);
    return verifyAttestation(args[0], out, deps.verifyDeps ?? { nras: nrasOnline }, fromSeq);
  }
  if (o.attest !== undefined && o.attest !== "tee") throw new Error("--attest takes one value: tee");
  // Validate loop bounds before any network call or key load.
  const looped = cmd === "arena" || cmd === "house";
  const ticks = looped ? boundedInt(o.ticks!, "--ticks", 1, MAX_TICKS) : 1;
  const intervalS = looped ? boundedInt(o.interval!, "--interval", MIN_INTERVAL_S, MAX_INTERVAL_S) : 0;
  const rule = cmd === "house" ? houseRule(o.strategy ?? "") : undefined;
  if (cmd === "house") {
    // A house strategy is its published rules; nothing else may shape its decisions or its receipts.
    const extra = (["attest", "prompt", "harness", "model"] as const).filter((k) => o[k] !== undefined);
    if (extra.length) throw new Error(`house takes no ${extra.map((k) => `--${k}`).join(", ")}: the strategy hash fixes the rules`);
  }

  const net = selectNetwork(o.mainnet, env);

  if (cmd === "verify") {
    if (!args[0]) throw new Error("verify <receipts.jsonl> [--outcomes <file>] [--allow-dry-run]");
    const vaults = new Map<string, Vault>();
    const vaultFor = async (id: string) => {
      let v = vaults.get(id);
      if (!v) { v = makeVault(net, id); await v.assertChain(); vaults.set(id, v); }
      return v;
    };
    const viewer = makeVault(net, net.base);
    const decimals = new Map<string, number>();
    let chainProvenance: EventSource["provenance"] | undefined;
    const src: EventSource = {
      txEvents: async (vault, tx, sender) => (await vaultFor(vault)).txEvents(tx, sender),
      decimals: async (token) => decimals.get(token) ?? decimals.set(token, await viewer.decimals(token)).get(token)!,
      provenance: deps.provenance ?? ((v) => (chainProvenance ??= cachedProvenance(net.id, viewer.reader()))(v)),
    };
    const outcomesPath = o.outcomes ?? join(dirname(args[0]), "outcomes.jsonl");
    const rows = await verifyReceipts(receiptsText(args[0], "verify"), readIfExists(outcomesPath), net, src);
    out(rows);
    const bad = rows.filter((r) => !rowPasses(r, o["allow-dry-run"]));
    warn(`verify: onchain ${rows.filter((r) => r.onchain).length} of ${rows.length}; ${bad.length ? `${bad.length} failed` : "all passed"}`);
    return bad.length ? 1 : 0;
  }

  const vaultId = o.vault || envOf(env, "VAULT");
  if (!vaultId) throw new Error("no vault: pass --vault or set SLEDGIT_VAULT");
  const vault = makeVault(net, vaultId);
  // The RPC must serve the selected network before any key is loaded or anything is signed.
  await vault.assertChain();
  const needsKey = !["status", "preview"].includes(cmd);
  if (needsKey) {
    // Sign only for a genuine Sledgit vault: a look-alike contract would get the agent's calls, gas and records.
    const prov = await (deps.provenance ?? ((v: string) => cachedProvenance(net.id, vault.reader())(v)))(vault.id);
    if (!prov.sledgit_vault) {
      // A directly deployed test vault is never genuine; one may be named exactly, never matched by a pattern.
      const namedTest = envOf(env, "TEST_VAULT") === vault.id;
      if (!(namedTest || (o["allow-unverified-vault"] && net.id === "testnet"))) {
        throw new Error(`${vault.id} is not a genuine Sledgit vault (${prov.reason}); refusing to sign`
          + (net.id === "testnet" ? " (testnet only: --allow-unverified-vault)" : ""));
      }
      warn(`warning: ${vault.id} is not a genuine Sledgit vault (${prov.reason}); signing anyway (${namedTest ? "SLEDGIT_TEST_VAULT names it" : "--allow-unverified-vault, testnet"})`);
    }
    vault.useKey(loadAgentKey(env, warn));
    for (const w of (await vault.checkAccessKey()).warnings) warn(w);
  }
  const dir = o.receipts || join(HERE, "receipts", net.id);
  const receiptsPath = join(dir, "receipts.jsonl");
  const outcomesPath = join(dir, "outcomes.jsonl");
  if (needsKey && cmd !== "settle") await vault.assertAgent();

  switch (cmd) {
    case "status": out(await status(vault)); return 0;
    case "preview": {
      const s = await side(vault, args);
      out({ ...s.view, preview: await vault.preview(s.tokenIn, s.tokenOut, s.amountIn, 1n) });
      return 0;
    }
    case "swap": case "intent": {
      const s = await side(vault, args);
      const p = await vault.preview(s.tokenIn, s.tokenOut, s.amountIn, 1n);
      if (!p.ok) { out({ refused: p.code, reason: p.reason, sent: false }); return 1; }
      // --publish (intent only): sign at the best solver quote, then publish it to the solver relay.
      const relay = cmd === "intent" && o.publish ? relayKey() : undefined;
      const quote = relay ? await bestQuote(relay, s.tokenIn, s.tokenOut, s.amountIn) : null;
      if (relay && !quote) { out({ published: false, reason: "no solver quote", sent: false }); return 1; }
      if (quote && BigInt(quote.amount_out) < BigInt(p.band_floor)) {
        out({ published: false, reason: `best quote ${quote.amount_out} is below the vault's price band ${p.band_floor}`, sent: false });
        return 1;
      }
      const minOut = quote ? BigInt(quote.amount_out) : o.min ? toUnits(o.min, await vault.decimals(s.tokenOut)) : BigInt(p.band_floor);
      const decision: Decision = { action: s.action, amount_in: s.amount, reason: redact(o.reason ?? `manual ${cmd} from cli`) };
      const venue = cmd === "swap" ? "rhea" : "intents";
      const hash = await manualReceipt(vault, net, receiptsPath, decision, { venue, preview: p, min_amount_out: minOut.toString() });
      const r = cmd === "swap"
        ? await vault.requestSwap(s.tokenIn, s.tokenOut, s.amountIn, minOut, hash)
        : await vault.requestIntentSwap(s.tokenIn, s.tokenOut, s.amountIn, minOut, hash);
      const sent = { method: cmd === "swap" ? "request_swap" : "request_intent_swap", venue, min_amount_out: minOut.toString() };
      appendLine(outcomesPath, JSON.stringify({ ts: new Date().toISOString(), vault: vault.id, network: net.id, chain_id: vault.chainId,
        model: "human:cli", receipt_hash: hash, decision, sent, tx: r.tx, outcome: r.outcome }));
      let intentFile: string | undefined;
      if (r.outcome.status === "authorized" && r.outcome.multi_payload !== undefined) {
        // The signed intent is useless unless someone sends it to solvers before the deadline. Save it for that.
        intentFile = join(dir, "intents.jsonl");
        appendLine(intentFile, canonical({ ts: new Date().toISOString(), vault: vault.id, tx: r.tx, receipt_hash: hash,
          deadline: r.outcome.deadline, multi_payload: r.outcome.multi_payload as Json }));
      }
      let relayed: Record<string, unknown> | undefined;
      if (relay && quote && r.outcome.status === "authorized" && r.outcome.multi_payload !== undefined) {
        // The vault signs at max(quote, Rhea, band): publish only when that is exactly the solver's quote.
        if (r.outcome.min_amount_out !== quote.amount_out) {
          relayed = { published: false, reason: `the vault signed ${r.outcome.min_amount_out} (Rhea was better than the quote ${quote.amount_out}); it expires unfilled` };
        } else {
          const intentHash = await publish(relay, quote.quote_hash, r.outcome.multi_payload);
          relayed = { published: true, intent_hash: intentHash, ...(await waitSettled(relay, intentHash, new Date(r.outcome.deadline))) };
        }
      }
      out({ receipt_hash: hash, tx: r.tx, explorer: net.explorer + r.tx, outcome: r.outcome, ...(r.failure ? { failure: r.failure } : {}),
        ...(relayed ? { relay: relayed, next: "run settle to record the outcome in the vault" } : {}),
        ...(intentFile && !relayed ? { multi_payload_saved_to: intentFile,
          next: "publish multi_payload to a NEAR Intents solver relay before the deadline; this runner does not publish it" } : {}),
        ...(r.outcome.status === "unknown_until_settled" ? { next: "the cap stays reserved: run settle after the deadline" } : {}) });
      return commandSucceeded(cmd, r) ? 0 : 1;
    }
    case "skip": {
      const note = clipBytes(redact(args.join(" ") || "no trade"));
      const decision: Decision = { action: "hold", amount_in: "0", reason: note.slice(0, 200) };
      const hash = await manualReceipt(vault, net, receiptsPath, decision, { note });
      const r = await vault.logSkip(hash, note);
      appendLine(outcomesPath, JSON.stringify({ ts: new Date().toISOString(), vault: vault.id, network: net.id, chain_id: vault.chainId,
        model: "human:cli", receipt_hash: hash, decision, sent: { method: "log_skip", note }, tx: r.tx, outcome: r.outcome }));
      out({ receipt_hash: hash, tx: r.tx, explorer: net.explorer + r.tx, outcome: r.outcome });
      return commandSucceeded(cmd, r) ? 0 : 1;
    }
    case "settle": case "cancel": case "freeze": {
      const r = await (cmd === "settle" ? vault.intentsSettle() : cmd === "cancel" ? vault.intentsCancel() : vault.freeze());
      out({ tx: r.tx, explorer: net.explorer + r.tx, ok: r.ok, outcome: r.outcome, events: r.events, ...(r.failure ? { failure: r.failure } : {}) });
      const okNow = commandSucceeded(cmd, r);
      if (!okNow && cmd === "cancel") warn("cancel: the intent was NOT cancelled and may still fill; run settle after its deadline");
      if (!okNow && cmd === "settle") warn("settle: nothing was recorded (the intent may still be live); try again after its deadline");
      if (okNow && cmd === "freeze" && (await vault.intents()).open_intent !== null) {
        warn("freeze: an intent is still open and stays fillable until its deadline; run cancel");
      }
      return okNow ? 0 : 1;
    }
    case "arena": {
      if (o.attest === "tee" && !o.model) throw new Error("--attest tee needs --model <canonical NEAR AI Cloud id>, e.g. Qwen/Qwen3.6-35B-A3B-FP8");
      const model = o.attest === "tee"
        ? (deps.makeAttested ?? nearAiModel)(o.model!, env)
        : (deps.makeModel ?? makeModel)(o.provider!, o.model ?? defaultModel(o.provider!), env);
      const prompt = loadPrompt(o.prompt ?? join(HERE, "prompts", "arena-v1.1.md"));
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (let i = 0; i < ticks; i++) {
        if (i > 0) await sleep(intervalS * 1000);
        const r = await tick({ vault, model, prompt, price: deps.price ?? nearUsdt, receiptsPath, outcomesPath, dryRun: o["dry-run"],
          ...(o.harness ? { harness: o.harness } : {}), ...(deps.market ? { market: deps.market } : {}) });
        out({ tick: i + 1, model: model.ref, prompt_sha256: prompt.sha256, ...r, ...(r.tx ? { explorer: net.explorer + r.tx } : {}) });
        if (r.stopped) {
          warn(`arena: stopped at tick ${i + 1}: ${r.stopped === "frozen" ? "the vault is frozen" : "this key's account is no longer the vault's agent"}`);
          return 1;
        }
      }
      return 0;
    }
    case "house": {
      // Staked strategies need the network's staking token; testnet has none.
      const stake = rule!.staked ? PAIRS[net.id].stake : undefined;
      if (rule!.staked && !stake) throw new Error(`${rule!.id} needs a staking token; ${net.id} has none`);
      const model = rule!.model(vault.id);
      const prompt = rule!.prompt;
      const id = rule!.id;
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const now = deps.now ?? Date.now;
      for (let i = 0; i < ticks; i++) {
        // House ticks follow the published schedule (one daily slot); --interval doesn't apply.
        if (i > 0) await sleep(Math.max(0, nextSlot(now()) + 60_000 - now()));
        const cfg = await vault.config();
        const chain = await (deps.chainState ?? ((v: string, b: string, seq: number, t: number) => chainState(net.id, v, b, seq, t, fetch, undefined, stake?.token)))(
          vault.id, net.base, Number(cfg.seq ?? 0), now());
        if (chain.off_schedule && !o["off-schedule"] && !o["dry-run"]) {
          warn(`house: off schedule (slot ${chain.slot}, ${SCHEDULE.window_minutes} min window, one tick per slot); `
            + "rerun with --off-schedule to tick anyway (recorded in the receipt)");
          return 1;
        }
        const r = await tick({ vault, model, prompt, price: deps.price ?? nearUsdt, market: deps.market ?? (async () => (await dailyCandles()) as unknown as Json),
          chain: chain as unknown as Json, historySize: 0, receiptsPath, outcomesPath, dryRun: o["dry-run"], ...(stake ? { stake } : {}) });
        out({ tick: i + 1, strategy: id, strategy_sha256: prompt.sha256, slot: chain.slot, off_schedule: chain.off_schedule,
          ...r, ...(r.tx ? { explorer: net.explorer + r.tx } : {}) });
        if (r.stopped) { warn(`house: stopped at tick ${i + 1}: ${r.stopped}`); return 1; }
      }
      return 0;
    }
    default: out(USAGE); return 2;
  }
}

/** Re-run each rules receipt with the published strategy version its hash names (see strategies/rerun.ts). */
export function houseRerun(text: string): RerunRow[] {
  return rerunRows(text).rows;
}

function defaultModel(provider: string): string {
  if (provider === "anthropic") return "claude-opus-5-5";
  if (provider === "echo") return "hold";
  throw new Error(`--model is required for ${provider}`);
}

async function side(vault: Vault, args: string[]) {
  const [s, amount] = args;
  if ((s !== "buy" && s !== "sell") || !amount) throw new Error("expected <buy|sell> <amount>");
  const { base, quote } = vault.net;
  const [tokenIn, tokenOut] = s === "buy" ? [quote, base] : [base, quote];
  const amountIn = toUnits(amount, await vault.decimals(tokenIn));
  return { action: s as "buy" | "sell", amount, tokenIn, tokenOut, amountIn, view: { token_in: tokenIn, token_out: tokenOut, amount_in: amountIn.toString() } };
}

async function status(vault: Vault) {
  const { base, quote } = vault.net;
  const [config, policy, usage, inFlight, intents, db, dq, bb, bq] = await Promise.all([
    vault.config(), vault.policy(), vault.usage(), vault.inFlight(), vault.intents(),
    vault.decimals(base), vault.decimals(quote), vault.balance(base), vault.balance(quote),
  ]);
  return { network: vault.net.id, chain_id: vault.chainId, vault: vault.id, config, policy, usage, in_flight: inFlight, intents,
    balances: { [base]: fromUnits(bb, db), [quote]: fromUnits(bq, dq) } };
}

/** CLI actions get receipts too: the on-chain record should never carry a hash nobody can open. */
async function manualReceipt(vault: Vault, net: Network, path: string, decision: Decision, extra: Record<string, unknown>): Promise<string> {
  const s = await status(vault);
  const { line, hash } = sealReceipt({
    v: 1, vault: vault.id, network: net.id, agent: vault.agentId ?? "", model: { provider: "human", id: "cli" },
    prompt_sha256: "", inputs: { ...s, ...extra } as unknown as Json, decision: decision as unknown as Json,
    model_output: "", ts: new Date().toISOString(),
  });
  appendLine(path, line);
  return hash;
}
