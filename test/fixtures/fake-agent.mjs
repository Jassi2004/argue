// A fake coding agent for tests, driven through argue's custom-agent support:
//   command = node fake-agent.mjs {prompt_file} <behaviour>
//
// Behaviours (when asked to write code):
//   good       writes a correct add()
//   bad        writes a broken add()
//   fixer      broken first, fixed when asked to revise
//   breaker    correct first, then breaks it when asked to revise
//   noop       changes nothing
//   boom       exits with an error
//   slow       hangs for a minute
//   echo-env   writes ARGUE_DEPTH into depth.txt, then behaves like good
// As reviewer: "critic" objects to everyone, everyone else approves; reviewers also run `git clean`.
// As the final step: picks the work named in $FAKE_JUDGE_PICK (default B) and writes an answer.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [file, name] = process.argv.slice(2);
const prompt = readFileSync(file, "utf8");
const good = "export const add = (a, b) => a + b;\n";
const bad = "export const add = (a, b) => a - b;\n";

if (name === "boom") {
  console.error("oops");
  process.exit(3);
}
if (name === "slow") await new Promise((r) => setTimeout(r, 60_000));

if (prompt.includes("The user now has a follow-up question")) {
  console.log(prompt.includes("FINAL ANSWER GIVEN TO THE USER") ? "Because the record shows the alternatives lost." : "No record.");
} else if (prompt.includes("produce the single best final answer")) {
  const pick = process.env.FAKE_JUDGE_PICK ?? "B";
  console.log(`{"pick":"${pick}","unresolved":"none"}\nThe vetted answer, based mostly on ${pick}.`);
} else if (prompt.includes("You are now a reviewer")) {
  // A tidy reviewer cleans up its scratch files; this must not destroy argue's own files.
  try {
    execFileSync("git", ["clean", "-fdq"], { stdio: "ignore" });
  } catch {}
  const ids = [...prompt.matchAll(/^### ([A-Z])$/gm)].map((m) => m[1]);
  for (const id of ids) console.log(`## ${id}\n${name === "critic" ? "VERDICT: ISSUES\n- add() is wrong: evidence: node test.mjs failed" : "VERDICT: OK"}`);
} else if (process.env.ARGUE_WRITE === "1") {
  const revising = prompt.includes("Reviewers said:");
  if (name === "echo-env") writeFileSync("depth.txt", String(process.env.ARGUE_DEPTH));
  const code = { good, bad, critic: good, "echo-env": good, fixer: revising ? good : bad, breaker: revising ? bad : good }[name];
  if (code) writeFileSync("math.js", code);
  console.log(`I ${revising ? "revised" : "implemented"} add (${name}).`);
} else {
  console.log(`Answer from ${name}: use a hash map.`);
}
