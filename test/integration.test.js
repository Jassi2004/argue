import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAgents, registry } from "../src/agents/drivers.js";
import { callTool } from "../src/integrations/mcp.js";
import { runRoom } from "../src/room/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures", "fake-agent.mjs");
const BIN = join(here, "..", "bin", "argue.js");
const fake = (name) => ({ command: `node ${JSON.stringify(FAKE)} {prompt_file} ${name}` });

const BEHAVIOURS = ["good", "bad", "fixer", "breaker", "follower", "critic", "stubborn", "noop", "boom", "slow", "late", "echo-env"];
const config = { custom: Object.fromEntries(BEHAVIOURS.map((b) => [b, fake(b)])) };
const drivers = registry(config);
const installed = Object.fromEntries(BEHAVIOURS.map((b) => [b, "custom"]));
const agentsOf = (list, d = drivers) => parseAgents(list, d);

/**
 * The environment for CLI runs: only node and git on PATH and an empty config folder, so a test
 * can never reach a real agent CLI (or the user's saved lineup) on the machine running it.
 */
const SAFE = (() => {
  const config = mkdtempSync(join(tmpdir(), "argue-cfg-"));
  if (process.platform === "win32") return { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config, ARGUE_NO_SETUP: "1" };
  const bin = mkdtempSync(join(tmpdir(), "argue-bin-"));
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
  return { ...process.env, PATH: bin, XDG_CONFIG_HOME: config, ARGUE_NO_SETUP: "1" };
})();
const cli = (dir, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8", env: SAFE });
const cliJson = (dir, ...args) => {
  const res = cli(dir, ...args);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

function makeRepo({ git = true, commit = true, withConfig = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "argue-it-"));
  writeFileSync(join(dir, "math.js"), "export const add = (a, b) => 0;\n");
  writeFileSync(join(dir, "test.mjs"), 'import { add } from "./math.js";\nif (add(2, 3) !== 5) { console.error("bad"); process.exit(1); }\n');
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  if (withConfig) writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    if (commit) commitAll(dir, "init");
  }
  return dir;
}
const commitAll = (dir, msg) => {
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], { cwd: dir });
};
const worktrees = (dir) => execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length;

/** Run a room on a repo with fake agents. */
const play = (dir, list, opts = {}) =>
  runRoom({
    task: "make add() add",
    agents: agentsOf(list, opts.drivers),
    judge: agentsOf(opts.judge ?? "good", opts.drivers)[0],
    drivers: opts.drivers ?? drivers,
    installed: opts.installed ?? installed,
    cwd: dir,
    check: "node test.mjs",
    rounds: 4,
    ...opts,
  });

// ---------------------------------------------------------------- the room

test("code mode: the room converges on the passing work; the user's files are untouched until apply", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "notes.txt"), "untracked file\n"); // untracked files reach the agents
  const events = [];
  const r = await play(dir, "bad,good", { onEvent: (e) => events.push(e) });
  assert.equal(r.status, "done");
  assert.equal(r.ended, "consensus");
  assert.equal(r.winner.agent, "good");
  assert.deepEqual(r.files, ["math.js"]);
  assert.equal(r.agents.find((a) => a.agent === "bad").stance, "B", "the bad agent was convinced and backs the good work");
  assert.ok(r.challenges >= 1);
  assert.match(readFileSync(join(dir, "math.js"), "utf8"), /=> 0/, "user file untouched");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim(), "?? notes.txt");
  assert.equal(worktrees(dir), 1, "desks cleaned up");
  assert.ok(
    events.some((e) => e.type === "post" && e.challenges.length),
    "challenges are reported live",
  );
  for (const f of ["room.md", "room.json", "answer.md", "result.json", "work/winner.patch", "work/A.patch", "work/B.patch"])
    assert.ok(existsSync(join(r.runDir, f)), f);
  execFileSync(process.execPath, [BIN, "apply", r.runId], { cwd: dir, env: SAFE });
  execFileSync("node", ["test.mjs"], { cwd: dir });
});

test("instant agreement triggers a red-team turn before it counts as consensus", async () => {
  const r = await play(makeRepo(), "follower,good");
  assert.equal(r.ended, "consensus");
  assert.equal(r.winner.agent, "good");
  const record = readFileSync(join(r.runDir, "room.md"), "utf8");
  assert.match(record, /\(red team\)/);
  assert.match(r.outcome, /red-team turn found nothing/);
});

test("agents that never agree end the room (stall), without looping, and the verdict still answers", async () => {
  const r = await play(makeRepo(), "critic,stubborn");
  assert.equal(r.status, "done");
  assert.equal(r.agreed, false);
  assert.ok(["stalled", "quiet", "rounds"].includes(r.ended), r.ended);
  assert.ok(r.rounds <= 4);
  assert.ok(r.answer.length > 0);
});

test("a revision that breaks a passing check is rolled back; a fix is kept", async () => {
  const broken = await play(makeRepo(), "breaker,critic");
  const breaker = broken.agents.find((a) => a.agent === "breaker");
  assert.equal(breaker.check, true, "keeps its previously passing version");
  assert.match(readFileSync(join(broken.runDir, "work", "A.patch"), "utf8"), /a \+ b/);
  const room = JSON.parse(readFileSync(join(broken.runDir, "room.json"), "utf8"));
  assert.ok(
    room.notes.some((n) => n.to === "A" && /kept your previous version/.test(n.text)),
    "the agent is told",
  );

  const fixed = await play(makeRepo(), "fixer,good");
  const fixer = fixed.agents.find((a) => a.agent === "fixer");
  assert.deepEqual([fixer.check, fixer.version], [true, 2]);
});

test("an agent with no work of its own still reviews and backs others", async () => {
  const r = await play(makeRepo(), "noop,good");
  assert.equal(r.winner.agent, "good");
  assert.equal(r.agents.find((a) => a.agent === "noop").stance, "B");
});

test("answer mode: no file changes, the verdict's answer is returned", async () => {
  const dir = makeRepo();
  const r = await play(dir, "good,bad", { mode: "answer", task: "how should I cache?" });
  assert.equal(r.mode, "answer");
  assert.match(r.answer, /vetted answer/);
  assert.equal(r.patch, null);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim(), "");
  assert.match(readFileSync(join(r.runDir, "work", "A.md"), "utf8"), /hash map/);
});

test("works in a plain folder (no git) and in a repo without commits", async () => {
  for (const opts of [{ git: false }, { git: true, commit: false }]) {
    const dir = makeRepo(opts);
    const r = await play(dir, "good,bad", { apply: true });
    assert.equal(r.winner.agent, "good", JSON.stringify(opts));
    assert.equal(r.applied, true);
    execFileSync("node", ["test.mjs"], { cwd: dir });
  }
});

test("uncommitted edits to tracked files are what agents start from", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "extra.js"), "export const x = 1;\n");
  execFileSync("git", ["add", "extra.js"], { cwd: dir });
  writeFileSync(join(dir, "extra.js"), "export const x = 2;\n");
  const r = await play(dir, "good,bad", { rounds: 0 });
  assert.deepEqual(r.files, ["math.js"], "the dirty file is part of the base, not of the change");
});

test("node_modules is shared into desks but never part of a patch; a subdirectory cwd works", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "export const five = 5;\n");
  writeFileSync(
    join(dir, "test.mjs"),
    'import { add } from "./math.js";\nimport { five } from "./node_modules/dep/index.js";\nif (add(2, 3) !== five) process.exit(1);\n',
  );
  commitAll(dir, "deps");
  mkdirSync(join(dir, "sub"));
  const r = await play(dir, "bad,good", { cwd: join(dir, "sub"), rounds: 1 });
  assert.equal(r.winner.agent, "good");
  assert.deepEqual(r.files, ["math.js"]);
  assert.ok(existsSync(join(dir, ".argue", "runs", r.runId)), "runs are stored at the repo root");
});

test("agents running git clean in their desk do not break the room", async () => {
  const r = await play(makeRepo(), "good,critic,bad");
  assert.equal(r.status, "done");
  const room = JSON.parse(readFileSync(join(r.runDir, "room.json"), "utf8"));
  assert.ok(
    room.posts.every((p) => !p.error),
    "every turn succeeded",
  );
});

test("all agents failing gives a clear error, and the record says why", async () => {
  const dir = makeRepo();
  await assert.rejects(play(dir, "boom,boom"), /no agent produced a change[\s\S]*oops/);
});

test("a failing verdict falls back to the room's best work", async () => {
  const r = await play(makeRepo(), "good,bad", { judge: "boom", mode: "answer" });
  assert.equal(r.status, "done");
  assert.match(r.answer, /hash map/, "the best answer as it stood");
});

test("the record is saved after every round, so a cancelled run keeps what happened", async () => {
  const dir = makeRepo();
  const ac = new AbortController();
  const err = await play(dir, "good,late", {
    signal: ac.signal,
    onEvent: (e) => e.type === "phase" && e.name === "round" && setTimeout(() => ac.abort(), 200),
  }).catch((e) => e);
  assert.match(err.message, /cancelled/);
  const record = readFileSync(join(err.runDir, "room.md"), "utf8");
  assert.match(record, /## Opening[\s\S]*I worked on it \(good\)/);
  assert.equal(JSON.parse(readFileSync(join(err.runDir, "result.json"), "utf8")).status, "failed");
  assert.equal(worktrees(dir), 1);
});

test("cancelling stops a run quickly, even before agents start", async () => {
  const dir = makeRepo();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 500);
  const t0 = Date.now();
  await assert.rejects(play(dir, "slow,slow", { signal: ac.signal }), /cancelled/);
  assert.ok(Date.now() - t0 < 10_000);
  const early = new AbortController();
  early.abort();
  await assert.rejects(play(dir, "slow,slow", { signal: early.signal }), /cancelled/);
  assert.equal(worktrees(dir), 1);
});

test("agents get ARGUE_DEPTH so they cannot start nested runs", async () => {
  const dir = makeRepo({ withConfig: true });
  const r = await play(dir, "echo-env,bad", { rounds: 0 });
  assert.match(readFileSync(join(r.runDir, "work", "A.patch"), "utf8"), /\+1/);
  const nested = spawnSync(process.execPath, [BIN, "fix it", "-a", "good,bad"], { cwd: dir, encoding: "utf8", env: { ...SAFE, ARGUE_DEPTH: "1" } });
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /cannot start another one/);
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
  const opts = { drivers: d, installed: { literal: "custom", escapee: "custom" }, judge: "literal", rounds: 0 };
  const r = await play(dir, "literal,literal", { ...opts, task: `Fix add.\nRepository: ${dir}` });
  assert.match(readFileSync(join(dir, "math.js"), "utf8"), /=> 0/, "real project untouched");
  assert.equal(r.projectChanged, false);
  assert.equal(r.task, `Fix add.\nRepository: ${dir}`, "the user's original task is reported");
  process.env.TARGET = join(dir, "escaped.txt");
  try {
    const r2 = await play(dir, "literal,escapee", { ...opts, task: "Fix add." });
    assert.equal(r2.projectChanged, true, "an agent writing into the real project is detected");
  } finally {
    delete process.env.TARGET;
  }
});

test("two runs at once in the same repo do not interfere", async () => {
  const dir = makeRepo();
  const [a, b] = await Promise.all([play(dir, "good,bad"), play(dir, "bad,good")]);
  assert.equal(a.winner.agent, "good");
  assert.equal(b.winner.agent, "good");
  assert.notEqual(a.runId, b.runId);
  assert.equal(worktrees(dir), 1);
});

test("never copies a home folder or a huge non-git folder; answers still work there", async () => {
  const { tooBigToCopy } = await import("../src/workspace/git.js");
  const big = mkdtempSync(join(tmpdir(), "argue-big-"));
  for (let i = 0; i < 30; i++) writeFileSync(join(big, `f${i}.txt`), "x");
  assert.match(tooBigToCopy(big, { limit: { files: 10, bytes: 1e9 } }) ?? "", /too large/);
  assert.equal(tooBigToCopy(big), null, "a small folder is fine");
  // Pretend a temp folder is the home folder (never touch the real one).
  const home = mkdtempSync(join(tmpdir(), "argue-fakehome-"));
  // os.homedir() reads HOME on Unix and USERPROFILE on Windows.
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.match(tooBigToCopy(home), /home folder/);
    const r = await play(home, "good,bad", { mode: "answer", task: "which cache is best?", rounds: 0 });
    assert.equal(r.status, "done");
    await assert.rejects(play(home, "good,bad", { rounds: 0 }), /home folder/);
  } finally {
    for (const [k, v] of Object.entries(prev))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test("paths with spaces and unicode, renames and deletions, and apply from a subdirectory", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "my file é.txt"), "hello\n");
  writeFileSync(join(dir, "old.txt"), "bye\n");
  commitAll(dir, "more");
  const d = registry({
    custom: {
      mover: {
        command: `node -e "const f=require('fs');f.writeFileSync('my file é.txt','changed\\n');try{f.renameSync('old.txt','new.txt')}catch{};f.writeFileSync('math.js','export const add=(a,b)=>a+b;\\n');console.log('STANCE: A')"`,
      },
    },
  });
  const r = await play(dir, "mover,mover", { drivers: d, installed: { mover: "custom" }, judge: "mover", rounds: 0 });
  assert.equal(r.status, "done");
  assert.deepEqual([...r.files].sort(), ["math.js", "my file é.txt", "new.txt", "old.txt"].sort());
  mkdirSync(join(dir, "deep", "er"), { recursive: true });
  execFileSync(process.execPath, [BIN, "apply", r.runId], { cwd: join(dir, "deep", "er"), env: SAFE });
  assert.equal(readFileSync(join(dir, "my file é.txt"), "utf8"), "changed\n");
  assert.ok(existsSync(join(dir, "new.txt")) && !existsSync(join(dir, "old.txt")));
});

test("apply refuses cleanly when the user changed the same lines meanwhile; --agent picks another change", async () => {
  const plain = makeRepo({ git: false });
  const r = await play(plain, "good,bad", { rounds: 0 });
  writeFileSync(join(plain, "math.js"), "export const add = (a, b) => 42;\n");
  const res = cli(plain, "apply", r.runId);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /does not apply/);
  assert.equal(readFileSync(join(plain, "math.js"), "utf8"), "export const add = (a, b) => 42;\n", "user's file untouched");

  const dir = makeRepo();
  const r2 = await play(dir, "good,bad", { rounds: 0 });
  assert.match(cli(dir, "apply", r2.runId, "--agent", "Z").stderr, /no agent Z/);
  const ok = cli(dir, "apply", r2.runId, "--agent", "b");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(join(dir, "math.js"), "utf8"), /a - b/);
});

test("every run records the lineup's CLI, model and effort; the start note has no judge", async () => {
  const r = await play(makeRepo(), "good,bad", { rounds: 0 });
  const meta = JSON.parse(readFileSync(join(r.runDir, "meta.json"), "utf8"));
  assert.match(meta.note, /^Arguing with account default model \(effort n\/a, good\), account default model \(effort n\/a, bad\)\./);
  assert.doesNotMatch(meta.note, /judge/i);
  assert.equal(meta.agents[0].harness, "good");
  assert.match(meta.display, /Arguing with[\s\S]*costs more[\s\S]*up to 0 rounds · 60 min · no \$ cap/);
});

// ---------------------------------------------------------------- the CLI

test("CLI: one vetted answer for the user, the debate in argue show, follow-ups with argue ask", async () => {
  const dir = makeRepo({ withConfig: true });
  const run = cli(dir, "which approach is best for caching here?", "-a", "good,bad", "-j", "good");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /argue · 2 agents · answer/);
  assert.match(run.stdout, /── opening/);
  assert.match(run.stdout, /The vetted answer/);
  assert.equal(readFileSync(join(dir, "math.js"), "utf8"), "export const add = (a, b) => 0;\n", "a question changes no files");
  assert.match(cli(dir, "show").stdout, /# argue record[\s\S]*## Opening[\s\S]*## Final answer/);
  const ask = cli(dir, "ask", "why not something else?", "-j", "good");
  assert.equal(ask.status, 0, ask.stderr);
  assert.match(ask.stdout, /Because the record shows the alternatives lost/);
});

test("CLI: --bg --json, wait, runs, cancel", async () => {
  const dir = makeRepo({ withConfig: true });
  const started = cliJson(dir, "fix add", "-a", "bad,good", "-j", "good", "-c", "node test.mjs", "--bg", "--json");
  assert.equal(started.status, "running");
  assert.match(started.display, /Arguing with/);
  let s;
  for (let i = 0; i < 10; i++) {
    s = cliJson(dir, "wait", started.run_id, "--seconds", "10");
    if (s.status !== "running") break;
  }
  assert.equal(s.status, "done", JSON.stringify(s));
  assert.equal(s.winner, undefined, "the user-facing result has no winner");
  assert.match(cli(dir, "runs").stdout, new RegExp(started.run_id));

  const slow = cliJson(dir, "slow task here", "-a", "slow,slow", "-j", "slow", "-c", "none", "--bg", "--json");
  assert.match(cli(dir, "cancel", slow.run_id).stdout, /cancelled/);
  s = cliJson(dir, "wait", slow.run_id, "--seconds", "15");
  assert.equal(s.status, "failed");
});

test("--bg passes the exact task text, even when it looks like flags", async () => {
  const dir = makeRepo({ withConfig: true });
  const task = 'fix add -- --apply --agents boom "quoted" $HOME `x`';
  const started = cliJson(dir, "-a", "good,bad", "-j", "good", "-c", "node test.mjs", "-r", "0", "--bg", "--json", "--", task);
  const s = cliJson(dir, "wait", started.run_id, "--seconds", "30");
  assert.equal(s.status, "done");
  assert.equal(JSON.parse(readFileSync(join(dir, ".argue", "runs", started.run_id, "meta.json"), "utf8")).task, task);
  assert.equal(s.applied, false, "--apply inside the task text must not apply");
});

test("--bg reports an immediate failure instead of hanging", async () => {
  const dir = makeRepo({ withConfig: true });
  const t0 = Date.now();
  const res = cli(dir, "fix the add function", "-a", "good,bad", "--budget=-5", "--bg");
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--budget must be/);
  const { startDetached, waitForStart } = await import("../src/runs/background.js");
  const started = startDetached({ cwd: dir, args: ["-f", join(dir, "missing-task.md")] });
  await assert.rejects(waitForStart(dir, started), /task file not found/);
  assert.ok(Date.now() - t0 < 15_000);
});

test("a run killed with SIGKILL is cleaned up by the next run", { skip: process.platform === "win32" }, async () => {
  const dir = makeRepo({ withConfig: true });
  const started = cliJson(dir, "fix the add function", "-a", "slow,slow", "-j", "good", "-c", "none", "--bg", "--json");
  const runDir = join(dir, ".argue", "runs", started.run_id);
  const pidsOf = () => (existsSync(join(runDir, "pids")) ? readFileSync(join(runDir, "pids"), "utf8").trim().split("\n").filter(Boolean) : []);
  for (let i = 0; i < 100 && pidsOf().length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  const agentPids = pidsOf().map(Number);
  process.kill(JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")).pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  assert.match(cli(dir, "runs").stdout, /interrupted/);
  const next = cli(dir, "fix the add function", "-a", "good,bad", "-j", "good", "-c", "node test.mjs", "-r", "0", "--json");
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
  assert.equal(worktrees(dir), 1);
  assert.equal(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).status, "interrupted");
});

test("tasks that start with a command word are tasks; typos and one-word tasks never start a run", async () => {
  const dir = makeRepo({ withConfig: true });
  const res = cli(dir, "apply the fix to add", "-a", "good,bad", "-j", "good", "-c", "node test.mjs", "-r", "0", "--json");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).winner.agent, "good");
  // "show the bug" is a task: with no agent CLIs on PATH it says so (it does not look for a run).
  assert.match(cli(dir, "show", "the", "bug").stderr, /no agent CLIs found/);
  const fresh = makeRepo({ withConfig: true });
  for (const [arg, msg] of [
    ["install.", /Did you mean "argue install"/],
    ["Doctor", /Did you mean "argue doctor"/],
    ["aply", /Did you mean "argue apply"/],
    ["fixit", /one word is too little/],
  ]) {
    const r = cli(fresh, arg, "-a", "good,bad");
    assert.notEqual(r.status, 0, arg);
    assert.match(r.stderr, msg, arg);
  }
  assert.ok(!existsSync(join(fresh, ".argue", "runs")), "no run was started");
});

test("invalid config and bad flags give clear errors", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, ".argue.json"), '{"agentz":"claude"}');
  assert.match(cli(dir, "fix the add function").stderr, /unknown setting\(s\) agentz/);
  writeFileSync(join(dir, ".argue.json"), "{not json");
  assert.match(cli(dir, "fix the add function").stderr, /invalid JSON/);
  writeFileSync(join(dir, ".argue.json"), '{"mcp":"github"}');
  assert.match(cli(dir, "fix the add function").stderr, /"mcp" must be a list/);
  writeFileSync(join(dir, ".argue.json"), JSON.stringify(config));
  assert.match(cli(dir, "fix the add function", "-a", "good,bad", "-r", "nope").stderr, /--rounds must be a number/);
  assert.match(cli(dir, "fix the add function", "-a", "good").stderr, /at least two agents/);
  assert.match(cli(dir, "fix the add function", "-a", "good,nope").stderr, /unknown harness or model "nope"/);
  assert.match(cli(dir, "fix the add function", "--mode", "chat", "-a", "good,bad").stderr, /--mode must be/);
  assert.match(cli(dir, "fix the add function", "--frobnicate").stderr, /Unknown option/);
  assert.match(cli(dir, "apply").stderr, /no argue runs/);
});

// ---------------------------------------------------------------- integrations

test("MCP: start in the background, wait, apply, list runs", async () => {
  const dir = makeRepo({ withConfig: true });
  const start = await callTool("argue_start", { task: "fix add", cwd: dir, agents: "bad,good", judge: "good", check: "node test.mjs" });
  assert.equal(start.status, "running");
  let s;
  for (let i = 0; i < 20; i++) {
    s = await callTool("argue_wait", { run_id: start.run_id, cwd: dir, seconds: 5 });
    if (s.status !== "running") break;
  }
  assert.equal(s.status, "done", JSON.stringify(s));
  assert.match(s.answer, /vetted answer/);
  assert.equal(s.winner, undefined);
  assert.equal((await callTool("argue_apply", { run_id: start.run_id, cwd: dir })).applied, true);
  execFileSync("node", ["test.mjs"], { cwd: dir });
  assert.equal((await callTool("argue_runs", { cwd: dir }))[0].run_id, start.run_id);
});

test("MCP server speaks JSON-RPC over stdio", async () => {
  const dir = makeRepo();
  const child = spawn(process.execPath, [BIN, "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: SAFE });
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
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "argue_runs", arguments: { cwd: dir } } });
  for (let i = 0; i < 100 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  assert.equal(lines[0].result.serverInfo.name, "argue");
  assert.ok(lines[1].result.tools.some((t) => t.name === "argue_start"));
  assert.deepEqual(JSON.parse(lines[2].result.content[0].text), []);
});

test("install writes every integration into a fake home and uninstall removes them", async () => {
  const { install } = await import("../src/integrations/install.js");
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
    await install({ home, only: ["codex"] });
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.equal(toml.match(/\[mcp_servers\.argue\]/g).length, 1, "idempotent");
    await install({ home, only: ["skill", "codex", "cursor", "gemini", "opencode", "pi"], uninstall: true });
    assert.ok(!existsSync(join(home, ".agents", "skills", "argue")));
    assert.doesNotMatch(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /argue/);
    assert.ok(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.other);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("install skips CLIs that are not installed and uninstall leaves no empty files behind", async () => {
  const { install } = await import("../src/integrations/install.js");
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  mkdirSync(join(home, ".gemini"));
  const prev = { PATH: process.env.PATH, XDG: process.env.XDG_CONFIG_HOME };
  process.env.PATH = SAFE.PATH;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  try {
    const status = Object.fromEntries((await install({ home })).map((r) => [r.id, r.status]));
    assert.equal(status.gemini, "skipped", "a leftover ~/.gemini folder is not an installed Gemini CLI");
    assert.equal(status.skill, "installed");
    await install({ home, only: ["gemini"] });
    assert.ok(existsSync(join(home, ".gemini", "settings.json")));
    await install({ home, only: ["gemini"], uninstall: true });
    assert.ok(!existsSync(join(home, ".gemini", "settings.json")), "the settings.json argue created is removed again");
  } finally {
    process.env.PATH = prev.PATH;
    if (prev.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.XDG;
  }
});

test("first-run setup: asks once, connects on yes, remembers no, never asks in automation", async () => {
  const { maybeOfferSetup, interactive, readState, statePath } = await import("../src/integrations/setup.js");
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  mkdirSync(join(home, ".cursor"));
  const prev = { XDG: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.PATH = SAFE.PATH;
  const lines = [];
  const write = (s) => lines.push(s);
  try {
    assert.equal(interactive({}, false), false, "no TTY");
    assert.equal(interactive({ CI: "1" }, true), false);
    assert.equal(interactive({ CLAUDECODE: "1" }, true), false);
    assert.equal(interactive({ ARGUE_DEPTH: "1" }, true), false);
    assert.equal(interactive({}, true), true);
    let asked = 0;
    assert.equal(await maybeOfferSetup({ home, write, force: true, ask: async () => (asked++, "n") }), false);
    assert.equal(readState().setup, "declined");
    assert.equal(await maybeOfferSetup({ home, write, ask: async () => (asked++, "y") }), false);
    assert.equal(asked, 1, "not asked a second time");
    rmSync(statePath());
    assert.equal(await maybeOfferSetup({ home, write, force: true, ask: async () => "" }), true);
    assert.ok(existsSync(join(home, ".agents", "skills", "argue", "SKILL.md")));
    assert.ok(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.argue);
    assert.ok(lines.some((l) => /Cursor/.test(l)));
    rmSync(statePath());
    assert.equal(await maybeOfferSetup({ home, write, ask: async () => assert.fail("should not ask") }), false, "an existing install counts as done");
  } finally {
    process.env.PATH = prev.PATH;
    if (prev.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.XDG;
  }
});

test("first-run prompt never appears for piped/non-TTY CLI use", async () => {
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  const res = spawnSync(process.execPath, [BIN, "doctor"], {
    cwd: home,
    encoding: "utf8",
    env: { ...SAFE, ARGUE_NO_SETUP: "", HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /Welcome to argue/);
  assert.ok(!existsSync(join(home, ".agents")), "nothing installed without asking");
});

// The fake `codex` below is a Unix shebang script; Windows can't run it as a command.
test("argue lineup: rejects unknown models, saves valid ones, resets; doctor shows models", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
if (process.argv[2] === "debug") { console.log(JSON.stringify({ models: [
  { slug: "gpt-a", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
  { slug: "gpt-b", supported_reasoning_levels: [{ effort: "low" }] } ] })); process.exit(0); }
if (process.argv[2] === "mcp") { console.log("[]"); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(fakeCodex, 0o755);
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-a"\nmodel_reasoning_effort = "high"\n');
  const env = { ...SAFE, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: `${bin}:${SAFE.PATH}` };
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: home, encoding: "utf8", env });

  const bad = run("lineup", "codex:gpt-zzz,codex:gpt-b@high");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no model "gpt-zzz"/);
  assert.match(bad.stderr, /gpt-b supports effort: low/);
  assert.ok(!existsSync(join(home, ".config", "argue", "config.json")), "nothing saved on error");
  const ok = run("lineup", "codex,codex:gpt-b@low", "--json");
  assert.equal(ok.status, 0, ok.stderr);
  const res = JSON.parse(ok.stdout);
  assert.equal(res.saved, true);
  assert.deepEqual(
    res.lineup.map((d) => [d.model, d.effort]),
    [
      ["gpt-a", "high"],
      ["gpt-b", "low"],
    ],
  );
  assert.match(res.display, /- \*\*gpt-b\*\* · effort low · Codex/);
  const doc = JSON.parse(run("doctor", "--json").stdout);
  assert.equal(doc.lineupSource, "saved");
  assert.equal(doc.harnesses.find((h) => h.agent === "codex").model, "gpt-a");
  assert.match(run("doctor").stdout, /B +Codex +gpt-b +low/);
  const limits = JSON.parse(run("lineup", "-b", "3", "-r", "2", "--json").stdout);
  assert.deepEqual([limits.saved, limits.limits.budget, limits.limits.rounds], [true, 3, 2], "limits are saved as defaults");
  assert.match(limits.display, /up to 2 rounds · 60 min · \$3/);
  const preview = JSON.parse(run("lineup", "-b", "none", "--preview", "--json").stdout);
  assert.equal(preview.limits.budget, null, "a preview shows this run's override");
  assert.equal(JSON.parse(readFileSync(join(home, ".config", "argue", "config.json"), "utf8")).budget, 3, "a preview saves nothing");
  assert.equal(run("lineup", "--reset").status, 0);
  assert.equal(JSON.parse(readFileSync(join(home, ".config", "argue", "config.json"), "utf8")).agents, undefined);
});

test("removeTree deletes folders with read-only files (like Go's module cache)", { skip: process.platform === "win32" }, async () => {
  const { removeTree } = await import("../src/util/fs.js");
  const d = mkdtempSync(join(tmpdir(), "argue-ro-"));
  mkdirSync(join(d, "mod", "pkg"), { recursive: true });
  writeFileSync(join(d, "mod", "pkg", "a.go"), "x");
  chmodSync(join(d, "mod", "pkg", "a.go"), 0o444);
  chmodSync(join(d, "mod", "pkg"), 0o555);
  chmodSync(join(d, "mod"), 0o555);
  removeTree(d);
  assert.ok(!existsSync(d));
});
