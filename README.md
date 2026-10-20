# argue

**Several AI coding agents compete on your task. The best verified solution wins.**

```bash
npm i -g argue-ai
argue "fix the race condition in ws/reconnect.ts"
```

The first time you run argue, it offers to connect itself to your coding agents. After that, you can also just ask your agent to *"argue this"*.

## How it works

1. Each agent (Claude Code, Codex, Gemini, Cursor, OpenCode, Pi) solves the task in its own private copy of your project.
2. Your tests run in every copy.
3. The agents review each other's work and try to prove bugs.
4. Each agent fixes the problems that hold up.
5. A judge picks the winner.

You get the winning change and a report of the debate. **Your files don't change** until you run `argue apply`.

Everything runs on your machine through the agent CLIs you already use. There's no account and no server.

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
argue "<task>"                  # solve a task
argue "<question>" --mode ask   # debate an answer, no code changes
argue apply                     # apply the latest winner
argue show                      # read the full report
argue doctor                    # your harnesses, their default models, and the lineup
argue lineup claude:opus,codex@high   # check and save a new default lineup
argue install / uninstall       # connect argue to your agents, or remove it
```

Useful options:

```bash
-a claude,codex,gemini   # choose the agents for one run (format: harness:model@effort)
-c "npm test"            # the command that proves the task is done (auto-detected)
-r 2                     # rounds of review (default 2)
-b 5                     # budget in USD (for CLIs that report cost)
--bg                     # run in the background; check later with: argue watch
```

`argue --help` lists everything.

## Choosing agents, models and effort

`argue doctor` shows each harness with the model and effort it uses by default, read from that harness's own settings, plus the lineup argue will use.

```bash
argue lineup                                   # show the lineup
argue lineup claude:opus@high,codex:gpt-5@low  # check each model exists, then save it as your default
argue lineup --reset                           # back to automatic
```

Effort works with Claude Code, Codex and Pi. When you use argue from inside an agent, it tells you the lineup when a run starts. Ask it to add a harness, or to change a model or effort, and it restarts the run with the new lineup.

## Safe by default

- Agents only work in private copies, never in your project.
- Nothing is applied until you say so.
- If a fix breaks something that used to work, argue keeps the earlier version.
- Ctrl-C stops all agents and cleans up.
- `argue uninstall` removes everything argue added.

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
