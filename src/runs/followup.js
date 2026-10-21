import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask } from "../agents/drivers.js";
import { followUp } from "../room/prompts.js";
import { removeTree } from "../util/fs.js";
import { findRun, readText } from "./store.js";

/** The record a follow-up question is answered from: the room, the final answer and, for code, the change. */
export function recordText(run, maxChars = 120_000) {
  const parts = [readText(run, "room.md") || `TASK:\n${run.meta.task}`];
  if (run.result?.mode === "code") parts.push(`## The change that was delivered\n\n${readText(run, "work/winner.patch").slice(0, 30_000)}`);
  const text = parts.join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars / 2)}\n…(middle of the record trimmed)…\n${text.slice(-maxChars / 2)}` : text;
}

/** argue ask "why not Postgres?": answer a follow-up about a finished run from its record. */
export async function askAbout({ cwd, id, question, agent, drivers, installed }) {
  const run = await findRun(cwd, id);
  if (run.status !== "done") throw new Error(`run ${run.id} is ${run.status}; follow-up questions need a finished run`);
  const dir = mkdtempSync(join(tmpdir(), "argue-ask-"));
  try {
    const res = await ask(drivers, installed, agent, {
      prompt: followUp({ record: recordText(run), question }),
      cwd: dir,
      tag: "followup",
      write: false,
      timeoutMs: 10 * 60_000,
    });
    if (!res.ok) throw new Error(res.error);
    return { runId: run.id, answer: res.text.trim() };
  } finally {
    removeTree(dir);
  }
}
