import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ask } from "../agents/drivers.js";
import { describe, label, limitsNote, lineupCard, lineupNote } from "../agents/lineup.js";
import { lastJsonObject, unaborted, withScope } from "../util/exec.js";
import { removeTree } from "../util/fs.js";
import { applyPatch, diffFiles, diffStats, ignoreArgueDir, openWorkspace } from "../workspace/git.js";
import { newRunId, openRecord } from "../runs/store.js";
import * as P from "./prompts.js";
import * as D from "./desks.js";
import * as R from "./referee.js";
import { digest, inbox, parsePost, renderRecord, standingsText } from "./protocol.js";

/**
 * One argue run: a room of agents working on one task until they agree, stall, or hit a limit.
 *
 *   opening   every agent works alone and posts its own view (parallel, private)
 *   rounds    every agent reads the room, posts, and may improve its work (parallel)
 *             · the referee (referee.js) decides after each round: continue, red-team, or end
 *   verdict   one fresh call writes the final answer from the record
 *
 * Nothing touches the user's files unless `apply` is set. The record is saved after every round,
 * so a crash or cancel never loses what the agents did.
 */
export async function runRoom(opts) {
  const { agents, judge, drivers, installed, cwd, mode = "code", rounds = 4, budget, timeout = 20, minutes = 60, apply = false, keep = false } = opts;
  const { onEvent = () => {}, signal, mcp = [] } = opts;
  const check = mode === "code" ? opts.check || null : null;
  const runId = opts.runId ?? newRunId();
  const started = Date.now();
  const timeoutMs = timeout * 60_000;

  const scratch = join(tmpdir(), "argue", `${basename(cwd).replace(/[^\w.-]/g, "_")}-${runId}`);
  mkdirSync(scratch, { recursive: true });
  let ws;
  try {
    ws = await openWorkspace(cwd, scratch, { emptyOk: mode !== "code" });
  } catch (err) {
    removeTree(scratch);
    throw err;
  }
  const runDir = join(ws.home, ".argue", "runs", runId);
  await ignoreArgueDir(ws.home);

  // Briefs written by a host agent often contain the project's absolute path; point those at each agent's own copy.
  const roots = D.projectPaths(ws.home, ws.source, cwd);
  const context = D.localizePaths(opts.context ?? "", roots);
  const task = D.localizePaths(opts.task, roots) + (context ? `\n\nContext from the user's session:\n${context}` : "");
  const projectBefore = await D.projectFingerprint(ws);

  const lenses = P.lenses();
  const players = agents.map((a, i) => {
    const d = describe(a, { drivers, cwd: ws.home });
    return { ...a, id: String.fromCharCode(65 + i), lens: lenses[i % lenses.length] ?? "", desc: d, label: label(d) };
  });
  const room = R.newRoom({ task, mode, check, agents: players });
  const letters = players.map((p) => p.id);
  const ctx = (p) => ({ id: p.id, letters, task, check, mode, lens: p.lens, maxRounds: rounds });

  const meta = {
    runId,
    task: opts.task,
    mode,
    check,
    rounds,
    budget: budget ?? null,
    agents: players.map((p) => ({
      id: p.id,
      agent: p.name,
      harness: p.desc.harness,
      model: p.desc.model,
      effort: p.desc.effort,
      effortSupported: p.desc.effortSupported,
    })),
    judge: judge.name,
    project: ws.home,
    runDir,
    scratch,
    minutes,
    note: lineupNote(players.map((p) => p.desc)),
    limits: limitsNote({ rounds, minutes, budget }),
    display: lineupCard(
      players.map((p) => p.desc),
      { rounds, minutes, budget },
    ),
  };
  const record = openRecord(runDir, meta);
  const emit = (ev) => onEvent(record.emit(ev));
  emit({ type: "start", ...meta });

  // Usage as the CLIs report it. Not every CLI reports cost or tokens, so count who did.
  const ledger = { costUsd: 0, tokens: 0, calls: 0, costCalls: 0, tokenCalls: 0, promptChars: 0 };
  const charge = (res, prompt) => {
    ledger.calls++;
    ledger.promptChars += prompt.length;
    if (res.costUsd != null) ((ledger.costUsd += res.costUsd), ledger.costCalls++);
    if (res.tokens != null) ((ledger.tokens += res.tokens), ledger.tokenCalls++);
  };
  const overBudget = () => budget > 0 && ledger.costUsd >= budget;
  const overTime = () => Date.now() - started > minutes * 60_000;

  // Cancellation: an AbortSignal from the caller, or `argue cancel` dropping a file in the run folder.
  const local = new AbortController();
  if (signal?.aborted) local.abort();
  else signal?.addEventListener("abort", () => local.abort(), { once: true });
  const stopPolling = record.onCancel(() => local.abort());
  const cancelled = () => local.signal.aborted;

  const desks = {};
  let bench = null;
  const checks = {}; // check output per agent, mirrored into every desk
  const mirror = () => ({
    record: renderRecord(room),
    work: Object.fromEntries(
      players
        .filter((p) => room.work[p.id]?.version)
        .map((p) => [p.id, { file: mode === "code" ? `${p.id}.patch` : `${p.id}.md`, text: mode === "code" ? desks[p.id].patch : desks[p.id].answer }]),
    ),
    checks,
  });
  const save = () => {
    record.saveRoom(room);
    record.saveRecord(renderRecord(room));
    for (const p of players) if (desks[p.id]) record.saveWork(p.id, mode, mode === "code" ? desks[p.id].patch : desks[p.id].answer);
  };

  const inFlight = new Set(); // agents whose turn is running (the budget is split between them)

  /** One agent's turn: sync the room into its desk, ask it, read its post and its work. */
  const turn = async (p, prompt, kind) => {
    if (cancelled()) throw new Error("cancelled");
    const desk = desks[p.id];
    D.syncRoom(desk, mirror());
    if (mode === "code" && room.round > 0) await D.readyLab(ws, desk);
    const t0 = Date.now();
    emit({ type: "call", status: "start", who: p.id, agent: p.name, kind, round: room.round });
    const concurrent = Math.max(1, inFlight.size);
    const budgetUsd = budget > 0 ? Math.max(0.05, (budget - ledger.costUsd) / concurrent) : undefined;
    const res = await ask(drivers, installed, p, {
      prompt,
      cwd: desk.path,
      tag: `${p.id}-r${room.round}`,
      write: true,
      timeoutMs,
      budgetUsd,
      protect: roots,
      mcp,
    });
    charge(res, prompt);
    if (cancelled()) throw new Error("cancelled");
    emit({
      type: "call",
      status: "done",
      who: p.id,
      agent: p.name,
      kind,
      round: room.round,
      ok: res.ok,
      secs: Math.round((Date.now() - t0) / 1000),
      costUsd: res.costUsd ?? null,
      tokens: res.tokens ?? null,
      error: res.error,
      spentUsd: ledger.costUsd,
    });
    if (!res.ok) {
      // A turn that failed midway (timeout, crash) may have left half-made edits: back to the last recorded work.
      await restore(p, { patch: desk.patch, answer: desk.answer });
      return R.recordPost(room, p.id, null, { kind, error: res.error });
    }

    const post = parsePost(res.text, { self: p.id, letters });
    const versionBefore = room.work[p.id]?.version ?? 0;
    await snapshot(p, post);
    R.recordPost(room, p.id, post, { kind });
    const w = room.work[p.id];
    emit({
      type: "post",
      who: p.id,
      round: room.round,
      kind,
      stance: room.stance[p.id],
      challenges: room.challenges.filter((c) => c.by === p.id && c.round === room.round).map(({ id, target, text }) => ({ id, target, text })),
      answers: post.answers.map((a) => a.ref),
      withdraws: post.withdraws,
      asks: post.asks,
      tools: post.tools,
      gist: post.gist,
      version: w?.version ?? 0,
      changed: (w?.version ?? 0) > versionBefore,
      check: w?.check ?? null,
    });
  };
  /** Play turns at the same time. `list`: [[player, prompt], …]. */
  const playAll = (list, kind) => {
    for (const [p] of list) inFlight.add(p.id);
    return Promise.all(list.map(([p, prompt]) => turn(p, prompt, kind).finally(() => inFlight.delete(p.id))));
  };

  /** Read an agent's work after its turn; keep its last good version if the turn broke it. */
  const snapshot = async (p, post) => {
    const desk = desks[p.id];
    const before = { patch: desk.patch, answer: desk.answer, work: room.work[p.id] };
    let work = await D.readWork(ws, desk, mode);
    if (mode === "answer" && !work.hash && !before.work && post.body.length > 200) {
      // Replied with its answer instead of writing the file: keep it anyway.
      D.adoptAnswer(desk, post.body);
      work = await D.readWork(ws, desk, mode);
    }
    if (!work.hash && before.work) {
      R.note(room, `Your work was emptied during your turn, so argue kept your previous version (v${before.work.version}).`, p.id);
      await restore(p, before);
      return;
    }
    if (!work.hash) return;
    let checkPass = before.work?.hash === work.hash ? before.work.check : null;
    if (check && (checkPass === null || before.work?.hash !== work.hash)) {
      const res = await D.runCheck(desk, check, timeoutMs);
      checkPass = res.pass;
      emit({ type: "check", who: p.id, pass: res.pass });
      if (!res.pass && before.work?.check === true) {
        checks[`${p.id}.rejected`] = res.output;
        R.note(
          room,
          `Your last change made the check fail, so argue kept your previous version (v${before.work.version}). The failing output is in .argue/room/checks/${p.id}.rejected.txt.`,
          p.id,
        );
        await restore(p, before);
        return;
      }
      checks[p.id] = res.output;
    }
    R.recordWork(room, p.id, { hash: work.hash, check: checkPass, testEdits: work.testEdits ?? [] });
  };
  const restore = async (p, before) => {
    const desk = desks[p.id];
    if (mode === "code") await D.restorePatch(ws, desk, before.patch, scratch);
    else D.adoptAnswer(desk, before.answer);
    desk.patch = before.patch;
    desk.answer = before.answer;
  };

  let result;
  const pids = new Set();
  const onSpawn = (pid, live) => {
    if (!pid) return;
    if (live) pids.add(pid);
    else pids.delete(pid);
    record.savePids(pids);
  };
  // Agents inherit ARGUE_DEPTH so an agent cannot start a nested argue run.
  const depth = Number(process.env.ARGUE_DEPTH || 0) + 1;
  return withScope({ signal: local.signal, env: { ARGUE_DEPTH: String(depth) }, onSpawn }, async () => {
    try {
      // ---------- desks ----------
      for (const p of players) desks[p.id] = await D.openDesk(ws, join(scratch, p.id));

      // ---------- opening ----------
      emit({ type: "phase", name: "opening", round: 0, players: letters });
      await playAll(
        players.map((p) => [p, P.opening(ctx(p))]),
        "opening",
      );
      R.closeRound(room);
      save();
      if (!Object.keys(room.work).length) {
        const errors = room.posts.filter((x) => x.error).map((x) => `${x.by} (${players.find((p) => p.id === x.by).name}): ${x.error}`);
        throw new Error(`no agent produced ${mode === "code" ? "a change" : "an answer"}${errors.length ? `:\n  ${errors.join("\n  ")}` : ""}`);
      }
      for (const p of players)
        if (!room.work[p.id] && !room.posts.find((x) => x.by === p.id)?.error)
          R.note(room, `${p.id} produced no work of its own; it can still review and back others.`);

      // ---------- rounds ----------
      let decision;
      for (;;) {
        decision = R.decide(room, { maxRounds: rounds, overBudget: overBudget(), overTime: overTime() });
        if (decision.end) break;
        const view = digest(room);
        const next = room.round + 1;
        if (decision.next === "red-team") {
          const p = players.find((x) => x.id === decision.by);
          const prompt = P.redTeam(ctx(p), { round: next, digest: view, target: decision.target });
          R.openRound(room);
          emit({ type: "phase", name: "red-team", round: room.round, players: [p.id], target: decision.target });
          await playAll([[p, prompt]], "red-team");
          R.closeRedTeam(room, decision.target);
        } else {
          const list = decision.players.map((id) => players.find((x) => x.id === id));
          const prompts = list.map((p) => [p, P.turn(ctx(p), { round: next, digest: view, inbox: inbox(room, p.id) })]);
          R.openRound(room);
          emit({ type: "phase", name: "round", round: room.round, players: decision.players });
          await playAll(prompts, "turn");
        }
        R.closeRound(room);
        save();
      }
      const outcome = R.outcomeText(room, decision);
      emit({ type: "end", reason: decision.end, winner: decision.winner ?? null, outcome, round: room.round });

      // ---------- verdict ----------
      const pool = R.standings(room);
      const agreed = decision.end === "consensus" ? decision.winner : null;
      let pick = agreed ?? pool[0].id;
      let answer = "";
      let unresolved = null;
      if (!overBudget()) {
        emit({ type: "phase", name: "verdict", round: room.round });
        bench = await D.openDesk(ws, join(scratch, "verdict"));
        D.syncRoom(bench, mirror());
        const prompt = P.verdict({ task, check, mode, outcome, standings: standingsText(room, pool) });
        const t0 = Date.now();
        emit({ type: "call", status: "start", who: "verdict", agent: judge.name, kind: "verdict", round: room.round });
        const res = await ask(drivers, installed, judge, { prompt, cwd: bench.path, tag: "verdict", write: false, timeoutMs, protect: roots });
        charge(res, prompt);
        emit({
          type: "call",
          status: "done",
          who: "verdict",
          agent: judge.name,
          kind: "verdict",
          round: room.round,
          ok: res.ok,
          secs: Math.round((Date.now() - t0) / 1000),
          costUsd: res.costUsd ?? null,
          tokens: res.tokens ?? null,
          error: res.error,
          spentUsd: ledger.costUsd,
        });
        if (res.ok) {
          const v = parseVerdict(
            res.text,
            pool.map((s) => s.id),
          );
          // In code mode the room's agreement decides which patch ships; the verdict only explains it.
          if (v.pick && !(mode === "code" && agreed)) pick = v.pick;
          unresolved = v.unresolved;
          answer = scrubProcess(stripVerdict(res.text));
        } else R.note(room, `The final step failed (${res.error}); the answer is ${pick}'s work as it stood.`);
      }
      if (!answer.trim()) answer = mode === "code" ? (room.posts.filter((x) => x.by === pick && !x.error).at(-1)?.body ?? "") : desks[pick].answer;
      if (cancelled()) throw new Error("cancelled");

      // ---------- outputs ----------
      const projectChanged = (await D.projectFingerprint(ws)) !== projectBefore;
      if (projectChanged)
        emit({
          type: "warning",
          text: "your project's files changed during the run (by you, or by an agent that left its copy); check `git status` before applying",
        });
      record.saveAnswer(answer);
      const winner = players.find((p) => p.id === pick);
      let patch = null;
      let applied = false;
      let applyError = null;
      if (mode === "code") {
        patch = record.saveWork(pick, mode, desks[pick].patch, "winner");
        if (apply) {
          try {
            await applyPatch(ws.source, patch);
            applied = true;
          } catch (err) {
            applyError = err.message;
          }
        }
      }
      result = {
        runId,
        status: "done",
        mode,
        task: opts.task,
        answer,
        unresolved,
        outcome,
        ended: decision.end,
        agreed: Boolean(agreed),
        winner: { id: winner.id, agent: winner.name },
        agents: players.map((p) => {
          const w = room.work[p.id];
          const s = mode === "code" && desks[p.id].patch ? diffStats(desks[p.id].patch) : null;
          return {
            id: p.id,
            agent: p.name,
            harness: p.desc.harness,
            model: p.desc.model,
            alive: room.agents.find((a) => a.id === p.id).alive,
            stance: room.stance[p.id] ?? null,
            version: w?.version ?? 0,
            check: w?.check ?? null,
            testEdits: w?.testEdits ?? [],
            ...(s ? { files: s.files, added: s.add, removed: s.del } : {}),
          };
        }),
        files: mode === "code" ? diffFiles(desks[pick].patch) : [],
        patch,
        applied,
        applyError,
        check,
        rounds: room.round,
        challenges: room.challenges.length,
        projectChanged,
        costUsd: round4(ledger.costUsd),
        tokens: ledger.tokens,
        calls: ledger.calls,
        costCalls: ledger.costCalls,
        tokenCalls: ledger.tokenCalls,
        promptChars: ledger.promptChars,
        seconds: Math.round((Date.now() - started) / 1000),
        project: ws.home,
        runDir,
      };
      save();
      record.saveRecord(renderRecord(room, { outcome, answer }));
      record.finish(result);
      emit({ type: "done", result });
      return result;
    } catch (caught) {
      const err = cancelled() ? Object.assign(new Error("cancelled"), { cause: caught }) : caught;
      try {
        save();
        record.saveRecord(renderRecord(room, { outcome: `The run ${err.message === "cancelled" ? "was cancelled" : `failed: ${err.message}`}.` }));
      } catch {}
      record.finish({ runId, status: "failed", error: err.message, costUsd: round4(ledger.costUsd), tokens: ledger.tokens, runDir });
      emit({ type: "error", message: err.message });
      err.runDir = runDir;
      throw err;
    } finally {
      stopPolling();
      await unaborted(async () => {
        if (!keep) {
          for (const desk of [...Object.values(desks), bench].filter(Boolean)) await D.closeDesk(ws, desk);
          removeTree(scratch);
        }
      });
      if (keep) emit({ type: "note", text: `desks kept in ${scratch}` });
      record.close();
    }
  });
}

const round4 = (n) => Math.round(n * 10000) / 10000;

/** Read the verdict's first JSON line: {"pick": "B", "unresolved": "…"}. */
export function parseVerdict(text = "", ids = []) {
  const found = [...String(text).matchAll(/\{[^{}]*"pick"[^{}]*\}/g)].map((m) => m[0]);
  for (const c of [...found, lastJsonObject(text)]) {
    if (!c) continue;
    try {
      const v = typeof c === "string" ? JSON.parse(c) : c;
      const pick = String(v.pick ?? "")
        .trim()
        .replace(/^(?:agent|candidate|work|answer|model)\s+/i, "");
      if (!ids.includes(pick)) continue;
      const u = v.unresolved == null ? "" : String(v.unresolved).trim();
      return { pick, unresolved: u && !/^none\.?$/i.test(u) ? u : null };
    } catch {}
  }
  return { pick: null, unresolved: null };
}

/** Remove the verdict's JSON line, and the code fence around it if the model added one. */
export function stripVerdict(text = "") {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^\s*\{.*"pick".*\}\s*$/.test(l));
  if (i < 0) return text.trim();
  const fenced = /^\s*```\w*\s*$/.test(lines[i - 1] ?? "") && /^\s*```\s*$/.test(lines[i + 1] ?? "");
  const [from, to] = fenced ? [i - 1, i + 2] : [i, i + 1];
  return [...lines.slice(0, from), ...lines.slice(to)].join("\n").trim();
}

/** Safety net: turn leftover "agent B" / "B's work" mentions into neutral wording. */
export function scrubProcess(text = "") {
  return text
    .replace(/\b(?:candidate|model|agent|solution|work)\s+[A-H]'s\s+/gi, "another ")
    .replace(/\b(?:candidate|model|agent|solution)\s+[A-H]\b/gi, "another approach");
}
