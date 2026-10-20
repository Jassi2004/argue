# Contributing

## Changing what models are told

Edit a file in `instructions/` (see the table in `instructions/README.md`). Then:

```bash
npm run instructions:preview -- critique          # see the filled-in text (add --code for the coding version)
UPDATE_SNAPSHOTS=1 npm test                       # record the new text
git diff test/instructions/snapshots/             # review exactly what changed
```

Commit the snapshot changes with your edit, so reviewers see the before and after.

## Adding a harness

1. Add a driver to `src/harnesses/index.js` (copy an existing one: it runs the CLI headless and returns `{ ok, text, costUsd, tokens, error }`).
2. If it has default-model settings or a model list, add it to `harnessDefaults` / `listModels` in `src/models/index.js`.
3. If it has an MCP config or a commands folder, add a target in `src/integrations/install.js`.
4. Add a test in `test/`.

## Finding a bug

| Symptom | Look at |
|---|---|
| A model behaves oddly in one step | That step's file in `instructions/`, and its message in `.argue/runs/<id>/transcript.json` |
| One harness fails or returns nothing | Its driver in `src/harnesses/index.js`; the error is in `transcript.json` |
| Wrong model or effort shown | `src/models/index.js` (`harnessDefaults`, `describe`) |
| "Arguing with" list or saved defaults are wrong | `src/models/index.js` (`manageLineup`) and `~/.config/argue/config.json` |
| Code change missing, wrong, or won't apply | `src/workspace/git.js` |
| The final answer mentions the process | `instructions/final-answer.md`, then `scrubProcess` in `src/arena/session.js` |
| A run hangs, or leaves processes behind | `src/util/exec.js` (process handling), `src/arena/runs.js` (cancel and cleanup) |
| An agent can't find argue's tools | `src/integrations/install.js`, `src/integrations/mcp.js` |

Every run keeps its full record in `<project>/.argue/runs/<id>/`: `transcript.json` (every message), `events.jsonl` (timeline), `answer.md`, and one `.patch` per model in code tasks.

## Before a PR

```bash
npm test
npm run lint
```
