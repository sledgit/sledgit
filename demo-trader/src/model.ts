// The desk as a Model, so the agent runner seals, previews, refuses and records it exactly like an LLM agent.
import type { Model } from "../../agent/src/models.js";
import { desk, type DeskInput } from "./roles.js";

export const VERSION = "0.1.0";
export const HARNESS = `demo-trader/${VERSION}`;
export const modelId = (kronos: boolean) => (kronos ? "iron-trader-v1+kronos-small" : "iron-trader-v1");

export function deskModel(kronos: boolean): Model {
  return {
    ref: { provider: "iron-trader", id: modelId(kronos) },
    async complete(_system: string, user: string): Promise<string> {
      return JSON.stringify(desk(JSON.parse(user) as DeskInput, kronos).decision);
    },
  };
}
