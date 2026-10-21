# argue

[![npm](https://img.shields.io/npm/v/argue-ai)](https://www.npmjs.com/package/argue-ai)

**Ask several AI models the same thing. They argue it out. You get one carefully checked answer.**

Use it for questions, decisions, plans, writing, or code changes.

## 1. Install

```bash
npm i -g argue-ai
```

You also need:
- **Node 20 or newer** and **git**
- **At least one AI coding tool, logged in.** Two different ones work best.

| Tool | Install it with |
|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` |
| Codex | `npm i -g @openai/codex` |
| Gemini CLI | `npm i -g @google/gemini-cli` |
| Cursor CLI | `curl https://cursor.com/install -fsS \| bash` |
| OpenCode | `npm i -g opencode-ai` |
| Pi | `npm i -g @earendil-works/pi-coding-agent` |

## 2. Check your setup

```bash
argue doctor
```

This shows which AI tools argue found, which model each one uses, and which models will argue by default. The first time, it also offers to connect argue to your AI tools. Press **Enter** to say yes.

## 3. Ask something

Run it **inside your project folder**:

```bash
argue "which database should our social media app use?"
argue "fix the failing login test"
```

argue first shows which models will argue, then gives you one answer. That's it.

**Or, from your AI tool:** in Claude Code, Codex, Cursor, Pi, OpenCode or Gemini, just say:

> argue this: which database should we use?

## 4. After you get an answer

| You want to… | Run |
|---|---|
| Ask a follow-up ("why not MongoDB?") | `argue ask "why not MongoDB?"` |
| Apply a code change it suggested | `argue apply` |
| See everything the models said | `argue show` |

Your files never change until you run `argue apply`.

## Choosing models

argue uses your default models. To pick others for one run, add `-a`:

```bash
argue "your question" -a opus,gpt-6.1-sol
```

- **A model name** (`opus`, `gpt-6.1-sol`, `gemini-2.5-pro`): argue finds the right tool for it.
- **A tool name** (`claude`, `codex`): that tool's usual model.
- **Thinking effort:** add `@high` or `@low` (e.g. `gpt-6.1-sol@high`). This works with Claude Code, Codex and Pi.

To change your default models:

```bash
argue lineup opus,gpt-6.1-sol@high   # checks the models exist, then saves them
argue lineup --reset                 # go back to automatic
```

## All commands

| Command | What it does |
|---|---|
| `argue "<question or task>"` | Get one checked answer, or a code change |
| `argue ask "<follow-up>"` | Ask about the last answer |
| `argue apply` | Apply the last code change to your files |
| `argue show` | Show the full record of the last run |
| `argue runs` | List past runs |
| `argue cancel` | Stop a run |
| `argue doctor` | Check your setup |
| `argue lineup [models]` | Show or change your default models |
| `argue install` | Connect argue to your AI tools |
| `argue uninstall` | Remove argue from your AI tools |
| `argue --help` | All options |

## Remove argue

```bash
argue uninstall
npm uninstall -g argue-ai
```

## How it works

1. Each model works on your question alone, in its own private copy of your project.
2. They review each other's work and point out mistakes, with evidence.
3. Each model fixes what was wrong.
4. The best of what survives becomes your answer.

If the models still disagree about something important, the answer ends with a short **Note:**.

## Contributing

Everything the models are told is plain text in [`instructions/`](instructions/README.md), one file per step. You can change how they argue without touching code. See [how it works](docs/HOW-IT-WORKS.md) and [contributing](docs/CONTRIBUTING.md).

<details>
<summary>Advanced options</summary>

**Per-project settings.** Create `.argue.json` in your project:

```json
{ "agents": "opus,codex", "check": "npm test", "rounds": 2, "budget": 10 }
```

**Options for a single run:**
- `-c "npm test"`: the command that proves a code change works (auto-detected)
- `-r 2`: rounds of review
- `-b 5`: budget in USD (for tools that report cost)
- `--bg`: run in the background
- `--verbose`: show every step

**Custom tools.** Any command-line AI tool can take part:

```json
{ "custom": { "aider": { "command": "aider --yes-always --message-file {prompt_file}" } } }
```

**MCP server.** `argue mcp`; `argue install` sets it up for you.

**Where files go.** Run records go in `<project>/.argue/`, which git ignores automatically. Settings live in `~/.config/argue/`.

</details>

## License

MIT
