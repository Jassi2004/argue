# How argue works

argue puts several coding agents (Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Pi, or your own) in a **room** on one task. They know they are in a room together. They decide what to do each round; argue only runs the rounds, keeps score, and enforces the few rules that make the result trustworthy and make the run end.

## A run

```
  opening        every agent works alone and posts its own view           (parallel, private)
     │
  round 1..n     every agent reads the room, posts once, may improve       (parallel)
     │           its work; the referee decides what happens next
     │             ├─ continue          (the next round, only agents with something to respond to)
     │             ├─ red team          (everyone agrees, but nobody tried to break the work yet)
     │             └─ end               (consensus · stalled · impasse · limit)
     │
  verdict        one fresh call writes the final answer from the record
```

- **Opening is private** so nobody anchors on the first idea. Each agent also states its `TOOLS:`, so others know who can, say, search the web or query a database.
- **Rounds are simultaneous**: posts in a round don't see each other. That keeps rounds fast (one round lasts as long as its slowest agent) and fair (no first-mover advantage).
- **Agents choose their moves**: research, challenge, answer, ask another agent for help, revise, or back someone else's work. Nothing in the code says "now critique".
- **Agents are letters** (A, B, C…). Nobody knows which model is which, so arguments win on evidence, not reputation.

## Where things live

| Path | What it is |
|---|---|
| `instructions/` | Everything agents are told, as plain Markdown. Change behaviour here, not in code. |
| `src/room/index.js` | One run, start to finish: desks, opening, rounds, verdict, outputs. |
| `src/room/referee.js` | The room's state and the decision between rounds. Pure functions, no I/O. |
| `src/room/protocol.js` | Reading posts (header lines) and writing the room back to agents (digest, record). |
| `src/room/desks.js` | Each agent's workspace: worktree, room mirror, work snapshots, checks, rollback. |
| `src/room/prompts.js` | Builds prompts from `instructions/` (fills blanks, applies `[code]`/`[answer]`). |
| `src/agents/drivers.js` | One driver per CLI (+ custom agents): runs it headless, returns `{ ok, text, costUsd, tokens }`. |
| `src/agents/lineup.js` | Lineups, each CLI's default model/effort, checking a model exists. |
| `src/runs/` | Run records on disk, background runs, `argue ask` follow-ups. |
| `src/workspace/git.js` | Git worktrees, diffs, applying patches. The user's repo is never committed to. |
| `src/integrations/` | `argue install` (skills, MCP entries, slash commands), the MCP server, first-run setup. |
| `src/cli.js` | Commands and flags. |
| `src/config.js` | Settings: defaults < `~/.config/argue/config.json` < `<project>/.argue.json` < flags. |

## The post protocol

A post is free text plus a few header lines (`instructions/post-format.md` is what agents read; `protocol.js` parses it, tolerating markdown and case):

```
STANCE: B                          back B's work ("open" = undecided, "impasse" = can't be settled)
CHALLENGE B: <one-line claim>      a problem in B's work; argue numbers it (#3)
ANSWER #3: <one-line reply>        the author's reply
WITHDRAW #3                        the challenger drops it
ASK C: <request>                   ask C to do something for the room (use its tools, run something)
TOOLS: <what you can use>          capabilities others may lack
GIST: <one line>                   the post in one line, for the compact record
```

Backing work concedes your challenges against it: the ones you raised before switching to it, and the ones its author has answered (once you've seen the answer). A challenge raised while you already back the work ("this is the best, but fix this first") stays open until its author answers it.

## The referee

After every round, `decide()` returns what happens next. These are the only rules argue imposes:

| Situation | What happens |
|---|---|
| Everyone backs X and has seen its latest version; someone else challenged X at some point; no challenge against X is still open or unseen; X's check passes | **End: consensus** |
| Everyone backs X, but someone backed it in the round X changed | Continue: they see the new version first |
| Everyone backs X but nobody ever challenged it | **Red team**: one other agent (a different model family if possible) is asked to try to break X. Nothing found → consensus. |
| Everyone backs X but X's check fails | Continue; everyone is told, and X's author plays |
| Two rounds in a row with no progress | **End: stalled** |
| The room is back in an earlier state (same stances, work and challenge states) | **End: loop** |
| Nobody has anything new to respond to | **End: quiet** |
| Every agent says `impasse` | **End: impasse** |
| Round limit, budget or time limit reached | **End**, with the best work so far |
| An agent fails two turns in a row | It leaves the room. One agent left → **end** |

**Progress** is: a new challenge, an answer, a withdrawal, a stance change, revised work, a changed check result, a request, or a post with genuinely new content. These don't count:

- a challenge that repeats one already answered (word-shingle similarity ≥ 0.6) against work that hasn't changed since. The challenger is told to bring new evidence or withdraw.
- a post that mostly copies the author's earlier posts.

**Who plays next round:** undecided agents always play. Agents that back some work sit out unless something since their last turn concerns them: a challenge to their work or the work they back, a request to them, a revision of that work, or a stance change. This is the main cost saver once a room converges.

**Safety nets** (in `src/room/index.js`): if a revision breaks a previously passing check, or empties the work, argue keeps the previous version and tells the agent. In answer mode, an agent that replies with its answer instead of writing the file still gets it kept.

## Desks

```
<scratch>/A/                    agent A's private git worktree of the project (its cwd)
  .argue/answer.md              answer mode: A's current answer (A edits it in place)
  .argue/room/room.md           the full record so far (read-only mirror, refreshed every turn)
  .argue/room/work/B.patch      everyone's current work (B.md in answer mode)
  .argue/room/checks/B.txt      the check's output on B's work
  .argue/lab/                   code mode: a clean copy for trying others' patches (reset every turn)
```

`.argue/` is never part of a patch. Big ignored folders (`node_modules`, `.venv`…) are symlinked, not copied. Untracked and uncommitted files are included, so agents start from what the user actually has.

## The run record

Everything stays in `<project>/.argue/runs/<id>/` (git-ignored automatically):

| File | Written | Used by |
|---|---|---|
| `meta.json` | at start, at end | status, lineup |
| `events.jsonl` | live | `argue watch`, the MCP server's `argue_wait` |
| `room.json`, `room.md` | after **every round** | `argue show`, `argue ask`; a crash never loses the debate |
| `work/A.patch` / `A.md`, `work/winner.patch` | every round, at end | `argue apply [--agent X]` |
| `answer.md`, `result.json` | at end | the user, hosts |
| `beat` | every 15 s | a run that stops beating for 2 minutes shows as `stuck`, not `running` |
| `pids`, `cancel` | while running | cleanup after a crash, `argue cancel` |

## Cost

A room costs roughly one agent call per agent per round, plus the verdict, and usually settles in 1–3 rounds. What keeps it down:

- **Pass by reference.** Prompts carry file paths to others' work (`.argue/room/work/B.patch`), not their content. Agents open only what they need.
- **A compact record.** Each turn's prompt holds a digest, not the whole debate: who backs what, every challenge in one line, older rounds as one-line gists, only the latest round in full. The full record is a file the agent can open.
- **Terse posts.** `post-format.md` asks for evidence and reasoning only, in short sentences, pointing at evidence rather than pasting it. Output tokens cost the most, and the final answer stays normal prose.
- **Edits, not rewrites.** Agents revise their work by editing files, so a revision costs the diff, not the whole answer again.
- **Settled agents sit out**, and a red-team turn is one call, not a round.
- **A stable prompt prefix.** The charter and post format come first and the per-round part last, so CLIs that cache prompt prefixes can reuse them.

Every run reports `calls`, `tokens`, `promptChars` and `costUsd` (for CLIs that report cost) in `result.json`.

## Safety

- Agents work only in their desks; absolute paths to the project in the brief are rewritten to `.`, Claude Code is denied writes to the real project, and argue checks afterwards whether the project changed during the run (`projectChanged`).
- **MCP servers are off for agents by default.** An unattended agent with your Slack or Jira servers could act on them. Share specific servers with `"mcp": ["github", "postgres"]` in your config. Claude Code and Codex honour this: Claude only gets the listed servers, and Codex has every server in `config.toml` switched off except the listed ones (servers that Codex plugins provide can't be switched off this way). Other CLIs use whatever they are configured with.
- Agents get `ARGUE_DEPTH`, so an agent can't start a nested argue run.
- Nothing touches the user's files until `argue apply` (or `--apply`). Patches apply fully or not at all.
