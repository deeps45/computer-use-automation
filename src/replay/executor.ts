import { chromium, type Page } from "playwright";
import { nanoid } from "nanoid";
import type { Capability, Step, OutcomeRule, ValueRef, ReplayResult } from "../artifact/schema.js";
import { resolveTargetRef, LocatorResolutionError } from "../browser/locate.js";
import { assertUrlAllowed, assertActionTypeAllowed, GuardrailViolation } from "../guardrails/policy.js";
import { resolveSecret } from "../guardrails/secrets.js";
import { RunLogger } from "../logging/logger.js";
import { interventionManager } from "../handoff/intervention-manager.js";

export interface ReplayOptions {
  /** Irreversible steps pause for human approval by default (see guardrails/policy.ts +
   * REPORT.md #6). Set true to represent a pre-approved / trusted unattended context. */
  allowIrreversible?: boolean;
  headless?: boolean;
  /** Appends ?simulate=<mode> to the initial navigation only -- for demonstrating the
   * hard_failure / transient-slowness paths without touching the target app's real logic. */
  simulate?: "timeout" | "slow" | "error500";
}

class CheckpointFailedError extends Error {}

export async function runReplay(capability: Capability, params: Record<string, string>, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const runId = `replay-${capability.id.replace(/\./g, "-")}-${Date.now()}-${nanoid(4)}`;
  const logger = new RunLogger("evidence", runId);
  logger.log({ type: "run_started", runType: "replay", goalOrCapabilityId: capability.id, params });

  validateParams(capability, params);

  const headless = opts.headless ?? process.env.HEADLESS === "true";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  let lastDocStatus = 200;
  page.on("response", (resp) => {
    if (resp.request().resourceType() === "document") lastDocStatus = resp.status();
  });

  const outputs: Record<string, string> = {};
  let escalated = false;

  const finish = (result: Omit<ReplayResult, "runId" | "evidence">): ReplayResult => {
    const full: ReplayResult = { ...result, runId, escalated: result.escalated || escalated, evidence: { logPath: "log.jsonl", screenshotPaths: logger.screenshotPaths } };
    logger.log({ type: "run_finished", status: full.status, detail: JSON.stringify(full.businessOutcome || full.failure || full.outputs || {}) });
    logger.writeJson("result.json", full);
    return full;
  };

  try {
    const initialUrl = withSimulate(capability.target.baseUrl, opts.simulate);
    assertUrlAllowed(capability.target.baseUrl); // policy is keyed on the real origin/route, not the debug query string
    await page.goto(initialUrl, { waitUntil: "domcontentloaded" });
    await settle(page);
    await logger.screenshot(page, "initial");

    for (const step of capability.steps) {
      // 1. Outcome-rule check BEFORE attempting the step -- catches "the flow already
      //    diverged" (no such member, permission denied, timed out, app error) before
      //    blindly trying to click/fill something that is no longer on the page.
      const ruleMatch = await evaluateOutcomeRules(page, capability.outcomeRules, lastDocStatus);
      if (ruleMatch) {
        const outcome = await resolveRuleMatch(ruleMatch, page, logger, lastDocStatus);
        if (outcome.terminal) {
          const screenshotPath = await logger.screenshot(page, `outcome-${ruleMatch.code}`);
          if (outcome.bucket === "business_outcome") {
            return finish({ status: "business_outcome", capabilityId: capability.id, capabilityVersion: capability.version, businessOutcome: { code: ruleMatch.code, message: ruleMatch.message }, escalated });
          }
          return finish({
            status: "failure",
            capabilityId: capability.id,
            capabilityVersion: capability.version,
            escalated,
            failure: { stepId: "outcome-rule", stepDescription: ruleMatch.id, expected: "flow to proceed normally", observed: ruleMatch.message, message: outcome.message || ruleMatch.message },
          });
        }
        // recovered (e.g. transient condition cleared) -- fall through and attempt this step
      }

      // 2. Guardrail gate on irreversible actions.
      if (step.risk === "irreversible" && !opts.allowIrreversible) {
        escalated = true;
        const screenshotPath = await logger.screenshot(page, `pre-irreversible-${step.id}`);
        const reason = `Irreversible step requires approval: ${step.description}`;
        const { id: requestId, resolution } = interventionManager.open({
          runId,
          runType: "replay",
          capabilityOrGoal: `${capability.id} v${capability.version}`,
          stepDescription: step.description,
          reason,
          page,
          screenshotPath,
        });
        logger.log({ type: "escalation_raised", requestId, reason });
        console.log(`\n>>> INTERVENTION REQUESTED [${requestId}]: ${reason} (unattended replay not allowed)`);
        console.log(`>>> Open http://localhost:${process.env.OPERATOR_PORT || 4200} to resume.\n`);
        const { decision, humanNotes } = await resolution;
        logger.log({ type: "escalation_resumed", requestId, decision, humanNotes });
        if (decision === "abort") {
          return finish({
            status: "failure",
            capabilityId: capability.id,
            capabilityVersion: capability.version,
            escalated,
            failure: { stepId: step.id, stepDescription: step.description, expected: "operator approval", observed: "operator aborted", message: "Run aborted by operator at irreversible-action gate." },
          });
        }
        if (decision === "manual_completed") {
          logger.log({ type: "action_executed", actor: "human", action: step.type, target: step.description, outcome: "ok", detail: "performed manually via operator" });
          continue; // skip our own execution; assume the human already did it on the live session
        }
        // approve_and_continue falls through to normal execution below
      }

      // 3. Execute the step.
      try {
        await executeStep(page, step, params, capability, logger, outputs);
      } catch (err: any) {
        if (err instanceof LocatorResolutionError || err instanceof CheckpointFailedError || err instanceof GuardrailViolation) {
          const screenshotPath = await logger.screenshot(page, `failure-${step.id}`);
          return finish({
            status: "failure",
            capabilityId: capability.id,
            capabilityVersion: capability.version,
            escalated,
            failure: {
              stepId: step.id,
              stepDescription: step.description,
              expected: step.target?.description || step.checkpoint?.description || step.description,
              observed: err.message,
              message: `Hard failure at step "${step.id}": ${err.message}`,
            },
          });
        }
        throw err;
      }
    }

    // 4. Verify overall success checkpoint.
    const cp = capability.successCheckpoint;
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const urlOk = cp.urlPattern ? new URL(page.url()).pathname.includes(cp.urlPattern) : true;
    const textOk = cp.textPresent ? bodyText.includes(cp.textPresent) : true;
    const passed = urlOk && textOk;
    logger.log({ type: "checkpoint", description: cp.description, passed });
    if (!passed) {
      await logger.screenshot(page, "checkpoint-failed");
      return finish({
        status: "failure",
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        escalated,
        failure: {
          stepId: "successCheckpoint",
          stepDescription: cp.description,
          expected: `url matches "${cp.urlPattern}" and body contains "${cp.textPresent}"`,
          observed: `url=${page.url()}`,
          message: "Final success checkpoint did not verify.",
        },
      });
    }

    await logger.screenshot(page, "success");
    return finish({ status: "success", capabilityId: capability.id, capabilityVersion: capability.version, outputs, escalated });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function executeStep(
  page: Page,
  step: Step,
  params: Record<string, string>,
  capability: Capability,
  logger: RunLogger,
  outputs: Record<string, string>
): Promise<void> {
  switch (step.type) {
    case "navigate": {
      assertActionTypeAllowed("navigate");
      const url = new URL(step.url!, capability.target.baseUrl).toString();
      assertUrlAllowed(url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: step.timeoutMs });
      await settle(page);
      logger.log({ type: "action_executed", actor: "agent", action: "navigate", target: step.url, outcome: "ok" });
      return;
    }
    case "click": {
      assertActionTypeAllowed("click");
      const { locator, matchedStrategy } = await resolveTargetRef(page, step.target!);
      await locator.click({ timeout: step.timeoutMs });
      await settle(page);
      logger.log({ type: "action_executed", actor: "agent", action: "click", target: `${step.target?.description} (via ${matchedStrategy})`, outcome: "ok" });
      return;
    }
    case "fill": {
      assertActionTypeAllowed("fill");
      const { locator, matchedStrategy } = await resolveTargetRef(page, step.target!);
      const value = resolveValue(step.value!, params);
      await locator.fill(value, { timeout: step.timeoutMs });
      logger.log({ type: "action_executed", actor: "agent", action: "fill", target: `${step.target?.description} (via ${matchedStrategy})`, outcome: "ok" });
      return;
    }
    case "selectOption": {
      assertActionTypeAllowed("selectOption");
      const { locator, matchedStrategy } = await resolveTargetRef(page, step.target!);
      const value = resolveValue(step.value!, params);
      await locator.selectOption({ label: value }, { timeout: step.timeoutMs });
      logger.log({ type: "action_executed", actor: "agent", action: "selectOption", target: `${step.target?.description} (via ${matchedStrategy})`, outcome: "ok" });
      return;
    }
    case "waitFor": {
      if (step.checkpoint?.textPresent) {
        await page.getByText(step.checkpoint.textPresent).first().waitFor({ timeout: step.timeoutMs });
      } else if (step.checkpoint?.urlPattern) {
        await page.waitForURL(`**${step.checkpoint.urlPattern}`, { timeout: step.timeoutMs });
      }
      logger.log({ type: "action_executed", actor: "agent", action: "waitFor", target: step.checkpoint?.description, outcome: "ok" });
      return;
    }
    case "extract": {
      const { locator, matchedStrategy } = await resolveTargetRef(page, step.target!);
      const raw =
        step.extractAttribute === "value"
          ? await locator.inputValue({ timeout: step.timeoutMs })
          : step.extractAttribute === "href"
          ? (await locator.getAttribute("href")) || ""
          : ((await locator.textContent()) || "").trim();
      outputs[step.outputName!] = raw;
      logger.log({ type: "action_executed", actor: "agent", action: "extract", target: `${step.outputName} (via ${matchedStrategy})`, outcome: "ok", detail: raw });
      return;
    }
    case "assertCheckpoint": {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const urlOk = step.checkpoint?.urlPattern ? new URL(page.url()).pathname.includes(step.checkpoint.urlPattern) : true;
      const textOk = step.checkpoint?.textPresent ? bodyText.includes(step.checkpoint.textPresent) : true;
      if (!urlOk || !textOk) {
        throw new CheckpointFailedError(`Checkpoint "${step.checkpoint?.description}" not satisfied (url=${page.url()})`);
      }
      logger.log({ type: "checkpoint", description: step.checkpoint?.description || step.description, passed: true });
      return;
    }
  }
}

function resolveValue(ref: ValueRef, params: Record<string, string>): string {
  if (ref.kind === "literal") return ref.value;
  if (ref.kind === "param") {
    const v = params[ref.name];
    if (v === undefined) throw new Error(`Missing required input parameter "${ref.name}"`);
    return v;
  }
  return resolveSecret(ref.name);
}

function validateParams(capability: Capability, params: Record<string, string>) {
  for (const input of capability.inputs) {
    if (input.required && !(input.name in params)) {
      throw new Error(`Missing required input parameter "${input.name}" (${input.description})`);
    }
  }
}

function withSimulate(url: string, simulate?: string): string {
  if (!simulate) return url;
  const u = new URL(url);
  u.searchParams.set("simulate", simulate);
  return u.toString();
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
}

async function readBannerText(page: Page): Promise<string> {
  const texts = await page.locator(".banner-err, .banner-warn, .banner-ok").allTextContents().catch(() => []);
  return texts.map((t) => t.trim()).join(" | ");
}

async function evaluateOutcomeRules(page: Page, rules: OutcomeRule[], statusCode: number): Promise<OutcomeRule | undefined> {
  const banner = await readBannerText(page);
  const url = page.url();
  for (const rule of rules) {
    const w = rule.when;
    const urlOk = w.urlPattern ? url.includes(w.urlPattern) : true;
    const textOk = w.textPresent ? banner.toLowerCase().includes(w.textPresent.toLowerCase()) : true;
    const statusOk = w.statusCodeAtLeast ? statusCode >= w.statusCodeAtLeast : true;
    const anyConditionGiven = !!(w.urlPattern || w.textPresent || w.statusCodeAtLeast);
    if (anyConditionGiven && urlOk && textOk && statusOk) return rule;
  }
  return undefined;
}

/** business_outcome / hard_failure are always terminal. recoverable gets bounded retries
 * against the SAME condition (reload + re-check); if it doesn't clear, it is downgraded to
 * a terminal failure rather than silently pretending to succeed. */
async function resolveRuleMatch(
  rule: OutcomeRule,
  page: Page,
  logger: RunLogger,
  statusCode: number
): Promise<{ terminal: boolean; bucket?: OutcomeRule["outcome"]; message?: string }> {
  logger.log({ type: "outcome_classified", bucket: rule.outcome, code: rule.code, message: rule.message });

  if (rule.outcome !== "recoverable") {
    return { terminal: true, bucket: rule.outcome };
  }

  const maxAttempts = rule.recovery?.maxAttempts ?? 1;
  const waitMs = rule.recovery?.waitMs ?? 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.waitForTimeout(waitMs);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    const stillMatches = await evaluateOutcomeRules(page, [rule], statusCode);
    if (!stillMatches) return { terminal: false };
  }
  return { terminal: true, bucket: "hard_failure", message: `Recoverable condition "${rule.code}" did not clear after ${maxAttempts} attempt(s).` };
}
