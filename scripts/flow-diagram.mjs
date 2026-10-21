#!/usr/bin/env node
// Draws docs/assets/argue-flow.svg, the animated "how a run works" diagram at the top of the README.
//   npm run diagram
// Plain SVG + CSS keyframes (no scripts, no web fonts), so it animates inside GitHub's <img> tags.
// Every animation shares one LOOP and starts at 0, so frames can be checked by freezing them at a moment.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "assets", "argue-flow.svg");
export const LOOP = 22; // seconds

const C = {
  bg: "#0d1117",
  panel: "#161b22",
  room: "#10151c",
  line: "#30363d",
  text: "#e6edf3",
  dim: "#8b949e",
  faint: "#6e7681",
  A: "#e0825e", // Claude
  B: "#19b38c", // Codex
  C: "#5b93f5", // Gemini
  ref: "#b083f0",
  ok: "#3fb950",
  info: "#e3b341",
};
const SANS = `ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;

// ---------------------------------------------------------------- animation helpers

const css = [];
let count = 0;
function anim(frames) {
  const m = new Map();
  for (const [p, v] of frames) m.set(Math.round(Math.min(100, Math.max(0, p)) * 100) / 100, v);
  const name = `k${count++}`;
  const body = [...m]
    .sort((a, b) => a[0] - b[0])
    .map(([p, v]) => `${p}%{${v}}`)
    .join("");
  css.push(`@keyframes ${name}{${body}}.${name}{animation:${name} ${LOOP}s infinite}`);
  return name;
}
/** Visible from a% to b% of the loop. */
const show = (a, b, f = 0.8) =>
  anim([
    [0, "opacity:0"],
    [a, "opacity:0"],
    [a + f, "opacity:1"],
    [b - f, "opacity:1"],
    [b, "opacity:0"],
    [100, "opacity:0"],
  ]);
/** One of several texts shown in turn in the same place: a quick fade out, then in (no ghosting). */
const turnOf = (a, b) => show(a, b, 0.35);
/** Moves through points [[pct, x, y], …], visible only while moving. */
function travel(points, f = 0.7) {
  const at = ([, x, y]) => `transform:translate(${x}px,${y}px)`;
  const first = points[0];
  const last = points.at(-1);
  return anim([
    [0, `opacity:0;${at(first)}`],
    [first[0] - f, `opacity:0;${at(first)}`],
    ...points.map((p) => [p[0], `opacity:1;${at(p)}`]),
    [last[0] + f, `opacity:0;${at(last)}`],
    [100, `opacity:0;${at(last)}`],
  ]);
}
/** A bar that fills left to right between a% and b%, then stays until the loop resets. */
const fill = (a, b) =>
  anim([
    [0, "transform:scaleX(0);opacity:1"],
    [a, "transform:scaleX(0);opacity:1"],
    [b, "transform:scaleX(1);opacity:1"],
    [96, "transform:scaleX(1);opacity:1"],
    [99, "transform:scaleX(1);opacity:0"],
    [100, "transform:scaleX(0);opacity:0"],
  ]);
/** A soft pulse (glow) between a% and b%. */
const pulse = (a, b) => {
  const frames = [
    [0, "opacity:0"],
    [a, "opacity:0"],
  ];
  for (let t = a; t + 2 <= b; t += 2) frames.push([t + 1, "opacity:1"], [t + 2, "opacity:0.35"]);
  frames.push([b, "opacity:0"], [100, "opacity:0"]);
  return anim(frames);
};

// ---------------------------------------------------------------- drawing helpers

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
const rect = (x, y, w, h, o = {}) =>
  `<rect ${attrs({ x, y, width: w, height: h, rx: o.rx ?? 10, fill: o.fill ?? C.panel, stroke: o.stroke ?? C.line, "stroke-width": o.sw ?? 1.2, "stroke-dasharray": o.dash, class: o.cls, opacity: o.op })}/>`;
const text = (x, y, s, o = {}) =>
  `<text ${attrs({
    x,
    y,
    "font-family": o.mono ? MONO : SANS,
    "font-size": o.size ?? 14,
    "font-weight": o.bold ? 700 : o.weight,
    fill: o.fill ?? C.text,
    "text-anchor": o.anchor,
    "letter-spacing": o.ls,
    class: o.cls,
    opacity: o.op,
  })}>${esc(s)}</text>`;
const group = (inner, o = {}) => `<g ${attrs({ class: o.cls, opacity: o.op, transform: o.at })}>${inner}</g>`;
const line = (d, o = {}) =>
  `<path d="${d}" fill="none" ${attrs({ stroke: o.stroke ?? C.line, "stroke-width": o.sw ?? 1.5, "stroke-dasharray": o.dash, class: o.cls, opacity: o.op, "stroke-linecap": "round" })}/>`;
const tick = (x, y, color = C.ok) =>
  `<path d="M${x - 5} ${y} l3.5 3.5 l6.5 -7" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;

/** A message chip centred on 0,0 (moved by its travel animation). */
function chip(label, color, cls) {
  const w = Math.round(label.length * 7.8 + 24);
  return group(
    rect(-w / 2, -14, w, 28, { rx: 14, fill: C.bg, stroke: color, sw: 1.8 }) +
      text(0, 5, label, { mono: true, size: 13, anchor: "middle", fill: color, bold: true }),
    { cls, op: 0 },
  );
}

// ---------------------------------------------------------------- the story (percent of LOOP)
//  0– 7  any AI tool can ask                      30–45  opening: everyone works alone
//  7–20  "argue this…" → skill/MCP → argue        45–61  round 1: challenge, ask for a tool, answer
// 19–44  lineup + limits note (not blocking)       61–69  round 2: everyone backs B
// 24–31  the brief goes to every desk              69–78  red team: C tries to break B; nothing found
//                                                   78–99  verdict → one answer back in your tool

const parts = [];
const add = (s) => parts.push(s);

add(rect(4, 4, 1272, 712, { rx: 18, fill: C.bg, stroke: C.line }));
add(text(36, 52, "argue", { mono: true, size: 26, bold: true }));
add(text(132, 51, "what happens when you say “argue this”", { size: 18, fill: C.dim }));
add(text(1244, 51, "agents decide every move · code keeps score", { size: 14, fill: C.faint, anchor: "end" }));

// 1 · any AI tool
const TOOLS = ["Claude Code", "Codex", "Cursor", "Gemini CLI", "OpenCode", "Pi", "terminal"];
const toolY = (i) => 116 + i * 54;
add(text(36, 98, "1 · ASK FROM ANY AI TOOL", { size: 12.5, fill: C.dim, bold: true, ls: 1 }));
TOOLS.forEach((name, i) => {
  const y = toolY(i);
  add(line(`M232 ${y + 21} H246`));
  add(rect(36, y, 196, 42));
  add(text(54, y + 27, name, { size: 16, mono: name === "terminal" }));
  add(rect(36, y, 196, 42, { fill: "#ffffff10", stroke: C.info, sw: 1.8, cls: show(0.5 + i * 0.9, 2.6 + i * 0.9, 0.6), op: 0 }));
});
add(line(`M246 ${toolY(0) + 21} V${toolY(6) + 21}`));
add(line("M246 243 H262"));
add(rect(36, toolY(0), 196, 42, { fill: "#ffffff12", stroke: C.A, sw: 2.2, cls: show(7, 92), op: 0 }));
add(line(`M232 ${toolY(0) + 21} H246 V243 H262`, { stroke: C.info, sw: 2.6, cls: show(13, 20), op: 0 }));

// the request
add(
  group(
    rect(252, 92, 214, 66, { rx: 12, fill: "#1c2430", stroke: C.info, sw: 1.6 }) +
      `<path d="M252 118 L238 131 L252 138 Z" fill="#1c2430" stroke="${C.info}" stroke-width="1.6"/>` +
      `<rect x="250" y="119" width="4" height="18" fill="#1c2430"/>` +
      text(268, 119, "“argue this proposal", { size: 15 }) +
      text(268, 141, "with other models”", { size: 15 }),
    { cls: show(7.5, 30), op: 0 },
  ),
);

// 2 · argue
add(text(262, 200, "2 · ARGUE STARTS A ROOM", { size: 12.5, fill: C.dim, bold: true, ls: 1 }));
add(rect(262, 214, 220, 58));
add(text(278, 240, "skill · MCP", { size: 16, bold: true }));
add(text(278, 260, "your tool writes the brief", { size: 12, fill: C.dim }));
add(rect(262, 214, 220, 58, { fill: "#ffffff10", stroke: C.info, sw: 2, cls: show(15, 21), op: 0 }));
add(line("M372 272 V300"));
add(line("M372 272 V300", { stroke: C.info, sw: 2.6, cls: show(17, 22), op: 0 }));
add(rect(262, 300, 220, 64));
add(text(280, 332, "argue", { mono: true, size: 24, bold: true }));
add(text(280, 352, "one engine for every tool", { size: 12, fill: C.dim }));
add(rect(262, 300, 220, 64, { fill: "#ffffff10", stroke: C.info, sw: 2, cls: show(18.5, 31), op: 0 }));

// the start notice (it doesn't block)
add(
  group(
    rect(262, 384, 220, 150, { rx: 12, fill: C.panel, stroke: C.info, sw: 1.4 }) +
      text(278, 409, "Arguing with", { size: 14, bold: true }) +
      [
        ["sonnet · Claude Code", C.A],
        ["gpt-6.1-sol · Codex", C.B],
        ["gemini-2.5-pro · Gemini", C.C],
      ]
        .map(([s, c], i) => `<circle cx="284" cy="${428 + i * 21}" r="5" fill="${c}"/>` + text(296, 433 + i * 21, s, { size: 13 }))
        .join("") +
      `<circle cx="284" cy="${496}" r="7.5" fill="none" stroke="${C.info}" stroke-width="1.6"/>` +
      text(284, 500.5, "i", { size: 11, bold: true, fill: C.info, anchor: "middle" }) +
      text(298, 501, "costs more · 4 rounds · $10", { size: 12.5, fill: C.info }) +
      text(278, 522, "just a note · the run starts now", { size: 12, fill: C.dim }),
    { cls: show(19.5, 46), op: 0 },
  ),
);

// 3 · the room
add(rect(512, 72, 736, 528, { rx: 16, fill: C.room, stroke: C.line }));
add(text(532, 100, "3 · THE ROOM", { size: 12.5, fill: C.dim, bold: true, ls: 1 }));
const phases = [
  [29.5, 45, "opening · each agent works alone", C.text],
  [45, 61, "round 1 · challenge · ask · answer", C.text],
  [61, 69, "round 2 · everyone backs B", C.text],
  [69, 78, "red team · C tries to break B", C.info],
  [78, 93, "verdict · one answer", C.ok],
];
for (const [a, b, s, fillColor] of phases) add(text(1228, 100, s, { size: 13.5, bold: true, fill: fillColor, anchor: "end", cls: turnOf(a, b), op: 0 }));

// the lane every post goes through, and its connectors
add(rect(532, 330, 696, 38, { rx: 19, fill: C.bg, stroke: C.line, dash: "4 5" }));
add(text(880, 354, "posts: STANCE · CHALLENGE · ANSWER · ASK · TOOLS", { mono: true, size: 12, fill: C.faint, anchor: "middle" }));
for (const x of [642, 880, 1118]) add(line(`M${x} 282 V330`) + line(`M${x} 368 V414`));

// the agents' desks
const DESKS = {
  A: { x: 532, y: 122, model: "sonnet", cli: "Claude Code", tool: "web search", color: C.A },
  B: { x: 1008, y: 122, model: "gpt-6.1-sol", cli: "Codex", tool: "shell · node", color: C.B },
  C: { x: 770, y: 414, model: "gemini-2.5-pro", cli: "Gemini CLI", tool: "Postgres MCP", color: C.C },
};
const status = {
  A: [
    [30.5, 41, "working alone…", C.dim],
    [41, 60, "work v1 · tests pass", C.dim],
    [60, 96, "revised · v2", C.text],
  ],
  B: [
    [30.5, 41, "working alone…", C.dim],
    [41, 75, "work v1 · tests pass", C.dim],
    [75, 96, "survived the red team", C.ok],
  ],
  C: [
    [30.5, 41, "working alone…", C.dim],
    [41, 96, "work v1 · tests pass", C.dim],
  ],
};
const stance = {
  A: [
    [41, 63.4, "backs own work", C.dim],
    [63.4, 96, "backs B", C.B],
  ],
  B: [[41, 96, "backs own work", C.B]],
  C: [
    [41, 64.8, "backs own work", C.dim],
    [64.8, 96, "backs B", C.B],
  ],
};
for (const [id, d] of Object.entries(DESKS)) {
  const { x, y } = d;
  add(rect(x, y, 220, 160));
  add(rect(x, y, 220, 160, { fill: "none", stroke: d.color, sw: 2, cls: show(26.5, 96), op: 0 }));
  add(`<circle cx="${x + 24}" cy="${y + 26}" r="14" fill="${d.color}"/>`);
  add(text(x + 24, y + 31.5, id, { size: 15, bold: true, fill: C.bg, anchor: "middle" }));
  add(text(x + 46, y + 25, d.model, { size: 15, bold: true }));
  add(text(x + 46, y + 43, `${d.cli} · own repo copy`, { size: 12, fill: C.dim }));
  add(rect(x + 14, y + 60, 192, 7, { rx: 3.5, fill: C.line, stroke: "none" }));
  add(
    `<rect x="${x + 14}" y="${y + 60}" width="192" height="7" rx="3.5" fill="${d.color}" class="${fill(30.5, 41)}" style="transform-box:fill-box;transform-origin:left center"/>`,
  );
  for (const [a, b, s, c] of status[id]) add(text(x + 14, y + 89, s, { size: 13, fill: c, cls: turnOf(a, b), op: 0 }));
  for (const [a, b, s, c] of stance[id]) add(text(x + 14, y + 112, s, { size: 13, bold: true, fill: c, cls: turnOf(a, b), op: 0 }));
  const badge = `has ${d.tool}`;
  const bw = Math.round(badge.length * 7 + 22);
  add(
    group(
      rect(x + 14, y + 126, bw, 22, { rx: 11, fill: "#ffffff08", stroke: d.color, sw: 1 }) +
        text(x + 14 + bw / 2, y + 141.5, badge, { size: 12, fill: d.color, anchor: "middle" }),
      { cls: show(39.5, 96), op: 0 },
    ),
  );
}
add(rect(1000, 114, 236, 176, { rx: 14, fill: "none", stroke: C.info, sw: 2.4, dash: "7 6", cls: pulse(69.5, 77.5), op: 0 }));

// the shared room
add(rect(770, 122, 220, 160, { fill: "#131a24" }));
add(text(786, 148, "shared room", { size: 15, bold: true }));
add(text(786, 166, "every agent reads it", { size: 12, fill: C.dim }));
[
  ["room.md", "the record"],
  ["work/", "everyone's work"],
  ["checks/", "test output"],
].forEach(([f, d], i) => add(text(786, 192 + i * 19, f, { mono: true, size: 12, fill: C.text }) + text(852, 192 + i * 19, d, { size: 12, fill: C.dim })));
const record = [
  [42, 48.5, "opening: A B C posted"],
  [48.5, 52.5, "#1 B → A challenge"],
  [52.5, 60, "A asks C for its DB"],
  [60, 63.4, "#1 answered · A v2"],
  [63.4, 69.5, "A and C back B"],
  [69.5, 77.5, "red team on B…"],
  [77.5, 96, "agreed: B"],
];
for (const [a, b, s] of record) add(text(786, 268, `› ${s}`, { mono: true, size: 12, fill: C.info, cls: turnOf(a, b), op: 0 }));

// the verdict
const V = { x: 532, y: 414 };
add(rect(V.x, V.y, 220, 160));
add(rect(V.x, V.y, 220, 160, { fill: "none", stroke: C.ok, sw: 2, cls: show(78.5, 91), op: 0 }));
add(text(V.x + 16, V.y + 28, "verdict", { size: 15, bold: true }));
add(text(V.x + 16, V.y + 47, "a fresh call writes the answer", { size: 12, fill: C.dim }));
[176, 150, 120].forEach((w, i) => {
  add(rect(V.x + 16, V.y + 70 + i * 16, w, 7, { rx: 3.5, fill: C.line, stroke: "none" }));
  add(
    `<rect x="${V.x + 16}" y="${V.y + 70 + i * 16}" width="${w}" height="7" rx="3.5" fill="${C.ok}" class="${fill(81 + i * 1.6, 82.6 + i * 1.6)}" style="transform-box:fill-box;transform-origin:left center"/>`,
  );
});
add(text(V.x + 16, V.y + 142, "Note: only if still split", { size: 12, fill: C.faint }));

// the referee: plain code, keeps score
const RF = { x: 1008, y: 414 };
add(rect(RF.x, RF.y, 220, 160));
add(text(RF.x + 16, RF.y + 28, "referee", { size: 15, bold: true, fill: C.ref }));
add(text(RF.x + 80, RF.y + 28, "· plain code", { size: 12, fill: C.dim }));
[
  ["tests pass", 41.5],
  ["everyone backs B", 65.5],
  ["no open challenges", 65.5],
  ["survived a red team", 77],
].forEach(([s, at], i) => {
  const cy = RF.y + 52 + i * 22;
  add(`<circle cx="${RF.x + 24}" cy="${cy}" r="7" fill="none" stroke="${C.faint}" stroke-width="1.4"/>`);
  add(group(`<circle cx="${RF.x + 24}" cy="${cy}" r="8" fill="#3fb95033"/>` + tick(RF.x + 24, cy), { cls: show(at, 96), op: 0 }));
  add(text(RF.x + 40, cy + 4.5, s, { size: 13 }));
});
add(text(RF.x + 16, RF.y + 148, "→ agreement", { size: 13.5, bold: true, fill: C.ok, cls: show(77.5, 96), op: 0 }));
add(text(RF.x + 16, RF.y + 148, "stalls, loops, limits end it", { size: 12, fill: C.faint, cls: show(0, 77.5, 0.5), op: 0 }));

// 4 · the answer comes back
add(text(36, 556, "4 · ONE ANSWER COMES BACK", { size: 12.5, fill: C.dim, bold: true, ls: 1 }));
add(
  group(
    rect(36, 570, 446, 112, { rx: 12, fill: "#0f1f14", stroke: C.ok, sw: 1.6 }) +
      tick(58, 598) +
      text(74, 603, "one vetted answer, in Claude Code", { size: 16, bold: true, fill: C.ok }) +
      text(56, 629, "the room checked it · a Note: only if a real split is left", { size: 12.5, fill: C.text }) +
      text(56, 653, "code change?", { size: 12.5, fill: C.dim }) +
      text(146, 653, "argue apply", { mono: true, size: 12.5, fill: C.text }) +
      text(240, 653, "· nothing changes before that", { size: 12.5, fill: C.dim }),
    { cls: `${show(88.5, 99)} still`, op: 0 },
  ),
);
add(text(56, 630, "the answer lands back where you asked", { size: 13, fill: C.faint, cls: show(0, 30, 0.5), op: 0 }));
// meanwhile, the tool you asked from prints a short status now and then
add(
  group(
    rect(36, 570, 446, 112, { rx: 12, fill: C.panel, stroke: C.line }) +
      text(56, 596, "meanwhile, in Claude Code", { size: 13, bold: true, fill: C.dim }) +
      `<circle cx="62" cy="626" r="4" fill="${C.info}"/>`,
    { cls: show(30, 88), op: 0 },
  ),
);
for (const [a, b, s] of [
  [30.5, 45.5, "3 models are working on it alone…"],
  [45.5, 52.3, "B challenged A's answer"],
  [52.3, 60, "A asked C to query its database tool"],
  [60, 65, "A fixed its answer (v2)"],
  [65, 69.5, "A and C now back B: everyone agrees"],
  [69.5, 78, "C is trying to break B's answer…"],
  [78, 88, "agreed; writing the final answer"],
])
  add(text(76, 631, s, { size: 13.5, cls: turnOf(a, b), op: 0 }));
add(text(56, 662, "one line now and then · never blocks you", { size: 12, fill: C.faint, cls: show(30, 88), op: 0 }));

add(text(532, 632, "Agents choose every move: research, challenge with evidence, use each other's tools, revise, agree.", { size: 13, fill: C.dim }));
add(text(532, 656, "The referee only keeps score: agreement must survive real scrutiny; stalls, loops and limits end every run.", { size: 13, fill: C.dim }));
add(text(532, 680, "Every agent has its own desk; everything they share goes through the room.", { size: 13, fill: C.dim }));

// ---------------------------------------------------------------- moving messages

const bottom = (id) => [DESKS[id].x + 110, DESKS[id].y + (DESKS[id].y < 300 ? 168 : -8)];
const lane = (x) => [x, 349];
const route = (from, to, t0, t1, via) => {
  const a = bottom(from);
  const b = bottom(to);
  const m = lane(via ?? (a[0] + b[0]) / 2);
  const mid = (t0 + t1) / 2;
  return [
    [t0, ...a],
    [mid, ...m],
    [t1, ...b],
  ];
};
const send = (label, color, points) => add(chip(label, color, travel(points)));

// the request and the brief
send("brief", C.info, [
  [24.5, 482, 332],
  [27, 642, 290],
]);
send("brief", C.info, [
  [24.5, 482, 332],
  [25.8, 700, 349],
  [27.5, 1118, 290],
]);
send("brief", C.info, [
  [24.5, 482, 332],
  [25.8, 700, 349],
  [27.5, 880, 406],
]);
// opening: everyone's work lands in the room
send("work A", C.A, [
  [40.5, 642, 290],
  [42.5, 800, 300],
]);
send("work C", C.C, [
  [40.5, 880, 406],
  [42.5, 880, 300],
]);
send("work B", C.B, [
  [40.5, 1118, 290],
  [42.5, 960, 300],
]);
// round 1
send("CHALLENGE A #1", C.B, route("B", "A", 46, 51.5));
send("ASK C: run EXPLAIN", C.A, route("A", "C", 52.3, 55.3, 760));
send("seq scan on users", C.C, route("C", "A", 56.3, 59.3, 760));
send("ANSWER #1 · v2", C.A, route("A", "B", 60.2, 62.8));
// round 2
send("STANCE: B", C.A, route("A", "B", 63.4, 66.2, 880));
send("STANCE: B", C.C, route("C", "B", 64.8, 67.6, 1060));
// red team
send("trying to break B…", C.info, route("C", "B", 69.5, 73.5, 1000));
send("nothing found", C.ok, route("B", "C", 74, 77.5, 1000));
// verdict and the answer
send("room.md + work/", C.ok, [
  [78.5, 880, 290],
  [80, 760, 349],
  [81.5, 642, 406],
]);
send("one answer", C.ok, [
  [86, 532, 494],
  [87.5, 482, 332],
  [89, 262, 243],
  [90.5, 232, 137],
]);

// ---------------------------------------------------------------- output

export const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720" role="img" aria-labelledby="t d">
<title id="t">How argue works</title>
<desc id="d">From any AI tool (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Pi or a terminal), "argue this" starts one argue engine. Each model works alone in its own copy of the project, then they challenge each other, share tools and revise through a shared room until a plain-code referee sees a real agreement. One answer comes back to the tool you asked from.</desc>
<style>${css.join("")}@media (prefers-reduced-motion:reduce){*{animation:none!important}.still{opacity:1}}</style>
${parts.join("\n")}
</svg>
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, svg);
  console.log(`wrote ${OUT} (${(svg.length / 1024).toFixed(1)} KB, ${count} animations)`);
}
