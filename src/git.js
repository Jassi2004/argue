import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isWin, run } from "./exec.js";

// Identity + safety flags for argue's own internal commits (never in the user's repo history).
const ID = ["-c", "user.name=argue", "-c", "user.email=argue@localhost", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${isWin ? "NUL" : "/dev/null"}`];

/** Stable, locale/config-independent git output for parsing. */
const SAFE = [
  "-c",
  "core.quotepath=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicprefix=false",
  "-c",
  "color.ui=false",
];

async function git(cwd, ...args) {
  const res = await run("git", [...SAFE, ...args], { cwd });
  if (res.code !== 0)
    throw new Error(
      `git ${args
        .filter((a) => !a.startsWith("-c") && !a.includes("="))
        .slice(0, 2)
        .join(" ")}: ${(res.stderr || res.stdout).trim().split("\n").pop()}`,
    );
  return res.stdout.replace(/\s+$/, "");
}

export async function hasGit() {
  return (await run("git", ["--version"])).code === 0;
}

async function repoRoot(cwd) {
  const res = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Usually-ignored folders that builds/tests need; symlinked (not copied) into each worktree. */
const SHARED_DIRS = ["node_modules", ".venv", "venv", ".tox", "vendor/bundle", "Pods", ".gradle"];
const SKIP_COPY = new Set([".git", ".argue", "node_modules", ".venv", "venv", "__pycache__", ".DS_Store", ".tox", ".gradle", "Pods"]);

/**
 * The user's project as argue sees it.
 *  - git repo with commits: worktrees come straight from it (uncommitted + untracked changes included)
 *  - anything else (plain folder, repo with no commits): a private git snapshot in `scratch`
 * The user's repo is never committed to, and its history is never touched.
 */
export async function openWorkspace(cwd, scratch) {
  if (!(await hasGit())) throw new Error("git is required (https://git-scm.com/downloads)");
  const top = await repoRoot(cwd);
  const hasHead = top ? (await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: top })).code === 0 : false;
  const source = top ?? cwd;
  const shared = SHARED_DIRS.filter((d) => existsSync(join(source, d)));

  if (top && hasHead) {
    // `stash create` snapshots staged + unstaged tracked changes without touching the working tree or stash list.
    const base = (await git(top, "stash", "create")) || (await git(top, "rev-parse", "HEAD"));
    const untracked = (await git(top, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
    return { root: top, source, home: top, isRepo: true, base, untracked, shared };
  }

  const root = join(scratch, "source");
  mkdirSync(root, { recursive: true });
  copyTree(source, root);
  await git(root, "init", "-q");
  if (top) {
    try {
      copyFileSync(join(top, ".gitignore"), join(root, ".gitignore"));
    } catch {}
  }
  await git(root, ...junkExcludes(), "add", "-A");
  await git(root, ...ID, "commit", "-q", "--allow-empty", "--no-verify", "-m", "argue: snapshot");
  const base = await git(root, "rev-parse", "HEAD");
  return { root, source, home: top ?? cwd, isRepo: false, base, untracked: [], shared };
}

function copyTree(from, to) {
  const keep = (p) => !SKIP_COPY.has(p.split(/[\\/]/).pop());
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    try {
      if (entry.isDirectory()) cpSync(src, dst, { recursive: true, filter: keep });
      else if (entry.isFile()) copyFileSync(src, dst);
    } catch {}
  }
}

/** Build artefacts and caches that must never end up in a patch (on top of the project's .gitignore). */
const JUNK = [
  "__pycache__/",
  "*.py[cod]",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".DS_Store",
  "Thumbs.db",
  "*.swp",
  ".coverage",
  "coverage/",
  ".nyc_output/",
  "node_modules/",
  ".venv/",
  ".tox/",
  ".argue/",
  "*.tsbuildinfo",
  ".eslintcache",
];
let junkFile;
function junkExcludes() {
  if (!junkFile) {
    junkFile = join(tmpdir(), `argue-ignore-${process.pid}`);
    writeFileSync(junkFile, `${JUNK.join("\n")}\n`);
  }
  return ["-c", `core.excludesFile=${junkFile}`];
}

/** Stage everything in a worktree except junk, argue's own files and the symlinked shared folders. */
async function stageAll(ws, path) {
  await git(path, ...junkExcludes(), "add", "-A");
  await git(path, "rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ".argue", ...ws.shared);
}

/** git's worktree bookkeeping is not safe under concurrent add/remove (notably on Windows): serialize. */
let worktreeLock = Promise.resolve();
function serial(fn) {
  const next = worktreeLock.then(fn, fn);
  worktreeLock = next.catch(() => {});
  return next;
}

/** Create an isolated worktree at the workspace snapshot. Returns its starting commit. */
export function addWorktree(ws, path) {
  return serial(() => addWorktreeNow(ws, path));
}

async function addWorktreeNow(ws, path) {
  mkdirSync(dirname(path), { recursive: true });
  await git(ws.root, "worktree", "add", "-q", "--detach", path, ws.base);
  for (const file of ws.untracked) {
    if (file.startsWith(".argue/")) continue;
    const src = join(ws.root, file);
    try {
      if (!lstatSync(src).isFile()) continue;
      mkdirSync(dirname(join(path, file)), { recursive: true });
      copyFileSync(src, join(path, file));
    } catch {}
  }
  for (const dir of ws.shared) {
    const dst = join(path, dir);
    if (existsSync(dst)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      symlinkSync(join(ws.source, dir), dst, isWin ? "junction" : "dir");
    } catch {}
  }
  await stageAll(ws, path);
  await git(path, ...ID, "commit", "-q", "--allow-empty", "--no-verify", "-m", "argue: start");
  return git(path, "rev-parse", "HEAD");
}

/** Reset a worktree back to `start`, keeping the symlinked shared folders. */
export async function resetWorktree(ws, path, start) {
  await git(path, "reset", "-q", "--hard", start);
  await git(path, "clean", "-fdq", "-e", "/.argue", ...ws.shared.flatMap((d) => ["-e", `/${d}`]));
}

export function removeWorktree(ws, path) {
  return serial(async () => {
    await run("git", ["worktree", "remove", "--force", path], { cwd: ws.root });
    await run("git", ["worktree", "prune"], { cwd: ws.root });
  });
}

/** Everything changed in a worktree since `start` (new, deleted, renamed, binary files included). */
export async function diffSince(ws, path, start) {
  await stageAll(ws, path);
  const res = await run("git", [...SAFE, "diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-renames", start], { cwd: path });
  if (res.code !== 0) throw new Error(`git diff: ${res.stderr.trim()}`);
  return res.stdout;
}

export function diffStats(diff = "") {
  let files = 0;
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { files, add, del };
}

/** Changed file paths in a patch (handles spaces, quoting and deleted files). */
export function diffFiles(diff = "") {
  const files = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const plus = block.match(/^\+\+\+ (?:b\/)?(.+?)\t?$/m)?.[1];
    const minus = block.match(/^--- (?:a\/)?(.+?)\t?$/m)?.[1];
    let file = plus && plus !== "/dev/null" ? plus : minus && minus !== "/dev/null" ? minus : null;
    if (!file) {
      // Binary or mode-only change has no ---/+++ lines; the header is `a/X b/X` (or quoted) with X repeated.
      const head = block.split("\n")[0].trimEnd();
      const quoted = head.match(/^"a\/((?:\\.|[^"\\])*)" /);
      file = quoted ? `"${quoted[1]}"` : head.slice(2, 2 + (head.length - 5) / 2);
    }
    files.push(unquote(file));
  }
  return files;
}

function unquote(s) {
  if (!s.startsWith('"')) return s;
  try {
    // git C-style quoting with octal escapes for non-ASCII bytes.
    const bytes = [];
    const body = s.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== "\\") {
        bytes.push(...Buffer.from(body[i]));
        continue;
      }
      const n = body[++i];
      if (/[0-7]/.test(n)) {
        bytes.push(parseInt(body.slice(i, i + 3), 8));
        i += 2;
      } else bytes.push({ n: 10, t: 9, r: 13, '"': 34, "\\": 92 }[n] ?? n.charCodeAt(0));
    }
    return Buffer.from(bytes)
      .toString("utf8")
      .replace(/^[ab]\//, "");
  } catch {
    return s;
  }
}

/**
 * Apply a patch to the user's project (git repo root or plain folder).
 * Checks first so a patch is applied fully or not at all; falls back to a 3-way merge in repos.
 */
export async function applyPatch(target, patchFile) {
  if (!existsSync(patchFile)) throw new Error(`patch not found: ${patchFile}`);
  if (!readFileSync(patchFile, "utf8").trim()) throw new Error("patch is empty");
  const inRepo = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: target })).code === 0;
  // In a plain folder git apply works on paths relative to cwd; in a repo it must run from the root.
  const cwd = inRepo ? await git(target, "rev-parse", "--show-toplevel") : target;
  const base = ["apply", "--whitespace=nowarn"];
  const check = await run("git", [...SAFE, ...base, "--check", patchFile], { cwd });
  if (check.code === 0) {
    await git(cwd, ...base, patchFile);
    return;
  }
  if (inRepo) {
    const merged = await run("git", [...SAFE, ...base, "--3way", patchFile], { cwd });
    if (merged.code === 0) return;
    throw new Error(`patch conflicts with your current files: ${firstLines(merged.stderr || merged.stdout)}`);
  }
  throw new Error(`patch does not apply to your current files (did they change since the run started?): ${firstLines(check.stderr)}`);
}

function firstLines(s = "") {
  return s.trim().split("\n").slice(0, 3).join(" | ");
}

/** Keep .argue/ out of `git status` in the user's repo, without editing their .gitignore. */
export async function ignoreArgueDir(root) {
  const res = await run("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root });
  if (res.code !== 0) return;
  const p = res.stdout.trim();
  writeExcludeFile(isAbsolute(p) ? p : join(root, p), [".argue/"]);
}

function writeExcludeFile(path, patterns) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = current.split(/\r?\n/);
    const add = patterns.filter((p) => !lines.includes(p));
    if (add.length) appendFileSync(path, `${current && !current.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
  } catch {}
}
