import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask } from "../harnesses/index.js";
import { followUp } from "../instructions/index.js";
import { findRun } from "./runs.js";

/**
 * The log book: everything that happened in a run, kept quietly so the user can ask follow-up
 * questions later ("why not Postgres?", "are you sure?"). Built from the run folder.
 */
export function logbookText(run, maxChars = 120_000) {
  const read = (f) => {
    try {
      return readFileSync(join(run.path, f), "utf8");
    } catch {
      return "";
    }
  };
  let transcript = [];
  try {
    transcript = JSON.parse(read("transcript.json"));
  } catch {}
  const parts = [`TASK:\n${run.meta.task}`];
  for (const t of transcript) parts.push(`--- ${t.phase} · ${t.who === "judge" ? "final step" : `model ${t.who}`} ---\n${t.text}`);
  const answer = read("answer.md") || run.result?.answer || "";
  if (answer) parts.push(`--- FINAL ANSWER GIVEN TO THE USER ---\n${answer}`);
  const winner = run.result?.winner?.id;
  if (run.result?.mode === "code" && winner) parts.push(`--- THE CODE CHANGE THAT WAS PICKED ---\n${read(`${winner}.patch`).slice(0, 30_000)}`);
  const text = parts.join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars / 2)}\n…(middle of the record trimmed)…\n${text.slice(-maxChars / 2)}` : text;
}

/** Answer a follow-up question about a finished run, using its log book. */
export async function askAbout({ cwd, id, question, agent, drivers, installed }) {
  const run = await findRun(cwd, id);
  if (run.status !== "done") throw new Error(`run ${run.id} is ${run.status}; follow-up questions need a finished run`);
  const dir = mkdtempSync(join(tmpdir(), "argue-ask-"));
  try {
    const res = await ask(drivers, installed, agent, {
      prompt: followUp({ logbook: logbookText(run), question }),
      cwd: dir,
      tag: "followup",
      write: false,
      timeoutMs: 10 * 60_000,
    });
    if (!res.ok) throw new Error(res.error);
    return { runId: run.id, answer: res.text.trim() };
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
