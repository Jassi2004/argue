---
name: argue
description: Run a hard coding task (or design/debugging question) through several competing AI agents — e.g. Claude Code, Codex, Gemini, Cursor, OpenCode, Pi — that solve it independently, attack each other's work with evidence, revise, and have a judge pick the best verified result. Use when the user says "argue", asks for multiple models to debate/compete/cross-check, wants a second opinion, or the task is hard or high-stakes and they have no clear approach.
---

# argue

`argue` makes several AI coding agents compete on one task in isolated copies of the repo and returns the winning, verified result. It never changes the user's files unless asked to apply.

## 1. Write the brief

The other agents cannot see this conversation, so write a complete, self-contained brief to a temp file (e.g. `/tmp/argue-brief.md`). Each agent works in its own copy of the project, so refer to files by their path relative to the project root:
- the goal, and what "done" means
- relevant files, functions, errors, logs
- constraints (APIs to keep, style, performance)
- what has already been tried and why it failed

Pick a mode:
- `code` (default): agents change code; you get a winning patch.
- `ask`: no edits; agents debate an answer (architecture, root-cause analysis, reviews, plans).

If a command proves the task is done (tests, a repro script), pass it with `--check`. Otherwise argue auto-detects the project's test command.

## 2. Run it

**If you have the `argue_start` MCP tool**, call it with `task` (the brief), `cwd` (absolute project path), and optionally `mode`, `check`, `agents`. Then call `argue_wait` repeatedly until `status` is `done` or `failed`.

**Otherwise use the shell.** Runs take several minutes, so start in the background and poll. Run these from the project directory:

```bash
argue -f /tmp/argue-brief.md --bg --json            # starts the run, prints {"run_id": ...}
argue wait <run_id>                                 # blocks up to 4 min; prints status JSON
```

Repeat `argue wait <run_id>` until `status` is `done`, `failed` or `interrupted`. Between calls, give the user a one-line update (phase and recent events from the JSON). To stop a run: `argue cancel <run_id>`.

Options: `--mode ask` · `--check "<cmd>"` · `--agents claude,codex,gemini` · `--rounds 3` · `--budget 5`.
If `argue` is not on PATH, use `npx -y argue-ai` instead.

## 3. Report back

From the final JSON, tell the user briefly:
- the winner and why
- the files it changes (code mode) or the final answer (ask mode)
- remaining risks, and any agent that failed
- cost, and the `report` path for the full debate

In code mode, **ask before applying**. To apply: `argue apply <run_id>` (or `argue_apply`). To apply a different agent's version: `argue apply <run_id> --agent B`.

If argue says fewer than two agents are available, tell the user to run `argue doctor`. If the result says `projectChanged: true`, warn the user that their files changed during the run and to review `git status` before applying.
