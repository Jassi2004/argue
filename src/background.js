import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newRunId } from "./argue.js";
import { findRun } from "./runs.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "argue.js");

/**
 * Start an argue run as a detached background process (survives the caller exiting,
 * MCP tool timeouts, editor reloads). Returns the run id; progress lives in .argue/runs/<id>/.
 */
export function startDetached({ cwd, args }) {
  const runId = newRunId();
  const logDir = join(tmpdir(), "argue-logs");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, `${runId}.log`), "a");
  const child = spawn(process.execPath, [BIN, ...args, "--run-id", runId, "--quiet"], {
    cwd,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  child.unref();
  closeSync(log);
  return { runId, log: join(logDir, `${runId}.log`), exited: () => exited };
}

/**
 * Wait until the background run has registered itself, or failed to start.
 * Returns the run, or throws with the child's own error message.
 */
export async function waitForStart(cwd, started, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      return await findRun(cwd, started.runId);
    } catch {}
    if (started.exited()) {
      await sleep(200);
      try {
        return await findRun(cwd, started.runId);
      } catch {}
      throw new Error(`run failed to start: ${logTail(started.log) || "unknown error"}`);
    }
    await sleep(200);
  }
  throw new Error(`run did not start within ${ms / 1000}s; see ${started.log}`);
}

function logTail(file) {
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .slice(-5)
      .join("\n")
      .replace(/^argue: /gm, "");
  } catch {
    return "";
  }
}

/** Long-poll a run until it finishes or `seconds` pass. */
export async function waitForFinish(cwd, runId, seconds) {
  const end = Date.now() + seconds * 1000;
  let run;
  do {
    try {
      run = await findRun(cwd, runId);
      if (run.status !== "running") return run;
    } catch {}
    await sleep(1000);
  } while (Date.now() < end);
  return run;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
