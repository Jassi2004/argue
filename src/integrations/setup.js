import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { userConfigPath } from "../config.js";
import { writeJson } from "../util/fs.js";
import { install, targets } from "./install.js";
import { bold, dim, green, red } from "../util/ui.js";

/**
 * First-run setup: the first time a person uses argue in a terminal, offer to connect it to their
 * coding agents (skill + MCP + /argue commands). One keypress, asked once, never in automation.
 *
 * The answer is remembered in ~/.config/argue/state.json:
 *   { "setup": "done" | "declined", "version": "<argue version that asked>" }
 */
export function statePath() {
  return join(dirname(userConfigPath()), "state.json");
}

export function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function saveState(patch) {
  try {
    writeJson(statePath(), { ...readState(), ...patch });
  } catch {}
}

/** Mark setup as done (called by `argue install`), so the first-run prompt never shows afterwards. */
export function markSetupDone() {
  saveState({ setup: "done", at: new Date().toISOString() });
}

/** Already connected to at least one agent (e.g. by an older argue, or by hand)? */
function alreadyConnected(home = homedir()) {
  return [".agents", ".claude", ".cursor"].some((d) => existsSync(join(home, d, "skills", "argue", "SKILL.md")));
}

/** Environment variables that coding agents set in their shell tools (checked on this machine for Claude Code, Codex, Pi). */
const AGENT_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_THREAD_ID", "PI_CODING_AGENT", "OPENCODE", "GEMINI_CLI", "CURSOR_AGENT"];

/** Only ask real people at a real terminal; never agents, CI, scripts, or nested runs. */
export function interactive(env = process.env, tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)) {
  if (!tty) return false;
  if (env.CI || env.ARGUE_DEPTH || env.ARGUE_NO_SETUP) return false;
  return !AGENT_ENV.some((k) => env[k]);
}

/**
 * Offer setup if it has never been answered. Returns true if setup ran.
 * `ask` is injectable for tests; by default it reads one line from the terminal.
 */
export async function maybeOfferSetup({ ask = askLine, write = (s) => process.stdout.write(`${s}\n`), force = false, home } = {}) {
  const state = readState();
  if (!force) {
    if (state.setup) return false;
    if (alreadyConnected(home)) {
      saveState({ setup: "done", at: new Date().toISOString() });
      return false;
    }
    if (!interactive()) return false;
  }

  const found = targets(home).filter((t) => t.id !== "skill" && t.present());
  const names = [...new Set(found.map((t) => AGENT_NAMES[t.id]))];
  write("");
  write(bold("Welcome to argue!"));
  write(
    names.length
      ? `Connect argue to ${names.join(", ")}, so you can ask your agent to "argue" a task right where you work?`
      : `Add an "argue" skill for your coding agents, so you can use argue from inside them?`,
  );
  write(dim('This adds a skill and an MCP entry to each agent\'s config. Undo any time with "argue uninstall".'));
  const answer = (await ask(`${bold("Connect now?")} ${dim("[Y/n]")} `)).trim().toLowerCase();
  if (answer && !["y", "yes"].includes(answer)) {
    saveState({ setup: "declined", at: new Date().toISOString() });
    write(dim('Skipped. Run "argue install" any time to connect.\n'));
    return false;
  }

  const results = await install({ home });
  for (const r of results) {
    if (r.status === "skipped") continue;
    write(`  ${r.status === "error" ? red("✗") : green("✓")} ${r.title}${r.status === "error" ? ` ${red(r.detail)}` : ""}`);
  }
  saveState({ setup: "done", at: new Date().toISOString() });
  write(dim('Done. Restart your agents, then ask them to "argue" a task.\n'));
  return true;
}

const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI", opencode: "OpenCode", pi: "Pi" };

async function askLine(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    return "n";
  } finally {
    rl.close();
  }
}
