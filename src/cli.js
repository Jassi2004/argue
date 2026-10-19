import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultLineup, detectAgents, parseAgents } from "./agents.js";
import { argue } from "./argue.js";

const HELP = `argue — make AI coding agents argue over your task until the best solution wins.

Usage:
  argue "<task>" [options]
  argue doctor                 show which agent CLIs are installed

Options:
  -a, --agents <list>    agents to compete, e.g. "claude,codex" or "claude:opus,claude:sonnet@high"
  -j, --judge <agent>    agent that picks the winner (default: first agent kind)
  -c, --check <cmd>      acceptance command run in each copy, e.g. "npm test"
  -r, --rounds <n>       max critique/revise rounds (default 2)
  -b, --budget <usd>     stop starting new rounds once this much is spent (Claude cost only)
  -t, --timeout <min>    per-agent-call timeout in minutes (default 20)
  -f, --file <path>      read the task from a file
      --apply            apply the winning patch to your working tree
      --keep             keep agent worktrees for inspection
      --json             print the result as JSON (for tools and host agents)
  -h, --help

Agents: claude (Claude Code), codex (Codex CLI). Format: kind[:model][@effort]
Everything runs locally through the CLIs you already use and are logged in to.`;

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agents: { type: "string", short: "a" },
      judge: { type: "string", short: "j" },
      check: { type: "string", short: "c" },
      rounds: { type: "string", short: "r", default: "2" },
      budget: { type: "string", short: "b" },
      timeout: { type: "string", short: "t", default: "20" },
      file: { type: "string", short: "f" },
      apply: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || (!positionals.length && !values.file)) return console.log(HELP);

  const installed = await detectAgents();
  if (positionals[0] === "doctor") {
    console.log(installed.length ? `found: ${installed.join(", ")}` : "no supported agent CLIs found (install Claude Code or Codex)");
    console.log(`default lineup: ${defaultLineup(installed) || "(none)"}`);
    return;
  }

  const task = values.file ? readFileSync(values.file, "utf8").trim() : positionals.join(" ").trim();
  if (!task) throw new Error("empty task");

  const lineup = values.agents ?? defaultLineup(installed);
  if (!lineup) throw new Error("no agents found. Install Claude Code (claude) or Codex (codex), or pass --agents");
  const agents = parseAgents(lineup);
  if (agents.length < 2) throw new Error("need at least two agents to argue (repeat one if you only have one, e.g. claude,claude)");
  for (const a of agents) if (!installed.includes(a.kind)) throw new Error(`"${a.kind}" CLI not found on PATH`);
  const judge = parseAgents(values.judge ?? agents[0].kind)[0];

  const log = values.json ? (m) => process.stderr.write(`${m}\n`) : (m) => console.log(m);
  const result = await argue({
    task,
    agents,
    judge,
    check: values.check,
    rounds: Number(values.rounds),
    budgetUsd: values.budget ? Number(values.budget) : undefined,
    timeoutMin: Number(values.timeout),
    apply: values.apply,
    keep: values.keep,
    cwd: process.cwd(),
    log,
  });

  if (values.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`
winner: ${result.winner.id} (${result.winner.agent})
why:    ${result.reason}
risks:  ${result.risks}
cost:   $${result.costUsd} · ${result.tokens} tokens
patch:  ${result.patch}${result.applied ? " (applied)" : `\n        apply with: git apply ${result.patch}`}
report: ${result.report}`);
}
