import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { detect, registry } from "./agents.js";
import { manageLineup } from "./models.js";
import { startDetached, waitForFinish, waitForStart } from "./background.js";
import { loadConfig } from "./config.js";
import { run } from "./exec.js";
import { applyRun, findRun, listRuns, readEvents, reap, requestCancel } from "./runs.js";
import { VERSION } from "./version.js";

/**
 * Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited). No dependencies.
 *
 * Runs are long (minutes), and many hosts time out tool calls after ~1 min, so the flow is:
 *   argue_start  -> returns run_id immediately (run continues in a background process)
 *   argue_wait   -> blocks up to ~50s, returns live progress, or the final result when done
 *   argue_apply  -> applies the winning patch
 */
const SUPPORTED = ["2025-06-18", "2025-11-25", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "argue_start",
    annotations: { title: "Start argue run", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description:
      "Start an argue run: several AI coding agents (e.g. Claude Code, Codex, Gemini, Cursor, OpenCode, Pi) independently solve the same task in isolated copies of the repo, critique each other with evidence, revise, and a judge picks the best verified solution. Use for hard or high-stakes tasks, or when the user says 'argue'. Returns a run_id immediately; then call argue_wait repeatedly until status is done. Does not modify the user's files unless apply=true.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Complete, self-contained task description: goal, relevant files, constraints, what has been tried. Agents do not see this conversation.",
        },
        cwd: { type: "string", description: "Absolute path of the project directory." },
        context: { type: "string", description: "Optional extra context from this session (findings, errors, logs) to share with all agents." },
        mode: {
          type: "string",
          enum: ["code", "ask"],
          description:
            "code (default): agents edit files and a winning patch is produced. ask: agents debate an answer without editing (design, debugging, analysis).",
        },
        agents: {
          type: "string",
          description: 'Comma-separated lineup, e.g. "claude,codex" or "claude:opus,claude:sonnet@high". Omit to auto-pick from installed CLIs.',
        },
        judge: { type: "string", description: "Agent that picks the winner. Omit to auto-pick." },
        check: { type: "string", description: 'Acceptance command run in each copy, e.g. "npm test". Omit to auto-detect; "none" to disable.' },
        rounds: { type: "number", description: "Max critique/revise rounds (default 2)." },
        budget: { type: "number", description: "USD budget (enforced for CLIs that report cost)." },
        apply: { type: "boolean", description: "Apply the winning patch to the working tree when done (default false)." },
      },
      required: ["task", "cwd"],
    },
  },
  {
    name: "argue_wait",
    annotations: { title: "Wait for argue run", readOnlyHint: true, openWorldHint: false },
    description:
      "Wait for an argue run (up to `seconds`, default 50) and return its progress, or the final result once done. Call repeatedly until status is 'done' or 'failed'. Show the user brief progress between calls.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" }, cwd: { type: "string" }, seconds: { type: "number" } },
      required: ["run_id", "cwd"],
    },
  },
  {
    name: "argue_apply",
    annotations: { title: "Apply argue result", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: "Apply a finished run's winning patch (or a specific agent's patch) to the project working tree.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        cwd: { type: "string" },
        agent: { type: "string", description: "Agent letter (A, B, …) to apply instead of the winner." },
      },
      required: ["run_id", "cwd"],
    },
  },
  {
    name: "argue_cancel",
    annotations: { title: "Cancel argue run", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Cancel a running argue run.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, cwd: { type: "string" } }, required: ["run_id", "cwd"] },
  },
  {
    name: "argue_lineup",
    annotations: { title: "Show or set argue lineup", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Call this FIRST in every argue session, before writing the brief, and show the user the returned `display` as-is. Shows the default lineup (harness, model, effort for each competing agent), or sets a new one. Setting checks that each model and effort is available first, then saves it as the user\'s default. Format: comma-separated agent[:model][@effort], e.g. "claude:opus@high,codex:gpt-5@medium,pi". Harnesses: claude, codex, gemini, cursor, opencode, pi.',
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute path of the project directory." },
        agents: { type: "string", description: "New lineup to check and save. Omit to just show the current one." },
        reset: { type: "boolean", description: "Go back to the automatic lineup." },
      },
      required: ["cwd"],
    },
  },
  {
    name: "argue_runs",
    annotations: { title: "List argue runs", readOnlyHint: true, openWorldHint: false },
    description: "List recent argue runs in a project.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } }, required: ["cwd"] },
  },
  {
    name: "argue_agents",
    annotations: { title: "List argue agents", readOnlyHint: true, openWorldHint: false },
    description: "List which coding-agent CLIs are installed and usable as argue participants.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
  },
];

export function startMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  let buf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line, send);
    }
  });
  input.on("end", () => process.exit(0));
  // Never let a stray error kill the server (the host would lose all argue tools).
  process.on("uncaughtException", (err) => process.stderr.write(`argue mcp: ${err.stack ?? err}\n`));
  process.on("unhandledRejection", (err) => process.stderr.write(`argue mcp: ${err?.stack ?? err}\n`));
}

async function handle(line, send) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    const result = await dispatch(method, params ?? {}, (p) => send({ jsonrpc: "2.0", method: "notifications/progress", params: p }));
    send({ jsonrpc: "2.0", id, result });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: err.code ?? -32603, message: err.message } });
  }
}

async function dispatch(method, params, progress) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: "argue", title: "argue", version: VERSION },
        instructions:
          "Use argue for hard or high-stakes coding tasks: argue_start, then argue_wait until done, then show the user the winner, reason, risks and files, and ask before argue_apply.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      try {
        const out = await callTool(params.name, params.arguments ?? {}, params._meta?.progressToken, progress);
        return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `argue: ${err.message}` }] };
      }
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default: {
      const err = new Error(`method not found: ${method}`);
      err.code = -32601;
      throw err;
    }
  }
}

export async function callTool(name, a, progressToken, progress = () => {}) {
  const cwd = a.cwd || process.cwd();
  if (!isAbsolute(cwd)) throw new Error(`cwd must be an absolute path (got "${cwd}")`);
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  if (!["argue_start", "argue_runs", "argue_agents", "argue_lineup"].includes(name) && !a.run_id) throw new Error("run_id is required");
  switch (name) {
    case "argue_start": {
      if (Number(process.env.ARGUE_DEPTH || 0) > 0) throw new Error("you are an agent inside an argue run; nested argue runs are not allowed");
      if (!a.task || !String(a.task).trim()) throw new Error("task is required");
      if (a.mode && !["code", "ask"].includes(a.mode)) throw new Error('mode must be "code" or "ask"');
      // The task goes through a file so its text is never parsed as CLI flags.
      const taskFile = join(tmpdir(), `argue-task-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
      writeFileSync(taskFile, String(a.task));
      const args = ["-f", taskFile, "--json"];
      if (a.mode) args.push("--mode", a.mode);
      if (a.agents) args.push("--agents", a.agents);
      if (a.judge) args.push("--judge", a.judge);
      if (a.check) args.push("--check", a.check);
      if (a.rounds != null) args.push("--rounds", String(a.rounds));
      if (a.budget != null) args.push("--budget", String(a.budget));
      if (a.context) args.push(`--context=${a.context}`);
      if (a.apply) args.push("--apply");
      const started = startDetached({ cwd, args });
      const run = await waitForStart(cwd, started);
      return {
        run_id: started.runId,
        status: "running",
        lineup: run.meta.agents,
        display: run.meta.display,
        note: run.meta.note,
        next: "If you have not shown the user this lineup yet in this session (or it changed), show `display` exactly as-is. Then call argue_wait with this run_id until status is done. If the user asks to add a harness or change a model or effort, call argue_cancel, then argue_lineup with the new lineup (it checks and saves it), then argue_start again with the same task.",
      };
    }
    case "argue_wait": {
      const seconds = Math.min(Math.max(Number(a.seconds) || 50, 1), 600);
      let n = 0;
      const timer = progressToken !== undefined ? setInterval(() => progress({ progressToken, progress: ++n, message: "argue running" }), 10_000) : null;
      try {
        const run = await waitForFinish(cwd, a.run_id, seconds);
        if (!run) throw new Error(`run ${a.run_id} not found`);
        return summarize(run);
      } finally {
        if (timer) clearInterval(timer);
      }
    }
    case "argue_apply": {
      const { label, file, files } = await applyRun(cwd, a.run_id, a.agent);
      return { applied: true, what: label, patch: file, files };
    }
    case "argue_cancel": {
      const run = await findRun(cwd, a.run_id);
      if (run.status === "interrupted") {
        await reap(run);
        return { status: "interrupted", cleaned_up: true };
      }
      if (run.status !== "running") return { status: run.status };
      await requestCancel(run);
      return { status: "cancelled" };
    }
    case "argue_lineup":
      return lineupTool(cwd, a);
    case "argue_runs":
      return (await listRuns(cwd)).slice(0, 20).map((r) => ({ run_id: r.id, status: r.status, task: r.meta.task, winner: r.result?.winner?.agent ?? null }));
    case "argue_agents": {
      const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
      const drivers = registry(loadConfig(top.code === 0 ? top.stdout.trim() : cwd));
      const found = await detect(drivers);
      return Object.entries(drivers).map(([kind, d]) => ({ agent: kind, name: d.title, installed: Boolean(found[kind]), install: d.install }));
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function lineupTool(cwd, a) {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  const res = await manageLineup(top.code === 0 ? top.stdout.trim() : cwd, { agents: a.agents, reset: a.reset });
  if (res.saved === false) return { ...res, next: "Tell the user which model or effort is not available and ask what to use instead." };
  return res;
}

/** Compact status for host agents: progress while running, full result when done. */
export function summarize(run) {
  if (run.status === "done") {
    const r = run.result;
    return {
      run_id: run.id,
      status: "done",
      winner: r.winner,
      reason: r.reason,
      risks: r.risks,
      agents: r.agents,
      ...(r.mode === "code" ? { files: r.files, patch: r.patch, applied: r.applied, apply_error: r.applyError } : { answer: r.answer }),
      cost_usd: r.costUsd,
      report: r.report,
      next:
        r.mode === "code" && !r.applied ? "Show the user the winner, reason, risks and files. Ask before calling argue_apply." : "Show the user the result.",
    };
  }
  if (run.status === "failed" || run.status === "interrupted")
    return { run_id: run.id, status: run.status, error: run.result?.error ?? "run stopped unexpectedly" };
  const events = readEvents(run.path);
  const phases = events.filter((e) => e.type === "phase");
  const phase = phases.at(-1);
  const calls = events.filter((e) => e.type === "call" && e.status === "done");
  const lastCost = calls.at(-1)?.spentUsd ?? 0;
  const recent = events
    .filter((e) => (e.type === "call" && e.status === "done") || e.type === "check" || e.type === "note" || e.type === "objections")
    .slice(-8)
    .map((e) =>
      e.type === "call"
        ? `${e.who} ${e.phase} ${e.ok ? "ok" : `failed: ${e.error}`} (${e.secs}s)`
        : e.type === "check"
          ? `${e.who} check ${e.pass ? "passed" : "failed"}`
          : e.type === "objections"
            ? `${e.who}: ${e.count} objection(s)`
            : e.text,
    );
  const elapsed = Math.round((Date.now() - (events[0]?.t ?? Date.now())) / 1000);
  return {
    run_id: run.id,
    status: "running",
    phase: phase ? `${phase.name}${phase.round ? ` (round ${phase.round})` : ""}` : "setup",
    elapsed_s: elapsed,
    calls_done: calls.length,
    spent_usd: Math.round(lastCost * 100) / 100,
    recent,
    next: "call argue_wait again",
  };
}
