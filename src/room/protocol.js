/**
 * The room protocol: how argue reads an agent's post, and how it writes the room back to them.
 *
 * A post is free text plus a few header lines (anywhere outside code blocks, any case, markdown allowed):
 *   STANCE: B             back candidate B (your own letter = your own work) · "open" · "impasse"
 *   CHALLENGE B: <claim>  something in B's work is wrong or missing (one line; evidence goes in the text)
 *   ANSWER #3: <reply>    reply to challenge #3 against your work
 *   WITHDRAW #3           you no longer hold challenge #3
 *   ASK C: <request>      ask agent C to do something (use its tools, run something, check a claim)
 *   TOOLS: <capabilities> tools or data sources you have that others may lack
 *   GIST: <one line>      the post in one line, used in the compact record
 *
 * The exact wording agents see lives in instructions/post-format.md; this file only parses it.
 */

const HEADER = /^(STANCE|CHALLENGE|ANSWER|WITHDRAW|ASK|TOOLS|GIST)\b([^:\n]{0,24}?)(?::\s*(.*))?$/i;

/** Strip markdown decoration from a line so "**STANCE:** B" and "- STANCE: B" read like "STANCE: B". */
function plain(line) {
  return line
    .trim()
    .replace(/^(?:[-*+>]\s+|\d+[.)]\s+)/, "")
    .replace(/[*_`]/g, "")
    .trim();
}

/**
 * Read one post. `self` is the author's letter, `letters` every agent in the room.
 * Returns { stance, challenges, answers, withdraws, asks, tools, gist, body }.
 */
export function parsePost(text = "", { self, letters = [] } = {}) {
  const post = { stance: null, challenges: [], answers: [], withdraws: [], asks: [], tools: "", gist: "", body: "" };
  const keep = [];
  let fenced = false;
  for (const raw of String(text).replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
    const m = fenced ? null : plain(raw).match(HEADER);
    if (!m || !header(post, m, { self, letters })) keep.push(raw);
  }
  post.body = keep
    .join("\n")
    .replace(/^\s*---\s*$/m, "")
    .trim();
  if (!post.gist) post.gist = firstSentence(post.body);
  return post;
}

/** Apply one header line to `post`. Returns false when the line is ordinary prose after all. */
function header(post, [, kw, arg, rest], { self, letters }) {
  const key = kw.toUpperCase();
  const a = arg.trim();
  let text = (rest ?? "").trim();
  const who = letterIn(a, letters);
  let ref = Number(a.match(/^#?(\d+)$/)?.[1]);
  if (!ref && !a && /^#\d+/.test(text)) {
    // "ANSWER: #3 reply" / "WITHDRAW: #3"
    ref = Number(text.match(/^#(\d+)/)[1]);
    text = text.replace(/^#\d+\s*[:—-]?\s*/, "");
  }
  if (rest === undefined) {
    // Only WITHDRAW may go without a colon ("WITHDRAW #3").
    if (key === "WITHDRAW" && ref) return (post.withdraws.push(ref), true);
    return false;
  }
  switch (key) {
    case "STANCE": {
      const stance = !a && readStance(text, letters);
      return stance ? ((post.stance = stance), true) : false;
    }
    case "CHALLENGE":
      return who && who !== self && text ? (post.challenges.push({ target: who, text: oneLine(text) }), true) : false;
    case "ASK":
      return who && who !== self && text ? (post.asks.push({ to: who, text: oneLine(text) }), true) : false;
    case "ANSWER":
      return ref && text ? (post.answers.push({ ref, text: oneLine(text) }), true) : false;
    case "WITHDRAW":
      return ref ? (post.withdraws.push(ref), true) : false;
    case "TOOLS":
      return !a && text ? ((post.tools = oneLine(text, 300)), true) : false;
    case "GIST":
      return !a && text ? ((post.gist = oneLine(text, 240)), true) : false;
  }
  return false;
}

/** "B", "back B", "I back B (because …)", "open", "impasse" → "B" | "open" | "impasse" | null. */
export function readStance(s = "", letters = []) {
  const t = plain(s).toLowerCase();
  if (/^\W*(open|undecided|unsure)\b/.test(t)) return "open";
  if (/^\W*(impasse|stuck|deadlock)\b/.test(t)) return "impasse";
  return letterIn(s, letters);
}

/** The first standalone capital letter in `s` that names an agent in the room. */
function letterIn(s = "", letters = []) {
  for (const m of String(s).matchAll(/\b([A-H])\b/g)) if (letters.includes(m[1])) return m[1];
  return null;
}

export function oneLine(s = "", max = 400) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function firstSentence(body = "") {
  const t = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = t.match(/^(.{20,240}?[.!?])(\s|$)/);
  return oneLine(m ? m[1] : t, 240);
}

// ---------------------------------------------------------------- similarity

/** Word 3-gram shingles (word sets for very short texts). */
function shingles(s = "") {
  const w = String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (w.length < 5) return new Set(w);
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/** Jaccard similarity of two texts, 0..1. Cheap, deterministic, no dependencies. */
export function similarity(a, b) {
  const x = shingles(a);
  const y = shingles(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const s of x) if (y.has(s)) shared++;
  return shared / (x.size + y.size - shared);
}

// ---------------------------------------------------------------- the record

const stanceText = (stance, self) =>
  stance === "open" ? "undecided" : stance === "impasse" ? "impasse" : stance === self ? "backs own work" : stance ? `backs ${stance}` : "no stance";

function challengeLine(c, room) {
  const now = room?.work[c.target]?.version ?? 0;
  const stale = c.version && now > c.version ? ` (raised on v${c.version}; ${c.target} is now v${now})` : "";
  const reply = c.answers.length ? ` — ${c.target}: "${oneLine(c.answers.at(-1).text, 160)}"` : "";
  return `#${c.id} ${c.by}→${c.target} [${c.status}] ${c.text}${stale}${reply}`;
}

function workLine(room, id) {
  const w = room.work[id];
  if (!w?.version) return "no work yet";
  const check = room.check ? (w.check == null ? ", check not run" : w.check ? ", check PASS" : ", check FAIL") : "";
  const tests = w.testEdits?.length ? `, changes existing tests: ${w.testEdits.join(", ")}` : "";
  return `v${w.version}${check}${tests}`;
}

/** Header lines of a post, normalised, for the record. */
function headerLines(room, p, { short = false } = {}) {
  const out = [];
  for (const id of p.challengeIds ?? []) {
    const c = room.challenges.find((x) => x.id === id);
    out.push(short ? `CHALLENGE #${id} ${c.target}` : `CHALLENGE #${id} ${c.target}: ${c.text}`);
  }
  for (const a of p.answers) out.push(short ? `ANSWER #${a.ref}` : `ANSWER #${a.ref}: ${a.text}`);
  for (const w of p.withdraws) out.push(`WITHDRAW #${w}`);
  for (const a of p.asks) out.push(`ASK ${a.to}: ${oneLine(a.text, 160)}`);
  return out;
}

/** Who is in the room, what they stand for and what their work looks like. */
function roster(room) {
  return room.agents
    .map((a) => {
      const bits = [stanceText(room.stance[a.id], a.id), `work ${workLine(room, a.id)}`];
      if (a.tools) bits.push(`tools: ${a.tools}`);
      if (!a.alive) bits.push("left the room");
      return `- ${a.id}: ${bits.join(" · ")}`;
    })
    .join("\n");
}

/**
 * The room as an agent sees it on its turn: who stands where, every challenge, older rounds as
 * one-line gists, the latest round in full. Deterministic (no model call); see docs/ARCHITECTURE.md.
 */
export function digest(room, { full = 1 } = {}) {
  const last = room.round;
  const parts = [`## Who is here\n${roster(room)}`];
  if (room.challenges.length) parts.push(`## Challenges\n${room.challenges.map((c) => challengeLine(c, room)).join("\n")}`);
  const old = room.posts.filter((p) => p.round <= last - full);
  if (old.length)
    parts.push(
      `## Earlier rounds (one line per post; full text in .argue/room/room.md)\n${old
        .map((p) => {
          const head = headerLines(room, p, { short: true });
          return `r${p.round} ${p.by} (${stanceText(p.stance, p.by)})${p.error ? " — failed" : `: ${p.gist}`}${head.length ? ` [${head.join("; ")}]` : ""}`;
        })
        .join("\n")}`,
    );
  const recent = room.posts.filter((p) => p.round > last - full);
  if (recent.length) parts.push(`## Latest round (round ${last}), in full\n\n${recent.map((p) => fullPost(room, p)).join("\n\n")}`);
  const notes = room.notes.filter((n) => n.round === last && !n.to);
  if (notes.length) parts.push(`## Notes from argue\n${notes.map((n) => `- ${n.text}`).join("\n")}`);
  return parts.join("\n\n");
}

/** What is addressed to one agent this turn: challenges against its work, requests, notes, its check. */
export function inbox(room, id) {
  const out = [];
  const w = room.work[id];
  out.push(`Your stance: ${stanceText(room.stance[id], id)}. Your work: ${workLine(room, id)}.`);
  if (room.check && w?.check === false) out.push(`Your check fails; the output is in .argue/room/checks/${id}.txt.`);
  for (const c of room.challenges.filter((x) => x.target === id && x.status === "open")) out.push(`Open challenge #${c.id} from ${c.by}: ${c.text}`);
  for (const p of room.posts.filter((x) => x.round === room.round && x.by !== id))
    for (const a of p.asks.filter((x) => x.to === id)) out.push(`${p.by} asks you: ${a.text}`);
  for (const n of room.notes.filter((x) => x.to === id && x.round >= room.round)) out.push(`Note from argue: ${n.text}`);
  return out.join("\n");
}

/** The candidates for the verdict step, strongest first (from referee.standings). */
export function standingsText(room, list) {
  return list
    .map((s) => {
      const backers = room.agents.filter((a) => a.alive && room.stance[a.id] === s.id).map((a) => a.id);
      const open = room.challenges.filter((c) => c.target === s.id && c.status === "open");
      const file = room.mode === "code" ? `${s.id}.patch` : `${s.id}.md`;
      return [
        `- ${s.id}: .argue/room/work/${file} · ${workLine(room, s.id)}`,
        `  backed by: ${backers.join(", ") || "nobody"} · open challenges: ${open.length ? open.map((c) => `#${c.id} (${c.by}) ${c.text}`).join("; ") : "none"}`,
      ].join("\n");
    })
    .join("\n");
}

function fullPost(room, p) {
  const head = `### ${p.by} · round ${p.round} · ${stanceText(p.stance, p.by)}`;
  if (p.error) return `${head}\n(this turn failed: ${p.error})`;
  const lines = headerLines(room, p);
  return `${head}\n${lines.length ? `${lines.join("\n")}\n\n` : ""}${p.body || p.gist || "(no text)"}`;
}

/** The complete, human-readable record of a run (also what follow-up questions are answered from). */
export function renderRecord(room, { outcome, answer } = {}) {
  const out = [`# argue record`, "", `**Task**`, "", room.task, ""];
  out.push(`**Mode:** ${room.mode === "code" ? "code change" : "answer"}${room.check ? ` · **check:** \`${room.check}\`` : ""}`, "");
  out.push(`## Lineup`, "", ...room.agents.map((a) => `- **${a.id}** · ${a.label}${a.lens ? ` · lens: ${a.lens}` : ""}`), "");
  for (let r = 0; r <= room.round; r++) {
    const posts = room.posts.filter((p) => p.round === r);
    if (!posts.length) continue;
    const kind = posts[0].kind === "red-team" ? " (red team)" : "";
    out.push(`## ${r === 0 ? "Opening" : `Round ${r}`}${kind}`, "");
    for (const p of posts) out.push(fullPost(room, p), "");
    for (const n of room.notes.filter((x) => x.round === r)) out.push(`> argue${n.to ? ` → ${n.to}` : ""}: ${n.text}`, "");
  }
  if (room.challenges.length) out.push(`## Challenges`, "", ...room.challenges.map((c) => `- ${challengeLine(c, room)}`), "");
  out.push(`## Where everyone ended`, "", roster(room), "");
  if (outcome) out.push(`## Outcome`, "", outcome, "");
  if (answer) out.push(`## Final answer`, "", answer, "");
  return `${out.join("\n").trim()}\n`;
}
