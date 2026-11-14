// The browser feed reads only the vault's own events from receipts that succeeded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsOf, type TxRecord } from "../src/lib/feed/near";

const VAULT = "v.arena.sledgit.testnet";
const log = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "sledgit", version: "1.0.0", event, data: [data] })}`;
const rec = (id: string, h: number, executor: string, logs: string[], status?: unknown) =>
  ({ execution_outcome: { id, block_height: h, block_timestamp: h * 1e9, outcome: { logs, executor_id: executor, ...(status === undefined ? {} : { status }) } } });

test("eventsOf: a failed receipt's events are skipped; succeeded and status-less receipts count", () => {
  const txs: TxRecord[] = [{ transaction: { hash: "t1" }, receipts: [
    rec("ok", 1, VAULT, [log("deposit", { token: "usdc", amount: "10" })], { SuccessValue: "" }),
    rec("bad", 2, VAULT, [log("trade", { seq: 1, token_in: "usdc", amount_in: "10" })], { Failure: { ActionError: {} } }),
    rec("old", 3, VAULT, [log("skip", { seq: 2 })]),
    rec("other", 4, "evil.testnet", [log("deposit", { token: "usdc", amount: "999" })], { SuccessValue: "" }),
  ] }];
  const errors: string[] = [];
  const evs = eventsOf(txs, VAULT, errors);
  assert.deepEqual(evs.map((e) => e.receiptId), ["ok", "old"]);
  assert.deepEqual(errors, []);
});
