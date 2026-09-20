import { readFileSync } from "node:fs";
import type { Scenario } from "./scenario.js";
import { DiscoverySession, type DiscoveryOutcome } from "./session-controller.js";
import { AGENT_TOOLS } from "./tools.js";

const BASE_URL = process.env.OPENAI_COMPAT_BASE_URL;
const API_KEY = process.env.OPENAI_COMPAT_API_KEY;
const MODEL = process.env.OPENAI_COMPAT_MODEL || "protected.Claude Sonnet 4.5";
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 25);
const MAX_RUNTIME_MS = Number(process.env.AGENT_MAX_RUNTIME_MS || 6 * 60 * 1000);

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
- Call "finish" only once you can see, on the CURRENT page, concrete proof the goal was achieved.
- Always respond by calling exactly one of the provided tools. Do not respond with plain text.`;

// Anthropic's {name, description, input_schema} maps 1:1 onto OpenAI-style function-calling
// -- input_schema IS already a JSON Schema object, so this is a pure relabeling.
const OPENAI_TOOLS = AGENT_TOOLS.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema as Record<string, unknown> },
}));

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: "system" | "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Talks to the gateway with plain `fetch` rather than the `openai` SDK. Reason: this
 * particular gateway's docs show `"stream": "false"` as a literal STRING, and empirically
 * a typed JSON `false` boolean (what the openai SDK sends) still comes back as an SSE
 * stream instead of a single JSON object. Matching the documented request shape exactly
 * avoids depending on an SDK's serialization for a quirk specific to this one gateway.
 */
async function chatCompletion(messages: ChatMessage[], attempt = 1): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, stream: "false", messages, tools: OPENAI_TOOLS, tool_choice: "auto" }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Gateway error ${res.status}: ${raw.slice(0, 500)}`);
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Gateway returned a non-JSON (likely streamed) response despite stream:"false": ${raw.slice(0, 300)}`);
    }
    if (parsed.error) throw new Error(`Gateway error: ${JSON.stringify(parsed.error)}`);
    const message = parsed.choices?.[0]?.message;
    if (!message) throw new Error(`Unexpected response shape: ${raw.slice(0, 500)}`);
    return { content: message.content ?? null, toolCalls: message.tool_calls ?? [] };
  } catch (err: any) {
    // Transient connection resets happen on this gateway, especially as the request body
    // grows with accumulated screenshots (see pruneOldImages below, which also mitigates
    // this by keeping the body smaller). Bounded retry, not indefinite -- a real outage
    // should still surface as a failure rather than hang.
    const isTransient = attempt < 3 && /fetch failed|ECONNRESET|socket|other side closed|ETIMEDOUT/i.test(String(err?.cause || err?.message || err));
    if (isTransient) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return chatCompletion(messages, attempt + 1);
    }
    throw err;
  }
}

/** Keeps only the most recent screenshot with full image content; earlier ones are
 * collapsed to a text placeholder. Older screenshots are stale by the time a new one
 * exists anyway, and letting every turn's image accumulate in the request body is both
 * wasteful and (per the transient-disconnect above) a real reliability risk. */
function pruneOldImages(messages: ChatMessage[]): ChatMessage[] {
  const lastImageIdx = messages.map((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url")).lastIndexOf(true);
  return messages.map((m, i) => {
    if (i === lastImageIdx || !Array.isArray(m.content)) return m;
    const pruned = m.content.map((c) => (c.type === "image_url" ? ({ type: "text", text: "[earlier screenshot omitted -- superseded by a later observation]" } as ContentPart) : c));
    return { ...m, content: pruned } as ChatMessage;
  });
}

/**
 * Same DiscoverySession, same guardrails, same artifact assembly as
 * agent/discovery-loop.ts -- only the chat client differs: any OpenAI-compatible chat-
 * completions endpoint (e.g. a university LLM gateway proxying Bedrock/Vertex models)
 * instead of the Anthropic Messages API directly. Selected automatically by
 * cli/discover.ts when OPENAI_COMPAT_API_KEY is set instead of ANTHROPIC_API_KEY. See
 * REPORT.md's Architecture section for why the decision-maker is a pluggable seam.
 */
export async function runDiscoveryOpenAICompat(scenario: Scenario): Promise<DiscoveryOutcome> {
  if (!API_KEY || !BASE_URL) {
    throw new Error("OPENAI_COMPAT_API_KEY and OPENAI_COMPAT_BASE_URL must both be set (see README.md).");
  }
  const session = new DiscoverySession(scenario, MAX_STEPS, MAX_RUNTIME_MS, `${MODEL} (via ${BASE_URL})`);
  const headless = process.env.HEADLESS === "true";

  try {
    const obs = await session.start(headless);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: `GOAL:\n${scenario.goal}\n\n${renderObservation(obs)}` }, imageBlock(obs.screenshotAbsPath)] },
    ];

    let noToolCallStreak = 0;

    while (!session.isDone()) {
      const { content, toolCalls } = await chatCompletion(pruneOldImages(messages));
      const toolCall = toolCalls[0];

      if (!toolCall) {
        noToolCallStreak += 1;
        if (noToolCallStreak >= 2) {
          return { status: "failure", runId: session.runId, logDir: session.logger.runDir };
        }
        messages.push({ role: "assistant", content: content || "" });
        messages.push({ role: "user", content: "You must call exactly one of the provided tools -- do not respond with plain text." });
        continue;
      }
      noToolCallStreak = 0;

      messages.push({ role: "assistant", content, tool_calls: [toolCall] });

      let input: Record<string, any>;
      try {
        input = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        input = {};
      }

      const { resultText, observation, outcome } = await session.act(toolCall.function.name, input);
      if (outcome) return outcome;

      messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
      messages.push({ role: "user", content: [{ type: "text", text: renderObservation(observation!) }, imageBlock(observation!.screenshotAbsPath)] });
    }
    return { status: "failure", runId: session.runId, logDir: session.logger.runDir };
  } finally {
    await session.close();
  }
}

function renderObservation(obs: { url: string; bannerText: string; elementsRendered: string }): string {
  return [`URL: ${obs.url}`, obs.bannerText ? `Page banner: ${obs.bannerText}` : "Page banner: (none)", `Interactive elements:\n${obs.elementsRendered}`].join("\n\n");
}

function imageBlock(screenshotAbsPath: string): ContentPart {
  return { type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(screenshotAbsPath).toString("base64")}` } };
}
