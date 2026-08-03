---
name: verification-loop
description: "A comprehensive verification system for Claude Code sessions."
origin: ECC
---

# Verification Loop Skill

A comprehensive verification system for Claude Code sessions.

## When to Use

Invoke this skill:
- After completing a feature or significant code change
- Before creating a PR
- When you want to ensure quality gates pass
- After refactoring

## Verification Phases

Run only the phases that apply to the current project stack. If a phase does not apply, mark it as `N/A` in the final report instead of forcing a command that does not fit the repo.

### Phase 1: Build Verification
```bash
# Check if project builds, when the repo has a build step
npm run build
# OR
pnpm build
# OR
yarn build
```

If build fails, STOP and fix before continuing.

### Phase 2: Type Check
```bash
# TypeScript projects
npx tsc --noEmit

# Python projects
pyright .
```

Report all type errors. Fix critical ones before continuing.

### Phase 3: Lint Check
```bash
# JavaScript/TypeScript
npm run lint

# Python
ruff check .
```

### Phase 4: Test Suite
```bash
# Run tests with coverage
npm run test -- --coverage

# Check coverage threshold
# Target: 80% minimum
```

Report:
- Total tests: X
- Passed: X
- Failed: X
- Coverage: X%

### Phase 5: Security Scan
```bash
# Check for secrets, debug artifacts, and unsafe local config handling.
# Use the environment's search tools where available instead of relying on grep.
# Examples:
# - search for `sk-`
# - search for `api_key`
# - search for `console.log`
# - inspect changed config, hooks, env references, and auth-related files
```

### Phase 6: Diff Review
```bash
# Show what changed
git diff --stat
git diff --name-only
```

Review each changed file for:
- Unintended changes
- Missing error handling
- Potential edge cases

## Output Format

After running all phases, produce a verification report:

```
VERIFICATION REPORT
==================

Build:     [PASS/FAIL]
Types:     [PASS/FAIL] (X errors)
Lint:      [PASS/FAIL] (X warnings)
Tests:     [PASS/FAIL] (X/Y passed, Z% coverage)
Security:  [PASS/FAIL] (X issues)
Diff:      [X files changed]

Overall:   [READY/NOT READY] for PR

Issues to Fix:
1. ...
2. ...
```

## Continuous Mode

For long sessions, run verification every 15 minutes or after major changes:

```markdown
Set a mental checkpoint:
- After completing each function
- After finishing a component
- Before moving to next task

Invoke the `verification-loop` skill directly.
If the environment later adds a `/verify` command, it may call this same workflow.
```

## Integration with Hooks

This skill complements PostToolUse hooks but provides deeper verification.
Hooks catch issues immediately; this skill provides comprehensive review.

## Relationship to Verification Before Completion

`verification-before-completion` remains the hard epistemic rule: do not claim success without fresh evidence.

`verification-loop` is the operational workflow that helps generate that evidence across build, types, lint, tests, security, and diff review.

Use both together:
- `verification-loop` to run the structured gate
- `verification-before-completion` to prevent unsupported claims
