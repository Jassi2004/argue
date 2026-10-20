---
name: argue
description: Run a hard coding task (or design/debugging question) through several competing AI agents — e.g. Claude Code, Codex, Gemini, Cursor, OpenCode, Pi — that solve it independently, attack each other's work with evidence, revise, and have a judge pick the best verified result. Use when the user says "argue", asks for multiple models to debate/compete/cross-check, wants a second opinion, or the task is hard or high-stakes and they have no clear approach.
---

# argue

`argue` makes several AI coding agents compete on one task in isolated copies of the repo and returns the winning, verified result. It never changes the user's files unless asked to apply.

## 1. Show the lineup first

Before anything else (before writing the brief), get the lineup and show it to the user:

- **MCP:** call `argue_lineup` with `cwd` (absolute project path).
- **Shell:** `argue lineup --json` (if `argue` is not on PATH, use `npx -y argue-ai`).

The result has a `display` field, a small markdown table like:

**⚔️ argue lineup**

| | Harness | Model | Effort |
|---|---|---|---|
| A | Claude Code | sonnet | default |
| B | Codex | gpt-6.1-sol | high |

_Want another harness, a different model, or more or less effort? Just say so._

**Make it your very first message, exactly as-is.** Then carry on straight away: don't ask a question or wait for an answer.

## 2. Write the brief

The other agents cannot see this conversation, so write a complete, self-contained brief to a temp file (e.g. `/tmp/argue-brief.md`). Each agent works in its own copy of the project, so refer to files by their path relative to the project root:
- the goal, and what "done" means
- relevant files, functions, errors, logs
- constraints (APIs to keep, style, performance)
- what has already been tried and why it failed

Pick a mode:
- `code` (default): agents change code; you get a winning patch.
- `ask`: no edits; agents debate an answer (architecture, root-cause analysis, reviews, plans).

If a command proves the task is done (tests, a repro script), pass it with `--check`. Otherwise argue auto-detects the project's test command.

Then start the run:
- **MCP:** `argue_start` with `task` (the brief) and `cwd`, plus `mode` / `check` if needed.
- **Shell** (from the project directory): `argue -f /tmp/argue-brief.md --bg --json`.

You've already shown the lineup, so don't repeat it, unless it has changed since (then show the new `display`).

## 3. Wait

Call `argue_wait` (or `argue wait <run_id>` in the shell, which blocks up to 4 minutes) repeatedly until `status` is `done`, `failed` or `interrupted`. Between calls, give the user a one-line update (phase and recent events).

## 4. If the user wants a different lineup

When the user asks to add or drop a harness, change a model, or raise or lower effort (during the run or before it):

1. Stop the run: `argue_cancel` (shell: `argue cancel <run_id>`).
2. Build the new lineup from the current one in the note. Format: `harness[:model][@effort]`, comma-separated, e.g. `claude:opus@high,codex:gpt-5@medium,pi`.
   - Harnesses: `claude`, `codex`, `gemini`, `cursor`, `opencode`, `pi`.
   - Effort exists only for `claude` (low…max), `codex` (minimal…ultra) and `pi` (off…max). For the others, tell the user it isn't supported.
3. Check and save it: `argue_lineup` with `agents` (shell: `argue lineup <lineup>`). This verifies each model and effort is available, then saves it as the user's default.
   - If it reports errors, tell the user which model or effort isn't available (include the suggestions it gives) and ask what to use instead. Don't restart.
4. Show the new lineup (`display` from `argue_lineup`), then start again with the same brief.

To see the lineup without running: `argue_lineup` with no `agents` (shell: `argue lineup`). To go back to the automatic lineup: `reset: true` (shell: `argue lineup --reset`).

## 5. Report back

From the final result, tell the user briefly:
- the winner and why
- the files it changes (code mode) or the final answer (ask mode)
- remaining risks, and any agent that failed
- cost, and the `report` path for the full debate

In code mode, **ask before applying**. To apply: `argue_apply` (shell: `argue apply <run_id>`). For another agent's version: `argue apply <run_id> --agent B`.

If argue says fewer than two agents are available, tell the user to run `argue doctor`. If the result says `projectChanged: true`, warn the user that their files changed during the run and to review `git status` before applying.
