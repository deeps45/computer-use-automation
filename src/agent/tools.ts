import type Anthropic from "@anthropic-ai/sdk";

// Tool-calling surface for the discovery loop. Every tool takes `reasoning` so the
// "why" is captured structurally in the transcript/log, not scraped from free text.
export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "click",
    description: "Click an interactive element by its [ref] number from the current element list.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "number", description: "The [ref] number of the element to click." },
        reasoning: { type: "string", description: "Why this click moves toward the goal." },
      },
      required: ["ref", "reasoning"],
    },
  },
  {
    name: "fill",
    description: "Type a value into a text/textarea input by its [ref] number.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "number" },
        value: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["ref", "value", "reasoning"],
    },
  },
  {
    name: "select_option",
    description: "Choose an option (by its visible text) in a <select> by its [ref] number.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "number" },
        value: { type: "string", description: "Visible option text, must match one of the listed options=[...]." },
        reasoning: { type: "string" },
      },
      required: ["ref", "value", "reasoning"],
    },
  },
  {
    name: "navigate",
    description: "Navigate directly to a path on the allowed target origin (e.g. \"/search\"). Prefer clicking links/buttons when possible; use this only when there is no on-page control.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["path", "reasoning"],
    },
  },
  {
    name: "wait",
    description: "Wait for a short bounded period (max 5000ms) for a transient load to finish, then re-observe.",
    input_schema: {
      type: "object",
      properties: {
        ms: { type: "number", maximum: 5000 },
        reasoning: { type: "string" },
      },
      required: ["ms", "reasoning"],
    },
  },
  {
    name: "extract",
    description: "Record a named output value read from the current page (e.g. an account balance or new account number). Call this whenever you observe a value the goal asks you to report.",
    input_schema: {
      type: "object",
      properties: {
        output_name: { type: "string", description: "snake_case name for this output, e.g. savings_balance" },
        ref: { type: "number", description: "[ref] of the element containing the value, OR -1 if reading from page banner/body text described in reasoning." },
        value: { type: "string", description: "The literal value observed (you transcribe it)." },
        reasoning: { type: "string" },
      },
      required: ["output_name", "ref", "value", "reasoning"],
    },
  },
  {
    name: "escalate",
    description: "Stop and request a human operator: use this when blocked, when the page state is unexpected/ambiguous, or before an action you are not confident is safe to take unattended.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
  {
    name: "finish",
    description: "End the run because the goal has been fully achieved and verified on the current page.",
    input_schema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        summary: { type: "string" },
        checkpoint_description: { type: "string", description: "A concrete, checkable fact that proves the goal state was reached (e.g. exact banner text or URL)." },
      },
      required: ["success", "summary", "checkpoint_description"],
    },
  },
];
