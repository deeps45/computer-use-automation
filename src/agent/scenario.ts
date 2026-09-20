import { readFileSync } from "node:fs";
import { z } from "zod";
import { ParamSpecSchema, OutcomeRuleSchema } from "../artifact/schema.js";

export const ScenarioSchema = z.object({
  capabilityId: z.string(),
  name: z.string(),
  description: z.string(),
  goal: z.string(), // natural-language goal given to the LLM
  baseUrl: z.string(),
  appId: z.string(),
  appLabel: z.string(),
  inputs: z.array(ParamSpecSchema),
  // literal values used THIS discovery run for each input param -- used to
  // parameterize recorded literals back into {kind:"param"} references.
  inputBindings: z.record(z.string(), z.string()),
  // Hand-reviewed, target-app-specific outcome rules (see REPORT.md #3 for why
  // these are authored/reviewed rather than auto-discovered in a single run).
  outcomeRules: z.array(OutcomeRuleSchema),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export function loadScenario(filePath: string): Scenario {
  return ScenarioSchema.parse(JSON.parse(readFileSync(filePath, "utf-8")));
}
