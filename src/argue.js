import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ask } from "./agents.js";
import { lastJsonObject, run, shell, tail, unaborted, withSignal } from "./exec.js";
import { addWorktree, applyPatch, diffFiles, diffSince, diffStats, ignoreArgueDir, openWorkspace, removeWorktree } from "./git.js";
import * as P from "./prompts.js";
import { renderReport } from "./report.js";

export function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Run one argue session.
 *
 * code mode:  propose (edit) → check → [critique (prove) → revise (edit) → check]×rounds → judge → patch
 * ask mode:   answer → [critique → revise]×rounds → judge writes the final merged answer
 *
 * Agents are anonymous letters (A, B, C…) to each other and to the judge.
 * Each agent works in its own git worktree outside the project, so nothing touches the user's files
 * unless `apply` is set.
 */
export function argue(opts) {
  return opts.signal ? withSignal(opts.signal, () => argueInner(opts)) : argueInner(opts);
}

async function argueInner(opts) {
  const { task, agents, judge, drivers, installed, cwd, mode = "code", rounds = 2, budget, timeout = 20, apply = false, keep = false, ctx = "", onEvent = () => {}, signal } = opts;
  const check = mode === "code" ? opts.check || null : null;
  const runId = opts.runId ?? newRunId();
  const timeoutMs = timeout * 60_000;

  // Where the user's project lives and where argue keeps things.
  const scratch = join(tmpdir(), "argue", `${basename(cwd).replace(/[^\w.-]/g, "_")}-${runId}`);
  mkdirSync(scratch, { recursive: true });
  const ws = await openWorkspace(cwd, scratch);
  const home = ws.home;
  const runDir = join(home, ".argue", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  await ignoreArgueDir(home);

  const eventsFile = join(runDir, "events.jsonl");
  const emit = (ev) => {
    const e = { t: Date.now(), ...ev };
    try {
      appendFileSync(eventsFile, `${JSON.stringify(e)}\n`);
    } catch {}
    onEvent(e);
  };

  const ledger = { costUsd: 0, tokens: 0, calls: 0 };
  const transcript = [];
  const overBudget = () => budget > 0 && ledger.costUsd >= budget;
  const worktrees = [];

  const players = agents.map((a, i) => ({ ...a, id: String.fromCharCode(65 + i), alive: true, summary: "", diff: "", check: null, objections: 0 }));
  const meta = { runId, task, mode, check, rounds, budget: budget ?? null, agents: players.map((p) => ({ id: p.id, agent: p.name })), judge: judge.name, project: home, runDir };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify({ ...meta, status: "running", startedAt: new Date().toISOString(), pid: process.pid }, null, 2));
  emit({ type: "start", ...meta });

  const makeTree = async (name) => {
    const path = join(scratch, name);
    const start = await addWorktree(ws, path);
    worktrees.push(path);
    return { path, start };
  };
  const dropTree = async (path) => {
    if (keep) return;
    await removeWorktree(ws, path);
    rmSync(path, { recursive: true, force: true });
    const i = worktrees.indexOf(path);
    if (i >= 0) worktrees.splice(i, 1);
  };

  const call = async (agent, who, phase, prompt, dir, write, concurrent = 1) => {
    if (signal?.aborted) throw new Error("cancelled");
    const t0 = Date.now();
    emit({ type: "call", status: "start", who, agent: agent.name, phase });
    const remaining = budget > 0 ? Math.max(0.05, (budget - ledger.costUsd) / concurrent) : undefined;
    const res = await ask(drivers, installed, agent, { prompt, cwd: dir, tag: `${who}-${phase}`, write, timeoutMs, budgetUsd: remaining });
    ledger.costUsd += res.costUsd || 0;
    ledger.tokens += res.tokens || 0;
    ledger.calls++;
    if (signal?.aborted) throw new Error("cancelled");
    const secs = Math.round((Date.now() - t0) / 1000);
    emit({ type: "call", status: "done", who, agent: agent.name, phase, ok: res.ok, secs, costUsd: res.costUsd || 0, tokens: res.tokens || 0, error: res.error, spentUsd: ledger.costUsd });
    transcript.push({ phase, who, agent: agent.name, ok: res.ok, text: res.ok ? res.text : `ERROR: ${res.error}` });
    return res;
  };

  const runCheck = async (p) => {
    if (!check) return;
    const [cmd, args] = shell(check);
    const res = await run(cmd, args, { cwd: p.tree.path, timeoutMs });
    p.check = { pass: res.code === 0 && !res.timedOut, output: tail(`${res.stdout}\n${res.stderr}`.trim(), 4000) };
    emit({ type: "check", who: p.id, pass: p.check.pass });
  };

  const snapshotDiff = async (p) => {
    p.diff = await diffSince(ws, p.tree.path, p.tree.start);
    p.stats = diffStats(p.diff);
    p.testEdits = modifiedTests(p.diff);
    writeFileSync(join(runDir, `${p.id}.patch`), p.diff);
  };

  /** Copy rival patches into a tree's .argue/<sub>/ so any agent can read them by relative path. */
  const stagePatches = (dir, sub, list) => {
    const d = join(dir, ".argue", sub);
    mkdirSync(d, { recursive: true });
    return list.map((r) => {
      writeFileSync(join(d, `${r.id}.patch`), r.diff);
      return { ...r, patchFile: `.argue/${sub}/${r.id}.patch` };
    });
  };

  let result;
  let shared; // ask mode: one read-only tree everybody looks at
  try {
    // ---------- setup ----------
    if (mode === "code") {
      await Promise.all(players.map(async (p) => (p.tree = await makeTree(p.id))));
    } else {
      shared = await makeTree("view");
      for (const p of players) p.tree = shared;
    }

    // ---------- 1. propose ----------
    emit({ type: "phase", name: mode === "code" ? "propose" : "answer", round: 0 });
    await Promise.all(
      players.map(async (p, i) => {
        const angle = P.ANGLES[i % P.ANGLES.length];
        const prompt = mode === "code" ? P.proposeCode({ task, check, angle, ctx }) : P.proposeAsk({ task, angle, ctx });
        const res = await call(p, p.id, "propose", prompt, p.tree.path, mode === "code", players.length);
        p.alive = res.ok;
        p.summary = res.ok ? res.text : "";
      }),
    );
    if (mode === "code") {
      await Promise.all(players.filter((p) => p.alive).map(async (p) => {
        await snapshotDiff(p);
        if (!p.diff.trim()) {
          p.alive = false;
          emit({ type: "note", text: `${p.id} made no changes` });
        } else await runCheck(p);
      }));
    }

    // ---------- 2. critique / revise ----------
    let round = 0;
    while (round < rounds) {
      const live = players.filter((p) => p.alive);
      if (live.length < 2) break;
      if (overBudget()) {
        emit({ type: "note", text: `budget of $${budget} reached` });
        break;
      }
      round++;

      emit({ type: "phase", name: "critique", round });
      const reviews = {}; // reviews[targetId][criticId] = section text
      for (const p of live) reviews[p.id] = {};
      await Promise.all(
        live.map(async (critic) => {
          const rivals = live.filter((o) => o !== critic);
          let res;
          if (mode === "code") {
            const tree = await makeTree(`review-${critic.id}-${round}`);
            const staged = stagePatches(tree.path, "rivals", rivals);
            res = await call(critic, critic.id, `critique${round}`, P.critiqueCode({ task, check, self: critic.id, rivals: staged, ctx }), tree.path, true, live.length);
            await dropTree(tree.path);
          } else {
            res = await call(critic, critic.id, `critique${round}`, P.critiqueAsk({ task, self: critic.id, rivals, ctx }), shared.path, false, live.length);
          }
          if (!res.ok) return;
          const parts = P.splitCritique(res.text, rivals.map((r) => r.id));
          for (const r of rivals) if (parts[r.id]) reviews[r.id][critic.id] = parts[r.id];
        }),
      );

      for (const p of live) {
        const verdicts = Object.values(reviews[p.id]).map(P.verdictOf);
        p.objections = verdicts.filter((v) => v === "issues").length;
        p.approvals = verdicts.filter((v) => v === "ok").length;
        emit({ type: "objections", who: p.id, count: p.objections, approvals: p.approvals, reviewers: live.length - 1 });
      }
      // Only stop early on explicit approval from every reviewer (garbled reviews don't count as approval).
      const settled = live.every((p) => p.objections === 0 && p.approvals === live.length - 1 && (!p.check || p.check.pass));
      if (settled) {
        emit({ type: "note", text: "no objections left" + (check ? " and all checks pass" : "") + "; stopping early" });
        break;
      }
      if (overBudget()) {
        emit({ type: "note", text: `budget of $${budget} reached` });
        break;
      }

      emit({ type: "phase", name: "revise", round });
      await Promise.all(
        live.map(async (p) => {
          const feedback = Object.entries(reviews[p.id])
            .filter(([, text]) => P.hasIssues(text))
            .map(([critic, text]) => `--- Reviewer ${critic} ---\n${text}`)
            .join("\n\n");
          if (mode === "code") {
            if (!feedback && (!check || p.check?.pass)) return; // nothing to fix
            stagePatches(p.tree.path, "rivals", live.filter((o) => o !== p));
            const res = await call(p, p.id, `revise${round}`, P.reviseCode({ task, check, feedback, checkResult: p.check, ctx }), p.tree.path, true, live.length);
            rmSync(join(p.tree.path, ".argue", "rivals"), { recursive: true, force: true });
            if (res.ok) p.summary = res.text;
          } else {
            if (!feedback) return;
            const res = await call(p, p.id, `revise${round}`, P.reviseAsk({ task, mine: p.summary, feedback, ctx }), shared.path, false, live.length);
            if (res.ok) p.summary = res.text;
          }
        }),
      );
      if (mode === "code") {
        await Promise.all(live.map(async (p) => {
          await snapshotDiff(p);
          await runCheck(p);
        }));
      }
    }

    // ---------- 3. judge ----------
    const finalists = players.filter((p) => p.alive && (mode === "ask" ? p.summary.trim() : p.diff.trim()));
    if (!finalists.length) {
      const errors = transcript.filter((t) => !t.ok).map((t) => `${t.who} (${t.agent}): ${t.text.replace(/^ERROR: /, "")}`);
      throw new Error(`no agent produced a ${mode === "code" ? "change" : "answer"}${errors.length ? `:\n  ${errors.join("\n  ")}` : ""}`);
    }
    const passing = finalists.filter((p) => !p.check || p.check.pass);
    const pool = passing.length ? passing : finalists;

    let verdict;
    let answer = "";
    if (pool.length === 1 && mode === "code") {
      verdict = { winner: pool[0].id, ranking: [pool[0].id], reason: finalists.length > 1 && check ? "Only solution that passes the acceptance check." : "Only remaining solution.", risks: pool[0].objections ? `${pool[0].objections} unresolved reviewer objection(s); see report.` : "not separately reviewed by judge" };
    } else {
      emit({ type: "phase", name: "judge", round });
      const judgeTree = mode === "code" ? await makeTree("judge") : shared;
      const cands = mode === "code" ? stagePatches(judgeTree.path, "candidates", pool) : pool;
      const prompt = mode === "code" ? P.judgeCode({ task, check, candidates: cands, ctx }) : P.judgeAsk({ task, candidates: pool, ctx });
      const res = await call(judge, "judge", "judge", prompt, judgeTree.path, false, 1);
      if (mode === "code") await dropTree(judgeTree.path);
      verdict = parseVerdict(res.ok ? res.text : "", pool);
      if (mode === "ask") answer = res.ok ? stripVerdict(res.text) : "";
      if (!res.ok) verdict.reason = `Judge failed (${res.error}); picked by checks and objections.`;
    }
    const winner = players.find((p) => p.id === verdict.winner);
    if (mode === "ask" && !answer) answer = winner.summary;

    // ---------- outputs ----------
    let patch = null;
    let applied = false;
    let applyError = null;
    if (mode === "code") {
      patch = join(runDir, "winner.patch");
      writeFileSync(patch, winner.diff);
      if (apply) {
        try {
          await applyPatch(ws.source, patch);
          applied = true;
        } catch (err) {
          applyError = err.message;
        }
      }
    } else {
      writeFileSync(join(runDir, "answer.md"), answer);
    }

    result = {
      runId,
      status: "done",
      mode,
      task,
      winner: { id: winner.id, agent: winner.name },
      reason: verdict.reason,
      risks: verdict.risks,
      ranking: verdict.ranking,
      agents: players.map((p) => ({ id: p.id, agent: p.name, ok: p.alive, check: p.check ? p.check.pass : null, objections: p.objections, testEdits: p.testEdits ?? [], ...(p.stats ? { files: p.stats.files, added: p.stats.add, removed: p.stats.del } : {}) })),
      files: mode === "code" ? diffFiles(winner.diff) : [],
      answer: mode === "ask" ? answer : undefined,
      check,
      rounds: round,
      costUsd: round4(ledger.costUsd),
      tokens: ledger.tokens,
      calls: ledger.calls,
      patch,
      applied,
      applyError,
      project: home,
      report: join(runDir, "report.md"),
      runDir,
    };
    writeFileSync(result.report, renderReport({ result, players, transcript }));
    writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));
    emit({ type: "done", result });
    return result;
  } catch (err) {
    const failure = { runId, status: "failed", error: err.message, costUsd: round4(ledger.costUsd), tokens: ledger.tokens, runDir };
    writeFileSync(join(runDir, "result.json"), JSON.stringify(failure, null, 2));
    writeFileSync(join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));
    emit({ type: "error", message: err.message });
    err.runDir = runDir;
    throw err;
  } finally {
    try {
      const m = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
      writeFileSync(join(runDir, "meta.json"), JSON.stringify({ ...m, status: result ? "done" : "failed", endedAt: new Date().toISOString() }, null, 2));
    } catch {}
    if (!keep) {
      await unaborted(async () => {
        for (const path of [...worktrees]) await dropTree(path).catch(() => {});
        await run("git", ["worktree", "prune"], { cwd: ws.root });
      });
      rmSync(scratch, { recursive: true, force: true });
    } else {
      emit({ type: "note", text: `worktrees kept in ${scratch}` });
    }
  }
}

/** Pre-existing test files a patch modifies or deletes (new test files are fine). */
export function modifiedTests(diff = "") {
  const out = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const file = block.match(/^a\/(.+?) b\//)?.[1];
    if (!file || /^new file mode/m.test(block)) continue;
    if (/(^|[\/._-])(tests?|specs?|__tests__)([\/._-]|$)/i.test(file)) out.push(file);
  }
  return out;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** Extract {"winner": ...} from judge output; fall back to fewest objections. */
export function parseVerdict(text, pool) {
  const ids = pool.map((p) => p.id);
  const candidates = [...String(text ?? "").matchAll(/\{[^{}]*"winner"[^{}]*\}/g)].map((m) => m[0]);
  const whole = lastJsonObject(text ?? "");
  for (const c of [...candidates, whole]) {
    if (!c) continue;
    try {
      const v = typeof c === "string" ? JSON.parse(c) : c;
      const w = String(v.winner ?? "").trim().replace(/^Candidate\s+|^Answer\s+/i, "");
      if (ids.includes(w)) {
        const ranking = Array.isArray(v.ranking) ? v.ranking.map(String).filter((id) => ids.includes(id)) : [w];
        return { winner: w, ranking: ranking.length ? ranking : [w], reason: String(v.reason ?? ""), risks: String(v.risks ?? "") };
      }
    } catch {}
  }
  const best = [...pool].sort((a, b) => (a.objections ?? 0) - (b.objections ?? 0))[0];
  return { winner: best.id, ranking: [best.id], reason: "Judge verdict unreadable; picked the candidate with the fewest reviewer objections.", risks: "unknown" };
}

export function stripVerdict(text = "") {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^\s*\{.*"winner".*\}\s*$/.test(l));
  return (i >= 0 ? [...lines.slice(0, i), ...lines.slice(i + 1)] : lines).join("\n").trim();
}
