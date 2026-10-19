---
name: argue
description: Have multiple AI coding agents (Claude Code, Codex) independently solve a hard task, critique each other, and pick the best verified solution. Use when the user says "argue", asks for multiple models to compete or debate, or wants a second opinion on a difficult change.
---

# argue

Run several coding agents against the same task in isolated git worktrees, let them critique each other, and return the winning patch.

## How to use

1. Write a clear task description. Include what the user wants, relevant files, what has already been tried, and constraints.
2. If the project has a test or build command that proves the task is done, pass it as `--check`.
3. Run (it can take several minutes; use a long timeout):

```bash
argue "<task>" --check "<test command>" --json
```

Options: `--agents claude,codex` (default: whatever is installed), `--rounds 2`, `--budget 5`, `--apply`.

4. Read the JSON result. Show the user the winner, the reason, and the risks. Ask before applying, then run `git apply <patch>` (or re-run with `--apply`). The full debate is in `report`.
