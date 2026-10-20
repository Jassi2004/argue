// All prompts live here so the protocol is easy to read and tune.

const RULES = `You are one of several independent AI agents competing on the same task. Rival agents will scrutinise your work and a judge will pick the best result.
Ground rules:
- Correctness beats cleverness. Verify claims by reading the code and running commands where you can.
- Never ask the user questions; make reasonable assumptions and state them.
- The current directory is your own private copy of the project. Work only inside it: any path in the task that points at the project means this copy. Put scratch files (repro scripts, notes) here, never in /tmp or elsewhere.
- Do not modify the .argue/ folder; only read files in it that you are pointed to.`;

const checkLine = (check) => (check ? `Acceptance check (run automatically in your copy afterwards): \`${check}\`\n` : "");

function context(c) {
  return c ? `\nCONTEXT FROM THE USER'S SESSION:\n${c}\n` : "";
}

// ---------- code mode: agents edit files in their own worktree ----------

export function proposeCode({ task, check, angle, ctx }) {
  return `${RULES}

TASK:
${task}
${context(ctx)}
${checkLine(check)}${angle ? `Your angle: ${angle}\n` : ""}
You are in your own private copy of the repository. Implement the best solution directly by editing files.
Run the project's tests or the acceptance check yourself if you can. Adding new tests that prove your change is encouraged; never weaken, skip or delete existing tests or assertions to make a check pass.
When done, reply with a brief summary: approach, files changed, how you verified it, known risks.`;
}

export function critiqueCode({ task, check, self, rivals, ctx }) {
  const list = rivals
    .map(
      (r) =>
        `- Solution ${r.id}: patch at \`${r.patchFile}\`${r.check ? ` (acceptance check ${r.check.pass ? "PASSED" : "FAILED"})` : ""}${r.summary ? `\n  Author's summary: ${oneParagraph(r.summary)}` : ""}`,
    )
    .join("\n");
  return `${RULES}

TASK:
${task}
${context(ctx)}
${checkLine(check)}
You are ${self}. You are now a reviewer. Rival solutions:
${list}

You are in a scratch copy of the original (unmodified) repository. You may apply a rival patch here (\`git apply <patch>\`), run tests, and write repro scripts or failing tests to PROVE problems. Undo it with \`git apply -R <patch>\` before trying the next rival, and delete your scratch files. Nothing you do here is kept.

Find real problems: bugs, missed requirements, broken edge cases, regressions, security issues. Ignore style nitpicks.
A claim backed by a failing test or command output counts far more than an opinion. Do not invent problems; if a solution is solid, say so.

Reply with exactly one section per rival (${rivals.map((r) => r.id).join(", ")}), in this format:

## <letter>
VERDICT: OK
or
VERDICT: ISSUES
- <issue>: <why, with file:line> — evidence: <command + result, or "unverified">`;
}

export function reviseCode({ task, check, feedback, checkResult, ctx }) {
  const checkInfo = check
    ? `Acceptance check \`${check}\` on your current solution: ${checkResult?.pass ? "PASSED" : `FAILED\n\`\`\`\n${checkResult?.output ?? ""}\n\`\`\``}\n`
    : "";
  return `${RULES}

TASK:
${task}
${context(ctx)}
${checkInfo}
This is your copy of the repository, containing your current solution. Rival reviewers examined it:

${feedback || "(no reviewer comments)"}

Verify each point yourself. Fix the real ones; reject wrong ones with a reason. Make the acceptance check pass if it fails.
You may borrow better ideas from rivals (their patches are in .argue/rivals/ if present).
When done, reply with a brief summary: what you changed, which critiques you rejected and why.`;
}

export function judgeCode({ task, check, candidates, ctx }) {
  const list = candidates
    .map(
      (c) => `### Candidate ${c.id}
Patch: \`${c.patchFile}\` (${c.stats.files} files, +${c.stats.add}/-${c.stats.del})
Acceptance check: ${c.check ? (c.check.pass ? "PASSED" : "FAILED") : "none"}
Reviewer objections in the last critique round: ${c.objections}${c.revisedAfter ? " (the author revised afterwards; check whether they still hold)" : ""}${c.testEdits?.length ? `\nModified pre-existing test files: ${c.testEdits.join(", ")} (inspect: adding tests is fine, weakening or deleting existing assertions is disqualifying)` : ""}
Author's summary: ${oneParagraph(c.summary) || "(none)"}`,
    )
    .join("\n\n");
  return `You are the impartial judge of a coding competition between AI agents. You did not write any of these solutions.

TASK:
${task}
${context(ctx)}
${checkLine(check)}
${list}

Read every patch file carefully (you are in a copy of the original repository, so you can compare against the original code).
Decide which single candidate best solves the task. Rank by:
1. Correctness: does it actually work, including the edge cases the task implies? Verify claims yourself (apply a patch with \`git apply <patch>\`, run tests, write a quick repro); undo with \`git apply -R <patch>\`.
2. Completeness against what the user asked for.
3. Safety: no risky or unrelated changes. Robustness the task calls for (validation, edge cases it mentions) is completeness, not scope creep.
4. Simplicity and readability.
A passing acceptance check is strong evidence; do not pick a failing candidate if a passing one exists.
Extra tests that prove the change are a plus. Weakening existing tests to pass the check is disqualifying.

Reply with ONLY this JSON object:
{"winner": "<id>", "ranking": ["<id>", ...], "reason": "<2-4 sentences>", "risks": "<remaining risks or 'none'>"}`;
}

// ---------- ask mode: no edits; agents debate an answer (design, debugging, analysis, review) ----------

export function proposeAsk({ task, angle, ctx }) {
  return `${RULES}

QUESTION / TASK:
${task}
${context(ctx)}
${angle ? `Your angle: ${angle}\n` : ""}
You have read-only access to the repository. Investigate as needed, then give your best answer.
Be concrete: reference files and lines, give code where useful, state assumptions, and say how confident you are and why.`;
}

export function critiqueAsk({ task, self, rivals, ctx }) {
  const body = rivals.map((r) => `## Answer ${r.id}\n${r.summary || "(empty)"}`).join("\n\n");
  return `${RULES}

QUESTION / TASK:
${task}
${context(ctx)}
You are ${self}. Rival answers:

${body}

Check each answer against the actual code (you have read-only access). Find factual errors, flawed reasoning, missed cases, and better alternatives. Do not invent problems.

Reply with exactly one section per rival (${rivals.map((r) => r.id).join(", ")}), in this format:

## <letter>
VERDICT: OK
or
VERDICT: ISSUES
- <issue>: <why, with evidence from the code>`;
}

export function reviseAsk({ task, mine, feedback, ctx }) {
  return `${RULES}

QUESTION / TASK:
${task}
${context(ctx)}
Your previous answer:
${mine}

Reviewers said:
${feedback || "(no comments)"}

Verify each point against the code. Produce your improved, complete answer (not a diff of changes). Adopt better ideas from others if they hold up; briefly note which critiques you rejected and why at the end.`;
}

export function judgeAsk({ task, candidates, ctx }) {
  const body = candidates
    .map((c) => `## Answer ${c.id}\nReviewer objections in the last round: ${c.objections}${c.revisedAfter ? " (revised afterwards)" : ""}\n\n${c.summary}`)
    .join("\n\n");
  return `You are the impartial judge of a debate between AI agents. You wrote none of these answers.

QUESTION / TASK:
${task}
${context(ctx)}
${body}

You have read-only access to the repository; verify disputed claims against the code.
Write the single best final answer for the user: take the strongest answer as the base, fix its errors, and merge in correct points from the others. Then add a short "Where they disagreed" section listing real disagreements and who was right.

Start your reply with exactly one line of JSON, then the final answer in markdown:
{"winner": "<id of the answer closest to your final one>", "ranking": ["<id>", ...], "reason": "<1-2 sentences>", "risks": "<open questions or 'none'>"}`;
}

/** Different starting angles so agents (especially copies of one model) don't converge on the same idea. */
export const ANGLES = [
  "",
  "Before settling, consider at least one approach different from the obvious one, and choose it if it is better.",
  "Prefer the smallest, safest change that fully solves the task.",
  "Start from edge cases and failure modes, then design around them.",
  "Think about performance and maintainability over the long term.",
];

/** Split a critique into per-rival sections keyed by id ("## B" headings). */
export function splitCritique(text = "", ids = []) {
  const out = {};
  const re = /^\s*(?:#{1,4}\s*|\*\*)\s*(?:Solution|Answer|Candidate|Rival)?\s*([A-Z])\b(?!['’])[^\n]*$/gm;
  const marks = [...text.matchAll(re)].filter((m) => ids.includes(m[1]));
  if (!marks.length) {
    for (const id of ids) out[id] = text.trim();
    return out;
  }
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out[m[1]] = text.slice(m.index + m[0].length, end).trim();
  });
  return out;
}

/** Reviewer verdict for one section: "ok", "issues", or null when the reviewer gave no readable verdict. */
export function verdictOf(section = "") {
  const all = [...String(section).matchAll(/VERDICT\W{0,5}\s*(OK|ISSUES)\b(\s*\|\s*(?:OK|ISSUES))?/gi)].filter((m) => !m[2]);
  const m = all.at(-1);
  return m ? (m[1].toUpperCase() === "OK" ? "ok" : "issues") : null;
}

export function hasIssues(section = "") {
  return verdictOf(section) === "issues";
}

function oneParagraph(s = "") {
  const t = String(s).trim();
  return t.length > 1500 ? `${t.slice(0, 1500)}…` : t;
}
