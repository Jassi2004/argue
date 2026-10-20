# argue

**Several AI models argue it out. You get one carefully vetted answer.**

```bash
npm i -g argue-ai
argue "which database should a social media app use?"
argue "fix the race condition in ws/reconnect.ts"
```

Or, inside Claude Code, Codex, Cursor, Pi and others, just say *"argue this"*. The first time you run argue, it offers to connect itself to them.

## How it works

1. argue shows which models will argue (model, effort and harness).
2. Each model works on it alone, in its own private copy of your project.
3. They cross-examine each other's work with evidence, then fix what held up.
4. What survives is combined into one answer for you.

You only see the answer. If the models still disagree on something important, it ends with a short **Note:** saying so. Ask follow-ups any time with `argue ask "why not X?"`. It answers from the full record of the debate.

For code, your files don't change until you say so (`argue apply`).

**Choosing models:** argue uses your default lineup, or the models you name: `argue "…" -a opus,gpt-6.1-sol@high`. You can name a model, a harness, or both (`codex`, `claude:sonnet`). To save a new default, run `argue lineup opus,gpt-6.1-sol`. It checks each model exists first.

## Requirements

Node 20+, git, and at least one of these agent CLIs, logged in:

| Agent | Install |
|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` |
| Codex | `npm i -g @openai/codex` |
| Gemini CLI | `npm i -g @google/gemini-cli` |
| Cursor CLI | `curl https://cursor.com/install -fsS \| bash` |
| OpenCode | `npm i -g opencode-ai` |
| Pi | `npm i -g @earendil-works/pi-coding-agent` |

With only one CLI, argue runs two copies of it. Mixing vendors works better.

## Commands

```bash
argue "<question or task>"      # get a vetted answer (or code change)
argue ask "<follow-up>"         # question the last answer
argue apply                     # apply the last code change
argue show                      # the full record of the last run
argue doctor                    # your harnesses, their default models, and the lineup
argue lineup claude:opus,codex@high   # check and save a new default lineup
argue install / uninstall       # connect argue to your agents, or remove it
```

Useful options:

```bash
-a opus,gpt-6.1-sol@high # models for this run: a model, a harness, or harness:model, with optional @effort
-c "npm test"            # the command that proves the task is done (auto-detected)
-r 2                     # rounds of review (default 2)
-b 5                     # budget in USD (for CLIs that report cost)
--bg                     # run in the background; check later with: argue watch
```

`argue --help` lists everything.

## Default models

`argue doctor` shows each harness with the model and effort it uses by default, plus your lineup.

```bash
argue lineup                                   # show it
argue lineup claude:opus@high,codex:gpt-5@low  # check the models exist, then save as default
argue lineup --reset                           # back to automatic
```

Effort works with Claude Code, Codex and Pi.

## Safe by default

- Agents only work in private copies, never in your project.
- Nothing is applied until you say so.
- If a fix breaks something that used to work, argue keeps the earlier version.
- Ctrl-C stops all agents and cleans up.
- `argue uninstall` removes everything argue added.

## Changing how the models argue

Everything the models are told is plain text in [`instructions/`](instructions/README.md), one file per step. See [how it works](docs/HOW-IT-WORKS.md) and [contributing](docs/CONTRIBUTING.md).

## Settings (optional)

`argue init` saves your defaults, or you can create `.argue.json` in a project:

```json
{ "agents": "claude:opus,codex", "check": "npm test", "rounds": 2, "budget": 10 }
```

<details>
<summary>Advanced</summary>

**Custom agents.** Any CLI can compete:

```json
{ "custom": { "aider": { "command": "aider --yes-always --message-file {prompt_file}" } } }
```

**More options.** `--context "<text>"` shares extra context with every agent, `-t <min>` sets the time limit per agent call (default 20), `--keep` keeps the agents' copies for inspection, and `argue wait <run>` waits for a background run and prints its status as JSON.

**MCP server.** `argue mcp` provides the tools `argue_start`, `argue_wait`, `argue_apply`, `argue_cancel`, `argue_runs` and `argue_agents`. `argue install` registers it automatically.

**Where things go.** Run reports go in `<project>/.argue/` (git-ignored automatically). Connections are a skill plus an MCP entry in each agent's config. Settings live in `~/.config/argue/`.

</details>

## License

MIT
