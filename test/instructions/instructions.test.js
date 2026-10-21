import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as P from "../../src/room/prompts.js";

// Snapshot tests: when you edit a file in instructions/, run `UPDATE_SNAPSHOTS=1 npm test`;
// the diff of test/instructions/snapshots/ in your PR shows exactly what agents will now receive.
const SNAP = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

const ctx = (mode) => ({
  id: "A",
  letters: ["A", "B", "C"],
  task: mode === "code" ? "Fix the LRU cache in lru.js so the tests pass." : "Which database is best for a social media app?",
  check: mode === "code" ? "npm test" : null,
  mode,
  lens: P.lenses()[0],
  maxRounds: 4,
});
const digest = "## Who is here\n- A: backs own work · work v1\n- B: backs own work · work v2";
const inbox = "Your stance: backs own work. Your work: v1.\nOpen challenge #2 from B: misses the empty-cache case";
const cases = {};
for (const mode of ["answer", "code"]) {
  cases[`opening.${mode}`] = () => P.opening(ctx(mode));
  cases[`turn.${mode}`] = () => P.turn(ctx(mode), { round: 2, digest, inbox });
  cases[`red-team.${mode}`] = () => P.redTeam(ctx(mode), { round: 3, digest, target: "B" });
  cases[`verdict.${mode}`] = () =>
    P.verdict({
      task: ctx(mode).task,
      check: ctx(mode).check,
      mode,
      outcome: "Everyone agreed on B's work after 2 rounds.",
      standings: "- B: .argue/room/work/B.md · v2",
    });
}
cases["follow-up"] = () => P.followUp({ record: "# argue record\n…", question: "Why not MongoDB?" });

for (const [name, build] of Object.entries(cases)) {
  test(`instruction snapshot: ${name}`, () => {
    const text = build();
    assert.doesNotMatch(text, /\{[a-z_]+\}/, "every blank is filled");
    assert.doesNotMatch(text, /^\[(code|answer)\]/m, "mode markers are stripped");
    mkdirSync(SNAP, { recursive: true });
    const file = join(SNAP, `${name}.txt`);
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) writeFileSync(file, `${text}\n`);
    assert.equal(text, readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd(), "instruction changed; if intended, run UPDATE_SNAPSHOTS=1 npm test");
  });
}

test("answer-mode instructions never mention patches or checks; code-mode ones do", () => {
  for (const [name, build] of Object.entries(cases)) {
    const text = build();
    if (name.endsWith(".answer")) assert.doesNotMatch(text, /patch|git apply|the check|npm test/i, name);
    if (name.endsWith(".code")) assert.match(text, /npm test/, name);
  }
});

test("every agent turn carries the room charter and the post format", () => {
  for (const name of ["opening.code", "turn.answer", "red-team.code"]) {
    const text = cases[name]();
    assert.match(text, /You are agent A in a room of 3 AI agents \(A, B, C\)/, name);
    assert.match(text, /^STANCE: <letter>/m, name);
    assert.match(text, /Be right, not agreeable/, name);
  }
});

test("the final answer never talks about the process", () => {
  assert.match(cases["verdict.answer"](), /Never mention agents, letters/);
  assert.match(cases["verdict.code"](), /Never merge different patches/);
});

test("a line whose blank is empty is left out", () => {
  assert.equal(P.fill("keep\nrun `{check}`\n[code] code only\n[answer] answer only", { check: "" }, "code"), "keep\ncode only");
  assert.equal(P.fill('{"pick": "x"} {unknown}', {}, "answer"), '{"pick": "x"} {unknown}', "JSON and unknown braces are untouched");
});

test("there is a lens for every agent the room can hold", () => {
  assert.ok(P.lenses().length >= 4);
});
