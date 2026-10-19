import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.js";

/** Where runs for a project are stored. */
export async function runsDir(cwd) {
  const res = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
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

export function loadRun(dir, id) {
  const path = join(dir, id);
  const read = (f) => {
    try {
      return JSON.parse(readFileSync(join(path, f), "utf8"));
    } catch {
      return null;
    }
  };
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
  try {
    return readFileSync(join(path, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
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
