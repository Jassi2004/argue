---
name: argue
description: Have several AI models (Claude, GPT, Gemini, …) argue out a question, proposal, plan, review or code change in a room, challenging each other with evidence until they agree, and return one vetted answer. Use when the user says "argue", "argue this (proposal/plan/approach) with other models", asks for other models' opinion, a second opinion, a debate or a cross-check, doubts an answer or proposal in this conversation, or the decision is hard or high-stakes.
---

# argue

argue puts several AI models in a room on one task. They work alone first, then challenge each other with evidence, fix what's wrong, and stop when they genuinely agree or have nothing new to say. The user gets **one vetted answer**.

Follow these steps in order. Don't ask the user anything before the run starts: it's never blocking.

## 1. Work out what to argue

"This" means what the user is pointing at in this conversation: usually the latest proposal, plan, design, answer, diff or decision, yours or theirs. If they doubt it ("I don't think this is good"), the question for the room is whether it's right and what would be better. It is not "defend it".

Note anything the user named for this run:
- **Models:** each item is `model`, `harness` or `harness:model`, optionally `@effort`: `opus`, `gpt-6.1-sol@high`, `gemini-2.5-pro`, `codex`, `claude:sonnet`, `pi:openrouter/deepseek/r1`. Effort exists only for Claude Code (low…max), Codex (minimal…ultra) and Pi (off…max).
- **Limits:** `budget` (USD), `rounds`, `minutes` ("cap it at $3", "only 2 rounds", "no cost limit" = budget 0).

## 2. Show the lineup and limits (your first message)

- **MCP:** `argue_lineup` with `cwd` (absolute project path) and anything the user named (`agents`, `budget`, `rounds`, `minutes`). Don't pass `save`.
- **Shell:** `argue lineup [agents] [-b usd] [-r rounds] [--minutes n] --preview --json` (if `argue` isn't on PATH: `npx -y argue-ai`).

Your first message is its `display` field, **exactly as-is**. It lists the models and an ℹ️ note that several models cost more, with this run's limits and how to change them. Don't announce that you're checking first, and don't wait for a reply: go straight to step 3.

If it reports a model isn't available, say so (with its suggestions) and continue with the models that are; if fewer than two agents are available, tell the user to run `argue doctor` and stop.

## 3. Write the brief and start

The other models can't see this conversation, so the brief must stand alone:
- **The task:** what's being decided or built, and what a great result must get right.
- **The proposal, verbatim** if there is one (the plan, the design, the code or diff), and the user's doubts about it, as open questions.
- **Facts from this session:** relevant files (paths relative to the project root), constraints, errors, findings, what's been tried and ruled out.
- Keep it neutral. Don't tell them which answer you or the user lean towards.

Then start it with the same models and limits:
- **MCP:** `argue_start` with `task` (the brief), `cwd`, `context` (session findings that don't fit the brief), plus `agents`, `budget`, `rounds`, `minutes` if named.
- **Shell:** write the brief to a temp file, then `argue -f <file> --bg --json [-a agents] [-b usd] [-r rounds] [--minutes n]`.

argue works out whether the models should change code or argue out an answer. Reviewing a proposal is an answer. Pass `mode` only if it's ambiguous.

## 4. While it runs

Call `argue_wait` (shell: `argue wait <run_id>`) until `status` is no longer `running`. Between calls, at most one short line now and then, taken from `recent` (e.g. "B challenged A's caching plan; A is revising"). Don't narrate every call.

**The user can change their mind at any time:**
- **Other models or limits for this run** ("use opus too", "cap it at $3"): `argue_cancel`, then `argue_lineup` with the new values (show its `display`), then `argue_start` again with the same brief and the new values.
- **"From now on" / "make that the default":** `argue_lineup` with the values and `save: true` (shell: `argue lineup <agents> -b <usd> -r <rounds>`). It checks the models exist, then saves them. Do this in addition to the restart if a run is going.

## 5. Give the answer

When `status` is `done`, **reply with the `answer` field as-is.** The room has already checked it. Don't add which model said what, rounds, scores or cost.
- If it ends with a line starting "Note:", keep it: a real disagreement is still open.
- **Code changes:** the answer describes the change. Ask once: "Apply it?" If yes, `argue_apply` (shell: `argue apply`).
- If `projectChanged` is true, warn that the project's files changed during the run.
- If the status is `failed`, `interrupted` or `stuck`, give the error and offer to run it again.

## 6. Follow-up questions

If the user questions the answer ("why not Postgres?", "are you sure?"), answer from the run's record: `argue ask "<question>"` (shell). Start a new run only if they ask to argue it again.
