// A fake coding agent for tests, driven through argue's custom-agent support:
//   command = node fake-agent.mjs {prompt_file} <good|bad|boom|slow>
import { readFileSync, writeFileSync } from "node:fs";

const [file, name] = process.argv.slice(2);
if (name === "boom") {
  console.error("oops");
  process.exit(3);
}
if (name === "slow") await new Promise((r) => setTimeout(r, 60_000));

const p = readFileSync(file, "utf8");
if (p.includes("impartial judge")) {
  console.log('{"winner":"B","ranking":["B","A"],"reason":"B passes the check.","risks":"none"}');
} else if (p.includes("You are now a reviewer") || p.includes("Rival answers")) {
  for (const x of ["A", "B", "C"]) console.log(`## ${x}\nVERDICT: OK`);
} else if (process.env.ARGUE_WRITE === "1") {
  writeFileSync("math.js", name === "good" ? "export const add = (a, b) => a + b;\n" : "export const add = (a, b) => a - b;\n");
  console.log(`I implemented add (${name}).`);
} else {
  console.log(`Answer from ${name}: use a hash map.`);
}
