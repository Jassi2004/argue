#!/usr/bin/env node
// Print the filled-in instruction for a step, so you can see exactly what agents receive.
//   npm run instructions:preview -- turn [--code]
import * as P from "../src/room/prompts.js";

const [stepName = "turn", ...flags] = process.argv.slice(2);
const mode = flags.includes("--code") ? "code" : "answer";
const ctx = {
  id: "A",
  letters: ["A", "B"],
  task: mode === "code" ? "Fix the LRU cache in lru.js so the tests pass." : "Which database is best for a social media app?",
  check: mode === "code" ? "npm test" : null,
  mode,
  lens: P.lenses()[0],
  maxRounds: 4,
};
const digest = '## Who is here\n- A: backs own work · work v1\n- B: backs own work · work v2\n\n## Challenges\n#1 A→B [answered] … — B: "…"';
const steps = {
  opening: () => P.opening(ctx),
  turn: () => P.turn(ctx, { round: 2, digest, inbox: "Your stance: backs own work. Your work: v1.\nOpen challenge #2 from B: …" }),
  "red-team": () => P.redTeam(ctx, { round: 3, digest, target: "B" }),
  verdict: () =>
    P.verdict({ task: ctx.task, check: ctx.check, mode, outcome: "Everyone agreed on B's work after 2 rounds.", standings: "- B: .argue/room/work/B.md · v2" }),
  "follow-up": () => P.followUp({ record: "# argue record\n…", question: "Why not MongoDB?" }),
};
if (!steps[stepName]) {
  console.error(`unknown step "${stepName}". Steps: ${Object.keys(steps).join(", ")}  (add --code for the coding version)`);
  process.exit(1);
}
console.log(steps[stepName]());
