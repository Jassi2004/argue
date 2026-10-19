import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAgents, registry } from "../src/agents.js";
import { argue } from "../src/argue.js";
import { callTool } from "../src/mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures", "fake-agent.mjs");
const fake = (name) => ({ command: `node ${JSON.stringify(FAKE)} {prompt_file} ${name}` });
const BIN = join(here, "..", "bin", "argue.js");

function makeRepo({ git = true, commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "argue-it-"));
  writeFileSync(join(dir, "math.js"), "export const add = (a, b) => 0;\n");
  writeFileSync(join(dir, "test.mjs"), 'import { add } from "./math.js";\nif (add(2, 3) !== 5) { console.error("bad"); process.exit(1); }\n');
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    if (commit) {
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir });
    }
  }
  return dir;
}

const config = {
  custom: {
    good: fake("good"),
    bad: fake("bad"),
  },
};
const drivers = registry(config);
const installed = { good: "custom", bad: "custom" };

test("code mode: check picks the passing agent, user files untouched until apply", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "notes.txt"), "untracked file\n"); // untracked files must reach agents
  const events = [];
  const result = await argue({
    task: "make add() add",
    agents: parseAgents("bad,good", drivers),
    judge: parseAgents("good", drivers)[0],
    drivers,
    installed,
    cwd: dir,
    check: "node test.mjs",
    rounds: 1,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.status, "done");
  assert.equal(result.winner.id, "B"); // "good"
  assert.deepEqual(result.files, ["math.js"]);
  assert.equal(result.agents.find((a) => a.id === "A").check, false);
  assert.equal(result.agents.find((a) => a.id === "B").check, true);
  assert.match(readFileSync(join(dir, "math.js"), "utf8"), /=> 0/, "user file must be untouched");
  assert.ok(existsSync(result.report));
  assert.ok(events.some((e) => e.type === "done"));
  // git status of the user's repo stays clean apart from the untracked file they already had
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert.equal(status.trim(), "?? notes.txt");
  const wts = execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
  assert.equal(wts.length, 1, "worktrees cleaned up");

  // apply via CLI
  execFileSync(process.execPath, [BIN, "apply", result.runId], { cwd: dir });
  execFileSync("node", ["test.mjs"], { cwd: dir });
});

test("works in a plain folder (no git) and a repo without commits", async () => {
  for (const opts of [{ git: false }, { git: true, commit: false }]) {
    const dir = makeRepo(opts);
    const result = await argue({
      task: "fix add",
      agents: parseAgents("good,bad", drivers),
      judge: parseAgents("good", drivers)[0],
      drivers,
      installed,
      cwd: dir,
      check: "node test.mjs",
      rounds: 1,
      apply: true,
    });
    assert.equal(result.winner.agent, "good", JSON.stringify(opts));
    assert.equal(result.applied, true);
    execFileSync("node", ["test.mjs"], { cwd: dir });
  }
});

test("uncommitted edits to tracked files are what agents start from", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "extra.js"), "export const x = 1;\n");
  execFileSync("git", ["add", "extra.js"], { cwd: dir });
  writeFileSync(join(dir, "extra.js"), "export const x = 2;\n"); // dirty, staged-then-modified
  const result = await argue({
    task: "t",
    agents: parseAgents("good,bad", drivers),
    judge: parseAgents("good", drivers)[0],
    drivers,
    installed,
    cwd: dir,
    check: "node test.mjs",
    rounds: 0,
  });
  // The winning patch only touches math.js; the dirty extra.js was part of the base, so it is not in the diff.
  assert.deepEqual(result.files, ["math.js"]);
});

test("ask mode: no edits, judge answer returned", async () => {
  const dir = makeRepo();
  const result = await argue({
    task: "how should I cache?",
    mode: "ask",
    agents: parseAgents("good,bad", drivers),
    judge: parseAgents("good", drivers)[0],
    drivers,
    installed,
    cwd: dir,
    rounds: 1,
  });
  assert.equal(result.mode, "ask");
  assert.ok(result.answer.length > 0);
  assert.equal(result.patch, null);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim(), "");
});

test("all agents failing gives a clear error", async () => {
  const dir = makeRepo();
  const d = registry({ custom: { boom: fake("boom") } });
  await assert.rejects(
    argue({ task: "t", agents: parseAgents("boom,boom", d), judge: parseAgents("boom", d)[0], drivers: d, installed: { boom: "custom" }, cwd: dir, rounds: 1 }),
    /no agent produced a change[\s\S]*oops/,
  );
});

test("cancellation via AbortSignal stops the run", async () => {
  const dir = makeRepo();
  const d = registry({ custom: { slow: fake("slow") } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 500);
  const t0 = Date.now();
  await assert.rejects(
    argue({
      task: "t",
      agents: parseAgents("slow,slow", d),
      judge: parseAgents("slow", d)[0],
      drivers: d,
      installed: { slow: "custom" },
      cwd: dir,
      rounds: 1,
      signal: ac.signal,
    }),
    /cancelled/,
  );
  assert.ok(Date.now() - t0 < 10_000, "should stop quickly");
});

test("MCP: start in background, wait, apply", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  execFileSync("git", ["add", ".argue.json"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "cfg"], { cwd: dir });
  const start = await callTool("argue_start", { task: "fix add", cwd: dir, agents: "bad,good", judge: "good", check: "node test.mjs", rounds: 1 });
  assert.equal(start.status, "running");
  let s;
  for (let i = 0; i < 20; i++) {
    s = await callTool("argue_wait", { run_id: start.run_id, cwd: dir, seconds: 5 });
    if (s.status !== "running") break;
  }
  assert.equal(s.status, "done", JSON.stringify(s));
  assert.equal(s.winner.agent, "good");
  const applied = await callTool("argue_apply", { run_id: start.run_id, cwd: dir });
  assert.equal(applied.applied, true);
  execFileSync("node", ["test.mjs"], { cwd: dir });
  const runs = await callTool("argue_runs", { cwd: dir });
  assert.equal(runs[0].run_id, start.run_id);
});

test("MCP server speaks JSON-RPC over stdio", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [BIN, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "argue_agents", arguments: {} } });
  for (let i = 0; i < 100 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  assert.equal(lines[0].result.serverInfo.name, "argue");
  assert.ok(lines[1].result.tools.some((t) => t.name === "argue_start"));
  assert.ok(Array.isArray(JSON.parse(lines[2].result.content[0].text)));
});

test("install writes every integration into a fake home and uninstall removes them", async () => {
  const { install } = await import("../src/install.js");
  const { mkdirSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  for (const d of [".codex", ".cursor", ".gemini", ".pi", ".config/opencode"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  writeFileSync(join(home, ".cursor", "mcp.json"), '{"mcpServers":{"other":{"command":"x"}}}');
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  try {
    const res = await install({ home, only: ["skill", "codex", "cursor", "gemini", "opencode", "pi"] });
    assert.ok(
      res.every((r) => r.status === "installed"),
      JSON.stringify(res),
    );
    assert.ok(existsSync(join(home, ".agents", "skills", "argue", "SKILL.md")));
    assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /model = "gpt-5"[\s\S]*\[mcp_servers\.argue\]/);
    const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    assert.ok(cursor.mcpServers.other && cursor.mcpServers.argue);
    assert.ok(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.argue);
    assert.ok(existsSync(join(home, ".gemini", "commands", "argue.toml")));
    assert.ok(JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8")).mcp.argue);
    assert.ok(existsSync(join(home, ".pi", "agent", "prompts", "argue.md")));
    // idempotent
    await install({ home, only: ["codex"] });
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.equal(toml.match(/\[mcp_servers\.argue\]/g).length, 1);
    assert.match(toml, /\[mcp_servers\.argue\.tools\.argue_start\]\napproval_mode = "approve"/);

    await install({ home, only: ["skill", "codex", "cursor", "gemini", "opencode", "pi"], uninstall: true });
    assert.ok(!existsSync(join(home, ".agents", "skills", "argue")));
    assert.doesNotMatch(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /argue/);
    assert.ok(!JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.argue);
    assert.ok(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.other);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("node_modules is shared into worktrees but never part of the patch; subdirectory cwd works", async () => {
  const { mkdirSync } = await import("node:fs");
  const dir = makeRepo();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "export const five = 5;\n");
  writeFileSync(
    join(dir, "test.mjs"),
    'import { add } from "./math.js";\nimport { five } from "./node_modules/dep/index.js";\nif (add(2, 3) !== five) process.exit(1);\n',
  );
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "deps"], { cwd: dir });
  mkdirSync(join(dir, "sub"));
  const result = await argue({
    task: "fix",
    agents: parseAgents("bad,good", drivers),
    judge: parseAgents("good", drivers)[0],
    drivers,
    installed,
    cwd: join(dir, "sub"),
    check: "node test.mjs",
    rounds: 0,
  });
  assert.equal(result.winner.agent, "good");
  assert.deepEqual(result.files, ["math.js"]);
  assert.ok(existsSync(join(dir, ".argue", "runs", result.runId)), "runs stored at repo root");
});

test("CLI: --bg --json, wait, show, runs, cancel", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".argue.json"), JSON.stringify({ custom: { ...config.custom, slow: fake("slow") } }));
  const cli = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
  const started = JSON.parse(cli("fix add", "-a", "bad,good", "-j", "good", "-c", "node test.mjs", "-r", "1", "--bg", "--json"));
  assert.equal(started.status, "running");
  let s;
  for (let i = 0; i < 10; i++) {
    s = JSON.parse(cli("wait", started.run_id, "-t", "10"));
    if (s.status !== "running") break;
  }
  assert.equal(s.status, "done");
  assert.match(cli("show", started.run_id), /Winner: B \(good\)/);
  assert.match(cli("runs"), new RegExp(started.run_id));

  const slow = JSON.parse(cli("x", "-a", "slow,slow", "-j", "slow", "-c", "none", "--bg", "--json"));
  assert.match(cli("cancel", slow.run_id), /cancelled/);
  s = JSON.parse(cli("wait", slow.run_id, "-t", "15"));
  assert.equal(s.status, "failed");
});
