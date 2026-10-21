import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, shell, tail } from "../util/exec.js";
import { addWorktree, diffSince, diffStats, removeWorktree, resetWorktree } from "../workspace/git.js";

/**
 * Desks: each agent's private workspace, a git worktree of the user's project.
 *
 *   <desk>/                     the agent's own copy of the project (its cwd)
 *   <desk>/.argue/answer.md     answer mode: the agent's current answer (it edits this file)
 *   <desk>/.argue/room/         read-only mirror of the room, refreshed before every turn
 *       room.md                 the full record so far
 *       work/<X>.md | <X>.patch everyone's current work
 *       checks/<X>.txt          output of the check command on X's work
 *   <desk>/.argue/lab/          code mode: a clean copy for trying rivals' patches (reset every turn)
 *
 * .argue/ is never part of a patch (see workspace/git.js).
 */

export const ANSWER_FILE = ".argue/answer.md";
export const ROOM_DIR = ".argue/room";
export const LAB_DIR = ".argue/lab";

export async function openDesk(ws, path) {
  const start = await addWorktree(ws, path);
  mkdirSync(join(path, ROOM_DIR), { recursive: true });
  return { path, start, lab: null, patch: "", answer: "" };
}

export async function closeDesk(ws, desk) {
  if (desk.lab) await removeWorktree(ws, desk.lab.path).catch(() => {});
  await removeWorktree(ws, desk.path).catch(() => {});
}

/** A clean copy of the project inside the desk, for applying and testing other agents' patches. */
export async function readyLab(ws, desk) {
  if (desk.lab) return resetWorktree(ws, desk.lab.path, desk.lab.start);
  const path = join(desk.path, LAB_DIR);
  desk.lab = { path, start: await addWorktree(ws, path) };
}

/** Copy the room into a desk: the record and everyone's current work. */
export function syncRoom(desk, { record, work, checks }) {
  const dir = join(desk.path, ROOM_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  mkdirSync(join(dir, "checks"), { recursive: true });
  writeFileSync(join(dir, "room.md"), record);
  for (const w of Object.values(work)) writeFileSync(join(dir, "work", w.file), w.text);
  for (const [id, out] of Object.entries(checks)) writeFileSync(join(dir, "checks", `${id}.txt`), out);
}

/** The agent's current work: { text, hash, stats? } (null hash = nothing yet). */
export async function readWork(ws, desk, mode) {
  if (mode === "code") {
    desk.patch = await diffSince(ws, desk.path, desk.start);
    const text = desk.patch;
    return { text, hash: text.trim() ? sha(text) : null, stats: diffStats(text), testEdits: modifiedTests(text) };
  }
  let text = "";
  try {
    text = readFileSync(join(desk.path, ANSWER_FILE), "utf8").trim();
  } catch {}
  desk.answer = text;
  return { text, hash: text ? sha(text) : null };
}

/** Answer mode safety net: an agent that replied with its answer instead of writing the file. */
export function adoptAnswer(desk, text) {
  mkdirSync(join(desk.path, ".argue"), { recursive: true });
  writeFileSync(join(desk.path, ANSWER_FILE), `${text.trim()}\n`);
}

/** Run the check command in a desk. */
export async function runCheck(desk, check, timeoutMs) {
  const [cmd, args] = shell(check);
  const res = await run(cmd, args, { cwd: desk.path, timeoutMs });
  return { pass: res.code === 0 && !res.timedOut, output: tail(`${res.stdout}\n${res.stderr}`.trim(), 4000) || "(no output)" };
}

/** Put a desk back to an earlier patch (code mode), e.g. when a revision broke a passing check. */
export async function restorePatch(ws, desk, patch, scratch) {
  await resetWorktree(ws, desk.path, desk.start);
  if (!patch.trim()) return;
  const file = join(scratch, `restore-${Math.random().toString(36).slice(2)}.patch`);
  writeFileSync(file, patch);
  await run("git", ["apply", "--whitespace=nowarn", file], { cwd: desk.path });
  rmSync(file, { force: true });
}

export const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/**
 * Existing test files whose lines a patch removes or changes, or that it deletes: the signs of a
 * weakened test. New test files and tests only added to an existing file are fine.
 */
export function modifiedTests(diff = "") {
  const out = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const file = block.match(/^a\/(.+?) b\//)?.[1];
    if (!file || /^new file mode/m.test(block)) continue;
    if (!/(^|[/._-])(tests?|specs?|__tests__)([/._-]|$)/i.test(file)) continue;
    if (/^deleted file mode/m.test(block) || /^-(?!--)/m.test(block)) out.push(file);
  }
  return out;
}

// ---------------------------------------------------------------- keeping agents in their desks

/** The project's absolute path in every spelling an agent might see (symlinks like /tmp -> /private/tmp). */
export function projectPaths(...dirs) {
  const out = new Set();
  for (const d of dirs) {
    if (!d) continue;
    out.add(d);
    try {
      out.add(realpathSync(d));
    } catch {}
  }
  return [...out].filter((d) => d.length > 1).sort((a, b) => b.length - a.length);
}

/** Replace absolute project paths with "." so a brief written for the real project points agents at their own copy. */
export function localizePaths(text = "", roots = []) {
  let out = String(text);
  for (const r of roots) {
    const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${esc}(?=[\\/]|\\b|$)`, "g"), ".");
  }
  return out;
}

/** Cheap fingerprint of the user's working tree, to notice edits during a run (by the user, or an agent that escaped). */
export async function projectFingerprint(ws) {
  if (!ws.isRepo) return null;
  const status = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: ws.root });
  const diff = await run("git", ["diff", "--no-ext-diff", "--binary", "HEAD"], { cwd: ws.root });
  const entries = status.stdout.split("\0").filter((e) => e && !e.includes(".argue/"));
  return sha(`${entries.join("\0")}::${diff.stdout}`);
}
