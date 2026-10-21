import { readFileSync } from "node:fs";
import { fromRoot } from "../util/paths.js";

/**
 * Builds what agents are told from the Markdown files in instructions/. No wording lives here.
 *
 * Rules applied to every instruction file (documented in instructions/README.md):
 *   {blank}            filled in by argue
 *   a line with an empty blank is left out (e.g. the check line when there is no check)
 *   [code] / [answer]  at the start of a line: only sent in that mode
 *
 * Static text (the room charter, the post format) comes first and the per-round part last,
 * so harnesses that cache prompt prefixes can reuse it across an agent's turns.
 */

const cache = new Map();
export function load(name) {
  if (!cache.has(name))
    cache.set(
      name,
      readFileSync(fromRoot("instructions", `${name}.md`), "utf8")
        .replace(/\r\n/g, "\n")
        .trim(),
    );
  return cache.get(name);
}

export function fill(text, values = {}, mode = "answer") {
  const out = [];
  for (let line of text.split("\n")) {
    const tag = line.match(/^\[(code|answer)\]\s?/);
    if (tag) {
      if (tag[1] !== mode) continue;
      line = line.slice(tag[0].length);
    }
    let empty = false;
    line = line.replace(/\{(\w+)\}/g, (m, k) => {
      if (!(k in values)) return m;
      const v = values[k];
      if (v == null || v === "") empty = true;
      return v == null ? "" : String(v);
    });
    if (!empty) out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The starting lenses, one per agent (bullets in instructions/lenses.md). */
export function lenses() {
  return load("lenses")
    .split("\n")
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
}

/**
 * Everything an agent's turn shares: who it is, the task, the rules, the post format.
 * ctx: { id, letters, task, check, mode, lens, maxRounds }
 */
function charter(ctx) {
  const values = {
    id: ctx.id,
    count: ctx.letters.length,
    letters: ctx.letters.join(", "),
    task: ctx.task,
    check: ctx.check,
    lens: ctx.lens,
    max_rounds: ctx.maxRounds,
  };
  return { values, text: `${fill(load("room"), values, ctx.mode)}\n\n${fill(load("post-format"), values, ctx.mode)}` };
}

const step = (ctx, name, extra = {}) => {
  const c = charter(ctx);
  return `${c.text}\n\n${fill(load(name), { ...c.values, ...extra }, ctx.mode)}`;
};

export const opening = (ctx) => step(ctx, "opening");

export const turn = (ctx, { round, digest, inbox }) => step(ctx, "turn", { round, digest, inbox });

export const redTeam = (ctx, { round, digest, target }) => step(ctx, "red-team", { round, digest, target });

export const verdict = ({ task, check, mode, outcome, standings }) => fill(load("verdict"), { task, check, outcome, standings }, mode);

export const followUp = ({ record, question }) => fill(load("follow-up"), { record, question });
