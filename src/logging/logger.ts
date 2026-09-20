import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { redactDeep } from "../guardrails/policy.js";

export type LogEvent =
  | { type: "run_started"; runType: "discovery" | "replay"; goalOrCapabilityId: string; params?: Record<string, unknown> }
  | { type: "observation"; url: string; summary: string; screenshot?: string }
  | { type: "llm_decision"; step: number; tool: string; args: unknown; reasoning?: string }
  | { type: "action_executed"; actor: "agent" | "human"; action: string; target?: string; outcome: "ok" | "error"; detail?: string }
  | { type: "guardrail_block"; reason: string; action: unknown }
  | { type: "outcome_classified"; bucket: "business_outcome" | "recoverable" | "hard_failure"; code: string; message: string }
  | { type: "escalation_raised"; requestId: string; reason: string }
  | { type: "escalation_resumed"; requestId: string; decision: string; humanNotes?: string }
  | { type: "checkpoint"; description: string; passed: boolean }
  | { type: "run_finished"; status: string; detail?: string };

export class RunLogger {
  readonly runDir: string;
  private readonly logPath: string;
  private screenshotCounter = 0;
  readonly screenshotPaths: string[] = [];

  constructor(evidenceRoot: string, runId: string) {
    this.runDir = path.join(evidenceRoot, runId);
    mkdirSync(path.join(this.runDir, "screenshots"), { recursive: true });
    this.logPath = path.join(this.runDir, "log.jsonl");
    writeFileSync(this.logPath, "");
  }

  log(event: LogEvent) {
    const redacted = redactDeep(event);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...redacted });
    appendFileSync(this.logPath, line + "\n");
    // eslint-disable-next-line no-console
    console.log(`[log] ${line}`);
  }

  async screenshot(page: Page, label: string): Promise<string> {
    this.screenshotCounter += 1;
    const filename = `${String(this.screenshotCounter).padStart(2, "0")}-${label}.png`;
    const filePath = path.join(this.runDir, "screenshots", filename);
    await page.screenshot({ path: filePath }).catch(() => undefined);
    const relative = path.join("screenshots", filename);
    this.screenshotPaths.push(relative);
    return relative;
  }

  writeJson(filename: string, data: unknown) {
    writeFileSync(path.join(this.runDir, filename), JSON.stringify(redactDeep(data), null, 2));
  }
}
