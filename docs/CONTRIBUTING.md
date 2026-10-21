# Contributing

Start with [ARCHITECTURE.md](ARCHITECTURE.md) (one page). Then pick what you want to change.

## Change how agents behave

Edit a file in `instructions/` (the table in [`instructions/README.md`](../instructions/README.md) says which). Then:

```bash
npm run instructions:preview -- turn     # see the filled-in text (add --code for the coding version)
UPDATE_SNAPSHOTS=1 npm test              # record the new text
git diff test/instructions/snapshots/    # review exactly what changed
```

Commit the snapshot changes with your edit, so reviewers see the before and after. If you can, try it on a real task (`node bin/argue.js "…" -a claude,codex`) and mention what changed in `argue show`.

## Change the room's rules

When the room ends, who plays each round, and what counts as progress all live in `src/room/referee.js`, which is pure functions. Add or change a test in `test/unit.test.js` (the "referee" section builds small rooms by hand) before you change the rule.

## Add an agent CLI

1. Add a driver to `src/agents/drivers.js`. Copy an existing one: it runs the CLI headless in `cwd` and returns `{ ok, text, costUsd, tokens, error }`, with `null` for anything the CLI doesn't report. `write: true` lets it edit files; `write: false` must be read-only.
2. If the CLI has default-model settings or a model list, add it to `harnessDefaults` / `listModels` in `src/agents/lineup.js`.
3. If it can load MCP servers, honour the `mcp` list (none by default).
4. If it has an MCP config or a commands folder, add a target in `src/integrations/install.js`.
5. Add tests. Tests must never call a real CLI: use the fake agent in `test/fixtures/` and the `SAFE` environment in `test/integration.test.js`.

## Find a bug

| Symptom | Look at |
|---|---|
| An agent behaves oddly | Its posts in `.argue/runs/<id>/room.md`, then the step's file in `instructions/` |
| A post's STANCE/CHALLENGE lines were misread | `src/room/protocol.js` (`parsePost`) and its tests |
| The room ended too early or ran too long | `room.json` (`events`, `stalled`, `stance`), then `src/room/referee.js` (`decide`, `whoPlays`) |
| One CLI fails or returns nothing | Its driver in `src/agents/drivers.js`; the error is in `events.jsonl` and in `room.md` |
| Wrong model or effort shown | `src/agents/lineup.js` (`harnessDefaults`, `describe`) |
| Code change missing, wrong, or won't apply | `src/room/desks.js`, `src/workspace/git.js` |
| The final answer mentions agents or the process | `instructions/verdict.md`, then `scrubProcess` in `src/room/index.js` |
| A run hangs, shows `stuck`, or leaves processes behind | `src/util/exec.js` (processes), `src/runs/store.js` (heartbeat, cancel, cleanup) |
| A coding agent can't find argue | `src/integrations/install.js`, `src/integrations/mcp.js`, `skills/argue/SKILL.md` |

## Before a PR

```bash
npm test
npm run lint
```
