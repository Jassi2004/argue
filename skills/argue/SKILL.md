---
name: argue
description: Run a hard coding task (or design/debugging question) through several competing AI agents — e.g. Claude Code, Codex, Gemini, Cursor, OpenCode, Pi — that solve it independently, attack each other's work with evidence, revise, and have a judge pick the best verified result. Use when the user says "argue", asks for multiple models to debate/compete/cross-check, wants a second opinion, or the task is hard or high-stakes and they have no clear approach.
---

# argue

`argue` makes several AI coding agents compete on one task in isolated copies of the repo and returns the winning, verified result. It never changes the user's files unless asked to apply.

## 1. Write the brief

The other agents cannot see this conversation, so write a complete, self-contained task:
- the goal, and what "done" means
- relevant files, functions, errors, logs
- constraints (APIs to keep, style, performance)
- what has already been tried and why it failed

Pick a mode:
- `code` (default): agents change code; you get a winning patch.
- `ask`: no edits; agents debate an answer (architecture, root-cause analysis, reviews, plans).

If there is a command that proves the task is done (tests, a repro script), pass it as the check. Otherwise argue auto-detects the project's test command.

## 2. Run it

**If you have the `argue_start` MCP tool**, call `argue_start` with `task`, `cwd` (absolute project path), and optionally `mode`, `context`, `check`, `agents`. Then call `argue_wait` repeatedly until `status` is `done` or `failed`, giving the user a one-line progress update between calls.

**Otherwise use the shell** (runs take several minutes; allow a long timeout or run in the background):

```bash
argue "<task>" --json                       # code mode, auto agents, auto check
argue "<task>" --mode ask --json            # debate an answer, no edits
argue -f brief.md --check "npm test" --json # long brief from a file
```

If `argue` is not on PATH, use `npx -y argue-ai` instead of `argue`.
Write long briefs to a temp file and pass `-f <file>` to avoid shell-quoting issues.
Useful options: `--agents claude,codex,gemini` · `--rounds 3` · `--budget 5` · `--context "<extra findings>"`.

## 3. Report back

From the JSON result, tell the user briefly:
- the winner and why
- the files it changes (code mode) or the final answer (ask mode)
- remaining risks, and any agent that failed
- cost, and the `report` path for the full debate

In code mode, ask before applying. To apply: `argue apply <run_id>` (or `argue_apply`). To apply a different agent's version: `argue apply <run_id> --agent B`.

If argue fails because fewer than two agents are available, tell the user to run `argue doctor` to see what's missing.
