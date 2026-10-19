import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultJudge, defaultLineup, detect, parseAgents, registry } from "./agents.js";
import { argue } from "./argue.js";
import { startDetached } from "./background.js";
import { detectCheck, loadConfig, userConfigPath, writeConfig } from "./config.js";
import { killAll } from "./exec.js";
import { applyPatch, hasGit } from "./git.js";
import { install } from "./install.js";
import { startMcpServer, summarize } from "./mcp.js";
import { findRun, listRuns, readEvents } from "./runs.js";
import { bold, cyan, dim, green, printResult, progressPrinter, red, yellow } from "./ui.js";
import { VERSION } from "./version.js";

const HELP = `${bold("argue")} — make AI coding agents argue over your task until the best solution wins.

${bold("Usage")}
  argue "<task>" [options]         run a task (code mode: agents edit, you get the winning patch)
  argue "<question>" --mode ask    debate an answer, no file changes
  argue apply [run] [--agent B]    apply a run's winning patch (or another agent's)
  argue show [run]                 print a run's report
  argue runs                       list runs in this project
  argue watch [run]                follow a running run's progress
  argue doctor                     check which agent CLIs are installed
  argue init                       set default agents for your machine
  argue install [targets…]         add /argue to your agents (skill + MCP); targets:
                                   skill claude codex cursor gemini opencode pi
  argue uninstall [targets…]       remove those integrations
  argue mcp                        run the MCP server (used by editors/agents)

${bold("Options")}
  -a, --agents <list>    competitors, e.g. "claude,codex,gemini" or "claude:opus,claude:sonnet@high"
  -j, --judge <agent>    who picks the winner (default: an installed CLI that isn't competing)
  -c, --check <cmd>      acceptance command run in every copy (default: auto-detect; "none" to skip)
  -m, --mode <mode>      code (default) or ask
  -r, --rounds <n>       max critique/revise rounds (default 2)
  -b, --budget <usd>     spending cap (enforced for CLIs that report cost: Claude Code, OpenCode, Pi)
  -t, --timeout <min>    timeout per agent call in minutes (default 20)
  -f, --file <path>      read the task from a file ("-" = stdin)
      --context <text>   extra context shared with every agent
      --apply            apply the winning patch when done
      --bg               run in the background; prints the run id (use argue watch / apply)
      --keep             keep agent worktrees for inspection
      --json             print the result as JSON (progress goes to stderr)
  -v, --version · -h, --help

${bold("Agents")}  claude · codex · gemini · cursor · opencode · pi · plus custom ones in config
         format: agent[:model][@effort]   e.g. codex:gpt-5@high, pi:openrouter/deepseek/deepseek-r1

Everything runs locally through the agent CLIs you already use and are logged in to.
Config: ${userConfigPath()} and <project>/.argue.json`;

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
  apply: { type: "boolean" },
  bg: { type: "boolean" },
  keep: { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
};

const COMMANDS = new Set(["apply", "show", "runs", "watch", "doctor", "init", "install", "uninstall", "mcp", "help", "version"]);

export async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, strict: true });
  if (o.version) return console.log(VERSION);
  const cmd = positionals.length && COMMANDS.has(positionals[0]) && !(o.file || positionals.length > 2) ? positionals[0] : null;
  const rest = cmd ? positionals.slice(1) : positionals;
  const cwd = process.cwd();

  if (o.help || cmd === "help" || (!cmd && !rest.length && !o.file)) return console.log(HELP);
  if (cmd === "version") return console.log(VERSION);
  if (cmd === "mcp") return startMcpServer();
  if (cmd === "doctor") return doctor(cwd);
  if (cmd === "init") return init(cwd);
  if (cmd === "install" || cmd === "uninstall") return integrations(rest, cmd === "uninstall");
  if (cmd === "runs") return runsCmd(cwd, o);
  if (cmd === "show") return show(cwd, rest[0], o);
  if (cmd === "watch") return watch(cwd, rest[0]);
  if (cmd === "apply") return applyCmd(cwd, rest[0], o);
  return runTask(cwd, rest, o, argv);
}

// ---------------------------------------------------------------- run

async function runTask(cwd, rest, o, argv) {
  const config = loadConfig(cwd);
  const drivers = registry(config);
  let task = rest.join(" ").trim();
  if (o.file) task = (o.file === "-" ? readFileSync(0, "utf8") : readFileSync(o.file, "utf8")).trim();
  if (!task) throw new Error("empty task");

  const mode = o.mode ?? config.mode ?? "code";
  if (!["code", "ask"].includes(mode)) throw new Error(`--mode must be "code" or "ask"`);
  if (!(await hasGit())) throw new Error("git is required (https://git-scm.com/downloads)");

  const installedMap = await detect(drivers);
  const installed = Object.keys(installedMap);
  const lineup = o.agents ?? config.agents ?? defaultLineup(installed);
  if (!lineup) throw new Error(`no agent CLIs found. Install at least one of: Claude Code, Codex, Gemini CLI, Cursor CLI, OpenCode, Pi.\nRun "argue doctor" for install commands.`);
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
  else if (check === "auto" || check == null) check = mode === "code" ? detectCheck(await projectRoot(cwd)) : null;

  const rounds = num(o.rounds ?? config.rounds, "rounds", 0, 10);
  const budget = o.budget ?? config.budget ? num(o.budget ?? config.budget, "budget", 0, 10000) : undefined;
  const timeout = num(o.timeout ?? config.timeout, "timeout", 1, 600);

  if (o.bg) {
    const args = argv.filter((a) => a !== "--bg");
    const { runId, log } = startDetached({ cwd, args });
    console.log(`${green("started")} ${runId}\n  ${dim("follow:")}  argue watch ${runId}\n  ${dim("apply:")}   argue apply ${runId}\n  ${dim("log:")}     ${log}`);
    return;
  }

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
    const result = await argue({ task, agents, judge, drivers, installed: installedMap, cwd, mode, check, rounds, budget, timeout, apply: o.apply, keep: o.keep, ctx: o.context ?? "", runId: o["run-id"], onEvent, signal: controller.signal });
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
  const { run } = await import("./exec.js");
  const r = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  return r.code === 0 ? r.stdout.trim() : cwd;
}

// ---------------------------------------------------------------- doctor / init / install

async function doctor(cwd) {
  const config = loadConfig(cwd);
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
    if (new Set(agents.map((a) => a.kind)).size === 1) console.log(dim("  tip: agents from different vendors catch more of each other's mistakes; install another CLI if you can."));
  }
  const check = detectCheck(await projectRoot(cwd));
  console.log(`${bold("Check here")}      ${check ?? dim("none detected (pass --check)")}`);
  console.log(dim(`\nLogin issues? Run each CLI once on its own (e.g. "claude", "codex") to sign in.`));
}

async function init(cwd) {
  const drivers = registry(loadConfig(cwd));
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
  for (const r of results) {
    const mark = r.status === "error" ? red("✗") : r.status === "skipped" ? dim("·") : green("✓");
    console.log(`  ${mark} ${r.title.padEnd(60)} ${r.status === "skipped" ? dim(r.detail) : r.status === "error" ? red(r.detail) : dim(r.detail)}`);
  }
  if (!remove) console.log(dim(`\nRestart your agents, then ask: "argue <task>" (or /argue in Gemini, OpenCode, Pi).`));
}

// ---------------------------------------------------------------- runs

async function runsCmd(cwd, o) {
  const runs = await listRuns(cwd);
  if (o.json) return console.log(JSON.stringify(runs.map((r) => ({ id: r.id, status: r.status, task: r.meta.task, winner: r.result?.winner ?? null })), null, 2));
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

async function applyCmd(cwd, id, o) {
  const run = await findRun(cwd, id);
  if (run.status !== "done") throw new Error(`run ${run.id} is ${run.status}`);
  if (run.result.mode !== "code") throw new Error("ask-mode runs have no patch");
  const file = o.agent ? join(run.path, `${o.agent.toUpperCase()}.patch`) : run.result.patch;
  if (!existsSync(file)) throw new Error(`no patch for agent ${o.agent}`);
  await applyPatch(run.result.project, file);
  console.log(`${green("✓ applied")} ${o.agent ? `agent ${o.agent.toUpperCase()}` : `winner ${run.result.winner.id} (${run.result.winner.agent})`} → ${run.result.files.join(", ")}`);
}

function trim(s = "", n) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
