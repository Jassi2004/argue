---
name: argue
description: Get a carefully vetted answer by putting several AI models (Claude, GPT, Gemini, …) in a room on the same question or task. Each forms its own view, they challenge each other with evidence until they genuinely agree, and one answer comes back. Use when the user says "argue", asks for several models to debate or cross-check something, wants a second opinion, or the question is hard or high-stakes. Works for any question or task: decisions, design, research, writing, debugging, or code changes.
---

# argue

argue puts several AI models in a room on the same task. They work alone first, then challenge each other's work with evidence, revise, and stop when they genuinely agree (or have nothing new). The user gets **one vetted answer**. They only want that answer: not which model said what, how many rounds it took, or what it cost.

## 1. Show who will argue (first message)

Before anything else, get the lineup:
- **MCP:** `argue_lineup` with `cwd` (absolute project path), plus `agents` if the user named models (see step 4). Don't pass `save`.
- **Shell:** `argue lineup --json`, or `argue lineup <agents> --preview --json` if the user named models (if `argue` isn't on PATH, use `npx -y argue-ai`).

Your first message to the user must be its `display` field, exactly as-is (don't announce that you're checking first). Then carry on straight away. Don't wait for a reply.

## 2. Start it

The other models can't see this conversation, so write a complete, self-contained brief: what's wanted, what "done" looks like, relevant files or facts, constraints, and what's been tried. Refer to project files by their path relative to the project root.

- **MCP:** `argue_start` with `task` (the brief) and `cwd`, plus `agents` if the user named models.
- **Shell** (from the project directory): write the brief to a temp file, then `argue -f <file> --bg --json`, plus `-a <agents>` if the user named models.

argue works out by itself whether models should change code or just argue out an answer. Only pass `mode: "code"` / `"answer"` if it's ambiguous.

## 3. Wait, then give the answer

Call `argue_wait` (shell: `argue wait <run_id>`) until `status` is no longer `running`. While waiting, a one-line status now and then is enough (`recent` says what the room is doing).

When it's done, **give the user the `answer` field as your reply**, as it is: the room has already checked it. Don't add which model won, rounds, scores or cost.

- If it ends with a line starting "Note:", keep it: it flags a real disagreement that is still open.
- **Code changes:** the answer describes the change. Ask once: "Apply it?" If yes, `argue_apply` (shell: `argue apply`).
- If `projectChanged` is true, warn that the project's files changed during the run.
- If the status is `failed`, `interrupted` or `stuck`, tell the user the error and offer to run it again.

## 4. If the user names models (before or during a run)

Each item is `model`, `harness`, or `harness:model`, optionally with `@effort`:
- `opus`, `gpt-6.1-sol@high`, `gemini-2.5-pro` (argue picks the right CLI)
- `codex`, `claude` (that CLI's default model)
- `pi:openrouter/deepseek/r1` (explicit CLI and model)

Effort exists only for Claude Code (low…max), Codex (minimal…ultra) and Pi (off…max). For others, say it isn't supported. Only add `@effort` to the models the user said it for.

- **For this run only** (the normal case): pass them as `agents` to `argue_start` (shell: `-a`). Saved defaults don't change.
- **Mid-run:** `argue_cancel`, then start again with the same brief and the new `agents`, and show the new lineup.
- **"From now on" / "make it default":** `argue_lineup` with `agents` and `save: true` (shell: `argue lineup <agents>`). This checks the models exist, then saves them.

If argue reports a model isn't available, tell the user (with its suggestions) and ask what to use instead. If fewer than two agents are available, tell the user to run `argue doctor`.

## 5. Follow-up questions

If the user questions or challenges the answer ("why not Postgres?", "are you sure?"), answer from the run's record: `argue ask "<their question>"` (shell). It uses everything the room found. Only start a new run if the user asks to argue it again.
