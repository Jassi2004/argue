import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultJudge, defaultLineup, detect, parseAgents, registry, sharedServers } from "./agents/drivers.js";
import { checkLimits, describe, harnessDefaults, limitsText, lineupNote, manageLineup, runLimits } from "./agents/lineup.js";
import { detectCheck, loadConfig } from "./config.js";
import { install } from "./integrations/install.js";
import { startMcpServer, summarize } from "./integrations/mcp.js";
import { markSetupDone, maybeOfferSetup } from "./integrations/setup.js";
import { runRoom } from "./room/index.js";
import { startDetached, waitForFinish, waitForStart } from "./runs/background.js";
import { askAbout } from "./runs/followup.js";
import { applyRun, findRun, listRuns, readEvents, readText, reap, reapStale, requestCancel } from "./runs/store.js";
import { killAll, run } from "./util/exec.js";
import { bold, cyan, dim, green, lineupBox, printResult, progressPrinter, red, yellow } from "./util/ui.js";
import { VERSION } from "./util/version.js";
import { hasGit } from "./workspace/git.js";

const HELP = `${bold("argue")} — put several AI models in a room; they argue it out; you get one vetted answer.

${bold("Start")}
  argue "<question or task>"      an answer, or a code change (your files change only when you apply)

${bold("After a run")}
  argue ask "<follow-up>"         question the last answer ("why not Postgres?") from the run's record
  argue apply [run]               apply the code change
  argue show [run]                the whole debate: every post, challenge and revision
  argue runs                      list past runs
  argue watch [run]               follow a run live
  argue cancel [run]              stop a run

${bold("Setup")}
  argue doctor                    your agent CLIs, their default models, the lineup, shared tools
  argue lineup [a,b,…] [-b -r]    show or save your defaults: models, $ cap, rounds (e.g. argue lineup opus,codex -b 5)
  argue install / uninstall       connect argue to your coding agents, or remove it

${bold("Options")}
  -a, --agents <list>    who argues: models (opus,gpt-6.1-sol@high), CLIs (claude,codex) or claude:sonnet
  -c, --check <cmd>      command that proves a code change works (auto-detected; "none" to skip)
  -r, --rounds <n>       most rounds after the opening (default 4; rooms usually settle sooner)
  -b, --budget <usd>     $ cap per run (default 10; "none" for no cap). Counted for CLIs that report cost
      --minutes <n>      no new round starts after this (default 60)
  -m, --mode <mode>      code (agents change files) or answer (agents argue out an answer); default: guessed
  -f, --file <path>      read the task from a file ("-" for stdin)
      --apply            apply the change automatically when done
      --bg               run in the background (then: argue watch / argue wait)
      --json             machine-readable output
      --verbose          also show costs, notes and every check
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
  minutes: { type: "string" },
  file: { type: "string", short: "f" },
  context: { type: "string" },
  agent: { type: "string" },
  "run-id": { type: "string" },
  run: { type: "string" },
  reset: { type: "boolean" },
  preview: { type: "boolean" },
  verbose: { type: "boolean" },
  seconds: { type: "string" },
  apply: { type: "boolean" },
  bg: { type: "boolean" },
  keep: { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
};

const COMMANDS = new Set(["ask", "apply", "show", "runs", "watch", "wait", "cancel", "doctor", "lineup", "install", "uninstall", "mcp", "help", "version"]);
const TARGETS = ["skill", "claude", "codex", "cursor", "gemini", "opencode", "pi"];

export async function main(argv) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, strict: true });
  if (o.version) return console.log(VERSION);
  const cmd = detectCommand(positionals, o);
  const rest = cmd ? positionals.slice(1) : positionals;
  const cwd = process.cwd();

  if (cmd === "mcp") return startMcpServer();
  // The first time a person uses argue at a terminal: offer to connect it to their agents (asked once).
  if (!o.json && !o.bg && !o.quiet && !["install", "uninstall", "wait", "version"].includes(cmd)) await maybeOfferSetup();
  if (o.help || cmd === "help" || (!cmd && !rest.length && !o.file)) return console.log(HELP);
  switch (cmd) {
    case "version":
      return console.log(VERSION);
    case "doctor":
      return doctor(cwd, o);
    case "lineup":
      return lineupCmd(cwd, rest, o);
    case "install":
    case "uninstall":
      return integrations(rest, cmd === "uninstall");
    case "runs":
      return runsCmd(cwd, o);
    case "show":
      return show(cwd, rest[0], o);
    case "watch":
      return watch(cwd, rest[0]);
    case "wait":
      return waitCmd(cwd, rest[0], o);
    case "cancel":
      return cancelCmd(cwd, rest[0]);
    case "apply":
      return applyCmd(cwd, rest[0], o);
    case "ask":
      return askCmd(cwd, rest, o);
  }
  return runTask(cwd, rest, o);
}

/**
 * `argue apply` is a command, `argue "apply the fix in parser.ts"` is a task.
 * A subcommand is the first word only when it is its own argument and takes at most its own arguments.
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
  if (first === "lineup") return more.every((m) => !/\s/.test(m)) ? first : null;
  if (first === "ask") return more.length ? first : null;
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

/**
 * Pick the mode from the task itself, so the user never has to: "code" when they ask for a change
 * to the project, "answer" for questions, decisions, plans, writing and research.
 */
export function guessMode(task) {
  const t = task.toLowerCase();
  const question =
    /^\s*(what|which|why|how|should|is|are|can|could|would|does|do|when|where|who|compare|explain|evaluate|recommend|review|summari[sz]e|tell me)\b/.test(t) ||
    /\?\s*$/.test(t);
  const change =
    /\b(fix|implement|add|refactor|rewrite|migrate|update|remove|delete|rename|build|create|write (a |the )?(test|function|script|endpoint|component|class|module|code)|make (it|the|this) (pass|work|faster)|optimi[sz]e|debug|patch|upgrade|port)\b/.test(
      t,
    );
  return change && !question ? "code" : "answer";
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

  const mode = o.mode ?? (config.mode && config.mode !== "auto" ? config.mode : null) ?? guessMode(task);
  if (!["code", "answer"].includes(mode)) throw new Error(`--mode must be "code" (agents change files) or "answer" (agents argue out an answer)`);
  if (!(await hasGit())) throw new Error("git is required (https://git-scm.com/downloads)");

  const installedMap = await detect(drivers);
  const installed = Object.keys(installedMap);
  const lineup = o.agents ?? config.agents ?? defaultLineup(installed);
  if (!lineup)
    throw new Error(
      `no agent CLIs found. Install at least one of: Claude Code, Codex, Gemini CLI, Cursor CLI, OpenCode, Pi.\nRun "argue doctor" for install commands.`,
    );
  const agents = parseAgents(lineup, drivers);
  if (agents.length < 2)
    throw new Error(
      `a room needs at least two agents. With one CLI, use two of its models (e.g. -a claude:opus,claude:sonnet) or the same one twice (-a ${agents[0].kind},${agents[0].kind})`,
    );
  if (agents.length > 8) throw new Error("at most 8 agents");
  const missing = [...new Set(agents.filter((a) => !installedMap[a.kind]).map((a) => a.kind))];
  if (missing.length) throw new Error(`not installed: ${missing.join(", ")}. Run "argue doctor".`);
  const [judge] = parseAgents(o.judge ?? config.judge ?? defaultJudge(installed, agents), drivers);
  if (!installedMap[judge.kind]) throw new Error(`"${judge.kind}" (for the final answer) is not installed`);

  let check = o.check ?? config.check;
  if (check === "none" || check === false || check === "") check = null;
  else if (check === "auto" || check == null) check = mode === "code" ? detectCheck(root) : null;

  const limits = runLimits(config, checkLimits({ rounds: o.rounds, budget: o.budget, minutes: o.minutes }));
  checkLimits(limits); // settings files are checked too
  const { rounds, minutes } = limits;
  const budget = limits.budget ?? undefined;
  const timeout = num(o.timeout ?? config.timeout, "timeout", 1, 600);

  if (o.bg) {
    // Rebuild the child's arguments from resolved settings; the task goes through a file so nothing in it is parsed as flags.
    if (o.file === "-") throw new Error("--bg cannot read the task from stdin; write it to a file and use -f <file>");
    const taskFile = join(tmpdir(), `argue-task-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(taskFile, task);
    const args = ["-f", taskFile, "--mode", mode, "--agents", agents.map((a) => a.name).join(","), "--judge", judge.name];
    args.push("--check", check ?? "none", "--rounds", String(rounds), "--timeout", String(timeout), "--minutes", String(minutes));
    args.push("--budget", budget ? String(budget) : "none");
    if (o.context) args.push(`--context=${o.context}`);
    if (o.apply) args.push("--apply");
    if (o.keep) args.push("--keep");
    const started = startDetached({ cwd, args });
    const { runId, log } = started;
    const r = await waitForStart(cwd, started);
    if (o.json)
      return console.log(
        JSON.stringify(
          { run_id: runId, status: "running", lineup: r.meta.agents, display: r.meta.display, note: r.meta.note, next: `argue wait ${runId}` },
          null,
          2,
        ),
      );
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

  const write = o.json ? (s) => process.stderr.write(`${s}\n`) : (s) => process.stdout.write(`${s}\n`);
  const onEvent = o.quiet ? () => {} : progressPrinter(write, { verbose: o.verbose });

  try {
    const result = await runRoom({
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
      minutes,
      mcp: config.mcp,
      apply: o.apply,
      keep: o.keep,
      context: o.context ?? "",
      runId: o["run-id"],
      onEvent,
      signal: controller.signal,
    });
    if (o.json) console.log(JSON.stringify(result, null, 2));
    else if (!o.quiet) printResult(result);
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

// ---------------------------------------------------------------- setup

async function doctor(cwd, o = {}) {
  const root = await projectRoot(cwd);
  const config = loadConfig(root);
  const drivers = registry(config);
  const found = await detect(drivers);
  const installed = Object.keys(found);
  const lineup = config.agents ?? defaultLineup(installed);
  const agents = lineup ? parseAgents(lineup, drivers) : [];
  const descs = agents.map((a) => describe(a, { drivers, cwd: root }));
  const check = config.check && config.check !== "auto" ? config.check : detectCheck(root);
  const shared = sharedServers(config.mcp, found);

  if (o.json)
    return console.log(
      JSON.stringify(
        {
          version: VERSION,
          git: await hasGit(),
          harnesses: Object.entries(drivers).map(([kind, d]) => ({
            agent: kind,
            name: d.title,
            installed: Boolean(found[kind]),
            ...harnessDefaults(kind, { cwd: root }),
          })),
          lineup: descs,
          lineupSource: config.agents ? "saved" : "automatic",
          note: descs.length ? lineupNote(descs) : null,
          check,
          mcp: { configured: config.mcp, found: shared },
        },
        null,
        2,
      ),
    );

  console.log(`${bold("argue")} ${VERSION} · node ${process.versions.node} · ${process.platform}`);
  console.log(`  ${(await hasGit()) ? green("✓") : red("✗")} git`);
  console.log(`\n${bold("Agent CLIs")}                 ${dim("default model · effort")}`);
  for (const [kind, d] of Object.entries(drivers)) {
    if (!found[kind]) {
      console.log(`  ${dim("·")} ${dim(kind.padEnd(9))} ${dim(`${d.title} — install: ${d.install}`)}`);
      continue;
    }
    const def = describe({ kind, name: kind }, { drivers, cwd: root });
    const model = def.model ?? dim("account default");
    const effort = def.effortSupported ? (def.effort ?? dim("default")) : dim("n/a");
    console.log(
      `  ${green("✓")} ${kind.padEnd(9)} ${d.title.padEnd(14)} ${model} · ${effort}${def.model && def.modelSource ? dim(`  (${def.modelSource})`) : ""}`,
    );
  }

  console.log("");
  if (!descs.length) console.log(`${bold("Lineup")}  ${red("none — install at least one agent CLI")}`);
  else {
    for (const line of lineupBox(descs)) console.log(line);
    console.log(dim(`  ${config.agents ? "your saved default" : "automatic (from installed CLIs)"} · change: argue lineup <a,b,…>`));
  }
  if (agents.length && new Set(agents.map((a) => a.kind)).size === 1)
    console.log(dim("  tip: models from different labs catch more of each other's mistakes; install another CLI if you can."));

  console.log(
    `\n${bold("Shared tools")}  ${config.mcp.length ? "" : dim('no MCP servers shared with agents (add "mcp": ["name", …] to your config to share some)')}`,
  );
  for (const [kind, names] of Object.entries(shared)) {
    const missing = config.mcp.filter((n) => !names.includes(n));
    console.log(
      `  ${kind.padEnd(9)} ${names.length ? names.join(", ") : dim("none")}${missing.length ? dim(`  (not in its config: ${missing.join(", ")})`) : ""}`,
    );
  }
  console.log(`\n${bold("Check here")}  ${check ?? dim("none detected (pass --check)")}`);
  console.log(dim(`\nLogin issues? Run each CLI once on its own (e.g. "claude", "codex") to sign in.`));
}

/** argue lineup [a,b,…] | --reset: show, set (after checking models exist) or reset the default lineup. */
async function lineupCmd(cwd, rest, o) {
  const spec = rest.join(",").trim();
  if (spec && !o.preview && !o.json) process.stdout.write(dim("checking each model is available…\n"));
  const limits = { budget: o.budget, rounds: o.rounds, minutes: o.minutes };
  const res = await manageLineup(await projectRoot(cwd), { agents: spec || undefined, reset: o.reset, save: !o.preview, limits });
  if (o.json) {
    if (res.saved === false) process.exitCode = 1;
    return console.log(JSON.stringify(res, null, 2));
  }
  if (res.saved === false) throw new Error(`lineup not saved:\n${res.errors.map((e) => `  ${red("✗")} ${e.agent}: ${e.error}`).join("\n")}`);
  if (res.reset) console.log(`${green("✓")} back to the automatic lineup`);
  if (res.saved) console.log(`${green("✓")} saved as your default lineup`);
  if (res.overriddenByProject) console.log(yellow("note: this project's .argue.json sets its own agents, which override your default here"));
  for (const line of lineupBox(res.lineup)) console.log(line);
  console.log(`  limits: ${limitsText(res.limits)}`);
  console.log(
    dim(`  ${res.source === "saved" ? "your saved default" : "automatic"} · change: argue lineup <a,b,…> [-b usd] [-r rounds] · reset: argue lineup --reset`),
  );
}

async function integrations(only, remove) {
  const bad = only.filter((t) => !TARGETS.includes(t));
  if (bad.length) throw new Error(`unknown target(s): ${bad.join(", ")} (choose from: ${TARGETS.join(" ")})`);
  const results = await install({ only: only.length ? only : undefined, uninstall: remove });
  // Either way the user has made a choice, so the first-run prompt should not appear again.
  if (!only.length) markSetupDone();
  for (const r of results) {
    const mark = r.status === "error" ? red("✗") : r.status === "skipped" ? dim("·") : green("✓");
    console.log(`  ${mark} ${r.title.padEnd(60)} ${r.status === "error" ? red(r.detail) : dim(r.detail)}`);
  }
  if (!remove) console.log(dim(`\nRestart your agents, then ask: "argue <task>" (or /argue in Gemini, OpenCode, Pi).`));
}

// ---------------------------------------------------------------- runs

async function runsCmd(cwd, o) {
  const runs = await listRuns(cwd);
  if (o.json)
    return console.log(
      JSON.stringify(
        runs.map((r) => ({ id: r.id, status: r.status, task: r.meta.task, outcome: r.result?.outcome ?? null })),
        null,
        2,
      ),
    );
  if (!runs.length) return console.log("no runs yet");
  for (const r of runs.slice(0, 30)) {
    const st = r.status === "done" ? green("done") : r.status === "running" ? yellow("running") : red(r.status);
    console.log(`${cyan(r.id)}  ${st.padEnd(16)} ${dim(trim(r.meta.task, 80))}`);
  }
}

async function show(cwd, id, o) {
  const r = await findRun(cwd, id);
  if (o.json) return console.log(JSON.stringify(r.result ?? summarize(r), null, 2));
  const record = readText(r, "room.md");
  if (record) return console.log(record);
  console.log(JSON.stringify(summarize(r), null, 2));
}

async function watch(cwd, id) {
  let r = await findRun(cwd, id);
  const print = progressPrinter();
  let seen = 0;
  for (;;) {
    const events = readEvents(r.path);
    for (const e of events.slice(seen)) print(e);
    seen = events.length;
    r = await findRun(cwd, r.id);
    if (r.status !== "running") break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (r.status === "done") printResult(r.result);
  else console.log(red(`run ${r.status}${r.result?.error ? `: ${r.result.error}` : ""}`));
}

async function waitCmd(cwd, id, o) {
  const r = await findRun(cwd, id);
  const seconds = o.seconds ? num(o.seconds, "seconds", 1, 3600) : 240;
  console.log(JSON.stringify(summarize(await waitForFinish(cwd, r.id, seconds)), null, 2));
}

async function cancelCmd(cwd, id) {
  const r = await findRun(cwd, id);
  if (r.status === "interrupted") {
    await reap(r);
    return console.log(`cleaned up interrupted run ${r.id}`);
  }
  if (r.status !== "running" && r.status !== "stuck") return console.log(`run ${r.id} is ${r.status}`);
  await requestCancel(r);
  console.log(`cancelled ${r.id}`);
}

/** argue ask "why not Postgres?" [--run <id>]: answer a follow-up from the latest (or given) run's record. */
async function askCmd(cwd, rest, o) {
  const question = rest.join(" ").trim();
  if (!question) throw new Error('ask a question, e.g. argue ask "why not Postgres?"');
  const root = await projectRoot(cwd);
  const config = loadConfig(root);
  const drivers = registry(config);
  const installedMap = await detect(drivers);
  const r = await findRun(cwd, o.run);
  const lineup = parseAgents(r.meta.agents?.map((a) => a.agent) ?? (config.agents || defaultLineup(Object.keys(installedMap))), drivers);
  const [agent] = parseAgents(o.judge ?? r.meta.judge ?? defaultJudge(Object.keys(installedMap), lineup), drivers);
  if (!installedMap[agent.kind]) throw new Error(`${agent.kind} is not installed`);
  if (!o.json) process.stderr.write(dim("reading the record of that run…\n"));
  const res = await askAbout({ cwd, id: r.id, question, agent, drivers, installed: installedMap });
  if (o.json) return console.log(JSON.stringify(res, null, 2));
  console.log(`\n${res.answer}\n`);
}

async function applyCmd(cwd, id, o) {
  const { label, files } = await applyRun(cwd, id, o.agent);
  console.log(`${green("✓ applied")} ${label} → ${files.join(", ")}`);
}

function trim(s = "", n) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
