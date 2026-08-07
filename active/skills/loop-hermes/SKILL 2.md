---
name: loop-hermes
version: 1.2.2
description: Use when the user explicitly asks for loop-hermes, Hermes loop, iterate until APPROVED_CLEAN, no soft approval, or an implementation/review workflow with named subagents plus repair cycles.
---

# loop-hermes

Goal: verified artifact. Not nice answer.

Style: caveman-lite. Short. No filler. Keep exact technical terms. Evidence > prose.

## Why this skill exists

LLMs approve their own work. Same-model "review" is theater.

loop-hermes exists for **cross-model independence**: the implementer and the reviewer must not be the same brain. Canonical pairing:

- Claude Code implements → Codex reviews / re-reviews
- Codex implements → Claude (or other non-Codex independent agent) reviews / re-reviews
- Cursor implements → a different model via Task/subagent reviews / re-reviews

Independence is the product. Ceremony, skill lenses, and proportionality serve that product — they do not replace it.

## Trigger

Use only when user explicitly asks for loop orchestration:

- `loop-hermes`, Hermes loop, loop until clean
- subagents plus reviewers in one repair workflow
- independent review plus re-review until `APPROVED_CLEAN`
- complex work where user wants correction loops, not just a normal answer

Do not steal normal flows. If user asks only for review, QA, debug, PRD, refactor, or dead-code audit, use the primary skill first. Add `loop-hermes` only when the user explicitly asks for loop, subagents, reviewers, re-review, or `APPROVED_CLEAN`.

## Core Rule

One agent cannot plan, implement, review, and approve same complex work.

Main agent orchestrates. Implementer changes. Reviewer attacks. Implementer fixes. Re-review runs. Advance only on clean approval.

## Proportionality

Match ceremony to risk. Not every task needs the full machine.

- Trivial / low-risk change (one file, obvious, reversible, no auth/data/LLM/production surface): 1 implementer + 1 independent review is enough. No multi-task split, no mandatory final independent review. No mandatory re-review when the first review is `APPROVED_CLEAN`. Any `REQUEST_CHANGES` still triggers hard-pairing re-review. Verdict rules still apply.
- Medium/high risk, multi-file, auth, data, secrets, LLM behavior, production: full flow, including final independent review.
- Uncertain which bucket: full flow. Default is full.

Proportionality trims steps, never rules. Implementer ≠ reviewer ≠ approver holds even for trivial work. Soft approvals stay forbidden.

## Runtime Rules

Common rule, all runtimes:

- Reviewer and re-reviewer must be **cross-model independent** — different model family / product from the implementer whenever the runtime can provide it.
- Same thread, same instance, or same model as the implementer is NOT an independent reviewer.
- After any `REQUEST_CHANGES`, re-review must again be cross-model independent. Do not let the fixer grade the fix.
- If the runtime cannot provide a cross-model independent reviewer: implement or analyze locally if useful, then stop at `NEEDS_DECISION` or `BLOCKED`. Never `APPROVED_CLEAN`. Never self-approve.

### Claude Code

Hard pairing (this is the original design — do not soften):

- Independent review / re-review: **Codex via plugin `codex@openai-codex`**.
- After any `REQUEST_CHANGES`, re-review **must** be Codex. Claude must not re-review its own fix.
- Before re-review, verify `codex@openai-codex` is available. If unavailable: stop at `NEEDS_DECISION`. Do not substitute another Claude instance.

First review may be any genuinely independent cross-model reviewer if Codex is briefly unavailable and the owner accepts the substitute — but re-review after `REQUEST_CHANGES` stays Codex-or-stop.

### Codex

Hard pairing (mirror of Claude Code):

- Independent review / re-review: **Claude** (Claude Code / Claude API agent) or another non-Codex independent agent — not another Codex session grading Codex work.
- After any `REQUEST_CHANGES`, re-review must again be non-Codex / cross-model. Codex must not re-review its own fix.
- Use native subagents when policy allows and they are genuinely a different model.
- No cross-model independent reviewer available: stop at `NEEDS_DECISION` or `BLOCKED`.

### Cursor

- Task/subagent spawns count only when they use a **different model** from the implementer.
- The implementer's own thread reviewing its own diff does not count — even with a stern prompt.
- Prefer the strongest available cross-model reviewer. If only one model is reachable: stop at `NEEDS_DECISION` rather than self-approve.

## Relationship

- `orchestrate`: phase pipeline, handoffs, skill sequence.
- `loop-hermes`: quality gate, independent review, repair cycle.

Use both when work needs pipeline plus approval gate. `orchestrate` plans phases; `loop-hermes` guards each risky task. When both run together, verdicts use loop-hermes vocabulary (`APPROVED_CLEAN` / `REQUEST_CHANGES` / `NEEDS_DECISION` / `BLOCKED`).

## Modes

- `PLAN`: task breakdown, order, checks.
- `IMPLEMENT`: code/artifact change.
- `DEBUG`: reproduce, isolate, fix, regression check.
- `REVIEW`: independent review of diff/spec/artifact.
- `QA`: user-flow/integration verification.
- `REFACTOR`: behavior-preserving cleanup.

Trivial / low-risk flow (see Proportionality):

```text
IMPLEMENT -> REVIEW
```

Default full flow:

```text
PLAN -> IMPLEMENT -> REVIEW -> REPAIR -> RE-REVIEW -> FINAL
```

Bug full flow:

```text
DEBUG -> IMPLEMENT -> REVIEW -> REPAIR -> RE-REVIEW -> QA
```

## Skill Routing

Per task: pick ONE primary skill from this allowlist. Trivial task may pick NONE. The task reviewer uses that skill as a LENS (its checklist/criteria), not as a second full pipeline.

- code / architecture / performance -> `hm-engineer`
- UI / visual -> `hm-design` or `hm-designer`
- cognitive flow / user journey -> `hm-ux-flow`
- auth / data / secrets -> `hm-security`
- chat / agent / LLM tools -> `hm-llm-guardrails`
- bug / regression -> `diagnose`
- plan / is-it-worth-doing -> `office-hours` (use `grill-me` to stress-test a plan)
- n8n workflows -> pertinent `n8n-*` skill if installed (patterns / node config / validation / to-langgraph); else `hm-engineer` lens + n8n MCP tooling

Final independent review (full flow only): apply the HM lenses that fit the whole diff — `hm-engineer`, `hm-qa`, `hm-security`, `hm-design`/`hm-designer`, `hm-llm-guardrails`, `hm-ux-flow` when relevant — plus the task's primary skill if still relevant.

Do NOT run the full HM suite inside every repair cycle. Lenses inform review criteria; they do not multiply pipelines.

## Loop

For each task:

1. Snapshot
   - Check real state.
   - Check `git status --short` in repos.
   - Preserve user changes.

2. Define success
   - Acceptance criteria.
   - Required evidence.
   - Safety gates.
   - Primary skill lens (see Skill Routing).

3. Split
   - Small tasks. Skip the split entirely for trivial work (see Proportionality).
   - Parallel only if independent.
   - Serialize shared files, migrations, APIs, data, UX flow.

4. Assign
   - One implementer per task.
   - Give objective, files, constraints, acceptance criteria, checks.

5. Verify
   - Implementer runs relevant checks.
   - Evidence captured (see Evidence).

6. Review
   - Independent reviewer gets task, criteria, primary skill lens, diff/artifact, evidence.
   - Reviewer returns exactly `APPROVED_CLEAN` or `REQUEST_CHANGES` (see Verdicts). Reviewers do not emit `NEEDS_DECISION` for nits — the orchestrator does.

7. Repair
   - Implementer fixes valid findings.
   - If finding is wrong, prove with evidence.
   - Run checks again.

8. Re-review
   - Fresh reviewer if critical, vague review, big change, repeat failure, or anchoring risk.
   - After any `REQUEST_CHANGES`, re-review must follow the hard pairing in Runtime Rules (Claude↔Codex, or Cursor cross-model). Never the implementer's own thread/model.

9. Stop/advance
   - Advance only on `APPROVED_CLEAN`.
   - If the reviewer returned `REQUEST_CHANGES` with only nits and the owner may accept them: orchestrator escalates to `NEEDS_DECISION` (list nits, wait for owner OK). Do not treat nits as automatic pass.
   - Max 3 repair cycles per task.
   - After 3 failures: `BLOCKED`, report blocker.

## Verdicts

One vocabulary everywhere — per-task reviews AND final independent review.

Who emits what:

- **Reviewer / re-reviewer / final reviewer:** `APPROVED_CLEAN` or `REQUEST_CHANGES` only (plus `NEEDS_DECISION` solely when the required hard pairing is unavailable — stop, do not review).
- **Orchestrator:** may escalate nits-only `REQUEST_CHANGES` to `NEEDS_DECISION` for the owner, or set `BLOCKED` after max cycles / missing pairing.

Only pass:

```text
APPROVED_CLEAN
```

Means: no blockers, no major issues, no minor issues, no nits, no caveats, no missing evidence, no untested assumptions.

Everything else from a reviewer:

```text
REQUEST_CHANGES
- [severity] area/file, issue, why it matters, suggested fix
```

Nits are findings. A review with remaining nits is NOT `APPROVED_CLEAN`. The reviewer still returns `REQUEST_CHANGES` (tag severity `nit` if useful). The orchestrator escalates nits-only remainders to `NEEDS_DECISION`: list the nits, hand the call to the owner. Nits advance only on explicit owner OK. There is no automatic soft-pass verdict.

Forbidden soft approvals:

- approved with notes
- looks good but
- minor issue
- nit
- should probably
- not a blocker
- I did not run tests
- assuming X
- seems fine
- likely works

## Evidence

Minimum schema for a check to count as evidence:

```text
- check: <what was verified>
- command: <exact command, or N/A for non-command proof>
- result: <exit code / pass-fail / relevant output line, secrets redacted>
```

Equivalent proof is fine when no command applies (screenshot for UI, diff excerpt for spec match, query result for data). "I ran it and it works" is not evidence.

No fresh evidence -> no `APPROVED_CLEAN`. Stale evidence from before the last change does not count.

## Non-code Artifacts

Plans, audits, backlogs, specs get reviewed too. Criteria:

- Completeness: covers the stated scope, no silent gaps.
- Internal consistency: no section contradicts another.
- Actionability: a reader can execute without guessing.
- Premise traceability: claims trace to evidence or are flagged as assumptions.

Same verdicts, same loop.

## Safety Gates

Stop for explicit user approval before:

- production deploy
- merge, push, release
- destructive command
- migration on real data
- reset/import massivo
- external automation or messages
- billing or paid resources
- secrets, tokens, permissions
- public post, email, DM, WhatsApp

Prepare plan. Stop at gate.

## Loop State

Keep this compact state during long work or before compaction:

```text
LOOP_STATE
mode:
task:
skill:
criteria:
cycle:
implementer:
reviewer:
re-reviewer:
verdict:
evidence:
blocked_on:
next:
```

## Prompts

Implementer:

```text
Task: <task>
Criteria: <criteria>
Context/files: <context>
Constraints: <constraints>
Checks: <checks>

Do smallest correct change. Preserve user changes. No scope creep.

Return: files changed, summary, checks, evidence, unresolved issues.
```

Reviewer:

```text
Review strictly.
Task: <task>
Criteria: <criteria>
Skill lens: <primary skill checklist, if any>
Summary: <summary>
Diff/artifact/evidence: <evidence>

Check: spec, correctness, edge cases, regressions, security/privacy, tests, maintainability, UX when relevant, scope creep, missing evidence.

Verdict exactly:
APPROVED_CLEAN
or
REQUEST_CHANGES
- [severity] area/file, issue, why, fix
```

Independent re-review (after `REQUEST_CHANGES`) — hard pairing:

```text
You are the cross-model re-reviewer. You did not write or fix this work.
Pairing:
- If implementer was Claude Code: you are Codex via plugin codex@openai-codex.
- If implementer was Codex: you are Claude (or other non-Codex independent agent).
- If implementer was Cursor: you are a different model via Task/subagent.
If the required pairing is unavailable: return NEEDS_DECISION and stop.
Do not self-approve. Do not soft-approve.

Original task: <task>
Criteria: <criteria>
Previous findings: <findings>
Claimed fixes: <fixes>
Current diff/artifact/evidence: <evidence>

Look for missed issues, false fixes, new regressions, missing evidence.
Return APPROVED_CLEAN, REQUEST_CHANGES, or NEEDS_DECISION (pairing unavailable only).
```

## Final Independent Review (full flow)

Mandatory for the full flow (medium/high risk — see Proportionality). Trivial single-review work skips it.

Per-task reviews check one change in isolation and miss cross-cutting bugs, integration gaps, missed call sites, and holistic correctness. So after ALL tasks are implemented and their per-task reviews pass, run ONE final independent GENERAL review over the WHOLE implementation BEFORE declaring done / shipping / merging.

This final general review is mandatory even when every previous reviewer returned `APPROVED_CLEAN`, including an adversarial review. A clean per-task review is only a prerequisite, not the terminal gate. Do not report the work as done, clean, ready, shippable, mergeable, or complete until this fresh whole-implementation review has run and its result is clean or its remaining nits are explicitly accepted by the owner.

If you realize this final review was skipped after saying the work was clean, immediately correct the status to `BLOCKED` or `NEEDS_DECISION`, run the final independent review, and report the missed gate plainly.

Rules:
- Fresh cross-model independent agent. Not the implementer, not an anchored per-task reviewer. Follow Runtime Rules pairing (Claude↔Codex; Cursor = different model). No such agent available: stop at `NEEDS_DECISION`.
- HM rigor. Apply the HM lenses that fit the whole diff (see Skill Routing), plus the task's primary skill if still relevant.
- Verify FROM THE CODE, not from the prior reviews. Job: find what the diff-level reviews MISSED — other call sites, integration, edge cases, regressions, the whole-feature view. Read the upstream/reference source when one exists.
- Verdict from the final reviewer: `APPROVED_CLEAN` or `REQUEST_CHANGES` with severity-tagged findings (`NEEDS_DECISION` only if pairing unavailable). Nits-only remainder: orchestrator escalates to `NEEDS_DECISION` for the owner. Same vocabulary as per-task reviews — no separate ship-with-nits verdict.
- Apply valid findings (loop again: REPAIR -> hard-pairing re-review after any `REQUEST_CHANGES`). Only declare done when the final review is `APPROVED_CLEAN` OR the owner explicitly accepts the remaining nits.

This pass repeatedly catches real bugs that per-task reviews passed (e.g. a missed display site, an unclamped input that breaks a downstream assumption, a WCAG fail). Cheap insurance vs shipping a holistic defect.

## Final Report

```text
Status: APPROVED_CLEAN | BLOCKED | NEEDS_DECISION
Completed:
- <task/artifact>
Agents:
- implementer:
- reviewer:
- re-reviewer:
- final-independent-reviewer:
Evidence:
- <check> -> PASS/FAIL, short result
Review:
- <per-task verdict/blocker>
Final independent review:
- <APPROVED_CLEAN | REQUEST_CHANGES | NEEDS_DECISION (nits listed)> + findings applied/accepted
Next:
- <next task/decision>
```

## Anti-patterns

- self-approval
- soft approval
- hidden failed command
- irrelevant tests as theater
- broad refactor inside small fix
- next task before clean verdict
- re-review by the same agent/thread/model that implemented or fixed, after `REQUEST_CHANGES`
- Claude re-reviewing a Claude fix, or Codex re-reviewing a Codex fix (breaks the hard pairing)
- substituting "another Claude" when Codex is down instead of `NEEDS_DECISION`
- more than 3 repair cycles without surfacing blocker
- declaring done / shipping / merging before the final independent review ran (full flow)
- treating per-task review passes as a substitute for the final general review
- running the full HM suite inside every repair cycle
- full-flow ceremony on a trivial one-file change (Proportionality exists — use it)

## Install

Canonical cortex path:

```text
active/skills/loop-hermes/SKILL.md
```

Runtime links:

```text
~/.codex/skills/loop-hermes -> active/skills/loop-hermes
~/.claude/skills/loop-hermes -> active/skills/loop-hermes
```

Do not create competing copies.
