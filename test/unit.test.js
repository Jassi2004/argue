import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIVERS, customDriver, defaultJudge, defaultLineup, parseAgents, registry } from "../src/agents.js";
import { modifiedTests, parseVerdict, stripVerdict } from "../src/argue.js";
import { jsonLines, lastJsonObject } from "../src/exec.js";
import { diffFiles, diffStats } from "../src/git.js";
import { hasIssues, splitCritique, verdictOf } from "../src/prompts.js";
import { stripTomlTable } from "../src/install.js";

test("parseAgents: kind, model, effort, slashes and colons in models", () => {
  const a = parseAgents("claude:opus@high, codex, pi:openrouter/deepseek/deepseek-r1, opencode:anthropic/claude-sonnet-4");
  assert.deepEqual(
    a.map((x) => [x.kind, x.model, x.effort]),
    [
      ["claude", "opus", "high"],
      ["codex", undefined, undefined],
      ["pi", "openrouter/deepseek/deepseek-r1", undefined],
      ["opencode", "anthropic/claude-sonnet-4", undefined],
    ],
  );
  assert.throws(() => parseAgents("nope"), /unknown agent/);
});

test("defaultLineup prefers vendor diversity, falls back to model diversity", () => {
  assert.equal(defaultLineup(["claude", "codex", "gemini", "pi"]), "claude,codex,gemini");
  assert.equal(defaultLineup(["claude", "codex", "pi", "opencode"]), "claude,codex");
  assert.equal(defaultLineup(["claude", "pi"]), "claude,pi");
  assert.equal(defaultLineup(["codex", "pi"]), "codex,pi");
  assert.equal(defaultLineup(["claude"]), "claude:opus,claude:sonnet");
  assert.equal(defaultLineup(["pi"]), "pi,pi");
  assert.equal(defaultLineup([]), "");
});

test("defaultJudge picks an installed non-competitor when possible", () => {
  assert.equal(defaultJudge(["claude", "codex", "gemini"], parseAgents("claude,codex")), "gemini");
  assert.equal(defaultJudge(["claude", "codex", "pi"], parseAgents("claude,codex")), "claude");
  assert.equal(defaultJudge(["claude", "codex", "pi"], parseAgents("pi,codex")), "claude");
  assert.equal(defaultJudge(["pi"], parseAgents("pi:x/y,pi:z")), "pi:x/y");
});

test("registry merges custom agents", () => {
  const r = registry({ custom: { aider: { command: "aider --message-file {prompt_file}" } } });
  assert.ok(r.aider.custom);
  assert.ok(r.claude);
  assert.equal(parseAgents("aider,claude", r)[0].kind, "aider");
});

test("custom driver runs a shell template and returns stdout", async () => {
  const d = customDriver("echo", { command: "cat {prompt_file}" });
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "argue-t-"));
  const f = join(dir, "p.md");
  writeFileSync(f, "hello");
  const res = await d.ask({ promptFile: f, cwd: dir, write: false, timeoutMs: 5000 });
  assert.equal(res.ok, true);
  assert.equal(res.text, "hello");
});

test("every built-in driver has bin, title and install hint", () => {
  for (const [k, d] of Object.entries(DRIVERS)) {
    assert.ok(d.bin && d.title && d.install && typeof d.ask === "function", k);
  }
});

test("parseVerdict: reads JSON, normalises ids, falls back to fewest objections", () => {
  const pool = [
    { id: "A", objections: 2 },
    { id: "B", objections: 0 },
  ];
  assert.equal(parseVerdict('blah {"winner":"A","ranking":["A","B"],"reason":"r","risks":"none"}', pool).winner, "A");
  assert.equal(parseVerdict('{"winner":"Candidate B"}', pool).winner, "B");
  assert.equal(parseVerdict("no json", pool).winner, "B");
  assert.equal(parseVerdict('{"winner":"Z"}', pool).winner, "B");
});

test("stripVerdict removes the JSON line from ask-mode judge output", () => {
  assert.equal(stripVerdict('{"winner":"A","reason":"x"}\n# Answer\nbody'), "# Answer\nbody");
});

test("splitCritique splits by rival heading and hasIssues reads verdicts", () => {
  const t = "## B\nVERDICT: OK\nlooks fine\n\n## C\nVERDICT: ISSUES\n- off by one in x.js:3";
  const parts = splitCritique(t, ["B", "C"]);
  assert.match(parts.B, /OK/);
  assert.match(parts.C, /off by one/);
  assert.equal(hasIssues(parts.B), false);
  assert.equal(hasIssues(parts.C), true);
  const single = splitCritique("VERDICT: ISSUES\n- bad", ["B"]);
  assert.equal(hasIssues(single.B), true);
  assert.equal(verdictOf("## Solution B\n**VERDICT:** OK"), "ok");
  assert.equal(verdictOf("garbled <function_calls>"), null);
  assert.equal(verdictOf("VERDICT: OK | ISSUES\nVERDICT: ISSUES"), "issues");
});

test("diffStats / diffFiles", () => {
  const d = "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@\n-a\n+b\n+c\ndiff --git a/y b/y\n";
  assert.deepEqual(diffStats(d), { files: 2, add: 2, del: 1 });
  assert.deepEqual(diffFiles(d), ["x.js", "y"]);
});

test("lastJsonObject / jsonLines tolerate noise", () => {
  assert.deepEqual(lastJsonObject('banner\n{"a":1}\nmore {"b":{"c":2}} end'), { b: { c: 2 } });
  assert.equal(lastJsonObject("nothing"), null);
  assert.deepEqual(jsonLines('x\n{"a":1}\n{bad\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
});

test("stripTomlTable removes a table and its sub-tables only", () => {
  const toml = 'model = "x"\n\n[mcp_servers.argue]\ncommand = "argue"\n\n[mcp_servers.argue.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "o"\n';
  const out = stripTomlTable(toml, "mcp_servers.argue");
  assert.doesNotMatch(out, /argue/);
  assert.match(out, /mcp_servers\.other/);
  assert.match(out, /model = "x"/);
});

test("modifiedTests flags edits to existing tests, not new test files", () => {
  const d =
    "diff --git a/test.mjs b/test.mjs\n--- a/test.mjs\n+++ b/test.mjs\n" +
    "diff --git a/src/a.spec.ts b/src/a.spec.ts\nnew file mode 100644\n" +
    "diff --git a/lib/x.js b/lib/x.js\n" +
    "diff --git a/tests/util.py b/tests/util.py\ndeleted file mode 100644\n";
  assert.deepEqual(modifiedTests(d), ["test.mjs", "tests/util.py"]);
});

test("windows: .cmd shims receive arguments with spaces, quotes and metacharacters intact", { skip: process.platform !== "win32" }, async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { run } = await import("../src/exec.js");
  const dir = mkdtempSync(join(tmpdir(), "argue-win-"));
  writeFileSync(join(dir, "echo.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(join(dir, "fakecli.cmd"), `@node "${join(dir, "echo.js")}" %*\r\n`);
  const args = ["plain", "with space", 'quo"te', "a&b|c<d>e^f%PATH%!g!", "trailing\\", "(paren)"];
  const res = await run("fakecli", args, { env: { PATH: `${dir};${process.env.PATH}` } });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), args);
});
