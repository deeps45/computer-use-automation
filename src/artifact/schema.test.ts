import { describe, it, expect } from "vitest";
import { CapabilitySchema, StepSchema } from "./schema.js";

const minimalCapability = {
  schemaVersion: "1.0",
  id: "creditvantage.test-capability",
  name: "Test capability",
  description: "A minimal capability for schema validation.",
  version: 1,
  createdAt: new Date().toISOString(),
  provenance: { discoveredBy: "llm", model: "claude-sonnet-5", discoveryRunId: "run-1" },
  target: { appId: "creditvantage", label: "Test", baseUrl: "http://localhost:4173", allowedOrigins: ["http://localhost:4173"] },
  inputs: [{ name: "memberId", type: "string", required: true, description: "member id" }],
  outputs: [{ name: "balance", type: "string", description: "balance" }],
  steps: [
    {
      id: "s1",
      type: "click",
      description: "Click Search",
      risk: "safe",
      target: { description: "Search button", candidates: [{ strategy: "role", role: "button", name: "Search", exact: true }] },
    },
  ],
  outcomeRules: [],
  successCheckpoint: { description: "done" },
  risk: { hasIrreversibleSteps: false, irreversibleStepIds: [] },
};

describe("CapabilitySchema", () => {
  it("accepts a well-formed capability, filling in step defaults (risk, timeoutMs)", () => {
    const parsed = CapabilitySchema.parse(minimalCapability);
    expect(parsed.steps[0].timeoutMs).toBe(8000);
    expect(parsed.steps[0].risk).toBe("safe");
  });

  it("rejects a capability with no steps -- an empty flow isn't a capability", () => {
    expect(() => CapabilitySchema.parse({ ...minimalCapability, steps: [] })).toThrow();
  });

  it("rejects an unversioned/unknown schemaVersion so old artifacts fail loudly instead of silently misbehaving", () => {
    expect(() => CapabilitySchema.parse({ ...minimalCapability, schemaVersion: "2.0" })).toThrow();
  });

  it("rejects a target with no locator candidates", () => {
    const bad = {
      ...minimalCapability,
      steps: [{ id: "s1", type: "click", description: "x", risk: "safe", target: { description: "x", candidates: [] } }],
    };
    expect(() => CapabilitySchema.parse(bad)).toThrow();
  });
});

describe("StepSchema value refs", () => {
  it("accepts literal, param, and secretRef value kinds", () => {
    for (const value of [{ kind: "literal", value: "x" }, { kind: "param", name: "memberId" }, { kind: "secretRef", name: "password" }]) {
      expect(() => StepSchema.parse({ id: "s1", type: "fill", description: "x", risk: "safe", value })).not.toThrow();
    }
  });
});
