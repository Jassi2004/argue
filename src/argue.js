import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "./agents.js";
import { run, tail } from "./exec.js";
import { addWorktree, applyPatch, diffAgainst, ignoreArgueDir, removeWorktree, repoRoot, snapshot } from "./git.js";
import { ANGLES, critiquePrompt, judgePrompt, proposePrompt, revisePrompt } from "./prompts.js";

/**
 * The argue protocol:
 *   1. propose  – every agent solves the task blind, in its own git worktree
 *   2. check    – the acceptance command (if any) runs in every worktree
 *   3. critique – every agent reviews the others' diffs (anonymised as A, B, C…)
 *   4. revise   – every agent fixes what holds up, may borrow ideas
 *   …repeat 2–4 until everyone passes and nobody objects, or rounds/budget run out
 *   5. judge    – a fresh agent picks the winner; the winning patch is saved (and optionally applied)
 */
export async function argue({ task, agents, judge, check, rounds = 2, budgetUsd, timeoutMin = 20, apply = false, keep = false, cwd, log }) {
  const root = await repoRoot(cwd);
  const snap = await snapshot(root);
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(root, ".argue", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  ignoreArgueDir(root);
  const timeoutMs = timeoutMin * 60_000;

  const ledger = { costUsd: 0, tokens: 0 };
  const transcript = [];
  const note = (phase, who, text) => transcript.push({ phase, who, text });
  const overBudget = () => budgetUsd && ledger.costUsd >= budgetUsd;

  // Anonymous ids so agents (and the judge) can't defer to a famous model name.
  const players = agents.map((a, i) => ({ ...a, id: String.fromCharCode(65 + i), wt: join(runDir, `wt-${String.fromCharCode(65 + i)}`) }));

  log(`argue ${runId}`);
  log(`  task:   ${oneLine(task)}`);
  log(`  agents: ${players.map((p) => `${p.id}=${p.name}`).join("  ")}`);
  if (check) log(`  check:  ${check}`);

  const call = async (p, phase, prompt, write) => {
    const t0 = Date.now();
    const res = await ask(p, { prompt, cwd: p.wt, write, timeoutMs });
    ledger.costUsd += res.costUsd;
    ledger.tokens += res.tokens;
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`  ${res.ok ? "✓" : "✗"} ${p.id} ${phase} (${secs}s${res.costUsd ? `, $${res.costUsd.toFixed(2)}` : ""})${res.ok ? "" : ` — ${oneLine(res.error)}`}`);
    note(phase, p.id, res.ok ? res.text : `ERROR: ${res.error}`);
    return res;
  };

  const refresh = async (p) => {
    p.diff = await diffAgainst(p.wt, p.start);
    p.check = check ? await runCheck(check, p.wt, timeoutMs) : null;
    if (p.check) log(`  ${p.check.pass ? "✓" : "✗"} ${p.id} check ${p.check.pass ? "passed" : "failed"}`);
  };

  try {
    for (const p of players) {
      p.start = await addWorktree(root, p.wt, snap.base, snap.untracked);
      linkNodeModules(root, p.wt);
    }

    // 1. Propose (blind, parallel)
    log("\n[1] propose");
    await Promise.all(
      players.map(async (p, i) => {
        const res = await call(p, "propose", proposePrompt({ task, check, angle: ANGLES[i % ANGLES.length] }), true);
        p.summary = res.text;
        p.alive = res.ok;
      }),
    );
    await Promise.all(players.map(refresh));

    // 2–4. Critique and revise
    let round = 0;
    for (; round < rounds; round++) {
      const live = players.filter((p) => p.alive);
      if (live.length < 2 || overBudget()) break;

      log(`\n[${round + 2}] critique`);
      const critiques = {};
      await Promise.all(
        live.map(async (p) => {
          const others = live.filter((o) => o !== p).map((o) => ({ id: o.id, summary: o.summary, diff: tail(o.diff, 30_000), check: o.check }));
          const res = await call(p, "critique", critiquePrompt({ task, check, self: p.id, others }), false);
          critiques[p.id] = res.ok ? res.text : "";
        }),
      );

      const allOk = live.every((p) => !critiques[p.id] || /VERDICT:\s*OK/i.test(critiques[p.id]));
      const allPass = live.every((p) => !p.check || p.check.pass);
      if (allOk && allPass) {
        log("  → no objections and all checks pass; stopping early");
        break;
      }
      if (overBudget()) break;

      log(`\n[${round + 2}] revise`);
      await Promise.all(
        live.map(async (p) => {
          const about = live
            .filter((o) => o !== p && critiques[o.id])
            .map((o) => `--- from ${o.id} (look for remarks about solution ${p.id}) ---\n${critiques[o.id]}`)
            .join("\n\n");
          const res = await call(p, "revise", revisePrompt({ task, check, critiques: about, checkResult: p.check }), true);
          if (res.ok) p.summary = res.text;
        }),
      );
      await Promise.all(live.map(refresh));
    }

    // 5. Judge
    const finalists = players.filter((p) => p.alive && p.diff.trim());
    if (!finalists.length) throw new Error("no agent produced a solution");
    const passing = finalists.filter((p) => !p.check || p.check.pass);
    const pool = passing.length ? passing : finalists;

    let verdict;
    if (pool.length === 1) {
      verdict = { winner: pool[0].id, reason: check ? "Only solution that passed the acceptance check." : "Only solution produced.", risks: "not reviewed by judge" };
    } else {
      log("\n[judge]");
      const judgeAgent = { ...judge, id: "judge", wt: root };
      const res = await call(judgeAgent, "judge", judgePrompt({ task, check, candidates: pool.map((p) => ({ id: p.id, summary: p.summary, diff: tail(p.diff, 30_000), check: p.check })) }), false);
      verdict = parseVerdict(res.text, pool);
    }
    const winner = players.find((p) => p.id === verdict.winner);

    const patchFile = join(runDir, "winner.patch");
    writeFileSync(patchFile, winner.diff);
    for (const p of players) writeFileSync(join(runDir, `${p.id}.patch`), p.diff ?? "");

    let applied = false;
    if (apply) {
      await applyPatch(root, patchFile);
      applied = true;
    }

    const result = {
      runId,
      winner: { id: winner.id, agent: winner.name },
      reason: verdict.reason,
      risks: verdict.risks,
      check: check ? players.map((p) => ({ id: p.id, agent: p.name, pass: p.check?.pass ?? null })) : null,
      rounds: round,
      costUsd: Number(ledger.costUsd.toFixed(4)),
      tokens: ledger.tokens,
      patch: patchFile,
      report: join(runDir, "report.md"),
      applied,
    };
    writeFileSync(result.report, report({ task, check, players, result, transcript }));
    writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (!keep) for (const p of players) await removeWorktree(root, p.wt);
  }
}

async function runCheck(cmd, cwd, timeoutMs) {
  const res = await run("/bin/sh", ["-c", cmd], { cwd, timeoutMs });
  return { pass: res.code === 0, output: tail(`${res.stdout}\n${res.stderr}`.trim(), 3000) };
}

function linkNodeModules(root, wt) {
  const src = join(root, "node_modules");
  const dst = join(wt, "node_modules");
  if (existsSync(src) && !existsSync(dst)) {
    try {
      symlinkSync(src, dst, "dir");
    } catch {}
  }
}

export function parseVerdict(text, pool) {
  const match = text?.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const v = JSON.parse(match[0]);
      if (pool.some((p) => p.id === v.winner)) return { winner: v.winner, reason: v.reason ?? "", risks: v.risks ?? "" };
    } catch {}
  }
  return { winner: pool[0].id, reason: "Judge output unreadable; defaulted to first finalist.", risks: "unknown" };
}

function oneLine(s = "") {
  const line = String(s).replace(/\s+/g, " ").trim();
  return line.length > 100 ? `${line.slice(0, 97)}…` : line;
}

function report({ task, check, players, result, transcript }) {
  const lines = [
    `# argue ${result.runId}`,
    "",
    `**Task:** ${task}`,
    check ? `**Check:** \`${check}\`` : "",
    "",
    `## Winner: ${result.winner.id} (${result.winner.agent})`,
    "",
    result.reason,
    "",
    `**Risks:** ${result.risks}`,
    "",
    "## Agents",
    "",
    "| id | agent | check | lines changed |",
    "|---|---|---|---|",
    ...players.map((p) => `| ${p.id} | ${p.name} | ${p.check ? (p.check.pass ? "pass" : "fail") : "-"} | ${(p.diff ?? "").split("\n").filter((l) => /^[+-][^+-]/.test(l)).length} |`),
    "",
    `Cost: $${result.costUsd} (Claude only; Codex reports tokens) · Tokens: ${result.tokens} · Rounds: ${result.rounds}`,
    "",
    "## Transcript",
    "",
    ...transcript.map((t) => `### ${t.phase} · ${t.who}\n\n${t.text}\n`),
  ];
  return lines.filter((l) => l !== null).join("\n");
}
