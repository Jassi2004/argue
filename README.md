<p align="center">
  <a href="docs/ARCHITECTURE.md"><img src="docs/assets/argue-flow.svg" width="100%" alt="How argue works: from Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Pi or a terminal, 'argue this' starts one engine. Each model works alone in its own copy of your repo, then they challenge each other, use each other's tools and revise through a shared room until a plain-code referee sees a real agreement. One answer comes back to the tool you asked from."></a>
</p>

# argue

[![npm](https://img.shields.io/npm/v/argue-ai)](https://www.npmjs.com/package/argue-ai)

**Get your approach challenged by several AI models, right inside your coding session.**

When you want a second opinion on a plan, decision or code change, ask argue. Models work independently, challenge each other's reasoning and revise their work. You get one final recommendation, with unresolved disagreements called out.

## Install

```bash
npm i -g argue-ai
argue install
```

This connects argue to your coding tools. You'll need **Node 20+**, **git** and at least one supported coding CLI, logged in. If an existing session doesn't pick up argue, reload its skills/MCP connections or start a new session.

## Use it in your session

Keep working in **Claude Code, Codex, Cursor, Gemini CLI, OpenCode or Pi**. Whenever you want a critique, just ask:

> Argue this approach and tell me the final recommendation.

Your agent passes along the proposal and relevant context from your conversation. The models argue it out, and the answer comes back in the same session.

Use it before committing to an architecture, choosing between implementations or trusting a proposed fix:

> Argue whether this caching design handles concurrent writes.

> Have other models critique this migration plan before we implement it.

**Want different models, coding tools or limits? Just say so:**

> Use Opus through Claude Code and Codex for this run.

> Include Gemini too, and cap it at three rounds.

Your choices override the defaults for that run. Add **“from now on”** to save them as your defaults. If a run is already underway, changing the lineup restarts it with the same task.

Your agent shows the models and run limits before starting. Using several models takes more time and tokens than asking one.

## More you can do

- **Run directly from your terminal.** Ask a question or request a code change from your project folder.
- **Keep control of code changes.** Agents work in separate git worktrees; apply the result when you're ready.
- **Inspect the reasoning.** Read every challenge, reply and revision, or ask a follow-up from the saved record.
- **Use the tools you already have.** argue picks from your installed coding CLIs; you can also choose models explicitly.

```bash
argue "What is the biggest architectural risk in this repo?"
argue "fix the failing login test"
argue "critique this API design" -a opus,codex
```

## Helpful commands

| You want to… | Run |
|---|---|
| Check installed tools and default models | `argue doctor` |
| Ask about the last answer | `argue ask "why not Postgres?"` |
| Apply the last code change | `argue apply` |
| Read the full debate | `argue show` |
| List past runs | `argue runs` |
| Follow a run live | `argue watch` |
| Stop a run | `argue cancel` |
| Show or change default models | `argue lineup` / `argue lineup opus,codex` |
| See all options | `argue --help` |

[How the debate works →](docs/ARCHITECTURE.md)

<details>
<summary>Advanced: models, settings and shared tools</summary>

### Choose models from the terminal

Use `-a` to override the lineup for one run:

```bash
argue "your question" -a opus,gpt-6.1-sol@high
```

- **Model name** (`opus`, `gpt-6.1-sol`, `gemini-2.5-pro`): argue finds the tool for it.
- **Tool name** (`claude`, `codex`): use that tool's configured model.
- **Specific tool and model** (`claude:opus`): choose both explicitly.
- **Thinking effort** (`@high`, `@low`): supported by Claude Code, Codex and Pi.
- **Only one tool installed?** Choose two of its models (`claude:opus,claude:sonnet`) or use the same one twice.

To save defaults:

```bash
argue lineup opus,gpt-6.1-sol@high   # checks availability, then saves
argue lineup -b 5 -r 3              # default budget and rounds
argue lineup --reset                # back to automatic
```

### Settings

Put settings in `.argue.json` in your project, or in `~/.config/argue/config.json` for all projects. Flags win over both.

```json
{ "agents": "opus,codex", "check": "npm test", "rounds": 4, "budget": 10, "mcp": ["github"] }
```

| Setting | Flag | Default |
|---|---|---|
| `agents` | `-a` | picked from your installed tools |
| `check`: the command that proves a code change works | `-c` | detected (`npm test`, `pytest`, `go test`, …); `"none"` to skip |
| `rounds`: most rounds after the opening | `-r` | 4 (rooms usually settle sooner) |
| `budget`: USD cap per run (`"none"` for no cap) | `-b` | $10, counted for tools that report cost (Claude Code, OpenCode, Pi) |
| `minutes`: no new round starts after this | `--minutes` | 60 |
| `timeout`: minutes per agent turn | `-t` | 20 |
| `mode`: `code` or `answer` | `-m` | guessed from what you ask |
| `mcp`: MCP servers agents may use | | none |
| `custom`: your own CLI agents (below) | | |

Other flags: `--bg` (run in the background), `--apply` (apply when done), `--verbose` (show costs and checks), `--json`.

**Any command-line AI tool can join:**

```json
{ "custom": { "aider": { "command": "aider --yes-always --message-file {prompt_file}" } } }
```

**Where files go.** Each run's full record is in `<project>/.argue/runs/<id>/`, which git ignores automatically. Settings live in `~/.config/argue/`.

### Share tools between agents

Agents get **no MCP servers by default**. To share specific servers from their coding tool's config:

```json
{ "mcp": ["github", "postgres"] }
```

Claude Code and Codex agents receive the listed servers. Other CLIs use their own MCP configuration. Agents can ask each other to use available tools; `argue doctor` shows which shared servers were found.

</details>

## Remove argue

```bash
argue uninstall
npm uninstall -g argue-ai
```

## Contributing

Agent behaviour lives in [`instructions/`](instructions/README.md). See [the architecture](docs/ARCHITECTURE.md) and [contributing guide](docs/CONTRIBUTING.md).

## License

MIT

## Published release checks

Published npm releases are independently verified on GitLab across Node 20, 22 and 24. See [release verification](docs/RELEASE-VERIFICATION.md) for the automatic flow, reports and manual retries.
