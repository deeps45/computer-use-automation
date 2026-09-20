import { describe, it, expect } from "vitest";
import { buildTargetRef } from "./locate.js";
import type { ElementInfo } from "./element-index.js";

describe("buildTargetRef: interactive elements", () => {
  it("prefers role+name, then label, then a name-attribute css fallback", () => {
    const el: ElementInfo = { ref: 0, role: "textbox", name: "Member ID", tag: "input", type: "text", nameAttr: "memberId", idAttr: "f-mid" };
    const target = buildTargetRef(el, "Member ID field");
    expect(target.candidates[0]).toMatchObject({ strategy: "role", role: "textbox", name: "Member ID" });
    expect(target.candidates).toContainEqual({ strategy: "label", text: "Member ID" });
    expect(target.candidates).toContainEqual({ strategy: "css", selector: 'input[name="memberId"]' });
  });

  it("falls back to an id-based css selector when there is no name attribute", () => {
    const el: ElementInfo = { ref: 0, role: "button", name: "Search", tag: "button", nameAttr: null, idAttr: "search-btn" };
    const target = buildTargetRef(el, "Search button");
    expect(target.candidates.some((c) => c.strategy === "css" && c.selector === "#search-btn")).toBe(true);
  });
});

describe("buildTargetRef: table cells (regression for the row/column-fallback bug)", () => {
  // Found via replay testing: a member with only ONE account row meant the
  // column-header fallback (which counts <td>s in document order across the
  // WHOLE table, ignoring row boundaries) silently resolved "Checking balance"
  // to the Savings row's cell instead of failing. Fixed by making row-relative
  // and column-relative mutually exclusive. See REPORT.md #3.
  it("uses ONLY the row-relative xpath when a row key is present -- no column-header fallback", () => {
    const el: ElementInfo = {
      ref: 0,
      role: "cell",
      name: 'Checking / Balance: "$310.55"',
      tag: "td",
      cellContext: { rowKeyText: "Checking", columnHeader: "Balance", columnIndex: 2 },
    };
    const target = buildTargetRef(el, "Checking balance cell");
    expect(target.candidates).toHaveLength(1);
    expect(target.candidates[0]).toEqual({
      strategy: "xpath",
      expression: "//tr[td[1][normalize-space()='Checking']]/td[3]",
    });
  });

  it("uses the column-header xpath only when there is no row key (single-row tables)", () => {
    const el: ElementInfo = {
      ref: 0,
      role: "cell",
      name: 'New Account Number: "SA-9001-12345"',
      tag: "td",
      cellContext: { rowKeyText: null, columnHeader: "New Account Number", columnIndex: 0 },
    };
    const target = buildTargetRef(el, "New account number cell");
    expect(target.candidates).toHaveLength(1);
    expect(target.candidates[0]).toEqual({
      strategy: "xpath",
      expression: "(//th[normalize-space()='New Account Number']/ancestor::table[1]//td)[1]",
    });
  });

  it("escapes an embedded single quote in the row key so the xpath stays well-formed", () => {
    const el: ElementInfo = {
      ref: 0,
      role: "cell",
      name: "row",
      tag: "td",
      cellContext: { rowKeyText: "O'Brien", columnHeader: null, columnIndex: 1 },
    };
    const target = buildTargetRef(el, "cell");
    expect(target.candidates[0]).toMatchObject({ strategy: "xpath" });
    const expr = (target.candidates[0] as { expression: string }).expression;
    expect(expr).toContain('"O\'Brien"');
  });
});
