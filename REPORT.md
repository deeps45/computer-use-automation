# REPORT

## 1. Architecture

A single Node/TypeScript process, no queues or services -- justified because the brief
explicitly asks for a small, correct system over scaling infrastructure. The layers:

- **`target-app/`** -- a mock "CreditVantage" back-office console (Express, server-rendered,
  table layouts, no `data-testid`/semantic classes, real `<table>`/`<input>`/`<button>`
  elements) standing in for the legacy surfaces described in the brief. It supports
  deterministic runtime-error injection (`?simulate=timeout|slow|error500`) so replay's
  error handling can be exercised on demand, not just hoped for.
- **`src/browser/`** -- perception and targeting. `element-index.ts` walks the live page for
  interactive controls *and* table cells, producing one numbered list keyed on role +
  accessible name (not CSS classes or DOM structure). `locate.ts` turns a chosen element
  into an ordered, portable locator fallback chain (the `TargetRef`).
- **`src/agent/session-controller.ts`** -- the observe → decide → act state machine
  (`DiscoverySession`): guardrail checks, risk classification, escalation, and artifact
  assembly all live here, independent of *who* decides the next action.
- **`src/agent/discovery-loop.ts`** -- the production decision-maker: drives a
  `DiscoverySession` via the Anthropic Messages API with forced tool-calling
  (`tool_choice: "any"`), feeding it the element list + a live screenshot each turn.
- **`src/cli/manual-discover-server.ts`** -- the *same* `DiscoverySession` exposed over a
  thin HTTP API (`POST /start`, `POST /act`). **Why this exists:** no `ANTHROPIC_API_KEY`
  was available in the environment this was built in. Rather than fake the discovery run,
  the two runs in `/evidence/` were driven turn-by-turn over this API by the assistant that
  built this project, genuinely reading each live screenshot and element list and deciding
  the next tool call in real time against the live target app -- the identical guardrails,
  locator-building, and artifact assembly that `discovery-loop.ts` would exercise, just with
  a different chooser of the next action. `discovery-loop.ts` is what ships; this is how the
  one mandatory "real LLM-driven run" requirement was honestly satisfied without funding an
  API key. See `evidence/README.md` for the disclosure attached to those specific runs.
- **`src/replay/executor.ts`** -- the deterministic path: no LLM, resolves `TargetRef`s
  against the live page, checks a declarative outcome taxonomy before every step, verifies
  checkpoints, returns a typed result.
- **`src/guardrails/`** -- allowlist enforcement, risk classification, and redaction, called
  from *both* the discovery and replay paths (not duplicated).
- **`src/handoff/`** -- `InterventionManager` (holds the paused request + the live `Page`
  handle) and `operator-server.ts` (a bare Express console, run in-process with whichever
  CLI raised the request). Explicitly mocked per the brief's scope note; the pause/resume/
  control-transfer mechanism it drives is real (see §5).
- **`src/artifact/`** -- Zod schema + file-based store (`artifacts/<id>/v<N>.json`).

**Trade-off called out on purpose:** the operator server and intervention manager are
in-process singletons, so a request only survives as long as the CLI process that raised it.
That's fine for one demo run; §5 and §7 describe what a real deployment needs instead.

## 2. Artifact schema

A capability is **steps + typed contract**, deliberately decoupled from the raw model
transcript (`src/artifact/schema.ts`):

- **`steps`**: a typed union (`navigate`/`click`/`fill`/`selectOption`/`waitFor`/`extract`/
  `assertCheckpoint`), each carrying a `risk` flag (`safe`/`irreversible`).
- **`TargetRef`**: not a single selector -- an *ordered fallback chain* of
  `role`/`label`/`text`/`css`/`xpath` candidates plus a `rationale` string explaining the
  ordering. Role + accessible name is tried first (survives markup/CSS changes); a
  name/id-attribute CSS selector is last (most implementation-coupled). This is the direct
  answer to "no stable selectors": don't pick one selector, pick a *strategy*.
- **`ValueRef`**: `literal` | `param` (bound to a typed input at replay time) | `secretRef`
  (resolved from an env var at run time, **never** written into the artifact -- see §6).
- **`OutcomeRule[]`**: declarative `when` (URL substring / banner text / status code) →
  `business_outcome` | `recoverable` | `hard_failure`, each with a `code` and `message`.
  This is the taxonomy from §3, expressed as data the replay engine consumes, not
  hard-coded control flow.
- **`inputs`/`outputs`**: typed, with descriptions -- this is the contract a calling agent
  or a human reviewer reads to know what the capability needs and returns, without reading
  the steps.
- **`successCheckpoint`**: a final assertion (URL substring and/or body text) proving the
  goal state was actually reached, not just that the last click didn't throw.
- **Tabular data got special treatment.** Balances and a new account number live in plain
  `<td>` cells with no interactive semantics. Locating them by their *own* text would only
  ever match today's value, so `element-index.ts` also indexes cells with row/column
  context, and `locate.ts` builds a **row-relative XPath** (keyed on the row's stable first
  cell, e.g. `"Savings"`) or a **column-relative XPath** (keyed on the column header, for
  single-row tables like the new-account-number screen) -- structural, not value-based. This
  is the one place XPath is the right tool in this project, precisely because it's positional
  rather than content-matching.

## 3. Determinism & error handling

Replay never calls an LLM. Before *every* step it checks the artifact's `outcomeRules`
against the live page (banner text / URL / last document status code):

- **`business_outcome`** (not found, permission denied, validation failed) is terminal and
  reported distinctly from a crash -- exactly the "no such member" ≠ failure distinction the
  brief calls out as the most common design mistake.
- **`recoverable`** gets a bounded reload-and-recheck; if the condition doesn't clear, it is
  **downgraded to a hard failure** rather than silently pretending to succeed. Currently the
  only implemented recovery is "wait, reload, recheck" (good for a stale transient state);
  self-healing a session timeout by replaying the capability's own login steps is designed
  for but not built (§7).
- **`hard_failure`** and any unanticipated locator-resolution failure stop the run and
  surface `{stepId, expected, observed, message}` -- enough to debug without re-running.

Locator resolution tries each `TargetRef` candidate in order and requires an exact,
*visible* match; it never guesses among ambiguous matches.

**A real bug found via testing, and how it was fixed:** the first version of the tabular
locator attached the column-header XPath as a *fallback* after the row-relative XPath for
every cell. For a member with only one account (no "Checking" row), that fallback matched
the *wrong* cell -- the 3rd `<td>` in document order, which was the Savings balance -- and
returned it silently as the Checking balance. That is the single worst failure mode this
system could produce: a *wrong* answer reported as success. Replaying against a second,
differently-shaped member caught it immediately. Fixed by making row-relative and
column-relative mutually exclusive: a row-keyed cell gets **only** the row-relative
strategy, so a missing row now fails cleanly (`LocatorResolutionError`, hard failure) instead
of guessing. See `evidence/replay-creditvantage-lookup-member-balance-*-UM1W/` for the fixed
behavior. This is also the strongest evidence in this project that failing loudly beats
failing helpfully-but-wrong.

UI drift (as opposed to runtime errors) is secondary per the brief's own framing, but the
fallback chain provides some resilience "for free": a text change breaks the `role+name`
candidate but not necessarily `label` or `css`.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `element-index.ts`/`locate.ts` are the *only* files that know about
Playwright/DOM. Everything above them -- the artifact schema, the replay contract, the
guardrails -- only deals in `{role, name}` and `TargetRef` candidates. Extending to a
legacy web app needs no new abstraction (`target-app` already *is* one: table layouts, no
test IDs). Extending to a desktop app means writing a new surface driver that produces the
same `ElementInfo{role,name}` shape from an OS accessibility tree (UIA on Windows, the
Accessibility API on macOS) and resolves the same `role`/`label`/`text` candidate types
against it (`css`/`xpath` wouldn't apply there; a coordinate-based candidate could be added
as a further fallback). Neither the schema nor `replay/executor.ts` would need to change.

**Multi-tenant reuse.** Today a capability's only tenant-specific data is
`target.baseUrl`/`allowedOrigins`. The natural extension: split a capability into a shared,
vendor-product-level artifact (`artifacts/<vendorProduct>.<capability>/v<N>.json`) and a
per-tenant binding/override layer (e.g. `tenants/<tenantId>/<capabilityId>.overrides.json`)
that can supply a different `baseUrl` and, where a tenant's branding changed a button's
visible text, **prepend** a tenant-specific `TargetRef` candidate ahead of the shared ones.
Because `TargetRef` is already an ordered list rather than one selector, this is additive,
not a fork -- the shared candidates remain the fallback. Not built (out of required scope
per the brief), but nothing in the schema blocks it.

**Drift detection.** The replay result already carries the raw material: which locator
strategy matched, or the full list of strategies tried on failure. A lightweight (not built)
addition would aggregate failure/fallback-tier rates per `(capabilityId, tenantId)` and flag
a capability whose steps increasingly fall through to weaker strategies, or start
hard-failing, as an early warning of vendor UI drift -- before it's an outage. The optional
"confidence & approval" stretch goal is exactly this, and was deliberately not built to keep
depth on the load-bearing pieces (§5 below is time better spent).

## 5. Escalation & handoff

**Detect.** Three triggers, one mechanism (`InterventionManager.raise`): (a) the agent calls
`escalate` explicitly; (b) the guardrail-classified `risk: "irreversible"` gate is reached
without prior approval -- classified by policy code (regex over visible control text + page
banner), not by asking the model whether it thinks an action is risky; (c) an execution
error (locator failure, an unexpected exception, a repeated-action loop-guard) is caught and
routed to escalation instead of crashing the run. The *same* irreversible-action gate fires
on both the discovery and replay paths -- both are exercised in `/evidence/`.

**Route.** The request carries the run/capability, the step and reason, a screenshot, the
URL at pause, and -- critically -- the live `Page` handle itself, not a description of it.

**Take control, on the same session.** The browser runs headed by default, so a human at the
machine can act on it directly. The operator console also exposes
`POST /intervention/:id/manual-action`, which executes one click/fill *on that same live
`Page`* -- a scriptable stand-in for literal mouse/keyboard input, used here because no
person was physically present to drive the visible window during evidence capture. Both
"take control" paths are demonstrated: `approve_and_continue` (operator approves, the agent
performs the step) and `manual_completed` (operator performs the step directly, the agent
skips its own execution and trusts it) -- see
`evidence/replay-creditvantage-open-subaccount-*-UBWV/` and `*-c4iw/` respectively. Every
manually-performed action is logged with `"actor":"human"`, distinct from `"actor":"agent"`.

**Resume.** `interventionManager.resolve(id, decision, notes)` unblocks the awaited promise
in the paused run; `abort` ends the run as a reported failure, never a crash.

**Limits, honestly:** everything above lives in one process's memory -- kill the CLI and the
pending request is gone. A real deployment needs a persistent request queue, real
authentication on the operator surface (there is none today), and a proper remote-input
transport (CDP input forwarding or similar) instead of a same-process `Page` handle, since a
production operator is not running on the same machine as the automation worker.

## 6. Safety

- **Allowlist is enforced in code**, not advisory: `assertUrlAllowed`/
  `assertActionTypeAllowed` (`src/guardrails/policy.ts`) throw on any origin, blocked route,
  or action type outside `src/config/allowlist.json`, caught and surfaced as a blocked
  action (discovery) or a hard failure (replay) -- the agent cannot argue its way past it.
- **Risk classification is policy code, not model self-report.** A regex over the actual
  control text and page banner (`classifyActionRisk`) decides `irreversible`, deliberately
  conservative -- an extra confirmation is cheap, an unguarded irreversible action is not.
- **Redaction, defense in depth.** `RunLogger` deep-redacts every log line and artifact
  write: field-name-based (`password`, `token`, `ssn`, ...) and, independently,
  pattern-based (credit-card- and SSN-shaped strings) even in an unlabeled field. Login
  credentials are never embedded as literal values in an artifact -- stored as
  `{kind:"secretRef", name}` and resolved from an env var only at run time
  (`src/guardrails/secrets.ts`).
- **Limits.** Redaction is field-name/pattern based, not a real PII classifier -- a
  disguised sensitive value in an unexpected field could slip through. The operator
  console's manual-action endpoint has no authentication (acceptable for a local demo;
  not for production, which would need real operator authN/authZ and a signed audit trail).

## 7. Cuts

- **Multi-tenant override layer** (§4): designed for, not built.
- **Desktop/native surface driver** (§4): out of required scope; the seam is described.
- **Session-timeout self-healing**: `recoverable` currently only retries a reload; it does
  not re-run a capability's own login steps automatically. It fails safely (downgrades to
  `hard_failure`) rather than doing nothing, but it isn't self-healing yet.
- **Confidence/staleness scoring + draft→approved gating** (optional stretch goal): not
  built, in favor of depth on the escalation and locator-robustness work above.
- **Real-time co-browsing console**: explicitly out of scope per the brief; a bare,
  functional Express console plus a scriptable API were built instead, and both control-
  transfer paths were exercised in `/evidence/`.
- **Test coverage is partial by design.** Unit tests (`npm test`, 22 tests) cover the
  pure, highest-failure-sensitivity logic: locator-building (including a regression test
  for the bug in §3), guardrail enforcement (allowlist bypass tricks, risk classification,
  redaction), and artifact schema validation. The Playwright-dependent paths (the replay
  executor, the discovery session, the escalation handoff) are **not** unit tested --
  they're validated through the real, repeated end-to-end runs captured in `/evidence/`
  instead, which is a deliberate trade-off given the time-box, not an oversight: those
  paths need a live browser and a live target app to mean anything, and the evidence runs
  already exercise every status/outcome branch (success, both business-outcome types, a
  hard failure, and both escalation-resolution paths). If continuing, the next addition
  would be a scripted integration harness that boots `target-app` and runs the CLI paths
  in CI, rather than more unit tests.
