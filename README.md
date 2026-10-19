# argue

Make AI coding agents argue over your task until the best solution wins.

```bash
argue "fix the flaky reconnect in ws/client.ts" --check "npm test"
```

`argue` runs the agent CLIs you already use (Claude Code, Codex) side by side on the same task:

1. **Propose:** each agent solves the task on its own, in a separate git worktree.
2. **Check:** your acceptance command runs in each copy.
3. **Critique:** agents review each other's diffs, which are labelled A, B, C… instead of with model names.
4. **Revise:** agents fix the problems that hold up and can borrow each other's ideas.
5. **Judge:** a separate agent picks the winner. Passing the check counts most.

You get the winning patch and a report of the whole debate. Your working tree is only changed if you pass `--apply`.

## Install

```bash
git clone https://github.com/Jassi2004/argue && cd argue && npm link
argue doctor   # shows which agents it found
```

Requires Node 20+, git, and at least one of `claude` or `codex` installed and logged in.

## Usage

```bash
argue "<task>"                                  # uses whatever is installed
argue "<task>" -a claude,codex -c "npm test"    # pick agents + acceptance check
argue "<task>" -a claude:opus,claude:sonnet@high
argue -f task.md --rounds 3 --budget 5 --apply
argue "<task>" --json                           # for other agents and tools
```

With only one CLI installed, it runs several copies of it, each nudged toward a different approach.

## Use it from your editor's agent

Copy `skills/argue/` into your agent's skills folder (for example `~/.claude/skills/`). Then ask *"argue this"* from Claude Code, Codex, Cursor, Pi or any agent that can run shell commands.

## Status

Early v0.1. Next up: more agents (Gemini, Cursor, Pi via ACP), an MCP tool, and a live room view.

MIT
