// Human-friendly progress output. Plain lines (works in any terminal, CI logs, and host-agent shells).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = c(2);
export const bold = c(1);
export const green = c(32);
export const red = c(31);
export const yellow = c(33);
export const cyan = c(36);

const secs = (s = 0) => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);
const stance = (s, who) => (s === "open" ? "undecided" : s === "impasse" ? yellow("impasse") : s === who ? "backs own work" : s ? `backs ${bold(s)}` : "");

/**
 * The room, live: the lineup, then one line per turn as it lands (what each agent did: challenges,
 * answers, stance), then how the room ended. `verbose` adds costs, notes and every check.
 */
export function progressPrinter(write = (s) => process.stdout.write(`${s}\n`), { verbose = false } = {}) {
  const took = {};
  return (e) => {
    switch (e.type) {
      case "start": {
        write("");
        write(
          `${bold("⚔  argue")} ${dim(`· ${e.agents.length} agents · ${e.mode === "code" ? `code change${e.check ? `, checked by ${e.check}` : ""}` : "answer (no files change)"}`)}`,
        );
        for (const a of e.agents) {
          const effort = a.effortSupported ? (a.effort ?? "default") : "n/a";
          write(`   ${cyan(a.id)}  ${bold(a.model ?? "account default model")} ${dim(`· ${a.harness ?? a.agent} · effort ${effort}`)}`);
        }
        if (new Set(e.agents.map((a) => a.harness)).size === 1)
          write(dim("   tip: models from different labs catch more of each other's mistakes (argue doctor shows what's installed)"));
        write(dim("   want different models? Ctrl-C and run again with -a, e.g. -a opus,gpt-6.1-sol@high"));
        break;
      }
      case "phase": {
        const title =
          e.name === "opening"
            ? "opening · each agent works alone"
            : e.name === "round"
              ? `round ${e.round} · ${e.players.join(" ")}`
              : e.name === "red-team"
                ? `red team · ${e.players[0]} tries to break ${e.target}'s work`
                : e.name === "verdict"
                  ? "writing the final answer"
                  : e.name;
        write(`${dim("──")} ${title}`);
        break;
      }
      case "call":
        if (e.status !== "done") break;
        took[e.who] = e;
        if (!e.ok) write(`   ${cyan(e.who)}  ${red("✗")} ${dim(secs(e.secs))}  ${red(trim(e.error, 120))}`);
        else if (verbose && e.who === "verdict") write(`   ${green("✓")} ${dim(`${secs(e.secs)}${e.costUsd ? ` · $${e.costUsd.toFixed(2)}` : ""}`)}`);
        break;
      case "post": {
        const c = took[e.who] ?? {};
        const bits = [];
        for (const ch of e.challenges) bits.push(`${yellow("challenges")} ${bold(ch.target)} #${ch.id} "${trim(ch.text, 70)}"`);
        if (e.answers.length) bits.push(`answers ${e.answers.map((n) => `#${n}`).join(" ")}`);
        if (e.withdraws.length) bits.push(`withdraws ${e.withdraws.map((n) => `#${n}`).join(" ")}`);
        for (const a of e.asks) bits.push(`asks ${bold(a.to)} "${trim(a.text, 50)}"`);
        if (e.changed && e.kind !== "opening") bits.push(`revised (v${e.version})`);
        if (e.changed && e.check !== null) bits.push(e.check ? green("check ✓") : red("check ✗"));
        bits.push(stance(e.stance, e.who));
        if (!e.challenges.length && e.gist && (e.kind === "opening" || verbose)) bits.push(dim(`"${trim(e.gist, 70)}"`));
        if (e.tools && e.kind === "opening") bits.push(dim(`tools: ${trim(e.tools, 50)}`));
        const cost = verbose && c.costUsd ? ` · $${c.costUsd.toFixed(2)}` : "";
        write(`   ${cyan(e.who)}  ${green("✓")} ${dim(`${secs(c.secs)}${cost}`)}  ${bits.filter(Boolean).join(dim(" · "))}`);
        break;
      }
      case "check":
        if (verbose) write(`      ${e.pass ? green("check passed") : red("check failed")} ${dim(`(${e.who})`)}`);
        break;
      case "note":
        if (verbose) write(dim(`      → ${e.text}`));
        break;
      case "end":
        write(`${e.reason === "consensus" ? green("✓") : yellow("·")}  ${e.outcome}`);
        break;
      case "warning":
        write(`   ${yellow(`⚠ ${e.text}`)}`);
        break;
      case "error":
        write(`\n${red("✗ failed:")} ${e.message}`);
        break;
    }
  };
}

/** The one thing the user came for: the answer (plus, for code, how to apply it). */
export function printResult(r, write = (s) => process.stdout.write(`${s}\n`)) {
  write("");
  write(r.answer || "(no answer)");
  write("");
  if (r.mode === "code") {
    if (r.applied) write(green(`✓ applied to your files: ${r.files.join(", ")}`));
    else {
      if (r.applyError) write(`${red("✗ could not apply:")} ${r.applyError}`);
      write(`${bold("apply it:")} argue apply ${dim(`· files: ${r.files.join(", ") || "(none)"}`)}`);
    }
  }
  const spent = r.costCalls ? ` · $${r.costUsd.toFixed(2)} reported by ${r.costCalls === r.calls ? "every turn" : `${r.costCalls} of ${r.calls} turns`}` : "";
  write(
    dim(
      `${r.rounds} round${r.rounds === 1 ? "" : "s"} · ${r.calls} turns · ${r.challenges} challenge${r.challenges === 1 ? "" : "s"}${spent} · ${secs(r.seconds)}`,
    ),
  );
  write(dim(`the whole debate: argue show · follow-up: argue ask "why not …?"`));
}

/** A boxed table of who is competing (harness · model · effort), shown first on every run. */
export function lineupBox(agents) {
  const rows = agents.map((a, i) => [
    String.fromCharCode(65 + i),
    a.harness ?? a.agent,
    a.model ?? "default model",
    a.effortSupported ? (a.effort ?? "default") : "n/a",
  ]);
  const head = ["", "Harness", "Model", "Effort"];
  const w = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (cells, fmt = (x) => x) => `│ ${cells.map((x, c) => fmt(x.padEnd(w[c]), c)).join("   ")} │`;
  const width = w.reduce((a, b) => a + b, 0) + 3 * (w.length - 1);
  const title = " ⚔  argue lineup ";
  return [
    `╭─${bold(title)}${"─".repeat(Math.max(0, width - title.length + 1))}╮`,
    line(head, (x) => dim(x)),
    ...rows.map((r) => line(r, (x, c) => (c === 0 ? cyan(x) : c === 2 ? bold(x) : x))),
    `╰${"─".repeat(width + 2)}╯`,
  ];
}

/** Dollar amount as reported by CLIs that report cost (others bill your plan and only report tokens). */
export function costText(usd) {
  return usd ? `$${usd.toFixed(2)}` : "$0 reported (Codex/Gemini/Cursor bill your plan)";
}

function trim(s = "", n = 110) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
