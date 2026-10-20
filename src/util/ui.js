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
  propose: "solving · each model works on it alone",
  answer: "solving · each model works on it alone",
  critique: "cross-examining · each model attacks the others' work",
  revise: "improving · each model fixes what held up",
  final: "writing the final answer",
};

/**
 * Progress for people: the lineup, then one short line per phase. Agent letters, the final-step
 * model, verdict counts and costs stay in the run's record (argue show), not on screen.
 * `verbose` restores the detailed per-call view.
 */
export function progressPrinter(write = (s) => process.stdout.write(`${s}\n`), { verbose = false } = {}) {
  const failed = new Set();
  return (e) => {
    switch (e.type) {
      case "start": {
        write("");
        write(bold("⚔  Arguing with:"));
        for (const a of e.agents) {
          const effort = a.effortSupported ? (a.effort ?? "default") : "n/a";
          write(`   ${bold(a.model ?? "account default model")} ${dim("·")} effort ${effort} ${dim("·")} ${a.harness ?? a.agent}`);
        }
        write(dim("   want different models? Ctrl-C and run again with -a <models>, e.g. -a opus,gpt-6.1-sol@high"));
        write("");
        if (e.mode === "answer") write(dim("   (answering, no files will change)"));
        break;
      }
      case "phase":
        write(`${dim("…")} ${PHASE[e.name] ?? e.name}`);
        break;
      case "call":
        if (e.status !== "done") break;
        if (verbose) {
          const cost = e.costUsd ? `, $${e.costUsd.toFixed(2)}` : "";
          write(`  ${e.ok ? green("✓") : red("✗")} ${e.who} ${dim(e.agent)} ${dim(`${e.secs}s${cost}`)}${e.ok ? "" : ` ${red(trim(e.error, 160))}`}`);
        } else if (!e.ok && !failed.has(e.agent)) {
          failed.add(e.agent);
          write(`  ${yellow("!")} ${e.agent} had a problem and was left out: ${trim(e.error, 140)}`);
        }
        break;
      case "check":
        if (verbose) write(`  ${e.pass ? green("✓") : red("✗")} ${e.who} check ${e.pass ? "passed" : "failed"}`);
        break;
      case "objections":
        if (verbose) write(`  ${e.who}: ${e.count} objection(s), ${e.approvals ?? 0} approval(s)`);
        break;
      case "note":
        if (verbose) write(`  ${dim(`→ ${e.text}`)}`);
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

/** The one thing the user cares about: the vetted answer (plus, for code, how to apply it). */
export function printResult(r, write = (s) => process.stdout.write(`${s}\n`)) {
  write("");
  write(r.answer || "(no answer)");
  write("");
  if (r.mode === "code") {
    if (r.applied) write(green(`✓ applied to your files: ${r.files.join(", ")}`));
    else {
      if (r.applyError) write(`${red("✗ could not apply:")} ${r.applyError}`);
      write(dim(`apply it: argue apply · files: ${r.files.join(", ") || "(none)"}`));
    }
  }
  write(dim(`questions about this answer: argue ask "why not …?"`));
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
