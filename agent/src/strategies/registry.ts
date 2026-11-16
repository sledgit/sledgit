// Every published strategy version, by hash. A receipt names its strategy hash (prompt_sha256); the re-run looks the
// hash up here and decides with that version's code, so changing the rules never strands old receipts.
import { createHash } from "node:crypto";
import { canonical, type Json } from "../receipt.js";
import type { Decision } from "../decision.js";
import * as v1 from "./rules-v1.js";
import * as v2 from "./rules-v2.js";
import * as v3 from "./rules.js";

export interface PublishedStrategy {
  hash: string;
  id: string;
  version: number;
  spec: Json;
  decide(inputs: unknown, vault: string): Decision;
}

function entries(): PublishedStrategy[] {
  const out: PublishedStrategy[] = [];
  for (const s of v1.STRATEGIES) {
    const spec = v1.spec(s);
    out.push({ hash: createHash("sha256").update(canonical(spec)).digest("hex"), id: s.id, version: 1, spec,
      decide: (x, vault) => v1.decide(s, x as v1.RuleInput, vault) });
  }
  for (const s of v2.STRATEGIES) {
    const spec = v2.spec(s);
    out.push({ hash: createHash("sha256").update(canonical(spec)).digest("hex"), id: s.id, version: 2, spec,
      decide: (x, vault) => v2.decide(s, x as v2.RuleInput, vault) });
  }
  for (const s of v3.STRATEGIES) {
    const spec = v3.spec(s);
    out.push({ hash: createHash("sha256").update(canonical(spec)).digest("hex"), id: s.id, version: 3, spec,
      decide: (x, vault) => v3.decide(s, x as v3.RuleInput, vault) });
  }
  return out;
}

export const PUBLISHED: PublishedStrategy[] = entries();

export const publishedByHash = (hash: string): PublishedStrategy | undefined => PUBLISHED.find((p) => p.hash === hash);
