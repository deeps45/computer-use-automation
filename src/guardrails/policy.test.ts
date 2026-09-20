import { describe, it, expect } from "vitest";
import { assertUrlAllowed, assertActionTypeAllowed, classifyActionRisk, redactDeep, GuardrailViolation } from "./policy.js";

describe("allowlist enforcement", () => {
  it("allows the configured origin", () => {
    expect(() => assertUrlAllowed("http://localhost:4173/members/12345")).not.toThrow();
  });

  it("blocks a different origin, including the classic userinfo look-alike trick", () => {
    // "http://localhost:4173@evil.example/login" parses to HOST evil.example (localhost:4173
    // becomes userinfo, not the host) -- a real class of allowlist-bypass attempt.
    expect(() => assertUrlAllowed("http://localhost:4173@evil.example/login")).toThrow(GuardrailViolation);
    expect(() => assertUrlAllowed("https://localhost:4173/login")).toThrow(GuardrailViolation); // wrong protocol -> different origin
  });

  it("blocks an explicitly denylisted route on an otherwise-allowed origin", () => {
    expect(() => assertUrlAllowed("http://localhost:4173/admin/system-config")).toThrow(GuardrailViolation);
  });

  it("only allows action types present in the allowlist", () => {
    expect(() => assertActionTypeAllowed("click")).not.toThrow();
    expect(() => assertActionTypeAllowed("execute_shell")).toThrow(GuardrailViolation);
  });
});

describe("risk classification (policy code, not model self-report)", () => {
  it("flags known irreversible-action control text as irreversible", () => {
    expect(classifyActionRisk("Confirm & Open Account", "")).toBe("irreversible");
    expect(classifyActionRisk("Delete Member", "")).toBe("irreversible");
  });

  it("flags a page carrying an irreversibility warning even if the button text looks benign", () => {
    expect(classifyActionRisk("Continue", "This action cannot be undone")).toBe("irreversible");
  });

  it("treats ordinary navigation controls as safe", () => {
    expect(classifyActionRisk("Search", "")).toBe("safe");
    expect(classifyActionRisk("Back to Search", "")).toBe("safe");
  });
});

describe("redaction (defense in depth for regulated data)", () => {
  it("redacts fields whose NAME looks sensitive, regardless of value", () => {
    const out = redactDeep({ username: "ops_agent", password: "demo-pass", apiToken: "abc123" });
    expect(out.username).toBe("ops_agent");
    expect(out.password).toBe("[REDACTED]");
    expect(out.apiToken).toBe("[REDACTED]");
  });

  it("redacts credit-card- and SSN-shaped VALUES even in an unlabeled field", () => {
    const out = redactDeep({ note: "card on file 4111 1111 1111 1111, ssn 123-45-6789" });
    expect(out.note).not.toContain("4111");
    expect(out.note).not.toContain("123-45-6789");
  });

  it("leaves ordinary business data untouched", () => {
    const out = redactDeep({ memberId: "12345", balance: "$2450.10" });
    expect(out).toEqual({ memberId: "12345", balance: "$2450.10" });
  });

  it("redacts nested objects and arrays too, at any depth", () => {
    const out: any = redactDeep({ steps: [{ description: "fill login field", password: "hunter2" }] });
    expect(out.steps[0].password).toBe("[REDACTED]");
    expect(out.steps[0].description).toBe("fill login field"); // unrelated fields untouched
  });

  it("does NOT flag a secretRef's pointer name as a secret -- it's an identifier, not a value", () => {
    // {kind:"secretRef", name:"password"} is how the artifact schema says "resolve this
    // from the secret store at run time" -- the pointer name itself is not sensitive.
    const out: any = redactDeep({ value: { kind: "secretRef", name: "password" } });
    expect(out.value.name).toBe("password");
  });
});
