// Every rule the house command can run, by id: its model, its published prompt, and whether it holds staked NEAR.
import type { Model } from "../models.js";
import type { Prompt } from "../arena.js";
import { rulesModel, strategyPrompt, STRATEGIES } from "./rules.js";
import { STAKED, stakedModel, stakedPrompt } from "./staked.js";
import { STAKED_TREND_VOL, TREND_VOL, trendVolPrompt } from "./trend-vol.js";

export interface HouseRule { id: string; staked: boolean; prompt: Prompt; model(vault: string): Model }

export const HOUSE_RULES: HouseRule[] = [
  ...STRATEGIES.map((s) => ({ id: s.id, staked: false, prompt: strategyPrompt(s), model: (v: string) => rulesModel(s, v) })),
  ...STAKED.map((s) => ({ id: s.id, staked: true, prompt: stakedPrompt(s), model: (v: string) => stakedModel(s, v) })),
  { id: TREND_VOL.id, staked: false, prompt: trendVolPrompt(false), model: (v) => rulesModel(TREND_VOL, v) },
  { id: STAKED_TREND_VOL.id, staked: true, prompt: trendVolPrompt(true), model: (v) => stakedModel(STAKED_TREND_VOL, v) },
];

export function houseRule(id: string): HouseRule {
  const r = HOUSE_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown strategy ${id} (${HOUSE_RULES.map((x) => x.id).join(" | ")})`);
  return r;
}
