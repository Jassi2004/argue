---
name: argue
description: Get a carefully vetted answer by having several AI models from different labs (Claude, GPT, Gemini, …) work on the same question or task independently, cross-examine each other with evidence, improve, and combine the best into one answer. Use when the user says "argue", asks for several models to debate or cross-check something, wants a second opinion, or the question is hard or high-stakes. Works for any question or task: decisions, design, research, writing, debugging, or code changes.
---

# argue

argue has several AI models work on the same thing, attack each other's reasoning, and combine what survives into **one vetted answer**. The user only wants that answer: not who won, which model judged, or what it cost.

## 1. Show who will argue (first message)

Before anything else, get the lineup:
- **MCP:** `argue_lineup` with `cwd` (absolute project path), plus `agents` if the user named models (see step 4). Don't pass `save`.
- **Shell:** `argue lineup --json`, or `argue lineup <agents> --preview --json` if the user named models (if `argue` isn't on PATH, use `npx -y argue-ai`).

Your first message to the user must be its `display` field, exactly as-is (don't announce that you're checking first). It looks like:

> **⚔️ Arguing with:**
> - **claude-opus-4-1** · effort high · Claude Code
> - **gpt-6.1-sol** · effort high · Codex
>
> _Want different models? Stop me and say so._

Then carry on straight away. Don't wait for a reply.

## 2. Start it

The other models can't see this conversation, so write a complete, self-contained brief to a temp file (e.g. `/tmp/argue-brief.md`): what's wanted, what "done" looks like, relevant files or facts, constraints, and what's been tried. Refer to project files by their path relative to the project root.

- **MCP:** `argue_start` with `task` (the brief) and `cwd`, plus `agents` if the user named models.
- **Shell** (from the project directory): `argue -f /tmp/argue-brief.md --bg --json`, plus `-a <agents>` if the user named models.

argue works out by itself whether models should change code or just argue out an answer. Only pass `mode: "code"` / `"answer"` if it's ambiguous.

## 3. Wait, then give the answer

Call `argue_wait` (shell: `argue wait <run_id>`) until `status` is `done`, `failed` or `interrupted`. While waiting, a one-line status now and then is enough.

When it's done, **give the user the `answer` field as your reply.** Keep it as it is: it has already been checked by all the models. Don't add who won, judges, rounds, scores or cost.

- If it ends with a line starting "Note:", keep it: it flags a real remaining disagreement.
- **Code changes:** the answer describes the change. Ask once: "Apply it?" If yes, `argue_apply` (shell: `argue apply`).
- If `projectChanged` is true, warn that the project's files changed during the run.

## 4. If the user names models (before or during a run)

The user can name models, harnesses or both. Each item is `model`, `harness`, or `harness:model`, optionally with `@effort`:
- `opus`, `gpt-6.1-sol@high`, `gemini-2.5-pro` (argue picks the right harness)
- `codex`, `claude` (that harness's default model)
- `pi:openrouter/deepseek/r1` (explicit harness and model)

Effort exists only for Claude Code (low…max), Codex (minimal…ultra) and Pi (off…max). For others, say it isn't supported. Only add `@effort` to the models the user said it for.

- **For this run only** (the normal case): pass them as `agents` to `argue_start` (shell: `-a`). The saved defaults don't change.
- **Mid-run:** `argue_cancel`, then start again with the same brief and the new `agents`, and show the new lineup.
- **"From now on" / "make it default":** `argue_lineup` with `agents` and `save: true` (shell: `argue lineup <agents>`). This checks the models exist, then saves them.

If argue reports a model isn't available, tell the user (with its suggestions) and ask what to use instead.

## 5. Follow-up questions

If the user questions or challenges the answer ("why not Postgres?", "are you sure?"), answer from the run's record: `argue ask "<their question>"` (shell). It uses everything the models found. Only start a new run if the user asks to argue it again.

If argue says fewer than two agents are available, tell the user to run `argue doctor`.
