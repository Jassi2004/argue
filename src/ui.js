// Human-friendly progress output. Plain lines (works in any terminal, CI logs, and host-agent shells).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = c(2);
export const bold = c(1);
export const green = c(32);
export const red = c(31);
export const yellow = c(33);
export const cyan = c(36);

const PHASE = {
  propose: "propose · each agent solves it alone",
  answer: "answer · each agent answers alone",
  critique: "critique · agents attack each other",
  revise: "revise · agents fix what holds up",
  judge: "judge · picking the winner",
};

/** Returns an onEvent handler that prints progress to `write`. */
export function progressPrinter(write = (s) => process.stdout.write(`${s}\n`)) {
  return (e) => {
    switch (e.type) {
      case "start":
        write(`${bold("argue")} ${dim(e.runId)}`);
        write(`  ${dim("task")}    ${trim(e.task)}`);
        for (const a of e.agents) {
          const effort = a.effortSupported ? `effort ${a.effort ?? "default"}` : "";
          write(
            `  ${a === e.agents[0] ? dim("agents") : "      "}  ${cyan(a.id)} ${a.harness ?? a.agent} ${dim("·")} ${a.model ?? "default model"}${effort ? ` ${dim("·")} ${effort}` : ""}`,
          );
        }
        if (e.check) write(`  ${dim("check")}   ${e.check}`);
        if (e.mode === "ask") write(`  ${dim("mode")}    ask (no file changes)`);
        write(dim(`  change agents, models or effort: argue lineup <a,b,…>  (e.g. claude:opus,codex@high)`));
        break;
      case "phase":
        write(`\n${bold(PHASE[e.name] ?? e.name)}${e.round ? dim(` (round ${e.round})`) : ""}`);
        break;
      case "call":
        if (e.status === "done") {
          const label = e.who === "judge" ? `judge ${dim(e.agent)}` : `${cyan(e.who)} ${dim(e.agent)}`;
          const cost = e.costUsd ? `, $${e.costUsd.toFixed(2)}` : "";
          write(`  ${e.ok ? green("✓") : red("✗")} ${label} ${dim(`${e.secs}s${cost}`)}${e.ok ? "" : ` ${red(trim(e.error, 160))}`}`);
        }
        break;
      case "check":
        write(`  ${e.pass ? green("✓") : red("✗")} ${cyan(e.who)} check ${e.pass ? green("passed") : red("failed")}`);
        break;
      case "objections":
        {
          const unclear = (e.reviewers ?? 0) - e.count - (e.approvals ?? 0);
          const msg = e.count
            ? `${e.count} reviewer(s) raised issues`
            : unclear > 0
              ? `no objections (${unclear} unclear review${unclear > 1 ? "s" : ""})`
              : "approved by all reviewers";
          write(`  ${e.count ? yellow("!") : unclear > 0 ? dim("?") : green("✓")} ${cyan(e.who)} ${msg}`);
        }
        break;
      case "note":
        write(`  ${dim(`→ ${e.text}`)}`);
        break;
      case "warning":
        write(`  ${yellow(`⚠ ${e.text}`)}`);
        break;
      case "error":
        write(`\n${red("✗ failed:")} ${e.message}`);
        break;
    }
  };
}

export function printResult(r, write = (s) => process.stdout.write(`${s}\n`)) {
  write("");
  write(`${green("🏆 winner")}  ${cyan(r.winner.id)} ${bold(r.winner.agent)}`);
  if (r.reason) write(`${dim("   why")}     ${r.reason}`);
  if (r.risks && r.risks !== "none") write(`${dim("   risks")}   ${r.risks}`);
  write(`${dim("   cost")}    ${costText(r.costUsd)} · ${r.tokens.toLocaleString("en-US")} tokens · ${r.calls} calls`);
  if (r.mode === "code") {
    write(`${dim("   files")}   ${r.files.join(", ") || "(none)"}`);
    if (r.applied) write(`${green("   ✓ applied to your working tree")}`);
    else {
      if (r.applyError) write(`${red("   ✗ could not apply:")} ${r.applyError}`);
      write(`${dim("   apply")}   argue apply ${r.runId}`);
    }
  } else {
    write("");
    write(r.answer);
    write("");
  }
  write(`${dim("   report")}  ${r.report}`);
}

/** Dollar amount as reported by CLIs that report cost (others bill your plan and only report tokens). */
export function costText(usd) {
  return usd ? `$${usd.toFixed(2)}` : "$0 reported (Codex/Gemini/Cursor bill your plan)";
}

function trim(s = "", n = 110) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
