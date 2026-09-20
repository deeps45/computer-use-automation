import { chromium, type Page, type Browser, type BrowserContext } from "playwright";
import { buildElementIndex, renderElementIndex, type ElementInfo } from "../browser/element-index.js";
import { buildTargetRef } from "../browser/locate.js";
import type { Scenario } from "./scenario.js";
import { RunLogger } from "../logging/logger.js";
import { assertUrlAllowed, assertActionTypeAllowed, classifyActionRisk, GuardrailViolation } from "../guardrails/policy.js";
import { interventionManager } from "../handoff/intervention-manager.js";
import { resolveSecret } from "../guardrails/secrets.js";
import type { Capability, Step, OutputSpec, ValueRef } from "../artifact/schema.js";

export interface DiscoveryOutcome {
  status: "success" | "failure" | "aborted";
  capability?: Capability;
  runId: string;
  logDir: string;
}

export interface Observation {
  url: string;
  bannerText: string;
  elementsRendered: string;
  screenshotAbsPath: string;
}

class StuckError extends Error {}
class AbortRequested extends Error {}

/**
 * The observe -> decide -> act session, factored out so it can be driven by EITHER
 * the automated Anthropic tool-calling loop (agent/discovery-loop.ts, used when
 * ANTHROPIC_API_KEY is set) OR a turn-by-turn HTTP control surface driven directly
 * by an LLM operator (cli/manual-discover-server.ts) -- same guardrails, same
 * artifact-building, same evidence trail either way. See REPORT.md's note on how
 * the discovery run in /evidence/ was actually produced.
 */
export class DiscoverySession {
  readonly runId: string;
  readonly logger: RunLogger;
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;

  private elements: ElementInfo[] = [];
  private locators: import("playwright").Locator[] = [];
  private lastBannerText = "";
  private recordedSteps: Step[] = [];
  private outputsCollected = new Map<string, { value: string; reasoning: string }>();
  private stepCounter = 0;
  private lastActionSignature = "";
  private startedAt = 0;
  private finished = false;

  constructor(readonly scenario: Scenario, private maxSteps: number, private maxRuntimeMs: number) {
    this.runId = `discovery-${scenario.capabilityId.replace(/\./g, "-")}-${Date.now()}`;
    this.logger = new RunLogger("evidence", this.runId);
  }

  async start(headless: boolean): Promise<Observation> {
    this.logger.log({ type: "run_started", runType: "discovery", goalOrCapabilityId: this.scenario.goal });
    this.browser = await chromium.launch({ headless });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } });
    this.page = await this.context.newPage();
    this.startedAt = Date.now();

    assertUrlAllowed(this.scenario.baseUrl);
    await this.page.goto(this.scenario.baseUrl, { waitUntil: "domcontentloaded" });
    await settle(this.page);
    return this.observe("observe");
  }

  private async observe(label: string): Promise<Observation> {
    const { elements, locators } = await buildElementIndex(this.page);
    this.elements = elements;
    this.locators = locators;
    const bannerText = await readBannerText(this.page);
    this.lastBannerText = bannerText;
    const screenshotRel = await this.logger.screenshot(this.page, label);
    const elementsRendered = renderElementIndex(elements);
    this.logger.log({ type: "observation", url: this.page.url(), summary: bannerText || "(no banner)", screenshot: screenshotRel });
    return {
      url: this.page.url(),
      bannerText,
      elementsRendered,
      screenshotAbsPath: `${this.logger.runDir}/${screenshotRel}`,
    };
  }

  isDone(): boolean {
    return this.finished;
  }

  stepsSoFar(): number {
    return this.recordedSteps.length;
  }

  /** Executes exactly one decided action (mirrors the tool schema in agent/tools.ts)
   * and returns the fresh observation plus a text summary of what happened. */
  async act(tool: string, input: Record<string, any>): Promise<{ resultText: string; observation?: Observation; outcome?: DiscoveryOutcome }> {
    if (this.finished) throw new Error("Session already finished.");
    if (this.recordedSteps.length + 1 > this.maxSteps) {
      this.finished = true;
      this.logger.log({ type: "run_finished", status: "failure", detail: "max_steps_exceeded" });
      return { resultText: "max steps exceeded", outcome: { status: "failure", runId: this.runId, logDir: this.logger.runDir } };
    }
    if (Date.now() - this.startedAt > this.maxRuntimeMs) {
      this.finished = true;
      this.logger.log({ type: "run_finished", status: "failure", detail: "timeout" });
      return { resultText: "timeout exceeded", outcome: { status: "failure", runId: this.runId, logDir: this.logger.runDir } };
    }

    this.logger.log({ type: "llm_decision", step: this.recordedSteps.length + 1, tool, args: input, reasoning: input.reasoning });
    // Keyed on the current URL + the element's NAME (not its numeric [ref], which is
    // just an array index freshly reassigned every page and so collides constantly
    // across different pages/turns) so this only fires on a genuine same-page repeat.
    const targetName = typeof input.ref === "number" ? this.elements[input.ref]?.name : undefined;
    const signature = `${this.page.url()}::${tool}:${targetName ?? input.ref ?? ""}:${input.value ?? ""}:${input.path ?? ""}`;
    const isRepeat = signature === this.lastActionSignature && tool !== "extract" && tool !== "wait";
    this.lastActionSignature = signature;

    let resultText = "";
    let outcome: DiscoveryOutcome | undefined;

    try {
      if (isRepeat) throw new StuckError("Repeated the same action with no visible progress since last turn.");

      switch (tool) {
        case "click": {
          const el = this.elements[input.ref];
          if (!el) throw new Error(`No element with ref ${input.ref}`);
          assertActionTypeAllowed("click");
          const risk = classifyActionRisk(el.name, this.currentBanner());
          const desc = `Click "${el.name}"`;
          const decided = await this.maybeGateOnRisk(risk, desc);
          if (decided !== "skip_execution") await this.locators[input.ref].click({ timeout: 5000 });
          await settle(this.page);
          this.record("click", desc, risk, { target: buildTargetRef(el, desc) });
          resultText = `Clicked "${el.name}".`;
          break;
        }
        case "fill": {
          const el = this.elements[input.ref];
          if (!el) throw new Error(`No element with ref ${input.ref}`);
          assertActionTypeAllowed("fill");
          const desc = `Enter value into "${el.name}"`;
          const isSecret = el.type === "password" || el.nameAttr === "username" || el.nameAttr === "password";
          const valueToType = isSecret ? resolveSecret(el.nameAttr || el.name) : String(input.value);
          await this.locators[input.ref].fill(valueToType, { timeout: 5000 });
          const valueRef: ValueRef = isSecret ? { kind: "secretRef", name: el.nameAttr || el.name } : this.bindParamOrLiteral(String(input.value));
          this.record("fill", desc, "safe", { target: buildTargetRef(el, desc), value: valueRef });
          resultText = isSecret ? `Filled "${el.name}" (secret, not logged).` : `Filled "${el.name}" with "${input.value}".`;
          break;
        }
        case "select_option": {
          const el = this.elements[input.ref];
          if (!el) throw new Error(`No element with ref ${input.ref}`);
          assertActionTypeAllowed("selectOption");
          const desc = `Select "${input.value}" in "${el.name}"`;
          await this.locators[input.ref].selectOption({ label: String(input.value) }, { timeout: 5000 });
          this.record("selectOption", desc, "safe", { target: buildTargetRef(el, desc), value: this.bindParamOrLiteral(String(input.value)) });
          resultText = `Selected "${input.value}" in "${el.name}".`;
          break;
        }
        case "navigate": {
          const url = new URL(input.path, this.scenario.baseUrl).toString();
          assertUrlAllowed(url);
          assertActionTypeAllowed("navigate");
          await this.page.goto(url, { waitUntil: "domcontentloaded" });
          await settle(this.page);
          this.record("navigate", `Navigate to ${input.path}`, "safe", { url: input.path });
          resultText = `Navigated to ${input.path}.`;
          break;
        }
        case "wait": {
          const ms = Math.min(Number(input.ms) || 1000, 5000);
          await this.page.waitForTimeout(ms);
          resultText = `Waited ${ms}ms.`;
          break;
        }
        case "extract": {
          const desc = `Extract ${input.output_name}`;
          const target = input.ref >= 0 && this.elements[input.ref] ? buildTargetRef(this.elements[input.ref], desc) : undefined;
          this.outputsCollected.set(input.output_name, { value: String(input.value), reasoning: input.reasoning || "" });
          this.record("extract", desc, "safe", { target, outputName: input.output_name, extractAttribute: "text" });
          resultText = `Recorded output ${input.output_name} = "${input.value}".`;
          break;
        }
        case "escalate": {
          const screenshotPath = await this.logger.screenshot(this.page, "escalation");
          const { decision } = await this.raiseAndAwait(`(agent-requested) step ${this.recordedSteps.length + 1}`, input.reason, screenshotPath);
          if (decision === "abort") {
            this.finished = true;
            outcome = { status: "aborted", runId: this.runId, logDir: this.logger.runDir };
            resultText = "Operator aborted the run.";
          } else {
            resultText = `Operator resumed (decision: ${decision}). Re-observe and continue.`;
          }
          break;
        }
        case "finish": {
          if (!input.success) {
            this.finished = true;
            this.logger.log({ type: "run_finished", status: "failure", detail: input.summary });
            outcome = { status: "failure", runId: this.runId, logDir: this.logger.runDir };
            resultText = "Recorded as failed finish.";
            break;
          }
          const genericUrlPattern = genericizeUrlPattern(new URL(this.page.url()).pathname, this.scenario.inputBindings);
          this.recordedSteps.push(
            makeStep(`s${++this.stepCounter}`, "assertCheckpoint", input.checkpoint_description, "safe", {
              checkpoint: { description: input.checkpoint_description, urlPattern: genericUrlPattern, textPresent: this.currentBanner() || undefined },
            })
          );
          this.logger.log({ type: "checkpoint", description: input.checkpoint_description, passed: true });
          const capability = this.buildCapability(input.checkpoint_description, genericUrlPattern);
          this.logger.writeJson("artifact.json", capability);
          this.logger.log({ type: "run_finished", status: "success", detail: input.summary });
          this.finished = true;
          outcome = { status: "success", capability, runId: this.runId, logDir: this.logger.runDir };
          resultText = "Recorded as successful finish.";
          break;
        }
        default:
          throw new Error(`Unknown tool "${tool}"`);
      }
    } catch (err: any) {
      if (err instanceof AbortRequested) {
        this.finished = true;
        this.logger.log({ type: "run_finished", status: "aborted", detail: err.message });
        outcome = { status: "aborted", runId: this.runId, logDir: this.logger.runDir };
        resultText = "Operator aborted the run.";
      } else if (err instanceof GuardrailViolation) {
        this.logger.log({ type: "guardrail_block", reason: err.message, action: input });
        resultText = `BLOCKED by policy: ${err.message}. Choose a different, in-policy action.`;
      } else {
        const reason = err instanceof StuckError ? err.message : `Action failed: ${err.message}`;
        const screenshotPath = await this.logger.screenshot(this.page, "escalation");
        const { decision } = await this.raiseAndAwait(`step ${this.recordedSteps.length + 1} (${tool})`, reason, screenshotPath);
        resultText = decision === "abort" ? "Operator aborted the run." : `Operator intervened (decision: ${decision}). Re-observe current state and continue.`;
        if (decision === "abort") {
          this.finished = true;
          outcome = { status: "aborted", runId: this.runId, logDir: this.logger.runDir };
        }
      }
    }

    if (this.finished) return { resultText, outcome };
    const observation = await this.observe("after-action");
    return { resultText, observation };
  }

  async close() {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }

  private currentBanner(): string {
    return this.lastBannerText;
  }

  private record(type: Step["type"], description: string, risk: Step["risk"], rest: Partial<Step>) {
    this.recordedSteps.push({ id: `s${++this.stepCounter}`, type, description, risk, timeoutMs: 8000, ...rest } as Step);
  }

  private bindParamOrLiteral(value: string): ValueRef {
    for (const [paramName, bound] of Object.entries(this.scenario.inputBindings)) {
      if (bound === value) return { kind: "param", name: paramName };
    }
    return { kind: "literal", value };
  }

  private async maybeGateOnRisk(risk: "safe" | "irreversible", stepDesc: string): Promise<"execute" | "skip_execution"> {
    if (risk === "safe") return "execute";
    const screenshotPath = await this.logger.screenshot(this.page, "pre-irreversible");
    const { decision } = await this.raiseAndAwait(stepDesc, `Irreversible action requires operator approval before it is taken: ${stepDesc}`, screenshotPath);
    if (decision === "abort") throw new AbortRequested("Operator aborted at irreversible-action approval gate.");
    if (decision === "manual_completed") return "skip_execution";
    return "execute";
  }

  private async raiseAndAwait(stepDescription: string, reason: string, screenshotPath: string) {
    const { id, resolution } = interventionManager.open({
      runId: this.runId,
      runType: "discovery",
      capabilityOrGoal: this.scenario.name,
      stepDescription,
      reason,
      page: this.page,
      screenshotPath,
    });
    this.logger.log({ type: "escalation_raised", requestId: id, reason });
    console.log(`\n>>> INTERVENTION REQUESTED [${id}]: ${reason}`);
    console.log(`>>> Open the operator console (http://localhost:${process.env.OPERATOR_PORT || 4200}) to resume.\n`);
    const result = await resolution;
    this.logger.log({ type: "escalation_resumed", requestId: id, decision: result.decision, humanNotes: result.humanNotes });
    return { requestId: id, decision: result.decision };
  }

  private buildCapability(checkpointDescription: string, urlPattern: string): Capability {
    const outputSpecs: OutputSpec[] = [...this.outputsCollected.entries()].map(([name, { reasoning }]) => ({
      name,
      type: "string",
      description: reasoning || name,
    }));
    const irreversibleStepIds = this.recordedSteps.filter((s) => s.risk === "irreversible").map((s) => s.id);
    const origin = new URL(this.scenario.baseUrl).origin;
    return {
      schemaVersion: "1.0",
      id: this.scenario.capabilityId,
      name: this.scenario.name,
      description: this.scenario.description,
      version: 1,
      createdAt: new Date().toISOString(),
      provenance: { discoveredBy: "llm", model: process.env.MODEL_ID || "claude-sonnet-5", discoveryRunId: this.runId },
      target: { appId: this.scenario.appId, label: this.scenario.appLabel, baseUrl: this.scenario.baseUrl, allowedOrigins: [origin] },
      inputs: this.scenario.inputs,
      outputs: outputSpecs,
      steps: this.recordedSteps,
      outcomeRules: this.scenario.outcomeRules,
      successCheckpoint: { description: checkpointDescription, urlPattern },
      risk: { hasIrreversibleSteps: irreversibleStepIds.length > 0, irreversibleStepIds },
    };
  }
}

function makeStep(id: string, type: Step["type"], description: string, risk: Step["risk"], rest: Partial<Step>): Step {
  return { id, type, description, risk, timeoutMs: 8000, ...rest } as Step;
}

function genericizeUrlPattern(pathname: string, inputBindings: Record<string, string>): string {
  let pattern = pathname;
  for (const value of Object.values(inputBindings)) {
    if (value && pattern.includes(value)) pattern = pattern.split(value)[0];
  }
  return pattern;
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
}

async function readBannerText(page: Page): Promise<string> {
  const texts = await page.locator(".banner-err, .banner-warn, .banner-ok").allTextContents().catch(() => []);
  return texts.map((t) => t.trim()).join(" | ");
}
