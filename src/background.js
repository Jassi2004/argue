import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
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
    env: { ...process.env, ARGUE_BACKGROUND: "1" },
  });
  child.unref();
  return { runId, log: join(logDir, `${runId}.log`) };
}

/** Wait until the run's folder exists (the child creates it after setup), up to `ms`. */
export async function waitForRun(cwd, runId, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      return await findRun(cwd, runId);
    } catch {}
    await sleep(300);
  }
  return null;
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
