// Re-run demo-trader receipts offline: same spec hash, same decision from the recorded inputs. With refetch, also
// fetch the recorded hourly window again and compare its hash to the one Kronos was fed.
import { createHash } from "node:crypto";
import { canonical } from "../../agent/src/receipt.js";
import { checkHourly } from "./market.js";
import { desk, type DeskInput } from "./roles.js";

export interface RerunRow { line: number; model: string; same_spec: boolean; same_decision: boolean; kronos_input?: "match" | "differs" | "unavailable" | "not_used" }

type Receipt = { model?: { provider?: string; id?: string }; prompt_sha256?: string; inputs?: DeskInput & { market?: { kronos?: { status?: string; input?: { source: string; candles_sha256: string } } } }; decision?: Record<string, unknown> };

export async function rerun(text: string, specSha256: string, refetch?: typeof fetch): Promise<RerunRow[]> {
  const rows: RerunRow[] = [];
  for (const [i, l] of text.split("\n").entries()) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as Receipt;
    if (r.model?.provider !== "iron-trader") continue;
    const kronos = String(r.model.id).includes("+kronos");
    const { error: _e, ...recorded } = r.decision ?? {};
    const got = r.decision?.error !== undefined ? null : desk(r.inputs!, kronos).decision;
    const row: RerunRow = { line: i + 1, model: String(r.model.id), same_spec: r.prompt_sha256 === specSha256,
      same_decision: got !== null && canonical(got as never) === canonical(recorded as never) };
    const k = r.inputs?.market?.kronos;
    if (refetch) {
      if (k?.status !== "ok" || !k.input) row.kronos_input = "not_used";
      else {
        const res = await refetch(k.input.source, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (!res?.ok) row.kronos_input = "unavailable";
        else {
          // Bars that closed before the receipt are final; the window is fetched by its exact start and end.
          const bars = checkHourly(await res.json(), Date.now());
          row.kronos_input = createHash("sha256").update(JSON.stringify(bars)).digest("hex") === k.input.candles_sha256 ? "match" : "differs";
        }
      }
    }
    rows.push(row);
  }
  return rows;
}
