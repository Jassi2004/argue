import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as I from "../../src/instructions/index.js";

// Snapshot tests: when you edit a file in instructions/, run `UPDATE_SNAPSHOTS=1 npm test`
// and the diff of test/instructions/snapshots/ in your PR shows exactly what models will now receive.
const SNAP = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

const others = [
  {
    id: "B",
    summary: "B's answer",
    objections: 1,
    revisedAfter: true,
    patchFile: ".argue/rivals/B.patch",
    stats: { files: 1, add: 3, del: 1 },
    check: { pass: true },
  },
];
const cases = {
  "solve.answer": () => I.solve({ task: "Which DB for a social app?", approach: I.APPROACHES[1], isCode: false }),
  "solve.code": () => I.solve({ task: "Fix lru.js", check: "npm test", approach: "", isCode: true }),
  "critique.answer": () => I.critique({ task: "Which DB?", self: "A", others, isCode: false }),
  "critique.code": () => I.critique({ task: "Fix lru.js", check: "npm test", self: "A", others, isCode: true }),
  "improve.answer": () => I.improve({ task: "Which DB?", previous: "Postgres", feedback: "VERDICT: ISSUES\n- x", isCode: false }),
  "improve.code": () =>
    I.improve({
      task: "Fix lru.js",
      check: "npm test",
      previous: "fixed get()",
      feedback: "- y",
      checkResult: { pass: false, output: "1 failing" },
      isCode: true,
    }),
  "final-answer.answer": () => I.finalAnswer({ task: "Which DB?", candidates: others, isCode: false }),
  "final-answer.code": () => I.finalAnswer({ task: "Fix lru.js", check: "npm test", candidates: others, isCode: true }),
  "follow-up": () => I.followUp({ logbook: "TASK: Which DB?", question: "Why not MongoDB?" }),
};

for (const [name, build] of Object.entries(cases)) {
  test(`instruction snapshot: ${name}`, () => {
    const text = build();
    assert.doesNotMatch(text, /\{\w+\}/, "every blank is filled");
    const file = join(SNAP, `${name}.txt`);
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) writeFileSync(file, `${text}\n`);
    assert.equal(text, readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd(), `instruction changed; if intended, run UPDATE_SNAPSHOTS=1 npm test`);
  });
}

test("answer-mode instructions never mention coding; code-mode ones do", () => {
  for (const [name, build] of Object.entries(cases)) {
    const text = build();
    if (name.endsWith(".answer")) assert.doesNotMatch(text, /coding task|git apply|patch/i, name);
    if (name.endsWith(".code") && !name.startsWith("final")) assert.match(text, /coding task/i, name);
  }
});

test("the final answer step tells the model not to talk about the process", () => {
  assert.match(I.finalAnswer({ task: "x", candidates: others, isCode: false }), /Do not mention models, candidates, letters/);
});
