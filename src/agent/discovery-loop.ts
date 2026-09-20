import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { AGENT_TOOLS } from "./tools.js";
import type { Scenario } from "./scenario.js";
import { DiscoverySession, type DiscoveryOutcome } from "./session-controller.js";

const MODEL_ID = process.env.MODEL_ID || "claude-sonnet-5";
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 25);
const MAX_RUNTIME_MS = Number(process.env.AGENT_MAX_RUNTIME_MS || 4 * 60 * 1000);

const SYSTEM_PROMPT = `You are an operations agent driving a real back-office banking console via a
browser, exactly as a trained human operator would: you can only see and act on what is on the
current screen. You do not have API access to this system -- clicking, typing, and reading the
screen is the only way to get anything done.

Each turn you receive: the current URL, any banner/notice text on the page, and a NUMBERED LIST
of interactive elements currently visible, formatted like:
[3] button "Search"
[7] textbox "Member ID"
You act ONLY by calling exactly one tool per turn, referencing elements by their [ref] number.
Numbers are reassigned every turn based on what's currently visible -- always use the ref from the
CURRENT list, never a number from an earlier turn.

Rules:
- Stay strictly on the target application. Never attempt to navigate off it.
- Use the "extract" tool any time you observe a value the goal asks you to report -- do not just
  mention it in reasoning, extract it.
- If a page shows an irreversible-action warning, or you are told an action needs approval, proceed
  only when instructed to -- the system will pause for human approval automatically when needed.
- If you are blocked, confused by the page state, or something looks wrong, call "escalate" rather
  than guessing or retrying the same thing repeatedly.
- Call "finish" only once you can see, on the CURRENT page, concrete proof the goal was achieved.`;

/** Fully automated discovery loop: Claude decides every step via the Anthropic Messages
 * API tool-calling. This is the intended production path. When no ANTHROPIC_API_KEY is
 * available, cli/manual-discover-server.ts exposes the identical DiscoverySession over
 * HTTP so an LLM operator (including this assistant itself) can drive the same
 * guardrails/artifact-building turn by turn -- see REPORT.md. */
export async function runDiscovery(scenario: Scenario): Promise<DiscoveryOutcome> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Export it before running automated discovery (see README.md).");
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const session = new DiscoverySession(scenario, MAX_STEPS, MAX_RUNTIME_MS);
  const headless = process.env.HEADLESS === "true";

  try {
    const obs = await session.start(headless);
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [{ type: "text", text: `GOAL:\n${scenario.goal}\n\n${renderObservation(obs)}` }, imageBlock(obs.screenshotAbsPath)],
      },
    ];

    while (!session.isDone()) {
      const response = await anthropic.messages.create({
        model: MODEL_ID,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        tool_choice: { type: "any" },
        messages,
      });
      messages.push({ role: "assistant", content: response.content });

      const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!toolUse) {
        return { status: "failure", runId: session.runId, logDir: session.logger.runDir };
      }

      const { resultText, observation, outcome } = await session.act(toolUse.name, toolUse.input as Record<string, any>);
      if (outcome) return outcome;

      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUse.id, content: resultText },
          { type: "text", text: renderObservation(observation!) },
          imageBlock(observation!.screenshotAbsPath),
        ],
      });
    }
    return { status: "failure", runId: session.runId, logDir: session.logger.runDir };
  } finally {
    await session.close();
  }
}

function renderObservation(obs: { url: string; bannerText: string; elementsRendered: string }): string {
  return [`URL: ${obs.url}`, obs.bannerText ? `Page banner: ${obs.bannerText}` : "Page banner: (none)", `Interactive elements:\n${obs.elementsRendered}`].join("\n\n");
}

function imageBlock(screenshotAbsPath: string): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: readFileSync(screenshotAbsPath).toString("base64") } };
}

export type { DiscoveryOutcome };
