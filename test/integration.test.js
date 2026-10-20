import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const BEHAVIOURS = ["good", "bad", "fixer", "breaker", "noop", "boom", "slow", "critic", "echo-env"];
const config = { custom: Object.fromEntries(BEHAVIOURS.map((b) => [b, fake(b)])) };
const drivers = registry(config);
const installed = Object.fromEntries(BEHAVIOURS.map((b) => [b, "custom"]));
const agentsOf = (list) => parseAgents(list, drivers);
const judgeOf = (name = "good") => agentsOf(name)[0];
/** Run argue on a repo with fake agents. */
const play = (dir, list, opts = {}) =>
  argue({
    task: "make add() add",
    agents: agentsOf(list),
    judge: judgeOf(opts.judgeName),
    drivers,
    installed,
    cwd: dir,
    check: "node test.mjs",
    rounds: 1,
    ...opts,
  });

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

  const slow = JSON.parse(cli("slow task here", "-a", "slow,slow", "-j", "slow", "-c", "none", "--bg", "--json"));
  assert.match(cli("cancel", slow.run_id), /cancelled/);
  s = JSON.parse(cli("wait", slow.run_id, "-t", "15"));
  assert.equal(s.status, "failed");
});

test("a revision that breaks a passing solution is rolled back", async () => {
  const dir = makeRepo();
  // critic objects to everyone, so everyone revises; breaker breaks its working code when revising.
  const r = await play(dir, "breaker,critic", { rounds: 1 });
  const breaker = r.agents.find((a) => a.agent === "breaker");
  assert.equal(breaker.check, true, "breaker keeps its previously passing version");
  const patch = readFileSync(join(r.runDir, "A.patch"), "utf8");
  assert.match(patch, /a \+ b/);
});

test("a revision that fixes a failing solution is kept", async () => {
  const dir = makeRepo();
  const r = await play(dir, "fixer,critic", { rounds: 1, judgeName: "good" });
  assert.equal(r.agents.find((a) => a.agent === "fixer").check, true);
});

test("reviewers running git clean do not break the run (prompt and patch files survive)", async () => {
  const dir = makeRepo();
  const r = await play(dir, "good,critic,bad", { rounds: 2 });
  assert.equal(r.status, "done");
  const transcript = JSON.parse(readFileSync(join(r.runDir, "transcript.json"), "utf8"));
  assert.ok(
    transcript.filter((t) => t.phase.startsWith("critique")).every((t) => t.ok),
    "every critique call succeeded",
  );
});

test("an agent that changes nothing is dropped; the other wins without a judge call", async () => {
  const dir = makeRepo();
  const r = await play(dir, "noop,good", { judgeName: "boom" });
  assert.equal(r.winner.agent, "good");
  assert.equal(r.agents.find((a) => a.agent === "noop").ok, false);
});

test("judge failure falls back to evidence, it does not crash the run", async () => {
  const dir = makeRepo();
  const r = await play(dir, "good,critic", { judgeName: "boom", rounds: 0 });
  assert.equal(r.status, "done");
  assert.match(r.reason, /Judge failed/);
});

test("agents get ARGUE_DEPTH so they cannot start nested runs", async () => {
  const dir = makeRepo();
  const r = await play(dir, "echo-env,bad", { rounds: 0 });
  const patch = readFileSync(join(r.runDir, "A.patch"), "utf8");
  assert.match(patch, /\+1/);
  const nested = await import("node:child_process").then(({ spawnSync }) =>
    spawnSync(process.execPath, [BIN, "fix it", "-a", "good,bad"], { cwd: dir, encoding: "utf8", env: { ...process.env, ARGUE_DEPTH: "1" } }),
  );
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /cannot start another one/);
});

test("paths with spaces and unicode, renames and deletions, and apply from a subdirectory", async () => {
  const { mkdirSync } = await import("node:fs");
  const dir = makeRepo();
  writeFileSync(join(dir, "my file é.txt"), "hello\n");
  writeFileSync(join(dir, "old.txt"), "bye\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "more"], { cwd: dir });
  const d = registry({
    custom: {
      mover: {
        command: `node -e "const f=require('fs');f.writeFileSync('my file é.txt','changed\\n');f.renameSync('old.txt','new.txt');f.writeFileSync('math.js','export const add=(a,b)=>a+b;\\n')"`,
      },
    },
  });
  const r = await argue({
    task: "t",
    agents: parseAgents("mover,mover", d),
    judge: parseAgents("mover", d)[0],
    drivers: d,
    installed: { mover: "custom" },
    cwd: dir,
    check: "node test.mjs",
    rounds: 0,
    judgeName: "x",
  }).catch((e) => e);
  // judge "mover" prints nothing parsable -> evidence fallback; run must still be done
  assert.equal(r.status, "done", String(r.message ?? ""));
  assert.deepEqual([...r.files].sort(), ["math.js", "my file é.txt", "new.txt", "old.txt"].sort());
  mkdirSync(join(dir, "deep", "er"), { recursive: true });
  execFileSync(process.execPath, [BIN, "apply", r.runId], { cwd: join(dir, "deep", "er") });
  assert.equal(readFileSync(join(dir, "my file é.txt"), "utf8"), "changed\n");
  assert.ok(existsSync(join(dir, "new.txt")) && !existsSync(join(dir, "old.txt")));
});

test("apply refuses cleanly when the user changed the same lines meanwhile", async () => {
  const dir = makeRepo({ git: false });
  const r = await play(dir, "good,bad", { rounds: 0 });
  writeFileSync(join(dir, "math.js"), "export const add = (a, b) => 42;\n");
  const res = await import("node:child_process").then(({ spawnSync }) => spawnSync(process.execPath, [BIN, "apply", r.runId], { cwd: dir, encoding: "utf8" }));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /does not apply/);
  assert.equal(readFileSync(join(dir, "math.js"), "utf8"), "export const add = (a, b) => 42;\n", "user's file untouched");
});

test("apply --agent picks another agent's patch and validates the letter", async () => {
  const dir = makeRepo();
  const r = await play(dir, "good,bad", { rounds: 0 });
  const cli = (...a) => import("node:child_process").then(({ spawnSync }) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf8" }));
  const bad = await cli("apply", r.runId, "--agent", "Z");
  assert.match(bad.stderr, /no agent Z/);
  const ok = await cli("apply", r.runId, "--agent", "b");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(join(dir, "math.js"), "utf8"), /a - b/);
});

test("tasks that start with a command word are still tasks", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, [BIN, "apply the fix to add", "-a", "good,bad", "-j", "good", "-c", "node test.mjs", "-r", "0", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).winner.agent, "good");
  const res2 = spawnSync(process.execPath, [BIN, "show", "the", "bug"], { cwd: dir, encoding: "utf8" });
  assert.doesNotMatch(res2.stderr, /no run matching/);
});

test("invalid config and bad flags give clear errors", async () => {
  const dir = makeRepo();
  const { spawnSync } = await import("node:child_process");
  const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf8" });
  writeFileSync(join(dir, ".argue.json"), '{"agentz":"claude"}');
  assert.match(cli("fix the add function").stderr, /unknown setting\(s\) agentz/);
  writeFileSync(join(dir, ".argue.json"), "{not json");
  assert.match(cli("fix the add function").stderr, /invalid JSON/);
  writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  assert.match(cli("fix the add function", "-a", "good,bad", "-r", "nope").stderr, /--rounds must be a number/);
  assert.match(cli("fix the add function", "-a", "good").stderr, /at least two/);
  assert.match(cli("fix the add function", "-a", "good,nope").stderr, /unknown agent "nope"/);
  assert.match(cli("fix the add function", "--mode", "chat", "-a", "good,bad").stderr, /--mode must be/);
  assert.match(cli("fix the add function", "--frobnicate").stderr, /Unknown option/);
  assert.match(cli("apply").stderr, /no argue runs/);
});

test("--bg passes the exact task text, even when it looks like flags", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  const { spawnSync } = await import("node:child_process");
  const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf8" });
  const task = 'fix add -- --apply --agents boom "quoted" $HOME `x`';
  const started = JSON.parse(cli("-a", "good,bad", "-j", "good", "-c", "node test.mjs", "-r", "0", "--bg", "--json", "--", task).stdout);
  const s = JSON.parse(cli("wait", started.run_id, "--seconds", "30").stdout);
  assert.equal(s.status, "done");
  const meta = JSON.parse(readFileSync(join(dir, ".argue", "runs", started.run_id, "meta.json"), "utf8"));
  assert.equal(meta.task, task);
  assert.equal(s.applied, false, "--apply inside the task text must not apply");
});

test("--bg reports an immediate failure instead of hanging", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  const { spawnSync } = await import("node:child_process");
  const t0 = Date.now();
  // Settings are validated before the background process starts…
  const res = spawnSync(process.execPath, [BIN, "fix the add function", "-a", "good,bad", "--budget=-5", "--bg"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--budget must be/);
  // …and a background process that dies during setup is reported right away.
  const { startDetached, waitForStart } = await import("../src/background.js");
  const started = startDetached({ cwd: dir, args: ["-f", join(dir, "missing-task.md")] });
  await assert.rejects(waitForStart(dir, started), /task file not found/);
  assert.ok(Date.now() - t0 < 15_000);
});

test("two runs at once in the same repo do not interfere", async () => {
  const dir = makeRepo();
  const [a, b] = await Promise.all([play(dir, "good,bad", { rounds: 1 }), play(dir, "bad,good", { rounds: 1 })]);
  assert.equal(a.winner.agent, "good");
  assert.equal(b.winner.agent, "good");
  assert.notEqual(a.runId, b.runId);
  const wts = execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
  assert.equal(wts.length, 1);
});

test("a run killed with SIGKILL is cleaned up by cancel and by the next run", { skip: process.platform === "win32" }, async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  const { spawnSync } = await import("node:child_process");
  const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf8" });
  const started = JSON.parse(cli("fix the add function", "-a", "slow,slow", "-j", "good", "-c", "none", "--bg", "--json").stdout);
  const runDir = join(dir, ".argue", "runs", started.run_id);
  for (let i = 0; i < 50 && !(existsSync(join(runDir, "pids")) && readFileSync(join(runDir, "pids"), "utf8").trim().split("\n").length >= 2); i++)
    await new Promise((r) => setTimeout(r, 100));
  const agentPids = readFileSync(join(runDir, "pids"), "utf8").trim().split("\n").map(Number);
  process.kill(JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")).pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  assert.match(cli("runs").stdout, /interrupted/);
  // The next run reaps the dead one: its agents are killed and its worktrees removed.
  const next = cli("fix the add function", "-a", "good,bad", "-j", "good", "-c", "node test.mjs", "-r", "0", "--json");
  assert.equal(next.status, 0, next.stderr);
  await new Promise((r) => setTimeout(r, 300));
  const alive = agentPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(alive, [], "orphaned agents were killed");
  const wts = execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
  assert.equal(wts.length, 1);
  assert.equal(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).status, "interrupted");
});

test("absolute project paths in the brief point agents at their own copy; changes to the project are flagged", async () => {
  const dir = makeRepo();
  const PATHS = join(here, "fixtures", "path-agent.mjs");
  const d = registry({
    custom: {
      literal: { command: `node ${JSON.stringify(PATHS)} {prompt_file} literal` },
      escapee: { command: `node ${JSON.stringify(PATHS)} {prompt_file} escapee` },
    },
  });
  const opts = {
    judge: parseAgents("literal", d)[0],
    drivers: d,
    installed: { literal: "custom", escapee: "custom" },
    cwd: dir,
    check: "node test.mjs",
    rounds: 0,
  };
  const r = await argue({ ...opts, task: `Fix add.\nRepository: ${dir}`, agents: parseAgents("literal,literal", d) });
  assert.equal(r.status, "done");
  assert.match(readFileSync(join(dir, "math.js"), "utf8"), /=> 0/, "real project untouched");
  assert.equal(r.projectChanged, false);
  assert.equal(r.task, `Fix add.\nRepository: ${dir}`, "the user's original task is reported");

  process.env.TARGET = join(dir, "escaped.txt");
  try {
    const r2 = await argue({ ...opts, task: "Fix add.", agents: parseAgents("literal,escapee", d) });
    assert.equal(r2.projectChanged, true, "an agent writing into the real project is detected");
  } finally {
    delete process.env.TARGET;
  }
});

test("install skips CLIs that are not installed and uninstall leaves no empty files behind", async () => {
  const { install } = await import("../src/install.js");
  const { mkdirSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  mkdirSync(join(home, ".gemini"));
  const prev = { PATH: process.env.PATH, XDG: process.env.XDG_CONFIG_HOME };
  process.env.PATH = dirname(process.execPath); // node only: no agent CLIs on PATH
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  try {
    const res = await install({ home });
    const status = Object.fromEntries(res.map((r) => [r.id, r.status]));
    assert.equal(status.gemini, "skipped", "a leftover ~/.gemini folder is not an installed Gemini CLI");
    assert.equal(status.opencode, "skipped");
    assert.equal(status.skill, "installed");
    assert.ok(!existsSync(join(home, ".gemini", "skills")));
    await install({ home, only: ["gemini"] });
    assert.ok(existsSync(join(home, ".gemini", "settings.json")));
    await install({ home, only: ["gemini"], uninstall: true });
    assert.ok(!existsSync(join(home, ".gemini", "settings.json")), "settings.json argue created is removed again");
    const again = await install({ home, only: ["gemini"], uninstall: true });
    assert.equal(again[0].status, "skipped");
  } finally {
    process.env.PATH = prev.PATH;
    if (prev.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.XDG;
  }
});

test("typos of commands and one-word tasks never start a run", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  const { spawnSync } = await import("node:child_process");
  for (const [arg, msg] of [
    ["install.", /Did you mean "argue install"/],
    ["Doctor", /Did you mean "argue doctor"/],
    ["aply", /Did you mean "argue apply"/],
    ["fixit", /one word is too little/],
  ]) {
    const res = spawnSync(process.execPath, [BIN, arg, "-a", "good,bad"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(res.status, 0, arg);
    assert.match(res.stderr, msg, arg);
  }
  assert.ok(!existsSync(join(dir, ".argue", "runs")), "no run was started");
});

test("first-run setup: asks once, connects on yes, remembers no, never asks in automation", async () => {
  const { mkdirSync } = await import("node:fs");
  const { maybeOfferSetup, interactive, readState, statePath } = await import("../src/setup.js");
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  mkdirSync(join(home, ".cursor"));
  const prev = { XDG: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.PATH = dirname(process.execPath);
  const lines = [];
  const write = (s) => lines.push(s);
  try {
    // Automation and agents are never asked.
    assert.equal(interactive({}, false), false, "no TTY");
    assert.equal(interactive({ CI: "1" }, true), false);
    assert.equal(interactive({ CLAUDECODE: "1" }, true), false);
    assert.equal(interactive({ PI_CODING_AGENT: "true" }, true), false);
    assert.equal(interactive({ CODEX_SANDBOX: "seatbelt" }, true), false);
    assert.equal(interactive({ ARGUE_DEPTH: "1" }, true), false);
    assert.equal(interactive({}, true), true);

    // "n" is remembered and never asked again.
    let asked = 0;
    assert.equal(await maybeOfferSetup({ home, write, force: true, ask: async () => (asked++, "n") }), false);
    assert.equal(readState().setup, "declined");
    assert.equal(await maybeOfferSetup({ home, write, ask: async () => (asked++, "y") }), false);
    assert.equal(asked, 1, "not asked a second time");

    // Enter (default yes) connects everything that is installed.
    rmSync(statePath());
    assert.equal(await maybeOfferSetup({ home, write, force: true, ask: async () => "" }), true);
    assert.ok(existsSync(join(home, ".agents", "skills", "argue", "SKILL.md")));
    assert.ok(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.argue);
    assert.equal(readState().setup, "done");
    assert.ok(
      lines.some((l) => /Cursor/.test(l)),
      "names the agents it found",
    );

    // An existing install (e.g. from an older argue) counts as done, without asking.
    rmSync(statePath());
    assert.equal(await maybeOfferSetup({ home, write, ask: async () => assert.fail("should not ask") }), false);
    assert.equal(readState().setup, "done");
  } finally {
    process.env.PATH = prev.PATH;
    if (prev.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.XDG;
  }
});

test("first-run prompt never appears for piped/non-TTY CLI use", async () => {
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(process.execPath, [BIN, "doctor"], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /Welcome to argue/);
  assert.ok(!existsSync(join(home, ".agents")), "nothing installed without asking");
});

test("cancelling during setup (before agents start) still cancels", async () => {
  const dir = makeRepo();
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  await assert.rejects(play(dir, "slow,slow", { signal: ac.signal, judgeName: "slow" }), /cancelled/);
  assert.ok(Date.now() - t0 < 10_000);
  assert.equal(execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 1);
});
