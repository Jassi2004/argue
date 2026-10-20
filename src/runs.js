import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killPid, run as exec } from "./exec.js";
import { writeJson } from "./fsx.js";
import { applyPatch, diffFiles } from "./git.js";

/** Where runs for a project are stored. */
export async function runsDir(cwd) {
  const res = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  const root = res.code === 0 ? res.stdout.trim() : cwd;
  return join(root, ".argue", "runs");
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

/** Read a JSON file that another process may be writing at the same moment (retry once on a torn read). */
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

export function loadRun(dir, id) {
  const path = join(dir, id);
  const read = (f) => readJsonFile(join(path, f));
  const meta = read("meta.json") ?? {};
  const result = read("result.json");
  let status = result?.status ?? meta.status ?? "unknown";
  if (status === "running" && meta.pid && !alive(meta.pid)) status = "interrupted";
  return { id, path, meta, result, status };
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

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Ask a run to stop. Works on every OS: the run polls for this file and cancels itself
 * (stopping its agents and cleaning up). Falls back to a signal after a grace period.
 */
export async function requestCancel(run, graceMs = 15000) {
  writeFileSync(join(run.path, "cancel"), String(Date.now()));
  if (process.platform !== "win32") {
    try {
      process.kill(run.meta.pid, "SIGTERM");
    } catch {}
  }
  const end = Date.now() + graceMs;
  while (Date.now() < end) {
    if (!alive(run.meta.pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(run.meta.pid, "SIGKILL");
  } catch {}
  killChildren(run.path);
  return false;
}

/** Kill agent processes recorded by a run that could not clean up after itself. */
export function killChildren(path) {
  try {
    for (const pid of readFileSync(join(path, "pids"), "utf8").split(/\s+/).filter(Boolean)) killPid(Number(pid));
  } catch {}
}

/** Apply a finished run's winning patch, or a specific agent's (by letter). */
export async function applyRun(cwd, id, agent) {
  const run = await findRun(cwd, id);
  if (run.status !== "done") throw new Error(`run ${run.id} is ${run.status}${run.result?.error ? `: ${run.result.error}` : ""}`);
  if (run.result.mode !== "code") throw new Error("ask-mode runs have no patch; the answer is in the report");
  let file = run.result.patch;
  let label = `winner ${run.result.winner.id} (${run.result.winner.agent})`;
  if (agent) {
    const letter = String(agent).trim().toUpperCase();
    const a = run.result.agents.find((x) => x.id === letter);
    if (!a) throw new Error(`no agent ${letter} in this run (agents: ${run.result.agents.map((x) => x.id).join(", ")})`);
    file = join(run.path, `${letter}.patch`);
    label = `agent ${letter} (${a.agent})`;
  }
  if (!existsSync(file) || !readFileSync(file, "utf8").trim()) throw new Error(`${label} produced no changes`);
  await applyPatch(run.result.project, file);
  return { label, file, files: diffFiles(readFileSync(file, "utf8")) };
}

/**
 * Clean up after a run whose process died without cleaning up (killed, crashed, machine slept):
 * stop its agents, drop its worktrees, and mark it interrupted.
 */
export async function reap(run) {
  killChildren(run.path);
  rmSync(join(run.path, "pids"), { force: true });
  const base = join(tmpdir(), "argue");
  const scratch =
    run.meta.scratch ??
    (existsSync(base)
      ? readdirSync(base)
          .map((d) => join(base, d))
          .find((d) => d.endsWith(`-${run.id}`))
      : null);
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  if (run.meta.project) await exec("git", ["worktree", "prune"], { cwd: run.meta.project });
  if (!run.result) writeJsonSafe(join(run.path, "result.json"), { runId: run.id, status: "interrupted", error: "the argue process stopped unexpectedly" });
}

/** Reap every interrupted run in the project (cheap; called before each new run). */
export async function reapStale(cwd) {
  for (const r of await listRuns(cwd)) if (r.status === "interrupted" && (existsSync(join(r.path, "pids")) || !r.result)) await reap(r);
}

function writeJsonSafe(file, data) {
  try {
    writeJson(file, data);
  } catch {}
}
