# Instructions

These are the exact words argue sends to the agents. Edit any file to change how the room behaves. No code needed.

| You want to change… | Edit |
|---|---|
| What every agent knows about the room: the task, how rounds work, the ground rules, its desk | [`room.md`](room.md) |
| How agents write posts (STANCE, CHALLENGE, ANSWER, ASK…) and how terse they are | [`post-format.md`](post-format.md) |
| The first turn, where each agent works alone | [`opening.md`](opening.md) |
| Every later turn: what an agent may do in a round | [`turn.md`](turn.md) |
| The red-team turn (everyone agrees but nobody has tried to break the work yet) | [`red-team.md`](red-team.md) |
| The starting angle each agent gets, so the room doesn't think alike | [`lenses.md`](lenses.md) |
| How the final answer for the user is written | [`verdict.md`](verdict.md) |
| How follow-up questions (`argue ask "why not X?"`) are answered | [`follow-up.md`](follow-up.md) |

Every agent turn is `room.md` + `post-format.md` + the step (`opening.md`, `turn.md` or `red-team.md`), in that order. The unchanging part comes first so CLIs that cache prompts can reuse it.

## Three conventions

1. **`{blanks}`** are filled in by argue (table below).
2. **A line whose blank is empty is left out.** For example, the line with `{check}` disappears when there is no check command.
3. **`[code]` or `[answer]` at the start of a line** sends that line only when agents change code, or only when they argue out an answer.

| Blank | Filled with |
|---|---|
| `{id}`, `{letters}`, `{count}` | This agent's letter, everyone's letters, how many |
| `{task}` | What the user asked for (plus any context from the user's session) |
| `{check}` | The command that proves a code change works (e.g. `npm test`) |
| `{lens}` | This agent's starting angle, from `lenses.md` |
| `{round}`, `{max_rounds}` | This round's number and the round limit |
| `{digest}` | The room so far: who backs what, every challenge, older posts as one-line gists, the latest round in full |
| `{inbox}` | What's addressed to this agent: open challenges against its work, requests, notes from argue |
| `{target}` | The work the red team should try to break |
| `{outcome}`, `{standings}` | (verdict) how the room ended; every piece of work with its backers and open challenges |
| `{record}`, `{question}` | (follow-up) the full record of the run; the user's question |

The header lines in `post-format.md` are read by code (`src/room/protocol.js`). You can reword their descriptions freely, but keep the keywords (`STANCE`, `CHALLENGE`, `ANSWER`, `WITHDRAW`, `ASK`, `TOOLS`, `GIST`) and their shape.

## Trying a change

```bash
npm run instructions:preview -- turn          # the filled-in text (opening | turn | red-team | verdict | follow-up; add --code)
UPDATE_SNAPSHOTS=1 npm test                   # record the new text
git diff test/instructions/snapshots/         # exactly what agents will now receive
```
