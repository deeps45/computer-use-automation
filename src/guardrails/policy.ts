import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AllowlistConfig {
  allowedOrigins: string[];
  allowedActionTypes: string[];
  blockedRoutePatterns: string[];
  riskyTextPatterns: string[];
  riskyPageBannerPatterns: string[];
}

let cached: AllowlistConfig | null = null;
export function loadAllowlist(): AllowlistConfig {
  if (cached) return cached;
  const raw = readFileSync(path.join(__dirname, "..", "config", "allowlist.json"), "utf-8");
  cached = JSON.parse(raw);
  return cached!;
}

export class GuardrailViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailViolation";
  }
}

/** Enforced before every navigation and before resolving any target: nothing outside
 *  the configured origin/route allowlist is touched, full stop — no LLM judgment call. */
export function assertUrlAllowed(url: string) {
  const policy = loadAllowlist();
  const u = new URL(url);
  const origin = `${u.protocol}//${u.host}`;
  if (!policy.allowedOrigins.includes(origin)) {
    throw new GuardrailViolation(`Origin not in allowlist: ${origin}`);
  }
  for (const pattern of policy.blockedRoutePatterns) {
    if (u.pathname.startsWith(pattern)) {
      throw new GuardrailViolation(`Route is explicitly blocked by policy: ${u.pathname}`);
    }
  }
}

export function assertActionTypeAllowed(actionType: string) {
  const policy = loadAllowlist();
  if (!policy.allowedActionTypes.includes(actionType)) {
    throw new GuardrailViolation(`Action type not in allowlist: ${actionType}`);
  }
}

/** Risk is classified by policy, not by LLM self-report — the model can be wrong or
 *  persuaded; a regex over the actual control text and page banner can't be talked out
 *  of it. This is deliberately conservative: false positives (extra confirmations) are
 *  cheap, false negatives (an unguarded irreversible action) are not. */
export function classifyActionRisk(controlText: string, pageBannerText: string): "safe" | "irreversible" {
  const policy = loadAllowlist();
  const hay = `${controlText}`.toLowerCase();
  for (const pattern of policy.riskyTextPatterns) {
    if (new RegExp(pattern, "i").test(hay)) return "irreversible";
  }
  for (const pattern of policy.riskyPageBannerPatterns) {
    if (new RegExp(pattern, "i").test(pageBannerText)) return "irreversible";
  }
  return "safe";
}

// ---------------------------------------------------------------------------
// Redaction: never let secrets / raw PII reach an artifact or a log line.
// ---------------------------------------------------------------------------
const SECRET_FIELD_NAMES = /password|passwd|secret|token|api[_-]?key|ssn|social.?security|cvv|pin\b/i;
const CREDIT_CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

export function redactValue(fieldName: string | undefined, value: string): string {
  if (fieldName && SECRET_FIELD_NAMES.test(fieldName)) return "[REDACTED]";
  return value.replace(CREDIT_CARD_RE, "[REDACTED-CC]").replace(SSN_RE, "[REDACTED-SSN]");
}

/** Deep-redacts an arbitrary JSON-ish object before it is written to a log or artifact. */
export function redactDeep<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactValue(undefined, obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map((v) => redactDeep(v)) as unknown as T;
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SECRET_FIELD_NAMES.test(k)) {
        out[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        out[k] = redactValue(k, v);
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as T;
  }
  return obj;
}
