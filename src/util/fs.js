import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write a file atomically (temp file + rename): readers never see a half-written file. */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export const writeJson = (file, data) => writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);

/** Delete a folder even if it contains read-only files (Go module caches, some build outputs). */
export function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return;
  } catch {}
  const makeWritable = (p) => {
    try {
      chmodSync(p, 0o700);
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const c = join(p, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) makeWritable(c);
        else chmodSync(c, 0o600);
      }
    } catch {}
  };
  makeWritable(path);
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {}
}
