# Instructions

These are the exact words argue sends to the models. Edit any file to change how they behave. No code needed.

| You want to change… | Edit |
|---|---|
| How every model behaves (the ground rules) | [`rules.md`](rules.md) |
| How a model first tackles the task on its own | [`solve.md`](solve.md) |
| How hard models push back on each other's work | [`critique.md`](critique.md) |
| How a model responds to criticism | [`improve.md`](improve.md) |
| What the final, vetted answer looks like | [`final-answer.md`](final-answer.md) |
| How follow-up questions ("why not X?") are answered | [`follow-up.md`](follow-up.md) |

## How they're used

A run goes: **solve** (each model alone) → **critique** (each attacks the others) → **improve** (each fixes what holds up) → repeat critique/improve → **final answer** (one model combines everything). `rules.md` is put in front of every step except the final answer.

## Blanks

Words in `{curly braces}` are filled in automatically:

| Blank | Filled with |
|---|---|
| `{task}` | What the user asked for |
| `{check}` | The command that proves the task is done (e.g. `npm test`), when there is one |
| `{approach}` | A nudge to take a different approach, so models don't all do the same thing |
| `{others}` | The other models' work: their answers, or where to find their code changes |
| `{feedback}` | What reviewers said about this model's work |
| `{previous}` | This model's own earlier answer |
| `{question}` | The user's follow-up question |
| `{logbook}` | Everything that happened in the run |

Sections that start with **"If this is a coding task:"** only matter when the models are editing code. Leave them in place.

## Trying a change

```bash
npm run instructions:preview -- solve   # print the filled-in instruction for a step
npm test                                # snapshot tests show exactly what your edit changed
```
