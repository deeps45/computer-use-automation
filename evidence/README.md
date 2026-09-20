# Evidence index

Each folder is one run: `log.jsonl` (structured event log), `screenshots/`, and for replay
runs, `result.json` (the exact result contract returned to the caller). Discovery runs also
write `artifact.json` (the capability produced by that run).

For illustrative, non-run-specific screenshots (every screen of the target app, every state
of the operator console), see **[docs/screenshots/](../docs/screenshots/)** and the
"Screenshots" section of the root [README.md](../README.md) -- everything there is embedded
inline for easy browsing.

## Discovery runs (real, live, fully automated -- LLM tool-calling end to end)

Both runs below were produced by `src/agent/discovery-loop-openai-compat.ts`: the real
`DiscoverySession` driven by actual Claude Sonnet 4.5 tool-calling API calls (via an
OpenAI-compatible chat-completions gateway, model id `protected.Claude Sonnet 4.5`, proxying
to `us.anthropic.claude-sonnet-4-5-20250929-v1:0` on Bedrock) -- no human chose any of the
individual actions. `src/agent/discovery-loop.ts` (direct Anthropic Messages API) is the
alternate, equally-real automated path, selected automatically by `cli/discover.ts` based on
which credentials are set; `src/cli/manual-discover-server.ts` remains available as a
fallback for driving the same session with no LLM API access at all. See REPORT.md's
Architecture section.

- `discovery-creditvantage-lookup-member-balance-1789908118501/` -- goal: *"search for
  member 12345 ... report Savings and Checking balances"*. 9 turns, no escalation needed.
  Produced `artifacts/creditvantage.lookup-member-balance/v1.json`.
- `discovery-creditvantage-open-subaccount-1789908138061/` -- goal: *"open a new Savings
  sub-account ... confirm ... report the new account number"*. 13 turns, **includes one
  live irreversible-action escalation** (see `log.jsonl` for `escalation_raised` /
  `escalation_resumed` events around step 11, the "Confirm & Open Account" click) that
  genuinely paused the automated run mid-flight until approved via the operator console.
  Produced `artifacts/creditvantage.open-subaccount/v1.json`.

## Replay runs (deterministic, no LLM) -- every status/outcome-code combination

**`creditvantage.lookup-member-balance`**

| Run | Params | Result |
|---|---|---|
| `*-oPzT` | `memberId=34567` (not the member discovery used) | **success** -- proves the artifact is parameterized, not hard-coded |
| `*-GDZN` | `memberId=99999` | **business_outcome** `member_not_found` |
| `*-JfgX` | `memberId=40404` | **business_outcome** `permission_denied` |
| `*-F8Fk` | `memberId=12345 --simulate timeout` | **failure** -- `recoverable` rule matched, retried once, didn't clear, correctly **downgraded to a hard failure** instead of hanging or pretending to succeed |
| `*-07nb` | `memberId=12345 --simulate error500` | **failure** -- `hard_failure` rule matched on the injected 500 |
| `*-UM1W` | `memberId=23456` (has no Checking account) | **failure** -- a real locator-resolution bug this project's own testing caught: see REPORT.md §3. Fixed in `src/browser/locate.ts`; this run is the fixed, clean-failure behavior |

**`creditvantage.open-subaccount`** (has one irreversible step: "Confirm & Open Account")

| Run | Params / path | Result |
|---|---|---|
| `*-lSHo` | `openingDeposit=5` (below the $25 minimum) | **business_outcome** `validation_error` |
| `*-UBWV` | valid params, escalation resolved `approve_and_continue` | **success** -- operator approved, the agent performed the click itself |
| `*-c4iw` | valid params, escalation resolved `manual_completed` | **success**, the stronger control-transfer path -- the operator clicked "Confirm & Open Account" **directly on the live, paused session** via `POST /intervention/:id/manual-action`, then the replay engine skipped its own execution and continued. `log.jsonl` shows that step with `"actor":"human"` |
| `*-9-bQ` | valid params, escalation resolved `abort` | **failure**, reported cleanly (`"Run aborted by operator at irreversible-action gate."`), not a crash |
| `*-KJBr` | valid params, `approve_and_continue` | **success**, produced while capturing the operator-console screenshots below -- a second independent example of the approval path |
| `*-zMMN` | valid params, `approve_and_continue` | **failure** -- an unplanned real example: between raising the escalation and it being approved, the live browser window was navigated away from the confirmation screen (by a person exploring the visible window). The replay engine correctly detected the target no longer resolved and reported a clean, debuggable hard failure (`stepId: s12`, expected vs. observed) instead of clicking the wrong thing. Left as-is rather than re-run, since it's a genuine example of the "diverged live session" failure mode discussed in REPORT.md |

All three escalation resolution decisions (`approve_and_continue`, `manual_completed`,
`abort`) are exercised above, on both the discovery and replay paths.
