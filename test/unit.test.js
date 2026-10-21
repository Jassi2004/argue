import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DRIVERS,
  claudeServers,
  codexServers,
  customDriver,
  defaultJudge,
  defaultLineup,
  harnessForModel,
  parseAgents,
  registry,
} from "../src/agents/drivers.js";
import { checkLimits, describe, harnessDefaults, label, limitsText, lineupCard, lineupNote, runLimits } from "../src/agents/lineup.js";
import { guessMode } from "../src/cli.js";
import { stripTomlTable } from "../src/integrations/install.js";
import { localizePaths, modifiedTests } from "../src/room/desks.js";
import { parseVerdict, scrubProcess, stripVerdict } from "../src/room/index.js";
import { digest, inbox, parsePost, readStance, renderRecord, similarity } from "../src/room/protocol.js";
import * as R from "../src/room/referee.js";
import { loadRun } from "../src/runs/store.js";
import { jsonLines, lastJsonObject } from "../src/util/exec.js";
import { lineupBox } from "../src/util/ui.js";
import { diffFiles, diffStats } from "../src/workspace/git.js";

// ---------------------------------------------------------------- the post protocol

const L = ["A", "B", "C"];

test("parsePost reads every header line, tolerating markdown, and keeps the rest as the message", () => {
  const p = parsePost(
    [
      "**STANCE:** B",
      "- CHALLENGE C: no index on users.email (schema.sql:12)",
      "ANSWER #3: fixed in v2, see cascade.test.js",
      "WITHDRAW #4",
      "ASK B: run EXPLAIN on the feed query with your Postgres MCP",
      "TOOLS: web search, Postgres MCP",
      "GIST: Postgres is right but needs an index",
      "",
      "Evidence: the query plan shows a seq scan.",
    ].join("\n"),
    { self: "A", letters: L },
  );
  assert.equal(p.stance, "B");
  assert.deepEqual(p.challenges, [{ target: "C", text: "no index on users.email (schema.sql:12)" }]);
  assert.deepEqual(p.answers, [{ ref: 3, text: "fixed in v2, see cascade.test.js" }]);
  assert.deepEqual(p.withdraws, [4]);
  assert.deepEqual(p.asks, [{ to: "B", text: "run EXPLAIN on the feed query with your Postgres MCP" }]);
  assert.equal(p.tools, "web search, Postgres MCP");
  assert.equal(p.gist, "Postgres is right but needs an index");
  assert.equal(p.body, "Evidence: the query plan shows a seq scan.");
});

test("parsePost leaves prose and code blocks alone", () => {
  const p = parsePost("Stance on caching is unclear.\nAnswer 3 is wrong.\nAsk B to verify\n```\nSTANCE: C\nCHALLENGE B: x\n```\nSTANCE: A", {
    self: "A",
    letters: L,
  });
  assert.equal(p.stance, "A", "only the real header line counts");
  assert.deepEqual(p.challenges, []);
  assert.deepEqual(p.answers, []);
  assert.deepEqual(p.asks, []);
  assert.match(p.body, /Stance on caching[\s\S]*Answer 3 is wrong[\s\S]*STANCE: C/);
});

test("parsePost ignores challenges and asks aimed at yourself or at nobody in the room", () => {
  const p = parsePost("CHALLENGE A: me\nCHALLENGE Z: nobody\nASK A: me\nCHALLENGE B:\nWITHDRAW: #2\nANSWER: #5 done", { self: "A", letters: L });
  assert.deepEqual(p.challenges, []);
  assert.deepEqual(p.asks, []);
  assert.deepEqual(p.withdraws, [2]);
  assert.deepEqual(p.answers, [{ ref: 5, text: "done" }]);
});

test("readStance understands letters, open and impasse in plain words", () => {
  assert.equal(readStance("B", L), "B");
  assert.equal(readStance("back B (because its test covers the edge case)", L), "B");
  assert.equal(readStance("open", L), "open");
  assert.equal(readStance("Undecided for now", L), "open");
  assert.equal(readStance("impasse: we disagree on the requirements", L), "impasse");
  assert.equal(readStance("Z", L), null);
});

test("the gist falls back to the first sentence of the message", () => {
  assert.equal(
    parsePost("STANCE: A\nMy answer uses Postgres with read replicas. Then more detail.", { self: "A", letters: L }).gist,
    "My answer uses Postgres with read replicas.",
  );
});

test("similarity: identical texts 1, unrelated 0, rewording in between", () => {
  assert.equal(similarity("the cache misses cascading deletes on users", "the cache misses cascading deletes on users"), 1);
  assert.equal(similarity("postgres read replicas scale reads", "kafka partitions order events per key"), 0);
  const s = similarity("the cache misses cascading deletes on the users table", "the cache still misses cascading deletes on the users table");
  assert.ok(s > 0.4 && s < 1, String(s));
});

// ---------------------------------------------------------------- the referee

/** A room with agents A and B (different model families) whose opening produced work. */
function room2({ check = null, agents = ["A", "B"] } = {}) {
  const room = R.newRoom({ task: "t", mode: check ? "code" : "answer", check, agents: agents.map((id, i) => ({ id, kind: `k${i}` })) });
  for (const id of agents) {
    R.recordWork(room, id, { hash: `${id}1`, check: check ? true : null });
    R.recordPost(room, id, post(`STANCE: ${id}\nmy work`, id, agents), {});
  }
  R.closeRound(room);
  return room;
}
const post = (text, self, letters = ["A", "B"]) => parsePost(text, { self, letters });
const turn = (room, posts) => {
  R.openRound(room);
  for (const [id, text] of Object.entries(posts))
    R.recordPost(
      room,
      id,
      post(
        text,
        id,
        room.agents.map((a) => a.id),
      ),
      {},
    );
  R.closeRound(room);
};

test("everyone plays the first round", () => {
  assert.deepEqual(R.decide(room2(), { maxRounds: 4 }), { next: "round", players: ["A", "B"] });
});

test("instant agreement is not consensus: someone else must try to break the work first", () => {
  const room = room2();
  turn(room, { A: "STANCE: B\nlooks good", B: "STANCE: B\nmine" });
  const d = R.decide(room, { maxRounds: 4 });
  assert.deepEqual(d, { next: "red-team", target: "B", by: "A" });
  // The red team finds nothing: now it counts.
  R.openRound(room);
  R.recordPost(room, "A", post("STANCE: B\ntried edge cases X and Y", "A"), { kind: "red-team" });
  assert.equal(R.closeRedTeam(room, "B"), false);
  R.closeRound(room);
  assert.deepEqual(R.decide(room, { maxRounds: 4 }), { end: "consensus", winner: "B" });
});

test("agreement after a real challenge is consensus without a red team", () => {
  const room = room2();
  turn(room, { A: "CHALLENGE B: misses the empty-list case\nSTANCE: A", B: "STANCE: B\nmine" });
  turn(room, { B: "ANSWER #1: handled now, see test\nSTANCE: B", A: "STANCE: B\nverified the fix" });
  assert.equal(room.challenges[0].status, "conceded", "backing B concedes A's own challenge against B");
  assert.deepEqual(R.decide(room, { maxRounds: 4 }), { end: "consensus", winner: "B" });
});

test("backing work in the same round it changed doesn't count until the backer has seen the new version", () => {
  const room = room2();
  turn(room, { A: "CHALLENGE B: misses empty input\nSTANCE: A", B: "STANCE: B" });
  R.openRound(room);
  R.recordWork(room, "B", { hash: "B2" });
  R.recordPost(room, "B", post("ANSWER #1: handled in v2\nSTANCE: B", "B"), {});
  R.recordPost(room, "A", post("STANCE: B\nB v1 is fine after all", "A"), {});
  R.closeRound(room);
  const d = R.decide(room, { maxRounds: 4 });
  assert.equal(d.next, "round", "A backed v1; B is now v2");
  assert.ok(d.players.includes("A"));
  turn(room, { A: "STANCE: B\nchecked v2" });
  assert.deepEqual(R.decide(room, { maxRounds: 4 }), { end: "consensus", winner: "B" });
});

test("a red team that finds a problem but still backs the work blocks agreement until it is answered and seen", () => {
  const room = room2();
  turn(room, { A: "STANCE: B\nlooks good", B: "STANCE: B" });
  assert.equal(R.decide(room, { maxRounds: 6 }).next, "red-team");
  R.openRound(room);
  R.recordPost(room, "A", post("CHALLENGE B: no versioning strategy for independent deploys\nSTANCE: B", "A"), { kind: "red-team" });
  R.closeRedTeam(room, "B");
  R.closeRound(room);
  assert.deepEqual(R.decide(room, { maxRounds: 6 }), { next: "round", players: ["B"] }, "B must answer #1 first");
  turn(room, { B: "ANSWER #1: added a versioning section\nSTANCE: B" });
  assert.deepEqual(R.decide(room, { maxRounds: 6 }), { next: "round", players: ["A"] }, "A must see the answer");
  turn(room, { A: "STANCE: B\nthe versioning section covers it" });
  assert.equal(room.challenges[0].status, "conceded");
  assert.deepEqual(R.decide(room, { maxRounds: 6 }), { end: "consensus", winner: "B" });
});

test("a room that returns to an earlier state ends as a loop", () => {
  const room = room2();
  turn(room, { A: "STANCE: B\nmaybe B", B: "STANCE: A\nmaybe A" });
  turn(room, { A: "STANCE: A\nback to mine", B: "STANCE: B\nback to mine" });
  assert.equal(R.looped(room), true);
  assert.deepEqual(R.decide(room, { maxRounds: 4 }), { end: "loop" });
});

test("consensus needs the agreed work's check to pass", () => {
  const room = room2({ check: "npm test" });
  turn(room, { A: "CHALLENGE B: too slow on big inputs\nSTANCE: A", B: "STANCE: B" });
  R.openRound(room);
  R.recordWork(room, "B", { hash: "B2", check: false });
  R.recordPost(room, "B", post("ANSWER #1: faster now\nSTANCE: B", "B"), {});
  R.closeRound(room);
  turn(room, { A: "STANCE: B\nfaster indeed" });
  const d = R.decide(room, { maxRounds: 6 });
  assert.equal(d.next, "round");
  assert.ok(room.notes.some((n) => /check fails/.test(n.text)));
  assert.ok(d.players.includes("B"), "the author of failing agreed work must play");
});

test("settled agents with nothing to respond to sit out; a room where nobody has anything left ends", () => {
  const room = room2();
  turn(room, { A: "STANCE: A\nno change", B: "STANCE: B\nno change" });
  assert.equal(room.stalled, 1);
  assert.deepEqual(R.decide(room, { maxRounds: 4 }), { end: "quiet" }, "nobody has anything new to respond to");
});

test("two rounds without progress end the room even if someone would still play", () => {
  const room = room2();
  turn(room, { A: "STANCE: open\nthinking", B: "STANCE: B\nno change" }); // A switching to "open" is progress
  turn(room, { A: "STANCE: open\nthinking" });
  turn(room, { A: "STANCE: open\nthinking" });
  assert.equal(room.stalled, 2);
  assert.deepEqual(R.decide(room, { maxRounds: 4 }), { end: "stalled" });
});

test("anyone's revised work wakes the agents that back other work", () => {
  const room = room2();
  R.openRound(room);
  R.recordWork(room, "A", { hash: "A2" });
  R.recordPost(room, "A", post("STANCE: A\nborrowed B's link", "A"), {});
  R.recordPost(room, "B", post("STANCE: B\nsame facts", "B"), {});
  R.closeRound(room);
  assert.deepEqual(R.whoPlays(room), ["B"]);
});

test("a challenge brings its target back; the challenger sits out until answered", () => {
  const room = room2();
  turn(room, { A: "CHALLENGE B: wrong unit (ms vs s)\nSTANCE: A", B: "STANCE: B\nfine" });
  assert.deepEqual(R.whoPlays(room), ["B"]);
  turn(room, { B: "ANSWER #1: it is seconds, see config.ts:4\nSTANCE: B" });
  assert.deepEqual(R.whoPlays(room), ["A"]);
});

test("repeating an answered challenge is flagged and is not progress; revised work is", () => {
  const room = room2();
  turn(room, { A: "CHALLENGE B: the retry loop never stops on a 4xx error\nSTANCE: A", B: "STANCE: B" });
  turn(room, { B: "ANSWER #1: 4xx is not retried, see retry.ts:9\nSTANCE: B" });
  turn(room, { A: "CHALLENGE B: the retry loop never stops on a 4xx error at all\nSTANCE: A" });
  assert.equal(room.challenges[1].repeatOf, 1);
  assert.equal(room.stalled, 1, "a repeat is not progress");
  assert.ok(room.notes.some((n) => n.to === "A" && /repeats #1/.test(n.text)));
  R.openRound(room);
  R.recordWork(room, "B", { hash: "B2" });
  R.recordPost(room, "B", post("ANSWER #2: added a test for 4xx\nSTANCE: B", "B"), {});
  R.closeRound(room);
  assert.equal(room.stalled, 0, "revised work is progress");
});

test("a challenge that is still open is not counted twice", () => {
  const room = room2();
  turn(room, { A: "CHALLENGE B: missing auth check on /admin\nSTANCE: A", B: "STANCE: B" });
  turn(room, { A: "CHALLENGE B: missing auth check on /admin route\nSTANCE: A", B: "STANCE: B" });
  assert.equal(room.challenges.length, 1);
});

test("impasse, limits, budget and time end the room", () => {
  const room = room2();
  turn(room, { A: "STANCE: impasse\nrequirements conflict", B: "STANCE: impasse\nagreed, they conflict" });
  assert.deepEqual(R.decide(room, { maxRounds: 4 }), { end: "impasse" });
  const r2 = room2();
  turn(r2, { A: "CHALLENGE B: x\nSTANCE: A", B: "STANCE: B" });
  assert.deepEqual(R.decide(r2, { maxRounds: 1 }), { end: "rounds" });
  assert.deepEqual(R.decide(r2, { maxRounds: 4, overBudget: true }), { end: "budget" });
  assert.deepEqual(R.decide(r2, { maxRounds: 4, overTime: true }), { end: "time" });
});

test("an agent that fails twice leaves the room; one agent left ends it", () => {
  const room = room2();
  R.openRound(room);
  R.recordPost(room, "B", null, { error: "timed out" });
  R.closeRound(room);
  assert.equal(room.agents[1].alive, true);
  assert.ok(R.whoPlays(room).includes("B"), "a failed agent retries");
  R.openRound(room);
  R.recordPost(room, "B", null, { error: "timed out" });
  R.closeRound(room);
  assert.equal(room.agents[1].alive, false);
  assert.deepEqual(R.decide(room, { maxRounds: 4 }), { end: "alone" });
});

test("backing an agent without work counts as undecided", () => {
  const room = R.newRoom({ task: "t", mode: "answer", agents: [{ id: "A" }, { id: "B" }] });
  R.recordWork(room, "A", { hash: "a" });
  R.recordPost(room, "A", post("STANCE: A", "A"), {});
  R.recordPost(room, "B", post("STANCE: B", "B"), {});
  assert.equal(room.stance.B, "open");
});

test("standings: passing check first, then backers, then fewest open challenges", () => {
  const room = room2({ check: "t", agents: ["A", "B", "C"] });
  R.recordWork(room, "A", { hash: "A2", check: false });
  turn(room, { A: "STANCE: C", B: "CHALLENGE C: x\nSTANCE: B", C: "STANCE: C" });
  assert.deepEqual(
    R.standings(room).map((s) => s.id),
    ["C", "B", "A"],
  );
});

test("the digest shows the roster, challenges, gists of older rounds and the latest round in full", () => {
  const room = room2();
  turn(room, { A: "CHALLENGE B: misses empty input\nGIST: B misses empty input\nfull reasoning here", B: "STANCE: B\nkeeping mine" });
  turn(room, { B: "ANSWER #1: handled\nSTANCE: B\nlatest full text" });
  const text = digest(room);
  assert.match(text, /## Who is here\n- A: backs own work/);
  assert.match(text, /#1 A→B \[answered\] misses empty input — B: "handled"/);
  assert.match(text, /r1 A \(backs own work\): B misses empty input \[CHALLENGE #1 B\]/);
  assert.doesNotMatch(text, /full reasoning here/, "older posts appear only as their gist");
  assert.match(text, /latest full text/);
  assert.match(inbox(room, "A"), /Your stance: backs own work/);
  assert.match(renderRecord(room, { outcome: "o", answer: "final" }), /## Round 1[\s\S]*full reasoning here[\s\S]*## Final answer\n\nfinal/);
});

test("a challenge remembers the version it was raised against", () => {
  const room = room2();
  turn(room, { A: "CHALLENGE B: misses empty input\nSTANCE: A", B: "STANCE: B" });
  R.openRound(room);
  R.recordWork(room, "B", { hash: "B2" });
  R.recordPost(room, "B", post("STANCE: B\nrevised", "B"), {});
  R.closeRound(room);
  assert.match(digest(room), /#1 A→B \[open\] misses empty input \(raised on v1; B is now v2\)/);
});

// ---------------------------------------------------------------- the verdict

test("parseVerdict reads the pick and the open disagreement", () => {
  assert.deepEqual(parseVerdict('{"pick":"A","unresolved":"cost vs latency"}\nanswer', ["A", "B"]), { pick: "A", unresolved: "cost vs latency" });
  assert.deepEqual(parseVerdict('{"pick":"Agent B","unresolved":"none"}', ["A", "B"]), { pick: "B", unresolved: null });
  assert.deepEqual(parseVerdict('{"pick":"Z"}', ["A", "B"]), { pick: null, unresolved: null });
  assert.deepEqual(parseVerdict("no json", ["A"]), { pick: null, unresolved: null });
  assert.equal(stripVerdict('{"pick":"A","unresolved":"none"}\nThe answer.'), "The answer.");
  assert.equal(stripVerdict('```json\n{"pick":"A","unresolved":"none"}\n```\n\n## The answer'), "## The answer", "a fenced verdict line goes, fence and all");
  assert.equal(stripVerdict("```js\nconst x = {};\n```"), "```js\nconst x = {};\n```", "ordinary code is kept");
});

test("lastJsonObject never hangs on text that starts with a brace (regression)", () => {
  const t0 = Date.now();
  assert.equal(lastJsonObject('{"pick": "A"\nthen prose with } and { braces }'), null);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(lastJsonObject('banner\n{"a":1}\nmore {"b":{"c":2}} end'), { b: { c: 2 } });
  assert.equal(lastJsonObject("nothing"), null);
  assert.deepEqual(jsonLines('x\n{"a":1}\n{bad\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
});

test("scrubProcess removes agent letters from the user's answer", () => {
  assert.equal(scrubProcess("Candidate B had the same fix but added tests."), "another approach had the same fix but added tests.");
  assert.equal(scrubProcess("Agent A's version was slower."), "another version was slower.");
  assert.equal(scrubProcess("Use plan A for now."), "Use plan A for now.", "ordinary text is left alone");
});

// ---------------------------------------------------------------- runs

test("a run whose process stopped responding is reported as stuck, not running", () => {
  const dir = mkdtempSync(join(tmpdir(), "argue-runs-"));
  mkdirSync(join(dir, "r1"));
  writeFileSync(join(dir, "r1", "meta.json"), JSON.stringify({ status: "running", pid: process.pid, startedAt: new Date().toISOString() }));
  writeFileSync(join(dir, "r1", "beat"), String(Date.now()));
  assert.equal(loadRun(dir, "r1").status, "running");
  writeFileSync(join(dir, "r1", "beat"), String(Date.now() - 10 * 60_000));
  assert.equal(loadRun(dir, "r1").status, "stuck");
  writeFileSync(join(dir, "r1", "meta.json"), JSON.stringify({ status: "running", pid: 999999 }));
  assert.equal(loadRun(dir, "r1").status, "interrupted");
});

// ---------------------------------------------------------------- agents and lineups

test("parseAgents: kind, model, effort, slashes and colons in models", () => {
  const a = parseAgents("claude:opus@high, codex, pi:openrouter/deepseek/deepseek-r1, opencode:anthropic/claude-sonnet-4");
  assert.deepEqual(
    a.map((x) => [x.kind, x.model, x.effort]),
    [
      ["claude", "opus", "high"],
      ["codex", undefined, undefined],
      ["pi", "openrouter/deepseek/deepseek-r1", undefined],
      ["opencode", "anthropic/claude-sonnet-4", undefined],
    ],
  );
  assert.throws(() => parseAgents("nope"), /unknown harness or model "nope"/);
  assert.deepEqual(
    parseAgents("opus@high,gpt-6.1-sol").map((x) => [x.kind, x.model, x.effort]),
    [
      ["claude", "opus", "high"],
      ["codex", "gpt-6.1-sol", undefined],
    ],
  );
});

test("defaultLineup prefers vendor diversity, falls back to model diversity", () => {
  assert.equal(defaultLineup(["claude", "codex", "gemini", "pi"]), "claude,codex,gemini");
  assert.equal(defaultLineup(["claude", "codex", "pi", "opencode"]), "claude,codex");
  assert.equal(defaultLineup(["claude", "pi"]), "claude,pi");
  assert.equal(defaultLineup(["claude"]), "claude:opus,claude:sonnet");
  assert.equal(defaultLineup(["pi"]), "pi,pi");
  assert.equal(defaultLineup([]), "");
});

test("defaultJudge picks an installed non-participant when possible", () => {
  assert.equal(defaultJudge(["claude", "codex", "gemini"], parseAgents("claude,codex")), "gemini");
  assert.equal(defaultJudge(["claude", "codex", "pi"], parseAgents("claude,codex")), "claude");
  assert.equal(defaultJudge(["claude", "codex", "pi"], parseAgents("pi,codex")), "claude");
  assert.equal(defaultJudge(["pi"], parseAgents("pi:x/y,pi:z")), "pi:x/y");
});

test("harnessForModel maps bare model names to their CLI", () => {
  assert.equal(harnessForModel("opus"), "claude");
  assert.equal(harnessForModel("claude-sonnet-4-5"), "claude");
  assert.equal(harnessForModel("gpt-6.1-sol"), "codex");
  assert.equal(harnessForModel("o3"), "codex");
  assert.equal(harnessForModel("gemini-2.5-pro"), "gemini");
  assert.equal(harnessForModel("openrouter/deepseek/r1"), "pi");
  assert.equal(harnessForModel("banana"), null);
});

test("registry merges custom agents; every built-in driver has bin, title and install hint", async () => {
  const r = registry({ custom: { aider: { command: "aider --message-file {prompt_file}" } } });
  assert.ok(r.aider.custom && r.claude);
  assert.equal(parseAgents("aider,claude", r)[0].kind, "aider");
  for (const [k, d] of Object.entries(DRIVERS)) assert.ok(d.bin && d.title && d.install && typeof d.ask === "function", k);
  const dir = mkdtempSync(join(tmpdir(), "argue-t-"));
  writeFileSync(join(dir, "p.md"), "hello");
  const res = await customDriver("echo", { command: "cat {prompt_file}" }).ask({ promptFile: join(dir, "p.md"), cwd: dir, write: false, timeoutMs: 5000 });
  assert.deepEqual([res.ok, res.text], [true, "hello"]);
});

test("only the MCP servers the user shares reach Claude agents (never argue itself)", () => {
  const home = mkdtempSync(join(tmpdir(), "argue-home-"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { github: { command: "gh-mcp" }, slack: { command: "s" }, argue: { command: "a" } } }),
  );
  assert.deepEqual(claudeServers([], home), {});
  assert.deepEqual(claudeServers(["github", "argue", "missing"], home), { github: { command: "gh-mcp" } });
});

test("Codex agents only toggle MCP servers defined in config.toml (plugin servers would break Codex)", () => {
  const home = mkdtempSync(join(tmpdir(), "argue-codex-"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "config.toml"),
    'model = "x"\n[mcp_servers.github]\ncommand = "g"\n[mcp_servers.github.env]\nA = "1"\n[mcp_servers."my.srv"] # quoted\nurl = "u"\n[profiles.p]\n',
  );
  assert.deepEqual(codexServers(home, {}), ["github", "my.srv"]);
  assert.deepEqual(codexServers(mkdtempSync(join(tmpdir(), "argue-codex-")), {}), [], "no config, nothing to toggle");
});

test("harnessDefaults reads each CLI's own config", () => {
  const home = mkdtempSync(join(tmpdir(), "argue-models-"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-6"\nmodel_reasoning_effort = "high"\n\n[profiles.x]\nmodel = "other"\n');
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), '{"model":"opus","effortLevel":"low"}');
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), '{"defaultProvider":"openrouter","defaultModel":"deepseek/r1","defaultThinkingLevel":"high"}');
  const env = {};
  assert.deepEqual([harnessDefaults("codex", { home, env }).model, harnessDefaults("codex", { home, env }).effort], ["gpt-6", "high"]);
  const c = harnessDefaults("claude", { home, env });
  if (c.modelSource !== "managed settings") assert.deepEqual([c.model, c.effort], ["opus", "low"]);
  assert.equal(harnessDefaults("claude", { home, env: { ANTHROPIC_MODEL: "haiku" } }).model, "haiku");
  assert.deepEqual([harnessDefaults("pi", { home, env }).model, harnessDefaults("pi", { home, env }).effort], ["openrouter/deepseek/r1", "high"]);
  const empty = mkdtempSync(join(tmpdir(), "argue-models-"));
  assert.equal(harnessDefaults("codex", { home: empty, env }).model, null);
  assert.equal(harnessDefaults("pi", { home: empty, env }).effort, "medium");
});

test("describe, label, the lineup note, card and box", () => {
  const env = { ANTHROPIC_MODEL: "" };
  const a = describe({ kind: "codex", name: "codex:gpt-6@low", model: "gpt-6", effort: "low" }, { env });
  assert.equal(label(a), "Codex · gpt-6 · effort low");
  const g = describe({ kind: "gemini", name: "gemini:gemini-2.5-pro", model: "gemini-2.5-pro" }, { env });
  assert.equal(
    lineupNote([a, g]),
    "Arguing with gpt-6 (effort low, Codex), gemini-2.5-pro (effort n/a, Gemini CLI). Want different models? Stop me and say so.",
  );
  const descs = [
    { harness: "Claude Code", model: "sonnet", effort: null, effortSupported: true },
    { harness: "Gemini CLI", model: null, effortSupported: false },
  ];
  assert.match(lineupCard(descs), /- \*\*sonnet\*\* · effort default · Claude Code/);
  const box = lineupBox(descs).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.match(box.join("\n"), /A {3}Claude Code {3}sonnet/);
  assert.equal(new Set(box.map((l) => l.length)).size, 1, "box lines line up");
});

test("limits: defaults, this run's overrides, validation, and the info note on the lineup card", () => {
  const config = { rounds: 4, minutes: 60, budget: 10 };
  assert.deepEqual(runLimits(config), { rounds: 4, minutes: 60, budget: 10 });
  assert.deepEqual(runLimits(config, checkLimits({ budget: "3", rounds: "2" })), { rounds: 2, minutes: 60, budget: 3 });
  assert.equal(runLimits(config, checkLimits({ budget: "none" })).budget, null);
  assert.equal(runLimits(config, checkLimits({ budget: 0 })).budget, null, "0 means no cap");
  assert.throws(() => checkLimits({ rounds: "lots" }), /--rounds must be a number/);
  assert.throws(() => checkLimits({ budget: -5 }), /--budget must be/);
  assert.equal(limitsText({ rounds: 4, minutes: 60, budget: null }), "up to 4 rounds · 60 min · no $ cap");
  const card = lineupCard([{ harness: "Codex", model: "gpt-6", effort: "high", effortSupported: true }], { rounds: 4, minutes: 60, budget: 10 });
  assert.match(card, /ℹ️ Several models will each work on this, so it costs more[\s\S]*up to 4 rounds · 60 min · \$10/);
  assert.match(card, /Want other models or limits\? Just say so/);
});

// ---------------------------------------------------------------- small helpers

test("guessMode: changes are code, questions and writing are answers", () => {
  assert.equal(guessMode("fix the flaky test in auth.spec.ts"), "code");
  assert.equal(guessMode("add rate limiting to the login endpoint"), "code");
  assert.equal(guessMode("which DB is best for a social media app"), "answer");
  assert.equal(guessMode("Should we use Kafka or SQS?"), "answer");
  assert.equal(guessMode("write a launch blog post"), "answer");
  assert.equal(guessMode("how do I fix the memory leak?"), "answer");
});

test("localizePaths points absolute project paths at the agent's own copy", () => {
  assert.equal(localizePaths("edit /work/app/src/a.js and /work/app", ["/work/app"]), "edit ./src/a.js and .");
  assert.equal(localizePaths("/work/apple stays", ["/work/app"]), "/work/apple stays");
});

test("diffStats, diffFiles and modifiedTests", () => {
  const d = "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@\n-a\n+b\n+c\ndiff --git a/y b/y\n";
  assert.deepEqual(diffStats(d), { files: 2, add: 2, del: 1 });
  assert.deepEqual(diffFiles(d), ["x.js", "y"]);
  const t =
    "diff --git a/test.mjs b/test.mjs\n--- a/test.mjs\n+++ b/test.mjs\n@@\n-assert(x)\n+assert(y)\n" +
    "diff --git a/added.test.js b/added.test.js\n--- a/added.test.js\n+++ b/added.test.js\n@@\n+assert(more)\n" +
    "diff --git a/src/a.spec.ts b/src/a.spec.ts\nnew file mode 100644\n" +
    "diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@\n-a\n" +
    "diff --git a/tests/util.py b/tests/util.py\ndeleted file mode 100644\n";
  assert.deepEqual(modifiedTests(t), ["test.mjs", "tests/util.py"], "changed or deleted tests count; tests only added to a file don't");
});

test("stripTomlTable removes a table and its sub-tables only", () => {
  const toml = 'model = "x"\n\n[mcp_servers.argue]\ncommand = "argue"\n\n[mcp_servers.argue.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "o"\n';
  const out = stripTomlTable(toml, "mcp_servers.argue");
  assert.doesNotMatch(out, /argue/);
  assert.match(out, /mcp_servers\.other/);
  assert.match(out, /model = "x"/);
});

test("windows: .cmd shims receive arguments with spaces, quotes and metacharacters intact", { skip: process.platform !== "win32" }, async () => {
  const { run } = await import("../src/util/exec.js");
  const dir = mkdtempSync(join(tmpdir(), "argue-win-"));
  writeFileSync(join(dir, "echo.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(join(dir, "fakecli.cmd"), `@node "${join(dir, "echo.js")}" %*\r\n`);
  const args = ["plain", "with space", 'quo"te', "a&b|c<d>e^f%PATH%!g!", "trailing\\", "(paren)"];
  const res = await run("fakecli", args, { env: { PATH: `${dir};${process.env.PATH}` } });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), args);
});

test("docs/assets/argue-flow.svg is up to date with scripts/flow-diagram.mjs (run npm run diagram)", async () => {
  const { readFileSync } = await import("node:fs");
  const { svg } = await import("../scripts/flow-diagram.mjs");
  assert.equal(readFileSync(new URL("../docs/assets/argue-flow.svg", import.meta.url), "utf8"), svg);
  assert.doesNotMatch(svg, /<script|<foreignObject|@import|url\(http/, "GitHub only animates plain SVG + CSS in images");
});
