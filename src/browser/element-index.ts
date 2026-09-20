import type { Page, Locator } from "playwright";

export interface ElementInfo {
  ref: number;
  role: string;
  name: string;
  tag: string;
  type?: string | null;
  nameAttr?: string | null;
  idAttr?: string | null;
  options?: string[]; // for <select>
  /** Present only for non-interactive <td> cells indexed for extraction -- see
   * buildTargetRef's cell branch in locate.ts and REPORT.md #2 ("tabular data"). */
  cellContext?: {
    rowKeyText: string | null; // first cell's text in the same row (null if this IS that cell)
    columnHeader: string | null; // nearest <th> text for this column, if any
    columnIndex: number; // 0-based
  };
}

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [role="link"], [onclick]';

function inferRole(tag: string, type?: string | null): string {
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    if (type === "submit" || type === "button") return "button";
    if (type === "password") return "textbox";
    return "textbox";
  }
  return "generic";
}

export interface ElementIndexResult {
  elements: ElementInfo[];
  locators: Locator[]; // parallel array, index-aligned with elements[].ref -- for live execution only, never serialized
}

/** Walks the live page for (a) interactive controls and (b) table cells that hold
 * reportable data, and builds ONE flat numbered index covering both. This is the
 * perception surface the LLM reasons over instead of raw HTML/DOM -- it degrades
 * gracefully on legacy markup because it only cares about role + visible accessible
 * name / tabular position, not classes/ids/structure. See REPORT.md #1, #2, #4. */
export async function buildElementIndex(page: Page): Promise<ElementIndexResult> {
  const elements: ElementInfo[] = [];
  const locators: Locator[] = [];
  let ref = 0;

  const interactiveHandles = await page.locator(INTERACTIVE_SELECTOR).all();
  for (const loc of interactiveHandles) {
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "unknown");
    const type = await loc.getAttribute("type").catch(() => null);
    const explicitRole = await loc.getAttribute("role").catch(() => null);
    const role = explicitRole || inferRole(tag, type);
    const idAttr = await loc.getAttribute("id").catch(() => null);
    const nameAttr = await loc.getAttribute("name").catch(() => null);

    let name = "";
    if (tag === "input" || tag === "select" || tag === "textarea") {
      name = await accessibleNameForField(page, loc, idAttr);
    } else {
      name = ((await loc.textContent().catch(() => "")) || "").trim().replace(/\s+/g, " ");
    }
    if (!name) {
      name = (await loc.getAttribute("placeholder").catch(() => "")) || nameAttr || idAttr || `${tag}#${ref}`;
    }

    let options: string[] | undefined;
    if (tag === "select") {
      options = await loc.locator("option").allTextContents().catch(() => []);
    }

    elements.push({ ref, role, name, tag, type, nameAttr, idAttr, options });
    locators.push(loc);
    ref += 1;
  }

  // Second pass: every <td> in every <table> is a potential extraction target. Computed
  // in one page.evaluate() for speed, then turned into Locators here in Node.
  const cellDescriptors = await page.evaluate(() => {
    const out: { tableIndex: number; rowIndex: number; colIndex: number; text: string; rowKeyText: string | null; columnHeader: string | null }[] = [];
    // Skip pure layout tables (identified here by a "chrome" class in this mock app --
    // a production version would use a heuristic like "no repeated column structure"
    // instead of an app-specific class name; see REPORT.md #2).
    const tables = Array.from(document.querySelectorAll("table")).filter((t) => !t.classList.contains("chrome"));
    tables.forEach((table, tableIndex) => {
      const rows = Array.from(table.querySelectorAll(":scope > tr, :scope > tbody > tr"));
      const headerRow = rows.find((r) => r.querySelector("th"));
      const headers = headerRow ? Array.from(headerRow.children).map((c) => (c.textContent || "").trim()) : [];
      rows.forEach((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll(":scope > td")).filter((c) => !c.querySelector("table"));
        if (cells.length === 0) return;
        const rowFirstText = (cells[0].textContent || "").trim();
        cells.forEach((cell, colIndex) => {
          const text = (cell.textContent || "").trim();
          if (!text) return;
          out.push({
            tableIndex,
            rowIndex,
            colIndex,
            text,
            rowKeyText: colIndex === 0 ? null : rowFirstText || null,
            columnHeader: headers[colIndex] || null,
          });
        });
      });
    });
    return out;
  });

  for (const cd of cellDescriptors) {
    const cellLocator = page
      .locator("table:not(.chrome)")
      .nth(cd.tableIndex)
      .locator(":scope > tr, :scope > tbody > tr")
      .nth(cd.rowIndex)
      .locator(":scope > td")
      .nth(cd.colIndex);
    const visible = await cellLocator.isVisible().catch(() => false);
    if (!visible) continue;
    const label = cd.rowKeyText ? `${cd.rowKeyText} / ${cd.columnHeader || `col ${cd.colIndex + 1}`}` : cd.columnHeader || `cell ${cd.rowIndex}.${cd.colIndex}`;
    elements.push({
      ref,
      role: "cell",
      name: `${label}: "${cd.text}"`,
      tag: "td",
      cellContext: { rowKeyText: cd.rowKeyText, columnHeader: cd.columnHeader, columnIndex: cd.colIndex },
    });
    locators.push(cellLocator);
    ref += 1;
  }

  return { elements, locators };
}

async function accessibleNameForField(page: Page, loc: Locator, idAttr: string | null): Promise<string> {
  if (idAttr) {
    const label = page.locator(`label[for="${cssEscape(idAttr)}"]`);
    const labelText = await label.textContent().catch(() => null);
    if (labelText && labelText.trim()) return labelText.trim();
  }
  const placeholder = await loc.getAttribute("placeholder").catch(() => null);
  if (placeholder) return placeholder;
  return "";
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

/** Renders the element index as compact text for the LLM prompt. */
export function renderElementIndex(elements: ElementInfo[]): string {
  if (elements.length === 0) return "(no interactive elements detected)";
  return elements
    .map((e) => {
      const extras = e.options?.length ? ` options=[${e.options.join(", ")}]` : "";
      return `[${e.ref}] ${e.role} "${e.name}"${extras}`;
    })
    .join("\n");
}
