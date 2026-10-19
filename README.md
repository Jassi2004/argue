# argue

**Make AI coding agents argue over your task until the best solution wins.**

```bash
argue "fix the race condition in ws/reconnect.ts"
```

`argue` takes the coding agents you already have (Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Pi) and has them compete on the same task:

1. **Solve:** each agent solves the task on its own, in a private copy of your repo.
2. **Check:** your tests run in every copy.
3. **Attack:** agents review each other's work. They can apply rival patches and run tests to prove bugs.
4. **Fix:** each agent fixes the problems that hold up, and can borrow better ideas from the others.
5. **Judge:** a neutral agent picks the winner. Passing tests count most.

You get the winning patch, the reasons it won, the remaining risks and the full debate. **Your files are not touched** until you run `argue apply`.

Everything runs locally through the CLIs you're already logged in to. There's no account, no server, and no new API keys.

## Install

```bash
npm i -g argue-ai
argue doctor        # shows which agents it found
argue install       # adds /argue to all your coding agents
```

Requires Node 20+, git, and at least one agent CLI:

| Agent | Install |
|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | `npm i -g @openai/codex` |
| Gemini CLI | `npm i -g @google/gemini-cli` |
| Cursor CLI | `curl https://cursor.com/install -fsS \| bash` |
| OpenCode | `npm i -g opencode-ai` |
| Pi | `npm i -g @earendil-works/pi-coding-agent` |

**If you have only one agent,** argue runs several copies of it, each nudged toward a different approach (e.g. `claude:opus` vs. `claude:sonnet`). Mixing vendors works best, because different models catch different mistakes.

## Use it from your editor or agent

After `argue install`, ask your agent as usual:

> argue this: the checkout total is wrong when a coupon and a gift card are combined

| Where you work | How it connects |
|---|---|
| Claude Code | skill + MCP server |
| Codex | skill + MCP server |
| Cursor | skill + MCP server |
| Gemini CLI | skill + MCP server + `/argue` command |
| OpenCode | skill + MCP server + `/argue` command |
| Pi | skill + `/argue` prompt |
| Anything else | any agent that can run shell commands can use `argue … --json` |

Your agent writes the brief, starts the run, reports progress, and asks you before applying the result.

## Usage

```bash
argue "<task>"                                   # auto: installed agents + detected test command
argue "<task>" -a claude,codex,gemini            # choose competitors
argue "<task>" -a claude:opus@high,codex:gpt-5   # models and reasoning effort
argue "<task>" -c "pytest -q tests/test_auth.py" # acceptance check
argue "<question>" --mode ask                    # debate an answer; no code changes
argue -f brief.md --rounds 3 --budget 5          # long brief, more rounds, $5 cap
argue "<task>" --bg                              # run in the background
argue "<task>" --apply                           # apply the winner automatically

argue watch                # follow the latest run
argue apply [run]          # apply the winner
argue apply [run] --agent B   # …or another agent's version
argue show [run]           # full report: scoreboard, debate, patch
argue runs                 # history
```

Agent format: `agent[:model][@effort]`, e.g. `codex:gpt-5@high`, `pi:openrouter/deepseek/deepseek-r1`, `opencode:anthropic/claude-sonnet-4`.

### Modes

- **code** (default): agents edit code, and you get a winning patch.
- **ask**: agents investigate read-only and debate. The judge writes one final answer plus a "where they disagreed" section. Use it for architecture, root-cause analysis, reviews and plans.

## Configuration

`argue init` saves your defaults. They're stored in `~/.config/argue/config.json`, and can be overridden per project with `.argue.json`:

```json
{
  "agents": "claude:opus,codex,gemini",
  "judge": "claude:opus",
  "check": "npm test",
  "rounds": 2,
  "budget": 10,
  "timeout": 20
}
```

### Custom agents

Any CLI that can take a prompt can compete:

```json
{
  "custom": {
    "aider": {
      "command": "aider --yes-always --no-auto-commits --message-file {prompt_file}",
      "readCommand": "aider --yes-always --dry-run --message-file {prompt_file}"
    }
  }
}
```

Placeholders: `{prompt_file}`, `{cwd}`, `{model}`. The command's stdout is the agent's reply. `ARGUE_WRITE=1` is set when the agent is allowed to edit.

## How it stays safe

- Each agent works in a separate git worktree outside your project. Uncommitted and untracked files are included, so agents see what you see.
- Your repo's history is never touched, and nothing is committed to it. Run data lives in `.argue/`, which is git-ignored automatically.
- Plain folders that aren't git repos are fine too; argue makes a private snapshot.
- `node_modules` and virtualenvs are shared into each copy without being included in patches.
- If an agent changes or deletes existing tests, it's flagged to the judge.
- Ctrl-C stops every agent and cleans up.
- Cost: Claude Code, OpenCode and Pi report spend, and `--budget` is enforced on them. Codex, Gemini and Cursor bill your existing plans and only report tokens.

## MCP server

`argue mcp` is a stdio MCP server with these tools: `argue_start`, `argue_wait`, `argue_apply`, `argue_cancel`, `argue_runs` and `argue_agents`. Runs continue in the background, so host tool timeouts don't matter. `argue install` registers it for you, or add it by hand:

```json
{ "mcpServers": { "argue": { "command": "argue", "args": ["mcp"] } } }
```

## License

MIT
