// Test agents that write to absolute paths:
//   literal  writes a correct math.js into the directory the prompt calls "Repository:" (default: its own copy)
//   escapee  also writes a file into $TARGET, outside its copy (an agent ignoring its sandbox)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [file, mode] = process.argv.slice(2);
const repo = readFileSync(file, "utf8").match(/Repository: (\S+)/)?.[1] ?? ".";
writeFileSync(join(repo, "math.js"), "export const add = (a, b) => a + b;\n");
if (mode === "escapee") writeFileSync(process.env.TARGET, "x");
console.log("done");
