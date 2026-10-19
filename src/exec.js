import { spawn } from "node:child_process";

/** Run a command, optionally feeding stdin. Never rejects; returns { code, stdout, stderr, timedOut }. */
export function run(cmd, args, { cwd, input, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + err.message, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export async function which(bin) {
  const res = await run("/bin/sh", ["-c", `command -v ${bin}`]);
  return res.code === 0 && res.stdout.trim() !== "";
}

export function tail(text, max = 4000) {
  return text.length > max ? `…(truncated)\n${text.slice(-max)}` : text;
}
