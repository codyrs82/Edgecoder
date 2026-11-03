# PLAN.md — Task contract

> Copy to the repo root as `PLAN.md` (gitignored) for a task that needs a contract.
> Fill this in before the agent acts. If a field is blank, the agent is improvising.
> The `reviewer` subagent judges the change against this file.

## Objective
<!-- One or two sentences: what outcome must exist when this is done? -->

## Scope (in)
<!-- Files, modules, behaviours that may change. -->
-

## Out of scope
<!-- Tempting but explicitly not part of this task. -->
-

## Must not change
<!-- Invariants. Breaking any of these = REJECT. -->
- Public API / CLI surface of `<module>`
- Database schema (no new migrations)
- Files under generated/protected paths (see `.claude/harness.json`)

## Acceptance checks
<!-- Observable evidence. Each must be runnable or inspectable. Prefer commands. -->
| # | Check | How to verify | Status |
|---|---|---|---|
| 1 | Tests pass | `<test command>` | ☐ |
| 2 | Lint clean | `<lint command>` | ☐ |
| 3 | <behaviour X works> | `<command or test name>` | ☐ |

## Approval required (stop and ask a human)
- Deploy to any environment
- `git push` / opening or merging PRs
- Database migrations
- Deleting data, rotating credentials, sending external messages, spending money

## Budget / stop conditions
- Max attempts on the same failure before escalating: 3
- Escalate if requirements contradict each other or a must-not-change item blocks the objective.
