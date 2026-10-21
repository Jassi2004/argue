import { similarity } from "./protocol.js";

/**
 * The referee: the room's state, and the decision between rounds. Pure functions, no I/O.
 *
 * Agents decide what to do; the referee only keeps score and enforces the few things that must
 * hold for the answer to be trustworthy and the run to end:
 *   - consensus counts only when everyone backs the same work, has seen its latest version,
 *     someone else challenged it (or a red-team turn tried and failed to), no challenge against
 *     it is left open, and its check passes
 *   - a round with no progress, twice in a row, ends the room (stall); so does returning to an
 *     earlier state (loop)
 *   - repeated challenges and copy-paste posts don't count as progress
 *   - safety limits: rounds, budget, wall-clock
 */

export const LIMITS = { stallRounds: 2, repeatSimilarity: 0.6, novelSimilarity: 0.35, maxFailures: 2 };

export function newRoom({ task, mode, check, agents }) {
  return {
    task,
    mode,
    check: check ?? null,
    round: 0,
    agents: agents.map((a) => ({ id: a.id, label: a.label ?? a.id, kind: a.kind ?? null, lens: a.lens ?? "", tools: "", alive: true, failures: 0 })),
    stance: {}, // id -> "B" | "open" | "impasse"
    work: {}, // id -> { version, hash, check, testEdits }
    posts: [],
    challenges: [], // { id, by, target, text, round, status, answers: [{ round, text }], repeatOf }
    notes: [], // { round, to?, text }
    events: [], // progress: { round, type, by, target?, to? }
    redTeamed: {}, // candidate id -> round of the red-team turn that found nothing
    lastPlayed: {}, // id -> last round the agent played
    stalled: 0,
    states: [], // per round: a signature of stances, work versions and challenge states (loop detection)
  };
}

const agentOf = (room, id) => room.agents.find((a) => a.id === id);
const letters = (room) => room.agents.map((a) => a.id);
export const alive = (room) => room.agents.filter((a) => a.alive);
const hasWork = (room, id) => Boolean(room.work[id]?.version);
const event = (room, e) => room.events.push({ round: room.round, ...e });
export const note = (room, text, to) => room.notes.push({ round: room.round, text, ...(to ? { to } : {}) });

/** Start the next round. */
export function openRound(room) {
  room.round++;
}

/**
 * Record an agent's turn: its parsed post (see protocol.parsePost), or an error.
 * Assigns challenge numbers and tracks what counts as progress.
 */
export function recordPost(room, by, post, { kind = "turn", error } = {}) {
  const agent = agentOf(room, by);
  room.lastPlayed[by] = room.round;
  if (error) {
    agent.failures++;
    room.posts.push({ round: room.round, by, kind, error, stance: room.stance[by] ?? null, answers: [], withdraws: [], asks: [], challengeIds: [] });
    if (agent.failures >= LIMITS.maxFailures) {
      agent.alive = false;
      note(room, `${by} failed ${agent.failures} turns in a row and left the room`);
    }
    return;
  }
  agent.failures = 0;
  if (post.tools) agent.tools = post.tools;

  // Novel content (not a copy of the author's earlier posts) is weak progress: new evidence, research results.
  const earlier = room.posts.filter((p) => p.by === by && !p.error);
  if (post.body.length > 200 && earlier.every((p) => similarity(p.body, post.body) < LIMITS.novelSimilarity)) event(room, { type: "evidence", by });

  const stance = validStance(room, by, post.stance);
  const switched = Boolean(stance && stance !== room.stance[by]);
  if (switched) {
    if (room.stance[by] !== undefined) event(room, { type: "stance", by, target: stance });
    room.stance[by] = stance;
  } else if (room.stance[by] === undefined) room.stance[by] = "open";
  // Backing work concedes your challenges against it: those raised before you switched to it,
  // and those its author has answered (you have now seen the answer). Challenges raised while
  // already backing it stay open until answered: "this is the best, but fix this first".
  for (const c of room.challenges)
    if (c.by === by && c.target === room.stance[by] && (c.status === "answered" || (switched && c.status === "open"))) c.status = "conceded";

  const challengeIds = [];
  for (const ch of post.challenges) {
    const c = addChallenge(room, by, ch);
    if (c) challengeIds.push(c.id);
  }
  for (const a of post.answers) {
    const c = room.challenges.find((x) => x.id === a.ref);
    if (!c || c.target !== by) continue;
    const fresh = c.answers.every((x) => similarity(x.text, a.text) < LIMITS.repeatSimilarity);
    c.answers.push({ round: room.round, text: a.text });
    if (c.status === "open") c.status = "answered";
    if (fresh) event(room, { type: "answer", by, target: c.by, ref: c.id });
  }
  for (const ref of post.withdraws) {
    const c = room.challenges.find((x) => x.id === ref);
    if (c && c.by === by && c.status !== "withdrawn") {
      c.status = "withdrawn";
      event(room, { type: "withdraw", by, target: c.target, ref });
    }
  }
  for (const a of post.asks) event(room, { type: "ask", by, to: a.to });
  room.posts.push({ ...post, round: room.round, by, kind, stance: room.stance[by], challengeIds });
}

/** A stance is your own letter only if you have work; a letter must be someone in the room with work. */
function validStance(room, by, stance) {
  if (!stance) return null;
  if (stance === "open" || stance === "impasse") return stance;
  if (!letters(room).includes(stance)) return null;
  return hasWork(room, stance) ? stance : "open";
}

function addChallenge(room, by, { target, text }) {
  if (!agentOf(room, target) || target === by) return null;
  const earlier = room.challenges.filter((c) => c.by === by && c.target === target && similarity(c.text, text) >= LIMITS.repeatSimilarity);
  const same = earlier.find((c) => c.status === "open");
  if (same) return null; // still open: nothing new
  const prior = earlier.at(-1);
  const c = {
    id: room.challenges.length + 1,
    by,
    target,
    text,
    round: room.round,
    version: room.work[target]?.version ?? 0, // the version it was raised against
    status: "open",
    answers: [],
    ...(prior ? { repeatOf: prior.id } : {}),
  };
  room.challenges.push(c);
  // Raising an answered point again only counts as progress if the work changed since.
  const changedSince = prior && (room.work[target]?.round ?? 0) > prior.round;
  if (!prior || changedSince) event(room, { type: "challenge", by, target, ref: c.id });
  else note(room, `#${c.id} repeats #${prior.id}, which ${target} already answered. Say what that answer misses, with new evidence, or withdraw it.`, by);
  return c;
}

/** Record an agent's current work after its turn (hash of the answer or patch). */
export function recordWork(room, id, { hash, check = null, testEdits = [] }) {
  const w = room.work[id];
  if (!hash) return;
  if (w?.hash === hash) {
    if (w.check !== check) {
      w.check = check;
      event(room, { type: "check", by: id });
    }
    return;
  }
  room.work[id] = { version: (w?.version ?? 0) + 1, hash, check, testEdits, round: room.round };
  if (w || room.round > 0) event(room, { type: "work", by: id });
}

/** Close the round: count rounds without progress, and remember the room's state. */
export function closeRound(room) {
  room.states[room.round] = signature(room);
  if (room.round === 0) return;
  const progress = room.events.some((e) => e.round === room.round);
  room.stalled = progress ? 0 : room.stalled + 1;
}

function signature(room) {
  const stances = room.agents.map((a) => `${a.id}:${a.alive ? (room.stance[a.id] ?? "-") : "x"}@${room.work[a.id]?.hash ?? "-"}`);
  return [...stances, ...room.challenges.map((c) => `#${c.id}:${c.status}`)].join("|");
}

/** The room is back in a state it was in before (not just the previous round, which is a stall). */
export function looped(room) {
  const now = room.states[room.round];
  return room.round >= 2 && room.states.slice(0, room.round - 1).includes(now);
}

/** The candidate every live agent backs, or null. */
export function agreedOn(room) {
  const live = alive(room);
  const s = room.stance[live[0]?.id];
  if (!s || s === "open" || s === "impasse") return null;
  return live.every((a) => room.stance[a.id] === s) && hasWork(room, s) ? s : null;
}

/** Has every backer of X played since X's latest version? (Backing in the same round it changed means backing an older version.) */
export function seenLatest(room, x) {
  const since = room.work[x]?.round ?? 0;
  return alive(room).every((a) => a.id === x || (room.lastPlayed[a.id] ?? -1) > since);
}

/** Challenges against X that block agreement: still open, or answered but not yet seen by the challenger. */
export function pending(room, x) {
  return room.challenges.filter((c) => c.target === x && (c.status === "open" || c.status === "answered") && agentOf(room, c.by)?.alive);
}

/** Was X's work really examined by someone else? */
export function scrutinized(room, x) {
  return room.challenges.some((c) => c.target === x && c.by !== x) || room.redTeamed[x] !== undefined;
}

/**
 * Which live agents should play next round. Agents that back some work sit out unless something since
 * their last turn concerns them: a challenge to their work or the work they back, a request to them,
 * anyone's revised work, a stance change, or a changed check on the work they back.
 */
export function whoPlays(room) {
  return alive(room)
    .filter((a) => {
      const last = room.lastPlayed[a.id] ?? -1;
      const mine = room.posts.filter((p) => p.by === a.id).at(-1);
      if (mine?.error) return true; // retry
      const s = room.stance[a.id];
      if (!s || s === "open" || s === "impasse") return true;
      if (s === a.id && room.check && room.work[a.id]?.check === false) return true;
      // Posts in a round are simultaneous, so others' events from the round it last played are news too.
      const news = room.events.filter((e) => e.round >= last && e.by !== a.id);
      return news.some(
        (e) => e.type === "stance" || e.type === "work" || e.target === a.id || e.target === s || e.to === a.id || (e.type === "check" && e.by === s),
      );
    })
    .map((a) => a.id);
}

/** Candidates, strongest first: check passes, most backers, fewest open challenges. */
export function standings(room) {
  const backers = (id) => alive(room).filter((a) => room.stance[a.id] === id).length;
  const open = (id) => room.challenges.filter((c) => c.target === id && c.status === "open").length;
  return room.agents
    .filter((a) => hasWork(room, a.id))
    .map((a) => ({ id: a.id, backers: backers(a.id), open: open(a.id), check: room.work[a.id].check, version: room.work[a.id].version }))
    .sort((x, y) => (y.check === true) - (x.check === true) || y.backers - x.backers || x.open - y.open || y.version - x.version);
}

/**
 * What happens next:
 *   { end: "consensus", winner }  | { end: "impasse" | "stalled" | "loop" | "quiet" | "rounds" | "budget" | "time" | "alone" | "no-work" }
 *   { next: "red-team", target, by } | { next: "round", players }
 */
export function decide(room, { maxRounds, overBudget = false, overTime = false }) {
  const live = alive(room);
  if (!room.agents.some((a) => hasWork(room, a.id))) return { end: "no-work" };
  const x = agreedOn(room);
  const limit = overBudget ? "budget" : overTime ? "time" : room.round >= maxRounds ? "rounds" : null;
  const fresh = x && seenLatest(room, x) && !pending(room, x).length;
  if (x && fresh) {
    const checkOk = !room.check || room.work[x].check === true;
    if (checkOk && scrutinized(room, x)) return { end: "consensus", winner: x };
    if (!limit && live.length >= 2 && checkOk) return { next: "red-team", target: x, by: redTeamer(room, x) };
    if (!checkOk && !room.notes.some((n) => n.round === room.round && /check fails/.test(n.text)))
      note(room, `Everyone backs ${x}, but its check fails. Fix it, or back work whose check passes.`);
  }
  if (live.length < 2) return { end: "alone" };
  if (live.every((a) => room.stance[a.id] === "impasse")) return { end: "impasse" };
  if (limit) return { end: limit };
  if (room.stalled >= LIMITS.stallRounds) return { end: "stalled" };
  if (looped(room)) return { end: "loop" };
  const players = room.round === 0 ? live.map((a) => a.id) : whoPlays(room);
  if (!players.length) return { end: "quiet" };
  return { next: "round", players };
}

/** The red-team agent: someone other than the author, preferably a different model family. */
function redTeamer(room, x) {
  const others = alive(room).filter((a) => a.id !== x);
  const kind = agentOf(room, x)?.kind;
  return (others.find((a) => a.kind !== kind) ?? others[0]).id;
}

/** After a red-team turn on X: if it raised nothing against X, X counts as scrutinized. */
export function closeRedTeam(room, x) {
  const found = room.challenges.some((c) => c.target === x && c.round === room.round);
  if (!found) room.redTeamed[x] = room.round;
  return found;
}

/** One line for people: why the room ended. */
export function outcomeText(room, decision) {
  const r = room.round;
  const rounds = `${r} round${r === 1 ? "" : "s"}`;
  switch (decision.end) {
    case "consensus":
      return `Everyone agreed on ${decision.winner}'s work after ${rounds}${room.redTeamed[decision.winner] !== undefined ? " (a red-team turn found nothing)" : ""}.`;
    case "impasse":
      return `No agreement after ${rounds}: every agent declared an impasse.`;
    case "stalled":
      return `No new arguments for ${LIMITS.stallRounds} rounds; the room stopped after ${rounds} without agreeing on one piece of work.`;
    case "loop":
      return `After ${rounds} the room was back where it had been before, so it stopped.`;
    case "quiet":
      return `After ${rounds} nobody had anything left to respond to, but they did not back the same work.`;
    case "rounds":
      return `Reached the limit of ${rounds} without full agreement.`;
    case "budget":
      return `Reached the budget after ${rounds}.`;
    case "time":
      return `Reached the time limit after ${rounds}.`;
    case "alone":
      return `Only one agent was left after ${rounds}.`;
    default:
      return `Ended after ${rounds}.`;
  }
}
