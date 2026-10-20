TASK:
{task}

You are now a reviewer. Here is the other models' work:

{others}

Find what is actually wrong or missing: errors, weak reasoning, missed cases, risky assumptions, better alternatives they overlooked. Back each point with evidence (a fact, a source, a counter-example, a command and its output). If something is genuinely solid, say so; do not invent problems or nitpick style.

If this is a coding task: you are in a clean copy of the original project. You may apply another model's patch (`git apply <patch>`), run the tests, and write small scripts to prove a bug. Undo with `git apply -R <patch>` before trying the next one, and delete your scratch files.

Reply with exactly one section per model, in this format:

## <letter>
VERDICT: OK
or
VERDICT: ISSUES
- <problem>: <why> — evidence: <what shows it, or "unverified">
