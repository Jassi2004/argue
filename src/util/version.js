import { readFileSync } from "node:fs";
import { fromRoot } from "./paths.js";

let v = "0.0.0";
try {
  v = JSON.parse(readFileSync(fromRoot("package.json"), "utf8")).version;
} catch {}
export const VERSION = v;
