import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "./exec.js";

async function git(cwd, ...args) {
  const res = await run("git", args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

export async function repoRoot(cwd) {
  return git(cwd, "rev-parse", "--show-toplevel").catch(() => {
    throw new Error("not inside a git repository");
  });
}

/** Commit-ish snapshot of the current working tree (tracked files, including uncommitted edits). */
export async function snapshot(root) {
  const head = await git(root, "rev-parse", "HEAD").catch(() => {
    throw new Error("repository has no commits yet");
  });
  const stash = await git(root, "stash", "create");
  const untracked = await git(root, "ls-files", "--others", "--exclude-standard");
  return { base: stash || head, dirty: Boolean(stash), untracked: untracked ? untracked.split("\n") : [] };
}

/**
 * Create an isolated worktree at `base`, copy in the user's untracked files,
 * and commit so the agent starts from exactly what the user sees. Returns the start commit.
 */
export async function addWorktree(root, path, base, untracked = []) {
  await git(root, "worktree", "add", "--detach", path, base);
  for (const file of untracked) {
    if (file.startsWith(".argue/")) continue;
    await run("mkdir", ["-p", dirname(join(path, file))]);
    try {
      copyFileSync(join(root, file), join(path, file));
    } catch {}
  }
  await git(path, "add", "-A");
  await git(path, "-c", "user.name=argue", "-c", "user.email=argue@localhost", "commit", "-q", "--allow-empty", "--no-verify", "-m", "argue: start");
  return git(path, "rev-parse", "HEAD");
}

export async function removeWorktree(root, path) {
  await run("git", ["worktree", "remove", "--force", path], { cwd: root });
}

/** Diff of everything the agent changed in its worktree (including new files) against base. */
export async function diffAgainst(wt, base) {
  await git(wt, "add", "-A", "--", ".", ":(exclude)node_modules");
  return run("git", ["diff", "--cached", base], { cwd: wt }).then((r) => r.stdout);
}

export async function applyPatch(root, patchFile) {
  await git(root, "apply", "--whitespace=nowarn", patchFile);
}

/** Keep .argue/ out of git status without touching the user's .gitignore. */
export function ignoreArgueDir(root) {
  const exclude = join(root, ".git", "info", "exclude");
  try {
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.split("\n").includes(".argue/")) appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}.argue/\n`);
  } catch {}
}
