import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonLines, lastJsonObject, oneLine, run, shell, tail, which } from "./exec.js";

/**
 * A driver wraps one coding-agent CLI in headless mode.
 *
 *   ask({ model, effort, prompt, promptFile, cwd, write, timeoutMs, budgetUsd })
 *     -> { ok, text, costUsd, tokens, error }
 *
 * `write: true`  = the agent may edit files and run commands in `cwd` (its own worktree).
 * `write: false` = read-only (critique / judge / plan).
 * `promptFile` is a copy of `prompt` on disk inside `cwd`, for CLIs that are easier to drive with a short argument.
 */
const POINTER = (file) => `Read the file ${file} and follow the instructions in it exactly. Reply only with what it asks for.`;

export const DRIVERS = {
  claude: {
    title: "Claude Code",
    bin: "claude",
    install: "npm i -g @anthropic-ai/claude-code",
    async ask({ model, effort, prompt, cwd, write, timeoutMs, budgetUsd }) {
      const args = ["-p", "--output-format", "json"];
      args.push(...(write ? ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,MultiEdit,Glob,Grep,Bash,TodoWrite"] : ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep"]));
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (budgetUsd > 0) args.push("--max-budget-usd", budgetUsd.toFixed(2));
      const res = await run("claude", args, { cwd, input: prompt, timeoutMs });
      const json = lastJsonObject(res.stdout);
      if (!json || json.type !== "result") return fail(res);
      return { ok: !json.is_error, text: json.result ?? "", costUsd: json.total_cost_usd ?? 0, tokens: sumTokens(json.usage), error: json.is_error ? oneLine(json.result || json.subtype, 300) : undefined };
    },
  },

  codex: {
    title: "Codex CLI",
    bin: "codex",
    install: "npm i -g @openai/codex",
    async ask({ model, effort, prompt, cwd, write, timeoutMs }) {
      const dir = mkdtempSync(join(tmpdir(), "argue-codex-"));
      const out = join(dir, "last.txt");
      const args = ["exec", "--json", "--skip-git-repo-check", "-s", write ? "workspace-write" : "read-only", "-C", cwd, "-o", out];
      if (model) args.push("-m", model);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push("-");
      const res = await run("codex", args, { cwd, input: prompt, timeoutMs });
      let tokens = 0;
      let error;
      for (const ev of jsonLines(res.stdout)) {
        if (ev.type === "turn.completed") tokens += (ev.usage?.input_tokens ?? 0) + (ev.usage?.output_tokens ?? 0);
        if (ev.type === "turn.failed" || ev.type === "error") error = ev.error?.message ?? ev.message;
      }
      let text = "";
      try {
        text = readFileSync(out, "utf8");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      if (res.code !== 0 || !text) return fail(res, error);
      return { ok: true, text, costUsd: 0, tokens };
    },
  },

  gemini: {
    title: "Gemini CLI",
    bin: "gemini",
    install: "npm i -g @google/gemini-cli",
    async ask({ model, promptFile, cwd, write, timeoutMs }) {
      const args = ["-p", POINTER(promptFile), "-o", "json", "--skip-trust", "--approval-mode", write ? "yolo" : "default"];
      if (model) args.push("-m", model);
      const res = await run("gemini", args, { cwd, timeoutMs });
      const json = lastJsonObject(res.stdout);
      if (!json || json.error || typeof json.response !== "string") return fail(res, json?.error?.message);
      let tokens = 0;
      for (const m of Object.values(json.stats?.models ?? {})) tokens += m?.tokens?.total ?? 0;
      return { ok: true, text: json.response, costUsd: 0, tokens };
    },
  },

  cursor: {
    title: "Cursor CLI",
    bin: "cursor-agent",
    altBins: ["agent"],
    install: "curl https://cursor.com/install -fsS | bash",
    async ask({ bin, model, promptFile, cwd, write, timeoutMs }) {
      const args = ["-p", "--output-format", "json", "--trust", "--workspace", cwd];
      args.push(...(write ? ["--force"] : ["--mode", "ask"]));
      if (model) args.push("--model", model);
      args.push(POINTER(promptFile));
      const res = await run(bin, args, { cwd, timeoutMs });
      const json = lastJsonObject(res.stdout);
      if (!json || json.is_error || typeof json.result !== "string") return fail(res);
      return { ok: true, text: json.result, costUsd: 0, tokens: 0 };
    },
  },

  opencode: {
    title: "OpenCode",
    bin: "opencode",
    install: "npm i -g opencode-ai",
    async ask({ model, promptFile, cwd, write, timeoutMs }) {
      const args = ["run", "--format", "json", "--dir", cwd];
      if (!write) args.push("--agent", "plan");
      if (model) args.push("-m", model);
      args.push(POINTER(promptFile));
      const res = await run("opencode", args, { cwd, timeoutMs });
      let text = "";
      let costUsd = 0;
      let tokens = 0;
      let error;
      for (const ev of jsonLines(res.stdout)) {
        if (ev.type === "text" && ev.part?.text) text = ev.part.text;
        if (ev.type === "step_finish") {
          costUsd += ev.part?.cost ?? 0;
          tokens += (ev.part?.tokens?.input ?? 0) + (ev.part?.tokens?.output ?? 0);
        }
        if (ev.type === "error") error = ev.error?.message ?? ev.error?.data?.message;
      }
      if (!text) return fail(res, error);
      return { ok: true, text, costUsd, tokens };
    },
  },

  pi: {
    title: "Pi",
    bin: "pi",
    install: "npm i -g @earendil-works/pi-coding-agent",
    async ask({ model, effort, prompt, cwd, write, timeoutMs }) {
      const args = ["-p", "--mode", "json", "--no-session", "--tools", write ? "read,bash,edit,write,grep,find,ls" : "read,grep,find,ls"];
      if (model) args.push("--model", model);
      if (effort) args.push("--thinking", effort);
      const res = await run("pi", args, { cwd, input: prompt, timeoutMs });
      let text = "";
      let costUsd = 0;
      let tokens = 0;
      let error;
      for (const ev of jsonLines(res.stdout)) {
        if (ev.type !== "message_end" || ev.message?.role !== "assistant") continue;
        const m = ev.message;
        costUsd += m.usage?.cost?.total ?? 0;
        tokens += m.usage?.totalTokens ?? 0;
        const t = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        if (t) text = t;
        if (m.stopReason === "error") error = m.errorMessage ?? "model error";
      }
      if (!text) return fail(res, error);
      return { ok: true, text, costUsd, tokens };
    },
  },
};

/**
 * Custom agents from config, e.g.
 *   "custom": { "aider": { "command": "aider --yes-always --no-git --message-file {prompt_file}", "readCommand": "..." } }
 * Placeholders: {prompt_file} {cwd} {model}. The agent's stdout is its reply.
 */
export function customDriver(name, def) {
  return {
    title: def.title ?? name,
    bin: null,
    custom: true,
    async ask({ model, promptFile, cwd, write, timeoutMs }) {
      const template = (!write && def.readCommand) || def.command;
      if (!template) return { ok: false, text: "", costUsd: 0, tokens: 0, error: `custom agent "${name}" has no command` };
      const line = template.replaceAll("{prompt_file}", quote(promptFile)).replaceAll("{cwd}", quote(cwd)).replaceAll("{model}", model ?? "");
      const [cmd, args] = shell(line);
      const res = await run(cmd, args, { cwd, timeoutMs, env: { ARGUE_WRITE: write ? "1" : "0", ARGUE_PROMPT_FILE: promptFile } });
      if (res.code !== 0) return fail(res);
      return { ok: true, text: res.stdout.trim(), costUsd: 0, tokens: 0 };
    },
  };
}

function quote(s) {
  return process.platform === "win32" ? `"${String(s).replaceAll('"', '""')}"` : `'${String(s).replaceAll("'", "'\\''")}'`;
}

function sumTokens(u) {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

function fail(res, hint) {
  let error = hint;
  if (!error) {
    if (res.timedOut) error = "timed out";
    else if (res.code === -1 && /ENOENT/.test(res.stderr)) error = "CLI not found";
    else error = tail((res.stderr || res.stdout).trim(), 600).split("\n").filter(Boolean).slice(-4).join(" | ") || `exit code ${res.code}`;
  }
  return { ok: false, text: "", costUsd: 0, tokens: 0, error: oneLine(error, 400) };
}

/** Registry of drivers available to this run (built-ins + custom from config). */
export function registry(config = {}) {
  const all = { ...DRIVERS };
  for (const [name, def] of Object.entries(config.custom ?? {})) all[name] = customDriver(name, def);
  return all;
}

/** Which agent CLIs are installed. Returns { kind: binPath }. */
export async function detect(drivers = DRIVERS) {
  const found = {};
  await Promise.all(
    Object.entries(drivers).map(async ([kind, d]) => {
      if (d.custom) return (found[kind] = "custom");
      for (const bin of [d.bin, ...(d.altBins ?? [])]) {
        const path = await which(bin);
        if (path) return (found[kind] = bin);
      }
    }),
  );
  return found;
}

/** Parse "claude:opus@high,codex,claude:sonnet" -> agent specs. */
export function parseAgents(list, drivers = DRIVERS) {
  const specs = (Array.isArray(list) ? list : String(list).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return specs.map((spec) => {
    const at = spec.lastIndexOf("@");
    const main = at > 0 ? spec.slice(0, at) : spec;
    const effort = at > 0 ? spec.slice(at + 1) : undefined;
    const colon = main.indexOf(":");
    const kind = colon < 0 ? main : main.slice(0, colon);
    const model = colon < 0 ? undefined : main.slice(colon + 1) || undefined;
    if (!drivers[kind]) throw new Error(`unknown agent "${kind}" (known: ${Object.keys(drivers).join(", ")})`);
    return { kind, model, effort, name: spec };
  });
}

const PRIORITY = ["claude", "codex", "gemini", "cursor", "opencode", "pi"];

/** Best default lineup from what is installed: up to three different vendors, else two models of one. */
export function defaultLineup(installed) {
  const kinds = PRIORITY.filter((k) => installed.includes(k));
  if (kinds.length >= 2) return kinds.slice(0, 3).join(",");
  if (kinds[0] === "claude") return "claude:opus,claude:sonnet";
  if (kinds[0]) return `${kinds[0]},${kinds[0]}`;
  return "";
}

/** CLIs whose default model is reliably strong enough to judge. */
const JUDGES = ["claude", "codex", "gemini", "cursor"];

/**
 * Judge preference: a strong CLI that is not competing (neutral), else a strong competitor's CLI
 * (it cannot tell which anonymous candidate is its own), else the first competitor exactly as specified.
 */
export function defaultJudge(installed, agents) {
  const playing = new Set(agents.map((a) => a.kind));
  const outsider = JUDGES.find((k) => installed.includes(k) && !playing.has(k));
  if (outsider) return outsider;
  const strong = agents.find((a) => JUDGES.includes(a.kind));
  return strong ? strong.kind : agents[0].name;
}

/** Ask an agent. Writes the prompt to `<cwd>/.argue/prompt-<tag>.md` for pointer-style drivers. */
export async function ask(drivers, installed, agent, { prompt, cwd, tag, ...opts }) {
  const driver = drivers[agent.kind];
  const dir = join(cwd, ".argue");
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, `prompt-${tag}.md`);
  writeFileSync(promptFile, prompt);
  try {
    return await driver.ask({ bin: installed[agent.kind], model: agent.model, effort: agent.effort, prompt, promptFile, cwd, ...opts });
  } catch (err) {
    return { ok: false, text: "", costUsd: 0, tokens: 0, error: err.message };
  }
}
