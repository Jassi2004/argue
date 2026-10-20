import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ask } from "../harnesses/index.js";
import { lastJsonObject, run, shell, tail, unaborted, withScope } from "../util/exec.js";
import { addWorktree, applyPatch, diffFiles, diffSince, diffStats, ignoreArgueDir, openWorkspace, removeWorktree, resetWorktree } from "../workspace/git.js";
import * as P from "../instructions/index.js";
import { writeJson } from "../util/fs.js";
import { describe, lineupCard, lineupNote } from "../models/index.js";
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
 * answer mode: answer → [critique → revise]×rounds → final answer merged from the best of all
 *
 * Agents are anonymous letters (A, B, C…) to each other and to the judge.
 * Each agent works in its own git worktree outside the project, so nothing touches the user's files
 * unless `apply` is set.
 */
export function argue(opts) {
  return argueInner(opts);
}

async function argueInner(opts) {
  let { task, agents, judge, drivers, installed, cwd, mode = "code", rounds = 2, budget, timeout = 20, apply = false, keep = false, ctx = "" } = opts;
  const { onEvent = () => {}, signal } = opts;
  if (mode === "answer") mode = "answer"; // older name
  const check = mode === "code" ? opts.check || null : null;
  const runId = opts.runId ?? newRunId();
  const originalTask = opts.task;
  const timeoutMs = timeout * 60_000;

  // Where the user's project lives and where argue keeps things.
  const scratch = join(tmpdir(), "argue", `${basename(cwd).replace(/[^\w.-]/g, "_")}-${runId}`);
  mkdirSync(scratch, { recursive: true });
  let ws;
  try {
    ws = await openWorkspace(cwd, scratch);
  } catch (err) {
    rmQuiet(scratch);
    throw err;
  }
  const home = ws.home;
  const runDir = join(home, ".argue", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  await ignoreArgueDir(home);

  // Agents work in private copies. Briefs written by a host agent often contain the project's absolute path,
  // which would send agents to edit the real project; point those paths at the agent's own copy instead.
  const roots = projectPaths(home, ws.source, cwd);
  task = localizePaths(task, roots);
  ctx = localizePaths(ctx, roots);
  const projectBefore = await projectFingerprint(ws);

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

  // Cross-platform cancellation: `argue cancel` drops a "cancel" file into the run folder.
  const local = new AbortController();
  // The caller may already have cancelled while the workspace was being prepared.
  if (signal?.aborted) local.abort();
  else signal?.addEventListener("abort", () => local.abort(), { once: true });
  const cancelPoll = setInterval(() => {
    if (existsSync(join(runDir, "cancel"))) local.abort();
  }, 500);
  cancelPoll.unref?.();

  const players = agents.map((a, i) => ({ ...a, id: String.fromCharCode(65 + i), alive: true, summary: "", diff: "", check: null, objections: 0 }));
  const meta = {
    runId,
    task: originalTask,
    mode,
    check,
    rounds,
    budget: budget ?? null,
    agents: players.map((p) => ({ id: p.id, agent: p.name, ...pick(describe(p, { drivers, cwd: home }), ["harness", "model", "effort", "effortSupported"]) })),
    judge: judge.name,
    project: home,
    runDir,
    scratch,
  };
  meta.note = lineupNote(meta.agents);
  meta.display = lineupCard(meta.agents);
  writeJson(join(runDir, "meta.json"), { ...meta, status: "running", startedAt: new Date().toISOString(), pid: process.pid });
  emit({ type: "start", ...meta });

  const makeTree = async (name) => {
    if (local.signal.aborted) throw new Error("cancelled");
    const path = join(scratch, name);
    // Track it before creating, so a worktree that is half-made when a cancel lands still gets removed.
    worktrees.push(path);
    const start = await addWorktree(ws, path);
    return { path, start };
  };
  // Pristine scratch trees (for reviewers and the judge) are reused across rounds instead of re-created.
  const pristine = {};
  const scratchTree = async (name) => {
    if (pristine[name]) {
      await resetWorktree(ws, pristine[name].path, pristine[name].start);
      return pristine[name];
    }
    return (pristine[name] = await makeTree(name));
  };
  const dropTree = async (path) => {
    if (keep) return;
    await removeWorktree(ws, path);
    rmQuiet(path);
    const i = worktrees.indexOf(path);
    if (i >= 0) worktrees.splice(i, 1);
  };

  const call = async (agent, who, phase, prompt, dir, write, concurrent = 1) => {
    if (local.signal.aborted) throw new Error("cancelled");
    const t0 = Date.now();
    emit({ type: "call", status: "start", who, agent: agent.name, phase });
    // Split what is left of the budget between the calls running in parallel (Claude Code enforces it per call).
    const remaining = budget > 0 ? Math.max(0.05, (budget - ledger.costUsd) / concurrent) : undefined;
    const res = await ask(drivers, installed, agent, { prompt, cwd: dir, tag: `${who}-${phase}`, write, timeoutMs, budgetUsd: remaining, protect: roots });
    ledger.costUsd += res.costUsd || 0;
    ledger.tokens += res.tokens || 0;
    ledger.calls++;
    if (local.signal.aborted) throw new Error("cancelled");
    const secs = Math.round((Date.now() - t0) / 1000);
    emit({
      type: "call",
      status: "done",
      who,
      agent: agent.name,
      phase,
      ok: res.ok,
      secs,
      costUsd: res.costUsd || 0,
      tokens: res.tokens || 0,
      error: res.error,
      spentUsd: ledger.costUsd,
    });
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

  /** After a revision: if it broke a previously passing check (or emptied the diff), roll back to the last good version. */
  const keepBest = async (p, before) => {
    const regressed = (before.check?.pass && p.check && !p.check.pass) || (!p.diff.trim() && before.diff.trim());
    if (!regressed) return;
    emit({ type: "note", text: `${p.id}'s revision ${p.diff.trim() ? "broke the check" : "removed its changes"}; keeping its previous version` });
    await resetWorktree(ws, p.tree.path, p.tree.start);
    if (before.diff.trim()) {
      const f = join(runDir, `${p.id}.prev.patch`);
      writeFileSync(f, before.diff);
      await run("git", ["apply", "--whitespace=nowarn", f], { cwd: p.tree.path });
      rmSync(f, { force: true });
    }
    Object.assign(p, {
      diff: before.diff,
      stats: before.stats,
      testEdits: before.testEdits,
      check: before.check,
      summary: before.summary,
      revisedAfter: false,
    });
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
  // Agents inherit ARGUE_DEPTH so an agent cannot start a nested argue run.
  const depth = Number(process.env.ARGUE_DEPTH || 0) + 1;
  // Record live agent pids so `argue cancel` can clean up even if this process is killed hard.
  const pids = new Set();
  const onSpawn = (pid, alive) => {
    if (!pid) return;
    if (alive) pids.add(pid);
    else pids.delete(pid);
    try {
      writeFileSync(join(runDir, "pids"), [...pids].join("\n"));
    } catch {}
  };
  return withScope({ signal: local.signal, env: { ARGUE_DEPTH: String(depth) }, onSpawn }, async () => {
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
          const approach = P.APPROACHES[i % P.APPROACHES.length];
          const prompt = P.solve({ task, check, approach, ctx, isCode: mode === "code" });
          const res = await call(p, p.id, "propose", prompt, p.tree.path, mode === "code", players.length);
          p.alive = res.ok && (mode === "code" || Boolean(res.text.trim()));
          p.summary = res.ok ? res.text : "";
        }),
      );
      if (mode === "code") {
        await Promise.all(
          players
            .filter((p) => p.alive)
            .map(async (p) => {
              await snapshotDiff(p);
              if (!p.diff.trim()) {
                p.alive = false;
                emit({ type: "note", text: `${p.id} made no changes` });
              } else await runCheck(p);
            }),
        );
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
              const tree = await scratchTree(`review-${critic.id}`);
              const staged = stagePatches(tree.path, "rivals", rivals);
              res = await call(
                critic,
                critic.id,
                `critique${round}`,
                P.critique({ task, check, self: critic.id, others: staged, ctx, isCode: true }),
                tree.path,
                true,
                live.length,
              );
            } else {
              res = await call(
                critic,
                critic.id,
                `critique${round}`,
                P.critique({ task, self: critic.id, others: rivals, ctx, isCode: false }),
                shared.path,
                false,
                live.length,
              );
            }
            if (!res.ok) return;
            const parts = P.splitCritique(
              res.text,
              rivals.map((r) => r.id),
            );
            for (const r of rivals) if (parts[r.id]) reviews[r.id][critic.id] = parts[r.id];
          }),
        );

        for (const p of live) {
          p.revisedAfter = false;
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
        const before = Object.fromEntries(
          live.map((p) => [p.id, { diff: p.diff, stats: p.stats, testEdits: p.testEdits, check: p.check, summary: p.summary }]),
        );
        await Promise.all(
          live.map(async (p) => {
            const feedback = Object.entries(reviews[p.id])
              .filter(([, text]) => P.hasIssues(text))
              .map(([critic, text]) => `--- Reviewer ${critic} ---\n${text}`)
              .join("\n\n");
            if (mode === "code") {
              if (!feedback && (!check || p.check?.pass)) return; // nothing to fix
              stagePatches(
                p.tree.path,
                "rivals",
                live.filter((o) => o !== p),
              );
              const res = await call(
                p,
                p.id,
                `revise${round}`,
                P.improve({ task, check, previous: p.summary, feedback, checkResult: p.check, ctx, isCode: true }),
                p.tree.path,
                true,
                live.length,
              );
              rmSync(join(p.tree.path, ".argue", "rivals"), { recursive: true, force: true });
              if (res.ok && res.text.trim()) p.summary = res.text;
              if (res.ok) p.revisedAfter = true;
            } else {
              if (!feedback) return;
              const res = await call(
                p,
                p.id,
                `revise${round}`,
                P.improve({ task, previous: p.summary, feedback, ctx, isCode: false }),
                shared.path,
                false,
                live.length,
              );
              if (res.ok && res.text.trim()) p.summary = res.text;
              if (res.ok) p.revisedAfter = true;
            }
          }),
        );
        if (mode === "code") {
          await Promise.all(
            live.map(async (p) => {
              await snapshotDiff(p);
              await runCheck(p);
              await keepBest(p, before[p.id]);
            }),
          );
        }
      }

      // ---------- 3. final answer ----------
      const finalists = players.filter((p) => p.alive && (mode === "code" ? p.diff.trim() : p.summary.trim()));
      if (!finalists.length) {
        const errors = transcript.filter((t) => !t.ok).map((t) => `${t.who} (${t.agent}): ${t.text.replace(/^ERROR: /, "")}`);
        throw new Error(`no agent produced a ${mode === "code" ? "change" : "answer"}${errors.length ? `:\n  ${errors.join("\n  ")}` : ""}`);
      }
      // In code mode, a passing check is required when any candidate passes.
      const passing = finalists.filter((p) => !p.check || p.check.pass);
      const pool = passing.length ? passing : finalists;
      const isCode = mode === "code";

      let verdict;
      let answer = "";
      if (overBudget()) {
        verdict = parseVerdict("", pool);
        verdict.reason = `Budget of $${budget} reached; picked by checks and reviewer objections.`;
      } else {
        // One model (the judge) writes the single vetted answer, or, for code, picks and explains the best change.
        emit({ type: "phase", name: "final", round });
        const tree = isCode ? await scratchTree(Object.keys(pristine)[0] ?? "final") : shared;
        const cands = isCode ? stagePatches(tree.path, "candidates", pool) : pool;
        const res = await call(judge, "judge", "final", P.finalAnswer({ task, check, candidates: cands, ctx, isCode }), tree.path, false, 1);
        verdict = parseVerdict(res.ok ? res.text : "", pool);
        if (res.ok) answer = scrubProcess(stripVerdict(res.text));
        else verdict.reason = `Final step failed (${res.error}); picked by checks and objections.`;
      }
      const winner = players.find((p) => p.id === verdict.winner);
      // Fall back to the chosen model's own last answer if the final step produced nothing.
      if (!answer.trim()) answer = winner.summary;

      // ---------- outputs ----------
      const touched = (await projectFingerprint(ws)) !== projectBefore;
      if (touched)
        emit({
          type: "warning",
          text: "your project's files changed during the run (by you, or by an agent that escaped its copy); review `git status` before applying",
        });
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
      }
      writeFileSync(join(runDir, "answer.md"), answer);

      result = {
        runId,
        status: "done",
        mode,
        task: originalTask,
        winner: { id: winner.id, agent: winner.name },
        reason: verdict.reason,
        risks: verdict.risks,
        agents: players.map((p) => ({
          id: p.id,
          agent: p.name,
          ok: p.alive,
          check: p.check ? p.check.pass : null,
          objections: p.objections,
          testEdits: p.testEdits ?? [],
          ...(p.stats ? { files: p.stats.files, added: p.stats.add, removed: p.stats.del } : {}),
        })),
        files: mode === "code" ? diffFiles(winner.diff) : [],
        answer,
        unresolved: verdict.unresolved ?? null,
        check,
        rounds: round,
        costUsd: round4(ledger.costUsd),
        tokens: ledger.tokens,
        calls: ledger.calls,
        patch,
        applied,
        applyError,
        projectChanged: touched,
        project: home,
        report: join(runDir, "report.md"),
        runDir,
      };
      writeFileSync(result.report, renderReport({ result, players, transcript }));
      writeJson(join(runDir, "transcript.json"), transcript);
      writeJson(join(runDir, "result.json"), result);
      emit({ type: "done", result });
      return result;
    } catch (caught) {
      const err = local.signal.aborted ? Object.assign(new Error("cancelled"), { cause: caught }) : caught;
      const failure = { runId, status: "failed", error: err.message, costUsd: round4(ledger.costUsd), tokens: ledger.tokens, runDir };
      writeJson(join(runDir, "transcript.json"), transcript);
      writeJson(join(runDir, "result.json"), failure);
      emit({ type: "error", message: err.message });
      err.runDir = runDir;
      throw err;
    } finally {
      try {
        const m = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
        writeJson(join(runDir, "meta.json"), { ...m, status: result ? "done" : "failed", endedAt: new Date().toISOString() });
      } catch {}
      if (!keep) {
        await unaborted(async () => {
          for (const path of [...worktrees]) await dropTree(path).catch(() => {});
          await run("git", ["worktree", "prune"], { cwd: ws.root });
        });
        rmQuiet(scratch);
      } else {
        emit({ type: "note", text: `worktrees kept in ${scratch}` });
      }
      clearInterval(cancelPoll);
    }
  });
}

/** The project's absolute path in every spelling an agent might see (symlinks like /tmp -> /private/tmp). */
function projectPaths(...dirs) {
  const out = new Set();
  for (const d of dirs) {
    if (!d) continue;
    out.add(d);
    try {
      out.add(realpathSync(d));
    } catch {}
  }
  return [...out].filter((d) => d.length > 1).sort((a, b) => b.length - a.length);
}

/** Replace absolute project paths with "." so agents act on their own copy. */
export function localizePaths(text = "", roots = []) {
  let out = String(text);
  for (const r of roots) {
    const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${esc}(?=[\\/]|\\b|$)`, "g"), ".");
  }
  return out;
}

/** Cheap fingerprint of the user's working tree (tracked changes + untracked files) to detect edits during a run. */
async function projectFingerprint(ws) {
  if (!ws.isRepo) return null;
  const res = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: ws.root });
  const diff = await run("git", ["diff", "--no-ext-diff", "--binary", "HEAD"], { cwd: ws.root });
  return `${res.stdout.replace(/[^\0]*\.argue\/[^\0]*\0/g, "")}::${diff.stdout.length}::${hash(diff.stdout)}`;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Pre-existing test files a patch modifies or deletes (new test files are fine). */
export function modifiedTests(diff = "") {
  const out = [];
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    const file = block.match(/^a\/(.+?) b\//)?.[1];
    if (!file || /^new file mode/m.test(block)) continue;
    if (/(^|[/._-])(tests?|specs?|__tests__)([/._-]|$)/i.test(file)) out.push(file);
  }
  return out;
}

/** Best-effort delete (Windows can keep files locked briefly after a process is killed). */
function rmQuiet(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** Extract {"winner": ...} from judge output; fall back to fewest objections. */
/**
 * Read the final step's first line, {"pick": "A", "unresolved": "…"}. Also accepts the older
 * {"winner": "A", …}. Falls back to the candidate with the fewest objections (passing checks first).
 */
export function parseVerdict(text, pool) {
  const ids = pool.map((p) => p.id);
  const found = [...String(text ?? "").matchAll(/\{[^{}]*"(?:pick|winner)"[^{}]*\}/g)].map((m) => m[0]);
  for (const c of [...found, lastJsonObject(text ?? "")]) {
    if (!c) continue;
    try {
      const v = typeof c === "string" ? JSON.parse(c) : c;
      const w = String(v.pick ?? v.winner ?? "")
        .trim()
        .replace(/^(Candidate|Answer|Model|Work)\s+/i, "");
      if (!ids.includes(w)) continue;
      const unresolved = v.unresolved && !/^none\.?$/i.test(String(v.unresolved).trim()) ? String(v.unresolved) : null;
      return { winner: w, reason: String(v.reason ?? ""), risks: String(v.risks ?? unresolved ?? ""), unresolved };
    } catch {}
  }
  const best = [...pool].sort((a, b) => (a.objections ?? 0) - (b.objections ?? 0))[0];
  return { winner: best.id, reason: "Picked the work with the fewest reviewer objections.", risks: "", unresolved: null };
}

/** Safety net: turn leftover "Candidate B" / "Model A's" / "Answer C" mentions into neutral wording. */
export function scrubProcess(text = "") {
  return text
    .replace(/\b(?:candidate|model|answer|solution|work|agent)\s+[A-H]'s\s+/gi, "another ")
    .replace(/\b(?:candidate|model|solution|agent)\s+[A-H]\b/gi, "another approach");
}

/** Remove the leading JSON line from the final answer. */
export function stripVerdict(text = "") {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^\s*\{.*"(?:pick|winner)".*\}\s*$/.test(l));
  return (i >= 0 ? [...lines.slice(0, i), ...lines.slice(i + 1)] : lines).join("\n").trim();
}
