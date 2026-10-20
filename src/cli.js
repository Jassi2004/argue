import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultJudge, defaultLineup, detect, parseAgents, registry } from "./agents.js";
import { argue } from "./argue.js";
import { startDetached, waitForFinish, waitForStart } from "./background.js";
import { detectCheck, loadConfig, userConfigPath, writeConfig } from "./config.js";
import { killAll, run } from "./exec.js";
import { hasGit } from "./git.js";
import { install } from "./install.js";
import { startMcpServer, summarize } from "./mcp.js";
import { markSetupDone, maybeOfferSetup } from "./setup.js";
import { applyRun, findRun, listRuns, readEvents, reap, reapStale, requestCancel } from "./runs.js";
import { bold, cyan, dim, green, printResult, progressPrinter, red, yellow } from "./ui.js";
import { VERSION } from "./version.js";

const HELP = `${bold("argue")} — several AI coding agents compete on your task; the best verified solution wins.

${bold("Start")}
  argue "<task>"                  solve a task (your files don't change until you apply)
  argue "<question>" --mode ask   debate an answer, no code changes

${bold("After a run")}
  argue apply [run] [--agent B]   apply the winner (or another agent's version)
  argue show [run]                read the full report
  argue runs                      list past runs
  argue watch [run]               follow a run live
  argue cancel [run]              stop a run

${bold("Setup")}
  argue doctor                    see which agents argue can use
  argue install / uninstall       connect argue to your agents, or remove it
  argue init                      save your default agents and budget

${bold("Options")}
  -a, --agents <list>    agents to compete, e.g. claude,codex,gemini (model/effort: claude:opus@high)
  -c, --check <cmd>      command that proves the task is done (auto-detected; "none" to skip)
  -r, --rounds <n>       rounds of review (default 2)
  -b, --budget <usd>     spending cap (Claude Code, OpenCode, Pi report cost)
  -j, --judge <agent>    who picks the winner (default: automatic)
  -m, --mode <mode>      code (default) or ask
  -f, --file <path>      read the task from a file
      --apply            apply the winner automatically
      --bg               run in the background
      --json             machine-readable output
  -h, --help · -v, --version

More: https://github.com/Jassi2004/argue#readme`;

const OPTIONS = {
  agents: { type: "string", short: "a" },
  judge: { type: "string", short: "j" },
  check: { type: "string", short: "c" },
  mode: { type: "string", short: "m" },
  rounds: { type: "string", short: "r" },
  budget: { type: "string", short: "b" },
  timeout: { type: "string", short: "t" },
  file: { type: "string", short: "f" },
  context: { type: "string" },
  agent: { type: "string" },
  "run-id": { type: "string" },
  seconds: { type: "string" },
  apply: { type: "boolean" },
  bg: { type: "boolean" },
  keep: { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
};

const COMMANDS = new Set(["apply", "show", "runs", "watch", "wait", "cancel", "doctor", "init", "install", "uninstall", "mcp", "help", "version"]);

export async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, strict: true });
  if (o.version) return console.log(VERSION);
  const cmd = detectCommand(positionals, o);
  const rest = cmd ? positionals.slice(1) : positionals;
  const cwd = process.cwd();

  if (cmd === "mcp") return startMcpServer();
  // First time a person uses argue at a terminal: offer to connect it to their agents (asked once).
  if (!o.json && !o.bg && !o.quiet && !["install", "uninstall", "wait", "version"].includes(cmd)) await maybeOfferSetup();
  if (o.help || cmd === "help" || (!cmd && !rest.length && !o.file)) return console.log(HELP);
  if (cmd === "version") return console.log(VERSION);
  if (cmd === "doctor") return doctor(cwd);
  if (cmd === "init") return init(cwd);
  if (cmd === "install" || cmd === "uninstall") return integrations(rest, cmd === "uninstall");
  if (cmd === "runs") return runsCmd(cwd, o);
  if (cmd === "show") return show(cwd, rest[0], o);
  if (cmd === "watch") return watch(cwd, rest[0]);
  if (cmd === "wait") return waitCmd(cwd, rest[0], o);
  if (cmd === "cancel") return cancelCmd(cwd, rest[0]);
  if (cmd === "apply") return applyCmd(cwd, rest[0], o);
  return runTask(cwd, rest, o);
}

/**
 * `argue apply` is a command, `argue "apply the fix in parser.ts"` is a task.
 * A subcommand is the first word only when it is passed as its own argument and takes at most its own arguments.
 */
function detectCommand(positionals, o) {
  const [first, ...more] = positionals;
  if (!first || o.file) return null;
  if (!COMMANDS.has(first)) {
    // A lone word that is almost a command ("install.", "Doctor", "aply") is a typo, not a task.
    const near = !more.length && !/\s/.test(first) && closestCommand(first);
    if (near)
      throw new Error(`unknown command "${first}". Did you mean "argue ${near}"?\nTo run a one-word task, add more detail, e.g. argue "${first} <what to do>"`);
    return null;
  }
  if (first === "install" || first === "uninstall") return more.every((t) => TARGETS.includes(t)) ? first : null;
  return more.length <= 1 && !more.some((m) => /\s/.test(m)) ? first : null;
}

function closestCommand(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (COMMANDS.has(w)) return w;
  for (const c of COMMANDS) if (w.length >= 3 && editDistance(w, c) <= (c.length > 5 ? 2 : 1)) return c;
  return null;
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// ---------------------------------------------------------------- run

async function runTask(cwd, rest, o) {
  if (Number(process.env.ARGUE_DEPTH || 0) > 0 && !process.env.ARGUE_ALLOW_NESTED)
    throw new Error("argue is already running this task; agents inside an argue run cannot start another one");
  const root = await projectRoot(cwd);
  const config = loadConfig(root);
  const drivers = registry(config);
  let task = rest.join(" ").trim();
  if (o.file) {
    if (o.file !== "-" && !existsSync(o.file)) throw new Error(`task file not found: ${o.file}`);
    task = (o.file === "-" ? readFileSync(0, "utf8") : readFileSync(o.file, "utf8")).trim();
    if (o["run-id"] && /[\\/]argue-task-[\w-]+\.md$/.test(o.file)) rmSync(o.file, { force: true });
  }
  if (!task) throw new Error("empty task");
  if (!o.file && !/\s/.test(task))
    throw new Error(
      `"${task}" is not a command, and one word is too little to work on.\nDescribe the task, e.g. argue "fix the flaky test in auth.spec.ts". Run "argue --help" for commands.`,
    );

  const mode = o.mode ?? config.mode ?? "code";
  if (!["code", "ask"].includes(mode)) throw new Error(`--mode must be "code" or "ask"`);
  if (!(await hasGit())) throw new Error("git is required (https://git-scm.com/downloads)");

  const installedMap = await detect(drivers);
  const installed = Object.keys(installedMap);
  const lineup = o.agents ?? config.agents ?? defaultLineup(installed);
  if (!lineup)
    throw new Error(
      `no agent CLIs found. Install at least one of: Claude Code, Codex, Gemini CLI, Cursor CLI, OpenCode, Pi.\nRun "argue doctor" for install commands.`,
    );
  const agents = parseAgents(lineup, drivers);
  if (agents.length < 2) throw new Error(`need at least two competitors. With one CLI you can repeat it: --agents ${agents[0].kind},${agents[0].kind}`);
  if (agents.length > 8) throw new Error("at most 8 competitors");
  const missing = [...new Set(agents.filter((a) => !installedMap[a.kind]).map((a) => a.kind))];
  if (missing.length) throw new Error(`not installed: ${missing.join(", ")}. Run "argue doctor".`);
  const judgeSpec = o.judge ?? config.judge ?? defaultJudge(installed, agents);
  const [judge] = parseAgents(judgeSpec, drivers);
  if (!installedMap[judge.kind]) throw new Error(`judge "${judge.kind}" is not installed`);

  let check = o.check ?? config.check;
  if (check === "none" || check === false || check === "") check = null;
  else if (check === "auto" || check == null) check = mode === "code" ? detectCheck(root) : null;

  const rounds = Math.floor(num(o.rounds ?? config.rounds, "rounds", 0, 10));
  const budgetRaw = o.budget ?? config.budget;
  const budget = budgetRaw == null || budgetRaw === "" ? undefined : num(budgetRaw, "budget", 0.01, 10000);
  const timeout = num(o.timeout ?? config.timeout, "timeout", 1, 600);

  if (o.bg) {
    // Rebuild the child's arguments from resolved settings; the task goes through a file so nothing in it is parsed as flags.
    if (o.file === "-") throw new Error("--bg cannot read the task from stdin; write it to a file and use -f <file>");
    const taskFile = join(tmpdir(), `argue-task-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(taskFile, task);
    const args = ["-f", taskFile, "--mode", mode, "--agents", agents.map((a) => a.name).join(","), "--judge", judge.name];
    args.push("--check", check ?? "none", "--rounds", String(rounds), "--timeout", String(timeout));
    if (budget) args.push("--budget", String(budget));
    if (o.context) args.push(`--context=${o.context}`);
    if (o.apply) args.push("--apply");
    if (o.keep) args.push("--keep");
    const started = startDetached({ cwd, args });
    const { runId, log } = started;
    const run = await waitForStart(cwd, started);
    if (o.json) {
      return console.log(
        JSON.stringify({ run_id: runId, status: "running", agents: run.meta.agents, judge: run.meta.judge, next: `argue wait ${runId}` }, null, 2),
      );
    }
    console.log(
      `${green("started")} ${runId}\n  ${dim("follow:")}  argue watch ${runId}\n  ${dim("apply:")}   argue apply ${runId}\n  ${dim("log:")}     ${log}`,
    );
    return;
  }

  await reapStale(cwd);

  const controller = new AbortController();
  let interrupts = 0;
  const onSig = () => {
    interrupts++;
    if (interrupts > 1) {
      killAll();
      process.exit(130);
    }
    process.stderr.write(`\n${yellow("cancelling… (Ctrl-C again to force)")}\n`);
    controller.abort();
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const quiet = o.quiet;
  const write = o.json ? (s) => process.stderr.write(`${s}\n`) : (s) => process.stdout.write(`${s}\n`);
  const onEvent = quiet ? () => {} : progressPrinter(write);

  try {
    const result = await argue({
      task,
      agents,
      judge,
      drivers,
      installed: installedMap,
      cwd,
      mode,
      check,
      rounds,
      budget,
      timeout,
      apply: o.apply,
      keep: o.keep,
      ctx: o.context ?? "",
      runId: o["run-id"],
      onEvent,
      signal: controller.signal,
    });
    if (o.json) console.log(JSON.stringify(result, null, 2));
    else if (!quiet) printResult(result);
  } catch (err) {
    if (o.json) console.log(JSON.stringify({ status: "failed", error: err.message, runDir: err.runDir }, null, 2));
    throw err;
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}

function num(v, name, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number between ${min} and ${max}`);
  return n;
}

async function projectRoot(cwd) {
  const r = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  return r.code === 0 ? r.stdout.trim() : cwd;
}

// ---------------------------------------------------------------- doctor / init / install

async function doctor(cwd) {
  const root = await projectRoot(cwd);
  const config = loadConfig(root);
  const drivers = registry(config);
  const found = await detect(drivers);
  console.log(`${bold("argue")} ${VERSION} · node ${process.versions.node} · ${process.platform}`);
  console.log(`  ${(await hasGit()) ? green("✓") : red("✗")} git`);
  console.log(`\n${bold("Agents")}`);
  for (const [kind, d] of Object.entries(drivers)) {
    if (found[kind]) console.log(`  ${green("✓")} ${kind.padEnd(9)} ${d.title}${found[kind] !== d.bin && !d.custom ? dim(` (${found[kind]})`) : ""}`);
    else console.log(`  ${dim("·")} ${dim(kind.padEnd(9))} ${dim(`${d.title} — install: ${d.install}`)}`);
  }
  const installed = Object.keys(found);
  const lineup = config.agents ?? defaultLineup(installed);
  console.log(`\n${bold("Default lineup")}  ${lineup || red("none — install at least one agent CLI")}`);
  if (lineup) {
    const agents = parseAgents(lineup, drivers);
    console.log(`${bold("Judge")}           ${config.judge ?? defaultJudge(installed, agents)}`);
    if (new Set(agents.map((a) => a.kind)).size === 1)
      console.log(dim("  tip: agents from different vendors catch more of each other's mistakes; install another CLI if you can."));
  }
  const check = config.check && config.check !== "auto" ? config.check : detectCheck(root);
  console.log(`${bold("Check here")}      ${check ?? dim("none detected (pass --check)")}`);
  console.log(dim(`\nLogin issues? Run each CLI once on its own (e.g. "claude", "codex") to sign in.`));
}

async function init(cwd) {
  const drivers = registry(loadConfig(await projectRoot(cwd)));
  const installed = Object.keys(await detect(drivers));
  const path = userConfigPath();
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const suggested = current.agents ?? defaultLineup(installed);
  console.log(`installed: ${installed.join(", ") || "none"}`);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const agents = (await rl.question(`competitors [${suggested}]: `)).trim() || suggested;
    parseAgents(agents, drivers);
    const judge = (await rl.question(`judge [auto]: `)).trim() || null;
    const budget = (await rl.question(`budget per run in USD [none]: `)).trim() || null;
    const rounds = (await rl.question(`max rounds [${current.rounds ?? 2}]: `)).trim() || current.rounds || 2;
    writeConfig(path, { ...current, agents, judge, budget: budget ? Number(budget) : null, rounds: Number(rounds) });
    console.log(`${green("saved")} ${path}`);
  } finally {
    rl.close();
  }
  console.log(dim(`next: "argue install" adds /argue to your coding agents`));
}

const TARGETS = ["skill", "claude", "codex", "cursor", "gemini", "opencode", "pi"];

async function integrations(only, remove) {
  const bad = only.filter((t) => !TARGETS.includes(t));
  if (bad.length) throw new Error(`unknown target(s): ${bad.join(", ")} (choose from: ${TARGETS.join(" ")})`);
  const results = await install({ only: only.length ? only : undefined, uninstall: remove });
  // Either way the user has made a choice, so the first-run prompt should not appear again.
  if (!only.length) markSetupDone();
  for (const r of results) {
    const mark = r.status === "error" ? red("✗") : r.status === "skipped" ? dim("·") : green("✓");
    console.log(`  ${mark} ${r.title.padEnd(60)} ${r.status === "skipped" ? dim(r.detail) : r.status === "error" ? red(r.detail) : dim(r.detail)}`);
  }
  if (!remove) console.log(dim(`\nRestart your agents, then ask: "argue <task>" (or /argue in Gemini, OpenCode, Pi).`));
}

// ---------------------------------------------------------------- runs

async function runsCmd(cwd, o) {
  const runs = await listRuns(cwd);
  if (o.json)
    return console.log(
      JSON.stringify(
        runs.map((r) => ({ id: r.id, status: r.status, task: r.meta.task, winner: r.result?.winner ?? null })),
        null,
        2,
      ),
    );
  if (!runs.length) return console.log("no runs yet");
  for (const r of runs.slice(0, 30)) {
    const st = r.status === "done" ? green("done") : r.status === "running" ? yellow("running") : red(r.status);
    console.log(`${cyan(r.id)}  ${st.padEnd(16)} ${(r.result?.winner?.agent ?? "").padEnd(16)} ${dim(trim(r.meta.task, 70))}`);
  }
}

async function show(cwd, id, o) {
  const run = await findRun(cwd, id);
  if (o.json) return console.log(JSON.stringify(run.result ?? summarize(run), null, 2));
  const report = join(run.path, "report.md");
  if (existsSync(report)) return console.log(readFileSync(report, "utf8"));
  console.log(JSON.stringify(summarize(run), null, 2));
}

async function watch(cwd, id) {
  let run = await findRun(cwd, id);
  const print = progressPrinter();
  let seen = 0;
  for (;;) {
    const events = readEvents(run.path);
    for (const e of events.slice(seen)) print(e);
    seen = events.length;
    run = await findRun(cwd, run.id);
    if (run.status !== "running") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (run.status === "done") printResult(run.result);
  else console.log(red(`run ${run.status}: ${run.result?.error ?? ""}`));
}

async function waitCmd(cwd, id, o) {
  const run = await findRun(cwd, id);
  const seconds = o.seconds ? num(o.seconds, "seconds", 1, 3600) : 240;
  console.log(JSON.stringify(summarize(await waitForFinish(cwd, run.id, seconds)), null, 2));
}

async function cancelCmd(cwd, id) {
  const run = await findRun(cwd, id);
  if (run.status === "interrupted") {
    await reap(run);
    return console.log(`cleaned up interrupted run ${run.id}`);
  }
  if (run.status !== "running") return console.log(`run ${run.id} is ${run.status}`);
  await requestCancel(run);
  console.log(`cancelled ${run.id}`);
}

async function applyCmd(cwd, id, o) {
  const { label, files } = await applyRun(cwd, id, o.agent);
  console.log(`${green("✓ applied")} ${label} → ${files.join(", ")}`);
}

function trim(s = "", n) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
