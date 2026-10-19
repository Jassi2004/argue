import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, which } from "./exec.js";

/**
 * Drivers wrap real coding-agent CLIs in headless mode.
 * Each driver: ask({ prompt, cwd, write, timeoutMs }) -> { text, costUsd, tokens, ok, error }
 */
const drivers = {
  claude: {
    bin: "claude",
    async ask({ model, effort, prompt, cwd, write, timeoutMs, maxBudgetUsd }) {
      const args = ["-p", "--output-format", "json"];
      if (write) {
        args.push("--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash");
      } else {
        args.push("--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep");
      }
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (maxBudgetUsd) args.push("--max-budget-usd", String(maxBudgetUsd));
      const res = await run("claude", args, { cwd, input: prompt, timeoutMs });
      try {
        const json = JSON.parse(res.stdout);
        return {
          ok: !json.is_error,
          text: json.result ?? "",
          costUsd: json.total_cost_usd ?? 0,
          tokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
          error: json.is_error ? json.result : undefined,
        };
      } catch {
        return { ok: false, text: "", costUsd: 0, tokens: 0, error: errorOf(res) };
      }
    },
  },

  codex: {
    bin: "codex",
    async ask({ model, effort, prompt, cwd, write, timeoutMs }) {
      const dir = mkdtempSync(join(tmpdir(), "argue-codex-"));
      const out = join(dir, "last.txt");
      const args = ["exec", "--json", "--skip-git-repo-check", "-s", write ? "workspace-write" : "read-only", "-C", cwd, "-o", out];
      if (model) args.push("-m", model);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push("-");
      const res = await run("codex", args, { cwd, input: prompt, timeoutMs });
      let tokens = 0;
      for (const line of res.stdout.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "turn.completed") tokens += (ev.usage?.input_tokens ?? 0) + (ev.usage?.output_tokens ?? 0);
        } catch {}
      }
      let text = "";
      try {
        text = readFileSync(out, "utf8");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      const ok = res.code === 0 && text !== "";
      return { ok, text, costUsd: 0, tokens, error: ok ? undefined : errorOf(res) };
    },
  },
};

function errorOf(res) {
  if (res.timedOut) return "timed out";
  return (res.stderr || res.stdout).trim().split("\n").slice(-5).join("\n") || `exit code ${res.code}`;
}

export const knownKinds = Object.keys(drivers);

/** Parse "claude:opus,codex,claude:sonnet@high" into agent specs with unique ids. */
export function parseAgents(list) {
  const counts = {};
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const [main, effort] = spec.split("@");
      const [kind, ...rest] = main.split(":");
      if (!drivers[kind]) throw new Error(`unknown agent "${kind}" (known: ${knownKinds.join(", ")})`);
      const model = rest.join(":") || undefined;
      counts[kind] = (counts[kind] ?? 0) + 1;
      const name = model ? `${kind}:${model}` : kind;
      return { kind, model, effort: effort || undefined, name, id: `${kind}${counts[kind]}` };
    });
}

export async function detectAgents() {
  const found = [];
  for (const kind of knownKinds) if (await which(drivers[kind].bin)) found.push(kind);
  return found;
}

/** Pick a sensible default lineup from whatever is installed. */
export function defaultLineup(installed) {
  if (installed.includes("claude") && installed.includes("codex")) return "claude,codex";
  if (installed.includes("claude")) return "claude:opus,claude:sonnet";
  if (installed.includes("codex")) return "codex,codex";
  return "";
}

export function ask(agent, opts) {
  return drivers[agent.kind].ask({ model: agent.model, effort: agent.effort, ...opts });
}
