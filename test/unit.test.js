import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLineup, parseAgents } from "../src/agents.js";
import { parseVerdict } from "../src/argue.js";

test("parseAgents handles kind, model, effort, and duplicates", () => {
  const agents = parseAgents("claude:opus@high, codex, claude");
  assert.deepEqual(
    agents.map((a) => [a.kind, a.model, a.effort, a.id]),
    [
      ["claude", "opus", "high", "claude1"],
      ["codex", undefined, undefined, "codex1"],
      ["claude", undefined, undefined, "claude2"],
    ],
  );
});

test("parseAgents rejects unknown agents", () => {
  assert.throws(() => parseAgents("gpt-nope"), /unknown agent/);
});

test("defaultLineup uses what is installed", () => {
  assert.equal(defaultLineup(["claude", "codex"]), "claude,codex");
  assert.equal(defaultLineup(["claude"]), "claude:opus,claude:sonnet");
  assert.equal(defaultLineup(["codex"]), "codex,codex");
  assert.equal(defaultLineup([]), "");
});

test("parseVerdict reads JSON and falls back safely", () => {
  const pool = [{ id: "A" }, { id: "B" }];
  assert.equal(parseVerdict('Sure:\n{"winner":"B","reason":"r","risks":"none"}', pool).winner, "B");
  assert.equal(parseVerdict("no json here", pool).winner, "A");
  assert.equal(parseVerdict('{"winner":"Z"}', pool).winner, "A");
});
