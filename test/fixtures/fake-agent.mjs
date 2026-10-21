// A scripted agent that speaks the room protocol, driven through argue's custom-agent support:
//   command = node fake-agent.mjs {prompt_file} <behaviour>
//
// Code mode: "good" work is a correct add(), "bad" work a broken one (math.js). Answer mode: .argue/answer.md.
//   good      correct work; challenges work whose check fails; answers challenges; backs itself
//   bad       broken work; once challenged, backs a passing agent
//   fixer     broken work; fixes it when challenged
//   breaker   correct work, then breaks it on its next turn
//   follower  backs the first other agent with work at once (a yes-man); never challenges
//   critic    challenges every other agent every turn with the same words; never agrees
//   stubborn  backs itself and repeats the same post forever
//   noop      makes no work; backs the first other agent with work
//   boom      exits with an error
//   slow      hangs for a minute
//   late      like good in the opening, then hangs for a minute
//   echo-env  writes ARGUE_DEPTH into depth.txt, then behaves like good
// Verdict: picks $FAKE_JUDGE_PICK, else the first work listed. Follow-up: answers from the record.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [file, name] = process.argv.slice(2);
const prompt = readFileSync(file, "utf8");
const GOOD = "export const add = (a, b) => a + b;\n";
const BAD = "export const add = (a, b) => a - b;\n";

if (name === "boom") {
  console.error("oops");
  process.exit(3);
}
if (name === "slow" || (name === "late" && !/^OPENING$/m.test(prompt))) await new Promise((r) => setTimeout(r, 60_000));

if (prompt.includes("THE USER'S QUESTION")) {
  console.log(prompt.includes("## Final answer") ? "Because the record shows the alternatives lost." : "No record.");
  process.exit(0);
}
if (prompt.includes("HOW THE ROOM ENDED")) {
  const listed = prompt.match(/^- ([A-H]): \.argue\/room\/work/m)?.[1] ?? "A";
  const pick = process.env.FAKE_JUDGE_PICK ?? listed;
  console.log(`{"pick":"${pick}","unresolved":"none"}\nThe vetted answer, based on ${pick}.`);
  process.exit(0);
}

const me = prompt.match(/You are agent ([A-H])/)[1];
const letters = prompt.match(/AI agents \(([A-H, ]+)\)/)[1].split(", ");
const others = letters.filter((x) => x !== me);
const code = prompt.includes("Your work is your change to the project");
const kind = /^OPENING$/m.test(prompt) ? "opening" : /^RED TEAM/m.test(prompt) ? "red-team" : "turn";
// The roster in the room record: "- B: backs own work · work v1, check PASS"
const roster = Object.fromEntries(
  [...prompt.matchAll(/^- ([A-H]): (.*)$/gm)].map(([, id, rest]) => [
    id,
    { work: /work v\d/.test(rest), fail: /check FAIL/.test(rest), pass: /check PASS/.test(rest) },
  ]),
);
const openOnMe = [...prompt.matchAll(/^Open challenge #(\d+) from ([A-H]): (.*)$/gm)].map((m) => Number(m[1]));
const target = prompt.match(/your job is to try to break it/) ? prompt.match(/Everyone now backs ([A-H])'s work/)[1] : null;

const writeWork = (good) => {
  if (code) writeFileSync("math.js", good ? GOOD : BAD);
  else {
    mkdirSync(".argue", { recursive: true });
    writeFileSync(".argue/answer.md", good ? `Use a hash map (${name}).\n` : `Use a linked list (${name}).\n`);
  }
};
const withWork = others.filter((x) => roster[x]?.work);
const passing = others.filter((x) => roster[x]?.pass);
const lines = [];
const say = (...l) => lines.push(...l);

if (kind === "opening") {
  if (name === "echo-env") writeFileSync("depth.txt", String(process.env.ARGUE_DEPTH));
  if (name !== "noop") writeWork(["good", "late", "breaker", "echo-env", "follower", "critic", "stubborn"].includes(name));
  say(`STANCE: ${name === "noop" ? "open" : me}`, `TOOLS: shell (${name})`, `GIST: ${name} opening`, `I worked on it (${name}).`);
} else if (kind === "red-team") {
  const broken = roster[target]?.fail;
  if (broken) say(`CHALLENGE ${target}: the check fails`, `STANCE: ${me}`, "The check output shows a failure.");
  else say(`STANCE: ${target}`, `I tried the check and edge cases on ${target}; nothing broke.`);
} else {
  // A tidy agent cleans up its scratch files; this must not break argue's own files.
  try {
    execFileSync("git", ["clean", "-fdq", "-e", ".argue"], { stdio: "ignore" });
  } catch {}
  switch (name) {
    case "good":
    case "echo-env":
      for (const x of others) if (roster[x]?.fail) say(`CHALLENGE ${x}: add() is wrong, the check fails`);
      for (const n of openOnMe) say(`ANSWER #${n}: verified again, the check passes`);
      say(`STANCE: ${me}`, "Evidence: node test.mjs passes on my work.");
      break;
    case "bad":
      say(openOnMe.length && passing.length ? `STANCE: ${passing[0]}` : `STANCE: ${me}`, "Reconsidered.");
      break;
    case "fixer":
      if (openOnMe.length) {
        writeWork(true);
        for (const n of openOnMe) say(`ANSWER #${n}: fixed`);
      }
      say(`STANCE: ${me}`, "Fixed after review.");
      break;
    case "breaker":
      writeWork(false);
      say(`STANCE: ${me}`, "Refactored.");
      break;
    case "follower":
    case "noop":
      say(`STANCE: ${withWork[0] ?? "open"}`, "Looks right to me.");
      break;
    case "critic":
      for (const x of others) say(`CHALLENGE ${x}: this approach is fundamentally wrong for the task`);
      say(`STANCE: ${me}`, "Same concern as before.");
      break;
    case "stubborn":
      say(`STANCE: ${me}`, "Mine is best.");
      break;
  }
}
console.log(lines.join("\n"));
