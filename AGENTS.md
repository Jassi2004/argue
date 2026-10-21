# Working on argue

argue puts several coding-agent CLIs in a "room" on one task; they argue it out and the user gets one vetted answer. Read `docs/ARCHITECTURE.md` first. It is short and explains every moving part.

## Rules of this codebase

- **Behaviour lives in `instructions/`, not in code.** If you want agents to act differently, edit the Markdown there. Code only facilitates (rounds, desks, records) and enforces the few rules in `src/room/referee.js`.
- **Zero runtime dependencies.** Node ≥ 20 built-ins only. Dev tools (eslint, prettier) are installed on the fly by `npm run lint`.
- **The referee is pure.** `src/room/referee.js` and `src/room/protocol.js` do no I/O; every rule there has a unit test in `test/unit.test.js`. Keep it that way.
- **Never touch the user's project** except through `applyPatch` when the user asks. Agents work in git worktrees under the OS temp folder; `.argue/` in the project holds run records and is git-ignored via `.git/info/exclude`.
- **Never lose a run's record.** The room is saved after every round (`room.json`, `room.md`); a crash, cancel or hang must still leave a readable record and a `result.json`.
- **Agents get no MCP servers unless the user shares them** (`"mcp": [...]` in config). Don't widen what unattended agents can reach.
- **Tests never call a real agent CLI.** Use the scripted fake agent in `test/fixtures/fake-agent.mjs`, and the `SAFE` environment (only node and git on PATH) for CLI runs in `test/integration.test.js`.
- Comments explain *why*, briefly. Prefer clear names over comments.

## Commands

```bash
npm test                                   # unit, integration and instruction-snapshot tests (~30 s)
npm run lint                               # eslint + prettier check
npx prettier --write src bin test scripts  # format
npm run instructions:preview -- turn       # print a filled-in prompt (opening | turn | red-team | verdict | follow-up; add --code)
UPDATE_SNAPSHOTS=1 npm test                # after editing instructions/, re-record what agents receive
node bin/argue.js doctor                   # run the CLI from the checkout
```

## Where to look

| You want to… | Go to |
|---|---|
| Change what agents are told | `instructions/*.md` (see `instructions/README.md`) |
| Change when the room ends, who plays, what counts as progress | `src/room/referee.js` + its tests |
| Change how posts are parsed or the room is shown to agents | `src/room/protocol.js` |
| Change a round's mechanics (desks, checks, rollback, verdict) | `src/room/index.js`, `src/room/desks.js` |
| Support a new agent CLI | `src/agents/drivers.js` (a driver), `src/agents/lineup.js` (default model/effort), `src/integrations/install.js` (skill/MCP entry) |
| Change terminal output | `src/util/ui.js` |
| Change the run record, cancel or cleanup | `src/runs/store.js` |
| Change commands or flags | `src/cli.js` (and `README.md`) |

## Debugging a run

Everything is in `<project>/.argue/runs/<id>/`: `room.md` (every post and challenge, readable), `room.json` (the referee's full state), `events.jsonl` (timeline with per-turn time, tokens, cost, errors), `work/` (each agent's latest work). `argue show <id>` prints `room.md`. `--keep` leaves the desks in the temp folder for inspection; `--verbose` shows notes, costs and checks live.

## Releasing

Merging to `main` with a new `version` in `package.json` publishes to npm automatically (`.github/workflows/release.yml`). Don't bump the version unless asked.
