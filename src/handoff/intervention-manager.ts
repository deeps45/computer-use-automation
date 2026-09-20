import { nanoid } from "nanoid";
import type { Page } from "playwright";

export type ResumeDecision = "approve_and_continue" | "manual_completed" | "abort";

export interface InterventionRequest {
  id: string;
  runId: string;
  runType: "discovery" | "replay";
  capabilityOrGoal: string;
  stepDescription: string;
  reason: string;
  urlAtPause: string;
  screenshotPath?: string;
  status: "pending" | "in_progress" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  decision?: ResumeDecision;
  humanNotes?: string;
  manualActions: { at: string; description: string }[];
  /** the live page the human takes control of -- same session, not a fresh one */
  page: Page;
}

type Resolver = (decision: { decision: ResumeDecision; humanNotes?: string }) => void;

/**
 * The seam between "automation is driving" and "a human is driving" for ONE live
 * Playwright session. Automation calls raise() and awaits the returned promise; it
 * blocks (the browser stays open, on whatever page it was on) until the operator
 * surface calls resolve() for that request id. See REPORT.md #5.
 */
export class InterventionManager {
  private requests = new Map<string, InterventionRequest>();
  private resolvers = new Map<string, Resolver>();

  /** Registers the request and returns its id SYNCHRONOUSLY (so the caller can log/
   * print "raised" immediately, before anyone has resumed it), plus a promise that
   * resolves once the operator surface calls resolve() for that id. */
  open(input: {
    runId: string;
    runType: "discovery" | "replay";
    capabilityOrGoal: string;
    stepDescription: string;
    reason: string;
    page: Page;
    screenshotPath?: string;
  }): { id: string; resolution: Promise<{ decision: ResumeDecision; humanNotes?: string }> } {
    const id = nanoid(8);
    const request: InterventionRequest = {
      id,
      runId: input.runId,
      runType: input.runType,
      capabilityOrGoal: input.capabilityOrGoal,
      stepDescription: input.stepDescription,
      reason: input.reason,
      urlAtPause: input.page.url(),
      screenshotPath: input.screenshotPath,
      status: "pending",
      createdAt: new Date().toISOString(),
      manualActions: [],
      page: input.page,
    };
    this.requests.set(id, request);
    const resolution = new Promise<{ decision: ResumeDecision; humanNotes?: string }>((resolve) => {
      this.resolvers.set(id, resolve);
    });
    return { id, resolution };
  }

  /** Convenience wrapper for callers that don't need the id before resolution. */
  async raise(input: Parameters<InterventionManager["open"]>[0]): Promise<{ id: string; decision: ResumeDecision; humanNotes?: string }> {
    const { id, resolution } = this.open(input);
    const result = await resolution;
    return { id, ...result };
  }

  takeControl(id: string) {
    const req = this.requests.get(id);
    if (!req) throw new Error("no such intervention request");
    req.status = "in_progress";
  }

  recordManualAction(id: string, description: string) {
    const req = this.requests.get(id);
    if (!req) throw new Error("no such intervention request");
    req.manualActions.push({ at: new Date().toISOString(), description });
  }

  resolve(id: string, decision: ResumeDecision, humanNotes?: string) {
    const req = this.requests.get(id);
    const resolver = this.resolvers.get(id);
    if (!req || !resolver) throw new Error("no such intervention request");
    req.status = "resolved";
    req.resolvedAt = new Date().toISOString();
    req.decision = decision;
    req.humanNotes = humanNotes;
    resolver({ decision, humanNotes });
    this.resolvers.delete(id);
  }

  get(id: string): InterventionRequest | undefined {
    return this.requests.get(id);
  }

  list(): InterventionRequest[] {
    return [...this.requests.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

// Singleton: the discovery/replay CLI and the operator HTTP server run in the same
// process for this project (see REPORT.md #5 for why, and what a production version
// would swap in instead).
export const interventionManager = new InterventionManager();
