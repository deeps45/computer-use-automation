import { z } from "zod";

// ---------------------------------------------------------------------------
// Locator strategy: an ORDERED fallback chain, most-robust first. Replay tries
// each candidate until one resolves to exactly one visible element. Storing
// the chain (not a single selector) is the core defense against "the UI has
// no stable selectors" — see REPORT.md #2 and #3.
// ---------------------------------------------------------------------------
export const LocatorCandidateSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string(), name: z.string(), exact: z.boolean().default(true) }),
  z.object({ strategy: z.literal("label"), text: z.string() }),
  z.object({ strategy: z.literal("text"), text: z.string(), exact: z.boolean().default(false) }),
  z.object({ strategy: z.literal("css"), selector: z.string() }),
  z.object({ strategy: z.literal("xpath"), expression: z.string() }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

export const TargetRefSchema = z.object({
  description: z.string(), // human-readable, e.g. "Member ID search field"
  candidates: z.array(LocatorCandidateSchema).min(1),
  rationale: z.string().optional(), // why this fallback ordering was chosen
});
export type TargetRef = z.infer<typeof TargetRefSchema>;

// A step value may be a literal or a reference to a runtime input parameter.
export const ValueRefSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), name: z.string() }),
  // Never persist credentials into the artifact -- resolved from a secret store by
  // name at replay time. See guardrails/policy.ts and REPORT.md #6.
  z.object({ kind: z.literal("secretRef"), name: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRefSchema>;

export const RiskLevelSchema = z.enum(["safe", "irreversible"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const CheckpointSchema = z.object({
  description: z.string(),
  urlPattern: z.string().optional(),
  textPresent: z.string().optional(),
  target: TargetRefSchema.optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const StepSchema = z.object({
  id: z.string(),
  type: z.enum(["navigate", "click", "fill", "selectOption", "waitFor", "extract", "assertCheckpoint"]),
  description: z.string(),
  risk: RiskLevelSchema.default("safe"),
  url: z.string().optional(), // navigate
  target: TargetRefSchema.optional(), // click / fill / selectOption / extract
  value: ValueRefSchema.optional(), // fill / selectOption
  outputName: z.string().optional(), // extract
  extractAttribute: z.enum(["text", "value", "href"]).optional(), // extract
  checkpoint: CheckpointSchema.optional(), // waitFor / assertCheckpoint
  timeoutMs: z.number().default(8000),
});
export type Step = z.infer<typeof StepSchema>;

export const ParamSpecSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().default(true),
  description: z.string(),
  example: z.string().optional(),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const OutputSpecSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// Declarative rules for classifying the page state the replay engine is
// looking at into an outcome bucket. Checked after every step. This is what
// keeps "no such member" from ever being conflated with a crash.
export const OutcomeRuleSchema = z.object({
  id: z.string(),
  when: z.object({
    urlPattern: z.string().optional(),
    textPresent: z.string().optional(),
    statusCodeAtLeast: z.number().optional(),
  }),
  outcome: z.enum(["business_outcome", "recoverable", "hard_failure"]),
  code: z.string(), // e.g. "member_not_found", "validation_error", "permission_denied"
  message: z.string(),
  recovery: z
    .object({
      type: z.enum(["retry", "dismiss", "none"]).default("none"),
      maxAttempts: z.number().default(1),
      waitMs: z.number().default(1000),
    })
    .optional(),
});
export type OutcomeRule = z.infer<typeof OutcomeRuleSchema>;

export const CapabilitySchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string(), // stable slug, e.g. "creditvantage.lookup-member-balance"
  name: z.string(),
  description: z.string(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  provenance: z.object({
    discoveredBy: z.literal("llm"),
    model: z.string(),
    discoveryRunId: z.string(),
    notes: z.string().optional(),
  }),
  target: z.object({
    appId: z.string(),
    label: z.string(),
    baseUrl: z.string(),
    allowedOrigins: z.array(z.string()),
  }),
  inputs: z.array(ParamSpecSchema),
  outputs: z.array(OutputSpecSchema),
  steps: z.array(StepSchema).min(1),
  outcomeRules: z.array(OutcomeRuleSchema),
  successCheckpoint: CheckpointSchema,
  risk: z.object({
    hasIrreversibleSteps: z.boolean(),
    irreversibleStepIds: z.array(z.string()),
  }),
});
export type Capability = z.infer<typeof CapabilitySchema>;

// ---------------------------------------------------------------------------
// Replay result contract — the thing an AI agent actually gets back.
// ---------------------------------------------------------------------------
export const ReplayResultSchema = z.object({
  status: z.enum(["success", "business_outcome", "failure"]),
  capabilityId: z.string(),
  capabilityVersion: z.number(),
  runId: z.string(),
  outputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  businessOutcome: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  failure: z
    .object({
      stepId: z.string(),
      stepDescription: z.string(),
      expected: z.string(),
      observed: z.string(),
      message: z.string(),
    })
    .optional(),
  escalated: z.boolean().default(false),
  evidence: z.object({
    logPath: z.string(),
    screenshotPaths: z.array(z.string()),
  }),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;
