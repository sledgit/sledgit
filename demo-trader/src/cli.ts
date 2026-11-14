// demo-trader: a small trading desk whose broker is a Sledgit vault. `tick` runs the desk through the agent runner
// (same receipts, refusals and verify); every other command goes straight to the runner (status, preview, verify, freeze).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { main } from "../../agent/src/main.js";
import { PARAMS } from "./roles.js";
import { deskModel, modelId, HARNESS } from "./model.js";
import { deskMarket, kronosEnv, KRONOS_PARAMS, KRONOS_WEIGHTS } from "./market.js";
import { rerun } from "./rerun.js";

export const PROMPT = new URL("../prompts/iron-trader-v1.md", import.meta.url).pathname;

const USAGE = `demo-trader tick --vault <id> [--kronos] [--ticks N --interval S] [--dry-run] [--receipts DIR]
demo-trader rerun <receipts.jsonl> [--refetch]   offline: same spec, same decision; --refetch re-checks the Kronos window
demo-trader <sledgit command> ...      status | preview | verify | freeze | ... (see sledgit --help)`;

/** The published desk spec must carry the exact parameters the code runs with, so the prompt hash pins them. */
export function checkSpec(text: string): void {
  for (const [name, v] of [["PARAMS", PARAMS], ["KRONOS_PARAMS", KRONOS_PARAMS], ["KRONOS_WEIGHTS", KRONOS_WEIGHTS]] as const) {
    if (!text.includes(JSON.stringify(v))) throw new Error(`${PROMPT} does not publish the running ${name}; update the spec`);
  }
}

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv[0] === "rerun") {
    const { values: o, positionals: p } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: { refetch: { type: "boolean", default: false } } });
    if (!p[0]) throw new Error("rerun <receipts.jsonl> [--refetch]");
    const spec = readFileSync(PROMPT);
    const rows = await rerun(readFileSync(p[0], "utf8"), createHash("sha256").update(spec).digest("hex"), o.refetch ? fetch : undefined);
    console.log(JSON.stringify(rows, null, 2));
    const ok = rows.length > 0 && rows.every((r) => r.same_spec && r.same_decision && r.kronos_input !== "differs");
    console.error(`rerun: ${rows.filter((r) => r.same_spec && r.same_decision).length} of ${rows.length} reproduce`);
    return ok ? 0 : 1;
  }
  if (argv[0] !== "tick") return main(argv.length ? argv : ["--help"], { env });
  const { values: o } = parseArgs({ args: argv.slice(1), options: {
    vault: { type: "string" }, kronos: { type: "boolean", default: false }, ticks: { type: "string", default: "1" },
    interval: { type: "string", default: "3600" }, "dry-run": { type: "boolean", default: false }, receipts: { type: "string" },
    mainnet: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } });
  if (o.help) { console.log(USAGE); return 0; }
  checkSpec(readFileSync(PROMPT, "utf8"));
  const k = o.kronos ? kronosEnv(env) : null;
  const args = ["arena", "--provider", "iron-trader", "--model", modelId(o.kronos!), "--prompt", PROMPT, "--harness", HARNESS,
    "--ticks", o.ticks!, "--interval", o.interval!,
    ...(o.vault ? ["--vault", o.vault] : []), ...(o.receipts ? ["--receipts", o.receipts] : []),
    ...(o["dry-run"] ? ["--dry-run"] : []), ...(o.mainnet ? ["--mainnet"] : [])];
  return main(args, { env, makeModel: () => deskModel(o.kronos!), market: deskMarket(k) });
}
