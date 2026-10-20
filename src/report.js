import { head } from "./exec.js";
import { costText } from "./ui.js";

const esc = (s = "") => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderReport({ result, players, transcript }) {
  const r = result;
  const out = [];
  out.push(`# argue · ${r.runId}`, "");
  out.push(`**Task:** ${r.task}`, "");
  out.push(
    `**Mode:** ${r.mode}${r.check ? ` · **Check:** \`${r.check}\`` : ""} · **Rounds:** ${r.rounds} · **Cost:** ${costText(r.costUsd)} · **Tokens:** ${r.tokens.toLocaleString("en-US")}`,
    "",
  );
  out.push(`## Winner: ${r.winner.id} (${r.winner.agent})`, "", r.reason || "", "", `**Risks:** ${r.risks || "none noted"}`, "");
  if (r.mode === "code") {
    out.push(`**Patch:** \`${r.patch}\`${r.applied ? " (applied)" : ""}`, "");
    if (r.files.length) out.push("**Files:** " + r.files.map((f) => `\`${f}\``).join(", "), "");
  } else {
    out.push("## Final answer", "", r.answer || "", "");
  }
  out.push("## Scoreboard", "");
  out.push(
    r.mode === "code" ? "| | agent | check | objections | change |" : "| | agent | objections |",
    r.mode === "code" ? "|---|---|---|---|---|" : "|---|---|---|",
  );
  for (const p of players) {
    const mark = p.id === r.winner.id ? "🏆" : p.alive ? "" : "✗";
    if (r.mode === "code")
      out.push(
        `| ${mark} ${p.id} | ${esc(p.name)} | ${p.check ? (p.check.pass ? "pass" : "fail") : "–"} | ${p.objections} | ${p.stats ? `${p.stats.files} files +${p.stats.add}/-${p.stats.del}` : "–"} |`,
      );
    else out.push(`| ${mark} ${p.id} | ${esc(p.name)} | ${p.objections} |`);
  }
  out.push("", "## Transcript", "");
  for (const t of transcript)
    out.push(
      `<details><summary><b>${t.phase}</b> · ${t.who} (${esc(t.agent)})${t.ok ? "" : " — failed"}</summary>`,
      "",
      head(t.text, 20000),
      "",
      "</details>",
      "",
    );
  if (r.mode === "code") {
    const w = players.find((p) => p.id === r.winner.id);
    const diff = head(w?.diff ?? "", 60000);
    const fence = "`".repeat(Math.max(3, ...[...diff.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    out.push("## Winning patch", "", `${fence}diff`, diff, fence, "");
  }
  return out.join("\n");
}
