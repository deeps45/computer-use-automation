# Evidence index

Each folder is one run: `log.jsonl` (structured event log), `screenshots/`, and for replay
runs, `result.json` (the exact result contract returned to the caller). Discovery runs also
write `artifact.json` (the capability produced by that run).

## Discovery runs (real, live, LLM-driven -- see note below)

- `discovery-creditvantage-lookup-member-balance-1789875705883/` -- goal: *"search for
  member 12345 ... report Savings and Checking balances"*. 9 turns, no escalation needed.
  Produced `artifacts/creditvantage.lookup-member-balance/v1.json`.
- `discovery-creditvantage-open-subaccount-1789875924369/` -- goal: *"open a new Savings
  sub-account ... confirm ... report the new account number"*. 14 turns, **includes one
  live irreversible-action escalation** (see `log.jsonl` for `escalation_raised` /
  `escalation_resumed` events around step 12, the "Confirm & Open Account" click) that
  paused the run until approved via the operator console. Produced
  `artifacts/creditvantage.open-subaccount/v1.json`.

**Who made the decisions:** no `ANTHROPIC_API_KEY` was available in the environment this
was built in. `src/agent/discovery-loop.ts` is the production path -- it drives this exact
session via the Anthropic Messages API tool-calling loop, and is what ships. For these two
runs, the identical `DiscoverySession` (same guardrails, same locator-building, same
artifact assembly) was instead driven turn-by-turn over the HTTP control surface in
`src/cli/manual-discover-server.ts` by the assistant that built this project, genuinely
observing each live screenshot/element-list and deciding the next action in real time
against the live target app -- not scripted or replayed from a transcript. `log.jsonl`'s
`llm_decision` events are exactly what a `tool_use` block from the automated path would
have contained. See REPORT.md's Architecture section for the full rationale.

## Replay runs (deterministic, no LLM)

- `replay-creditvantage-lookup-member-balance-1789876072465-oPzT/` -- **success**, member
  34567 (a different member than discovery used -- proves the artifact generalizes via
  its `memberId` parameter, not hard-coded data).
- `replay-creditvantage-lookup-member-balance-1789876081197-GDZN/` -- **business outcome**,
  member 99999 (`member_not_found` -- a legitimate answer, not a crash).
- `replay-creditvantage-lookup-member-balance-1789876051104-UM1W/` -- **hard failure**,
  member 23456, who has no Checking account. This one is a real bug this project's own
  testing caught: the locator fallback originally included a column-header-based XPath
  that (for a table with only one data row) silently resolved to the *Savings* cell when
  asked for *Checking*. Fixed in `src/browser/locate.ts` (row-relative and column-relative
  are now mutually exclusive strategies); this run is the fixed behavior -- a clean,
  debuggable failure instead of a silently wrong value.
- `replay-creditvantage-open-subaccount-1789876084344-lSHo/` -- **business outcome**,
  `validation_error` (opening deposit below the $25 minimum).
- `replay-creditvantage-open-subaccount-1789876093099-UBWV/` -- **success, `approve_and_continue`**:
  replay paused at the "Confirm & Open Account" step (see `escalation_raised`/
  `escalation_resumed` in its log), the operator reviewed the context and approved it via
  `POST /api/intervention/:id/resume` (`approve_and_continue`), and the agent performed the
  click itself and completed the run.
- `replay-creditvantage-open-subaccount-1789876183228-c4iw/` -- **success, `manual_completed`**:
  the stronger form of "take control of the live session." While paused at the same gate,
  the operator instead called `POST /intervention/:id/manual-action` to click "Confirm &
  Open Account" **directly on the live, paused Playwright session** (the one the automation
  had been driving, not a fresh one), then resumed with `manual_completed` so the replay
  engine skipped its own execution of that step, trusted the human's action, and continued
  straight to extracting the result. `log.jsonl` shows the resulting step attributed to
  `"actor":"human"`.

The `abort` resolution path (operator declines and the run ends as a reported failure, not
a crash) was also exercised during development against this same code path; not re-included
here as a separate folder to keep this index focused on one clean example per outcome type.
