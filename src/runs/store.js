import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killPid, run as exec } from "../util/exec.js";
import { removeTree, writeAtomic, writeJson } from "../util/fs.js";
import { applyPatch, diffFiles } from "../workspace/git.js";

/**
 * Run records: everything about a run lives in <project>/.argue/runs/<id>/ (git-ignored):
 *
 *   meta.json      task, lineup, status, pid, start/end time
 *   events.jsonl   live progress (argue watch, the MCP server's argue_wait)
 *   room.json      the room's full state, saved after every round
 *   room.md        the same, readable: every post and challenge (argue show, argue ask)
 *   work/          each agent's latest work (A.md or A.patch) and winner.patch
 *   answer.md      the final answer
 *   result.json    the final result (status done/failed)
 *   beat           heartbeat: the run process is alive and responsive
 *   pids           agent processes still running (so a killed run can be cleaned up)
 *   cancel         dropped by `argue cancel`; the run notices and stops
 */

export function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

const BEAT_MS = 15_000;
const STUCK_MS = 120_000;

/** The writer for a run that is starting in this process. */
export function openRecord(runDir, meta) {
  mkdirSync(join(runDir, "work"), { recursive: true });
  const file = (f) => join(runDir, f);
  writeJson(file("meta.json"), { ...meta, status: "running", startedAt: new Date().toISOString(), pid: process.pid });
  const beat = () => {
    try {
      writeFileSync(file("beat"), String(Date.now()));
    } catch {}
  };
  beat();
  const beater = setInterval(beat, BEAT_MS);
  beater.unref();
  return {
    emit(ev) {
      const e = { t: Date.now(), ...ev };
      try {
        appendFileSync(file("events.jsonl"), `${JSON.stringify(e)}\n`);
      } catch {}
      return e;
    },
    onCancel(fn) {
      const poll = setInterval(() => existsSync(file("cancel")) && fn(), 500);
      poll.unref();
      return () => clearInterval(poll);
    },
    saveRoom: (room) => writeJson(file("room.json"), room),
    saveRecord: (text) => writeAtomic(file("room.md"), text),
    saveAnswer: (text) => writeAtomic(file("answer.md"), `${text.trim()}\n`),
    saveWork(id, mode, text, name = id) {
      if (!text) return null;
      const path = file(join("work", `${name}.${mode === "code" ? "patch" : "md"}`));
      writeAtomic(path, text);
      return path;
    },
    savePids(pids) {
      try {
        writeFileSync(file("pids"), [...pids].join("\n"));
      } catch {}
    },
    finish(result) {
      writeJson(file("result.json"), result);
      try {
        const m = JSON.parse(readFileSync(file("meta.json"), "utf8"));
        writeJson(file("meta.json"), { ...m, status: result.status, endedAt: new Date().toISOString() });
      } catch {}
    },
    close() {
      clearInterval(beater);
      rmSync(file("pids"), { force: true });
    },
  };
}

// ---------------------------------------------------------------- reading runs

/** Where runs for a project are stored. */
export async function runsDir(cwd) {
  const res = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  return join(res.code === 0 ? res.stdout.trim() : cwd, ".argue", "runs");
}

export async function listRuns(cwd) {
  const dir = await runsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => existsSync(join(dir, id, "meta.json")))
    .sort()
    .reverse()
    .map((id) => loadRun(dir, id));
}

/** Read a JSON file another process may be writing at this moment (retry once on a torn read). */
function readJsonFile(file) {
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
    }
  }
  return null;
}

/**
 * A run and its status: running · done · failed · interrupted (its process died) ·
 * stuck (its process is alive but stopped responding, e.g. frozen).
 */
export function loadRun(dir, id) {
  const path = join(dir, id);
  const meta = readJsonFile(join(path, "meta.json")) ?? {};
  const result = readJsonFile(join(path, "result.json"));
  let status = result?.status ?? meta.status ?? "unknown";
  if (status === "running") {
    if (meta.pid && !alive(meta.pid)) status = "interrupted";
    else if (Date.now() - lastBeat(path, meta) > STUCK_MS) status = "stuck";
  }
  return { id, path, meta, result, status };
}

function lastBeat(path, meta) {
  try {
    return Number(readFileSync(join(path, "beat"), "utf8")) || 0;
  } catch {
    return Date.parse(meta.startedAt ?? "") || Date.now();
  }
}

export async function findRun(cwd, id) {
  const runs = await listRuns(cwd);
  if (!runs.length) throw new Error("no argue runs in this project yet");
  if (!id || id === "last") return runs[0];
  const hit = runs.find((r) => r.id === id) ?? runs.find((r) => r.id.includes(id));
  if (!hit) throw new Error(`no run matching "${id}"`);
  return hit;
}

export function readEvents(path) {
  let text;
  try {
    text = readFileSync(join(path, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // a line still being written
  }
  return out;
}

export function readText(run, file) {
  try {
    return readFileSync(join(run.path, file), "utf8");
  } catch {
    return "";
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// ---------------------------------------------------------------- acting on runs

/**
 * Ask a run to stop. The run polls for the cancel file and stops itself (agents killed, desks
 * removed). A run that doesn't stop within the grace period is killed, then cleaned up here.
 */
export async function requestCancel(run, graceMs = 15000) {
  writeFileSync(join(run.path, "cancel"), String(Date.now()));
  if (run.status === "running" && process.platform !== "win32") {
    try {
      process.kill(run.meta.pid, "SIGTERM");
    } catch {}
  }
  const end = Date.now() + (run.status === "stuck" ? 0 : graceMs);
  while (Date.now() < end) {
    if (!alive(run.meta.pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(run.meta.pid, "SIGKILL");
  } catch {}
  await reap(run);
  return false;
}

/** Kill agent processes recorded by a run that could not clean up after itself. */
export function killChildren(path) {
  try {
    for (const pid of readFileSync(join(path, "pids"), "utf8").split(/\s+/).filter(Boolean)) killPid(Number(pid));
  } catch {}
}

/** Clean up after a run whose process died or froze: stop its agents, drop its desks, record why. */
export async function reap(run) {
  if (run.status === "stuck") {
    try {
      process.kill(run.meta.pid, "SIGKILL");
    } catch {}
  }
  killChildren(run.path);
  rmSync(join(run.path, "pids"), { force: true });
  const base = join(realpathSync.native(tmpdir()), "argue");
  const scratch =
    run.meta.scratch ??
    (existsSync(base)
      ? readdirSync(base)
          .map((d) => join(base, d))
          .find((d) => d.endsWith(`-${run.id}`))
      : null);
  if (scratch && existsSync(scratch)) removeTree(scratch);
  if (run.meta.project) await exec("git", ["worktree", "prune"], { cwd: run.meta.project });
  if (!run.result) {
    const error = run.status === "stuck" ? "the argue process stopped responding and was stopped" : "the argue process stopped unexpectedly";
    try {
      writeJson(join(run.path, "result.json"), { runId: run.id, status: "interrupted", error });
    } catch {}
  }
}

/** Reap every dead or frozen run in the project (cheap; called before each new run). */
export async function reapStale(cwd) {
  for (const r of await listRuns(cwd))
    if ((r.status === "interrupted" || r.status === "stuck") && (existsSync(join(r.path, "pids")) || !r.result)) await reap(r);
}

/** Apply a finished run's change: the one the run delivered, or a specific agent's (by letter). */
export async function applyRun(cwd, id, agent) {
  const run = await findRun(cwd, id);
  if (run.status !== "done") throw new Error(`run ${run.id} is ${run.status}${run.result?.error ? `: ${run.result.error}` : ""}`);
  if (run.result.mode !== "code") throw new Error("this run answered a question; it has no change to apply");
  let file = run.result.patch;
  let label = "the change";
  if (agent) {
    const letter = String(agent).trim().toUpperCase();
    const a = run.result.agents.find((x) => x.id === letter);
    if (!a) throw new Error(`no agent ${letter} in this run (agents: ${run.result.agents.map((x) => x.id).join(", ")})`);
    file = join(run.path, "work", `${letter}.patch`);
    label = `agent ${letter}'s change (${a.agent})`;
  }
  if (!file || !existsSync(file) || !readFileSync(file, "utf8").trim()) throw new Error(`${label} is empty`);
  await applyPatch(run.result.project, file);
  return { label, file, files: diffFiles(readFileSync(file, "utf8")) };
}
