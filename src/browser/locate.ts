import type { Page, Locator } from "playwright";
import type { ElementInfo } from "./element-index.js";
import type { LocatorCandidate, TargetRef } from "../artifact/schema.js";

/** Turns a chosen element (picked by the LLM from the numbered index during discovery)
 * into an ordered, portable locator fallback chain for the artifact. Role+accessible-name
 * is listed first because it survives visual/markup changes; a name/id-attribute CSS
 * selector is listed last because it's tied to implementation details that are more
 * likely to drift. */
export function buildTargetRef(el: ElementInfo, description: string): TargetRef {
  if (el.role === "cell" && el.cellContext) {
    return buildCellTargetRef(el, description);
  }

  const candidates: LocatorCandidate[] = [];

  if (el.name && el.role !== "generic") {
    candidates.push({ strategy: "role", role: normalizeRoleForPlaywright(el.role), name: el.name, exact: true });
  }
  if ((el.tag === "input" || el.tag === "select" || el.tag === "textarea") && el.name) {
    candidates.push({ strategy: "label", text: el.name });
  }
  if (el.role === "button" || el.role === "link") {
    candidates.push({ strategy: "text", text: el.name, exact: true });
  }
  if (el.nameAttr) {
    candidates.push({ strategy: "css", selector: `${el.tag}[name="${cssEscape(el.nameAttr)}"]` });
  } else if (el.idAttr) {
    candidates.push({ strategy: "css", selector: `#${cssEscape(el.idAttr)}` });
  }

  if (candidates.length === 0) {
    candidates.push({ strategy: "css", selector: el.tag });
  }

  return {
    description,
    candidates,
    rationale:
      "Role + accessible name is preferred (stable across CSS/layout changes); a form-field name/id " +
      "attribute is kept as a fallback because legacy markup often lacks it, and it is the most " +
      "implementation-coupled option so it is tried last.",
  };
}

/** Table-cell values (a balance, a new account number) are dynamic -- the cell's own
 * text can never be part of its locator, or replay would only ever find today's value.
 * Instead we key on something STABLE nearby: the row's first-column label ("Savings")
 * for a keyed row, or the column header ("New Account Number") for a single-row table.
 * This is deliberately XPath, the one place in this project XPath is the right tool,
 * because it is structural (row/column position) rather than value-based. The column
 * offset is still positional and would break if columns were reordered -- a documented
 * limitation, see REPORT.md #2. */
function buildCellTargetRef(el: ElementInfo, description: string): TargetRef {
  const { rowKeyText, columnHeader, columnIndex } = el.cellContext!;
  const candidates: LocatorCandidate[] = [];

  if (rowKeyText) {
    // Row-relative ONLY -- deliberately no column-header fallback here. That strategy
    // finds the Nth <td> in document order across the WHOLE table, which loses row
    // identity: on a table with only one data row it would silently return THIS row's
    // value even when asked for a DIFFERENT row's (e.g. "Checking" balance resolving to
    // the "Savings" cell for a member with only one account). A clean resolution failure
    // is safer than a silently wrong value, so this cell gets exactly one strategy.
    candidates.push({
      strategy: "xpath",
      expression: `//tr[td[1][normalize-space()=${xpathLiteral(rowKeyText)}]]/td[${columnIndex + 1}]`,
    });
  } else if (columnHeader) {
    // No row-label column at all (e.g. a single-row "New Account Number" table) --
    // column-header-relative is safe here because there is only one row to match.
    candidates.push({
      strategy: "xpath",
      expression: `(//th[normalize-space()=${xpathLiteral(columnHeader)}]/ancestor::table[1]//td)[${columnIndex + 1}]`,
    });
  }

  return {
    description,
    candidates,
    rationale: rowKeyText
      ? `Row-relative: identified by the stable row label "${rowKeyText}" plus a fixed column offset, not by the cell's own (variable) value.`
      : `Column-relative: identified by the table's column header "${columnHeader}", since this table has no per-row label column.`,
  };
}

function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.replace(/'/g, "', \"'\", '")}')`;
}

function normalizeRoleForPlaywright(role: string): string {
  if (role === "textbox") return "textbox";
  return role;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

export interface ResolveOutcome {
  locator: Locator;
  matchedStrategy: LocatorCandidate["strategy"];
  attempted: string[];
}

/** Tries each candidate in order; the first that resolves to >=1 visible element wins.
 * This is the heart of deterministic replay's resilience: any single locator strategy
 * can fail (attribute renamed, text changed) without failing the step. */
export async function resolveTargetRef(page: Page, target: TargetRef): Promise<ResolveOutcome> {
  const attempted: string[] = [];
  for (const c of target.candidates) {
    let loc: Locator | null = null;
    switch (c.strategy) {
      case "role":
        loc = page.getByRole(c.role as any, { name: c.name, exact: c.exact });
        attempted.push(`role=${c.role} name="${c.name}"`);
        break;
      case "label":
        loc = page.getByLabel(c.text);
        attempted.push(`label="${c.text}"`);
        break;
      case "text":
        loc = page.getByText(c.text, { exact: c.exact });
        attempted.push(`text="${c.text}"`);
        break;
      case "css":
        loc = page.locator(c.selector);
        attempted.push(`css=${c.selector}`);
        break;
      case "xpath":
        loc = page.locator(`xpath=${c.expression}`);
        attempted.push(`xpath=${c.expression}`);
        break;
    }
    if (!loc) continue;
    const count = await loc.count().catch(() => 0);
    if (count === 0) continue;
    const visible = await loc.first().isVisible().catch(() => false);
    if (!visible) continue;
    return { locator: loc.first(), matchedStrategy: c.strategy, attempted };
  }
  throw new LocatorResolutionError(target, attempted);
}

export class LocatorResolutionError extends Error {
  constructor(public target: TargetRef, public attempted: string[]) {
    super(
      `Could not resolve target "${target.description}". Tried, in order: ${attempted.join(" | ") || "(no candidates)"}`
    );
    this.name = "LocatorResolutionError";
  }
}
