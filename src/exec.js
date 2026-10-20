import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";

/**
 * Per-run context for every child process started inside `withScope`:
 *  - signal: aborting it kills those processes
 *  - env: extra environment variables (e.g. ARGUE_DEPTH, so agents cannot start nested argue runs)
 */
const scope = new AsyncLocalStorage();
export const withScope = ({ signal, env, onSpawn } = {}, fn) => scope.run({ signal, env, onSpawn }, fn);
/** Run `fn` with no abort signal (for cleanup that must finish even after cancellation). */
export const unaborted = (fn) => scope.run({ env: scope.getStore()?.env }, fn);

export const isWin = process.platform === "win32";
const live = new Set();

/**
 * Run a command. Never rejects; resolves { code, stdout, stderr, timedOut }.
 * Children get their own process group (unix) so timeouts / Ctrl-C kill the whole tree.
 */
export function run(cmd, args = [], { cwd, input, timeoutMs = 0, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const [file, argv, extra] = isWin ? winSpawnArgs(cmd, args) : [cmd, args, {}];
      const scoped = scope.getStore()?.env;
      child = spawn(file, argv, {
        cwd,
        env: env || scoped ? { ...process.env, ...scoped, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: !isWin,
        windowsHide: true,
        ...extra,
      });
    } catch (err) {
      return resolve({ code: -1, stdout: "", stderr: err.message, timedOut: false });
    }
    live.add(child);
    const store = scope.getStore();
    const signal = store?.signal;
    store?.onSpawn?.(child.pid, true);
    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;
    const done = (code, extra = "") => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      store?.onSpawn?.(child.pid, false);
      live.delete(child);
      resolve({ code, stdout, stderr: stderr + extra, timedOut });
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => done(-1, err.message));
    child.on("close", (code) => done(code ?? -1));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** Executables that are real .exe files on Windows and can be spawned without a shell. */
const WIN_NATIVE = new Set(["git", "node", "where", "taskkill"]);
const META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Windows: npm-installed CLIs are .cmd shims that Node can only start through cmd.exe.
 * Escaping follows cross-spawn (CRT quoting, then caret-escaping; doubled for .cmd shims).
 */
function winSpawnArgs(cmd, args) {
  const base = cmd.replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (base === "cmd.exe" || base === "cmd") return [cmd, args, { windowsVerbatimArguments: true }];
  if (cmd === process.execPath || WIN_NATIVE.has(base) || base.endsWith(".exe")) return [cmd, args, {}];
  const line = [cmd.replace(META, "^$1"), ...args.map((a) => winEscapeArg(a, true))].join(" ");
  return ["cmd.exe", ["/d", "/s", "/c", `"${line}"`], { windowsVerbatimArguments: true }];
}

export function winEscapeArg(arg, doubleEscape = false) {
  let s = String(arg);
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, "$1$1");
  s = `"${s}"`.replace(META, "^$1");
  return doubleEscape ? s.replace(META, "^$1") : s;
}

/** Stop a child and everything it started. SIGTERM first, SIGKILL if it is still around 5s later. */
function killTree(child) {
  if (!child.pid) return;
  if (isWin) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    } catch {}
    return;
  }
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 5000).unref();
}

/** Kill every child process we started (used on forced exit). Synchronous, safe inside process.on("exit"). */
export function killAll() {
  for (const child of live) {
    try {
      if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      else process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

/** Kill a process group by pid (best effort), e.g. agents left behind by a run that was killed. */
export function killPid(pid) {
  try {
    if (isWin) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else process.kill(-pid, "SIGKILL");
  } catch {}
}

/** [cmd, args] that runs a shell command line on this OS. */
export function shell(line) {
  return isWin ? ["cmd.exe", ["/d", "/s", "/c", `"${line}"`]] : ["/bin/sh", ["-c", line]];
}

/** Absolute path of an executable on PATH, or null. `bin` must be a trusted constant. */
export async function which(bin) {
  const res = isWin ? await run("where", [bin]) : await run("/bin/sh", ["-c", `command -v ${bin}`]);
  const first = res.stdout.trim().split(/\r?\n/)[0];
  return res.code === 0 && first ? first : null;
}

export function tail(text = "", max = 4000) {
  return text.length > max ? `…(truncated)\n${text.slice(-max)}` : text;
}

export function head(text = "", max = 4000) {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export function stripAnsi(s = "") {
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function oneLine(s = "", max = 100) {
  const line = stripAnsi(s).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Parse the last JSON object in a blob of text (CLIs sometimes print banners around it). */
export function lastJsonObject(text = "") {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

/** Parse JSONL, ignoring non-JSON lines. */
export function jsonLines(text = "") {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}
