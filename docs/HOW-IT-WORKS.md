# How argue works

One run, start to finish, with the file that does each part.

| # | What happens | Instruction (words) | Code |
|---|---|---|---|
| 1 | The user's request comes in; argue works out the lineup and whether models should change files ("code") or just answer ("answer") | n/a | `src/cli/index.js` (`runTask`, `guessMode`) · `src/models/index.js` (lineup, defaults) |
| 2 | Each model gets a private copy of the project | n/a | `src/workspace/git.js` |
| 3 | **Solve:** each model works alone | `instructions/solve.md` | `src/arena/session.js` (step 1) |
| 4 | **Critique:** each model attacks the others' work with evidence | `instructions/critique.md` | `src/arena/session.js` (step 2) |
| 5 | **Improve:** each model fixes what held up | `instructions/improve.md` | `src/arena/session.js` (step 2) |
| 6 | Steps 4–5 repeat until nothing new is found, every check passes, or the round limit | n/a | `src/arena/session.js` |
| 7 | **Final answer:** one model combines what survived into one vetted answer | `instructions/final-answer.md` | `src/arena/session.js` (step 3) |
| 8 | Everything is saved as the log book | n/a | `src/arena/runs.js` · `.argue/runs/<id>/` |
| 9 | **Follow-ups:** `argue ask "why not X?"` answers from the log book | `instructions/follow-up.md` | `src/arena/logbook.js` |

`instructions/rules.md` goes in front of steps 3–5.

## Folders

| Folder | What's in it |
|---|---|
| `instructions/` | The words models receive. Plain Markdown; edit freely. |
| `skills/argue/` | What the user's own agent (Claude Code, Codex, …) does when they say "argue". |
| `src/cli/` | The `argue` command and its subcommands. |
| `src/arena/` | A run: the session flow, run records, the log book, background runs. |
| `src/instructions/` | Loads the Markdown files and fills in their blanks. No wording lives here. |
| `src/models/` | Lineups, default models and effort, model checks, settings. |
| `src/harnesses/` | One driver per CLI (Claude Code, Codex, Gemini, Cursor, OpenCode, Pi), plus custom agents. |
| `src/workspace/` | Private copies (git worktrees), diffs, applying changes. |
| `src/integrations/` | MCP server, `argue install`, first-run setup. |
| `src/util/` | Running processes, files, terminal output, paths. |
