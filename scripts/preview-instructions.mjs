#!/usr/bin/env node
// Print the filled-in instruction for a step, so you can see exactly what models receive.
//   npm run instructions:preview -- solve [--code]
import * as I from "../src/instructions/index.js";

const [stepName = "solve", ...flags] = process.argv.slice(2);
const isCode = flags.includes("--code");
const task = isCode ? "Fix the LRU cache in lru.js so the tests pass." : "Which database is best for a social media app?";
const check = isCode ? "npm test" : null;
const others = [
  {
    id: "B",
    summary: "Postgres with read replicas…",
    objections: 1,
    revisedAfter: true,
    patchFile: ".argue/rivals/B.patch",
    stats: { files: 1, add: 10, del: 2 },
    check: { pass: true },
  },
];
const steps = {
  solve: () => I.solve({ task, check, approach: I.APPROACHES[1], isCode }),
  critique: () => I.critique({ task, check, self: "A", others, isCode }),
  improve: () =>
    I.improve({
      task,
      check,
      previous: "My earlier answer…",
      feedback: "--- Reviewer B ---\nVERDICT: ISSUES\n- …",
      checkResult: { pass: false, output: "1 failing" },
      isCode,
    }),
  "final-answer": () => I.finalAnswer({ task, check, candidates: others, isCode }),
  "follow-up": () => I.followUp({ logbook: "TASK: …\n--- solve · model A ---\n…", question: "Why not MongoDB?" }),
};
if (!steps[stepName]) {
  console.error(`unknown step "${stepName}". Steps: ${Object.keys(steps).join(", ")}  (add --code for the coding version)`);
  process.exit(1);
}
console.log(steps[stepName]());
