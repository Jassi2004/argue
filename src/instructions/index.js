import { readFileSync } from "node:fs";
import { fromRoot } from "../util/paths.js";

/**
 * Loads the instruction files in instructions/*.md and fills in their {blanks}.
 * The words themselves live in those Markdown files; this file only assembles them.
 */

const cache = new Map();
export function load(name) {
  // Normalise Windows line endings so prompts are identical on every OS.
  if (!cache.has(name)) cache.set(name, readFileSync(fromRoot("instructions", `${name}.md`), "utf8").replace(/\r\n/g, "\n").trim());
  return cache.get(name);
}

/** Replace {blank} with values; blanks with no value disappear (and empty lines collapse). */
export function fill(text, values) {
  return text
    .replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k] ?? "") : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A step's full instruction: the shared rules, then the step itself. */
function step(name, values, { withRules = true } = {}) {
  const body = fill(load(name), values);
  return withRules ? `${load("rules")}\n\n${body}` : body;
}

/** Paragraphs starting with "If this is a coding task:" only apply when models edit code. */
const codeOnly = (text, isCode) =>
  isCode
    ? text
    : text
        .split(/\n{2,}/)
        .filter((p) => !p.startsWith("If this is a coding task:"))
        .join("\n\n");

/** Different starting nudges, so models (especially copies of one model) don't all converge. */
export const APPROACHES = [
  "",
  "Before settling, seriously consider at least one approach different from the obvious one, and choose it if it is better.",
  "Prefer the simplest, safest answer that fully solves the task.",
  "Start from edge cases, failure modes and counter-arguments, then build your answer around them.",
  "Think about the long term: maintainability, scale and second-order effects.",
];

const withCheck = (task, check) => (check ? `${task}\n\nThe result is checked by running: \`${check}\`` : task);

// ---------------------------------------------------------------- steps

export function solve({ task, check, approach, ctx, isCode }) {
  return codeOnly(step("solve", { task: withContext(withCheck(task, check), ctx), approach: approach ? `Your approach: ${approach}` : "", check }), isCode);
}

/** `others`: [{ id, summary, patchFile?, check? }] */
export function critique({ task, check, self, others, ctx, isCode }) {
  const list = others
    .map((o) =>
      isCode
        ? `### ${o.id}\nPatch: \`${o.patchFile}\`${o.check ? ` (check ${o.check.pass ? "PASSED" : "FAILED"})` : ""}\nTheir summary: ${short(o.summary)}`
        : `### ${o.id}\n${o.summary || "(empty)"}`,
    )
    .join("\n\n");
  return codeOnly(step("critique", { task: withContext(withCheck(task, check), ctx), others: `(You are ${self}.)\n\n${list}` }), isCode);
}

export function improve({ task, check, previous, feedback, checkResult, ctx, isCode }) {
  let prev = previous || "(your earlier summary is not available)";
  if (isCode && check)
    prev += `\n\nCheck \`${check}\` on your current code: ${checkResult?.pass ? "PASSED" : `FAILED\n\`\`\`\n${checkResult?.output ?? ""}\n\`\`\``}`;
  return codeOnly(
    step("improve", { task: withContext(withCheck(task, check), ctx), previous: prev, feedback: feedback || "(no reviewer comments)", check }),
    isCode,
  );
}

/** `candidates`: [{ id, summary, objections, revisedAfter, patchFile?, stats?, check?, testEdits? }] */
export function finalAnswer({ task, check, candidates, ctx, isCode }) {
  const list = candidates
    .map((c) => {
      const notes = [
        `Objections left after the last review: ${c.objections}${c.revisedAfter ? " (revised since; check whether they still hold)" : ""}`,
        isCode && c.patchFile ? `Patch: \`${c.patchFile}\` (${c.stats.files} files, +${c.stats.add}/-${c.stats.del})` : null,
        isCode && check ? `Check: ${c.check ? (c.check.pass ? "PASSED" : "FAILED") : "not run"}` : null,
        c.testEdits?.length ? `Changed existing test files: ${c.testEdits.join(", ")} (weakening tests is disqualifying)` : null,
      ].filter(Boolean);
      return `### ${c.id}\n${notes.join("\n")}\n\n${c.summary || "(empty)"}`;
    })
    .join("\n\n");
  return codeOnly(step("final-answer", { task: withContext(withCheck(task, check), ctx), others: list }, { withRules: false }), isCode);
}

export function followUp({ logbook, question }) {
  return step("follow-up", { logbook, question }, { withRules: false });
}

// ---------------------------------------------------------------- reading replies

/** Split a critique into per-model sections keyed by letter ("## B" headings). */
export function splitCritique(text = "", ids = []) {
  const out = {};
  const re = /^\s*(?:#{1,4}\s*|\*\*)\s*(?:Solution|Answer|Candidate|Rival|Model|Work)?\s*([A-Z])\b(?!['’])[^\n]*$/gm;
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

/** Reviewer verdict for one section: "ok", "issues", or null when unreadable. */
export function verdictOf(section = "") {
  const all = [...String(section).matchAll(/VERDICT\W{0,5}\s*(OK|ISSUES)\b(\s*\|\s*(?:OK|ISSUES))?/gi)].filter((m) => !m[2]);
  const m = all.at(-1);
  return m ? (m[1].toUpperCase() === "OK" ? "ok" : "issues") : null;
}

export const hasIssues = (section = "") => verdictOf(section) === "issues";

function withContext(task, ctx) {
  return ctx ? `${task}\n\nExtra context from the user's session:\n${ctx}` : task;
}

function short(s = "") {
  const t = String(s).trim();
  return t.length > 1500 ? `${t.slice(0, 1500)}…` : t;
}
