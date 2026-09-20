import { describe, it, expect } from "vitest";
import { validateParams } from "./executor.js";
import type { Capability } from "../artifact/schema.js";

const baseCapability = {
  inputs: [
    { name: "memberId", type: "string", required: true, description: "member id" },
    { name: "openingDeposit", type: "number", required: true, description: "deposit amount" },
    { name: "autoRenew", type: "boolean", required: false, description: "auto-renew flag" },
  ],
} as Capability;

describe("validateParams (fail fast, before a browser is ever launched)", () => {
  it("accepts params that satisfy the declared contract", () => {
    expect(() => validateParams(baseCapability, { memberId: "12345", openingDeposit: "100" })).not.toThrow();
  });

  it("rejects a missing required param", () => {
    expect(() => validateParams(baseCapability, { openingDeposit: "100" })).toThrow(/memberId/);
  });

  it("does not require an optional param", () => {
    expect(() => validateParams(baseCapability, { memberId: "12345", openingDeposit: "100" })).not.toThrow();
  });

  it("rejects a non-numeric value for a declared number input", () => {
    expect(() => validateParams(baseCapability, { memberId: "12345", openingDeposit: "not-a-number" })).toThrow(/must be a number/);
  });

  it("rejects a non-boolean value for a declared boolean input", () => {
    expect(() => validateParams(baseCapability, { memberId: "12345", openingDeposit: "100", autoRenew: "yes" })).toThrow(/must be "true" or "false"/);
  });

  it("accepts a valid boolean value", () => {
    expect(() => validateParams(baseCapability, { memberId: "12345", openingDeposit: "100", autoRenew: "true" })).not.toThrow();
  });
});
