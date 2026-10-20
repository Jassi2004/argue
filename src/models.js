import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DRIVERS, ask, defaultLineup, detect, parseAgents, registry } from "./agents.js";
import { loadConfig, userConfigPath, writeConfig } from "./config.js";
import { run } from "./exec.js";

/**
 * What model and effort each harness will use, and whether a chosen model/effort exists.
 *
 * Defaults are read from each harness's own config files (instant, no API calls). When a harness
 * leaves it to the account (nothing configured), we say so instead of guessing.
 */

export const HARNESS = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor", opencode: "OpenCode", pi: "Pi" };

/** Effort levels each harness accepts. Harnesses not listed have no effort setting. */
export const EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};
export const supportsEffort = (kind) => Boolean(EFFORTS[kind]);

const harnessName = (agent, drivers) => HARNESS[agent.kind] ?? drivers?.[agent.kind]?.title ?? agent.kind;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Top-level `key = "value"` pairs of a TOML file (everything before the first [table]). */
function tomlTop(path) {
  const out = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function claudeManagedSettings() {
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** First source that sets a value: [[label, value], …] -> { value, source }. */
function first(sources) {
  for (const [source, value] of sources) if (value != null && value !== "") return { value: String(value), source };
  return { value: null, source: null };
}

/**
 * The model and effort a harness uses when argue doesn't pass any.
 * Returns { model, modelSource, effort, effortSource }; null values mean "the harness/account decides".
 */
export function harnessDefaults(kind, { cwd, home = homedir(), env = process.env } = {}) {
  const project = (...p) => (cwd ? readJson(join(cwd, ...p)) : null);
  switch (kind) {
    case "claude": {
      // Claude Code precedence: ANTHROPIC_MODEL > managed > project local > project > user > ANTHROPIC_DEFAULT_MODEL.
      const files = [
        ["managed settings", readJson(claudeManagedSettings())],
        [".claude/settings.local.json", project(".claude", "settings.local.json")],
        [".claude/settings.json", project(".claude", "settings.json")],
        ["~/.claude/settings.json", readJson(join(home, ".claude", "settings.json"))],
      ];
      const model = first([
        ["ANTHROPIC_MODEL", env.ANTHROPIC_MODEL],
        ...files.map(([l, j]) => [l, j?.model]),
        ["ANTHROPIC_DEFAULT_MODEL", env.ANTHROPIC_DEFAULT_MODEL],
      ]);
      const effort = first([["CLAUDE_CODE_EFFORT_LEVEL", env.CLAUDE_CODE_EFFORT_LEVEL], ...files.map(([l, j]) => [l, j?.effortLevel])]);
      return { model: model.value, modelSource: model.source, effort: effort.value, effortSource: effort.source };
    }
    case "codex": {
      const file = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
      const top = tomlTop(file);
      return {
        model: top.model ?? null,
        modelSource: top.model ? "~/.codex/config.toml" : null,
        effort: top.model_reasoning_effort ?? null,
        effortSource: top.model_reasoning_effort ? "~/.codex/config.toml" : null,
      };
    }
    case "pi": {
      const s = { ...(readJson(join(home, ".pi", "agent", "settings.json")) ?? {}), ...(project(".pi", "settings.json") ?? {}) };
      const model = s.defaultModel ? (s.defaultProvider ? `${s.defaultProvider}/${s.defaultModel}` : s.defaultModel) : null;
      return {
        model,
        modelSource: model ? "~/.pi/agent/settings.json" : null,
        effort: s.defaultThinkingLevel ?? "medium",
        effortSource: s.defaultThinkingLevel ? "~/.pi/agent/settings.json" : "Pi default",
      };
    }
    case "gemini": {
      const s = readJson(join(home, ".gemini", "settings.json"));
      const model = first([
        ["GEMINI_MODEL", env.GEMINI_MODEL],
        ["~/.gemini/settings.json", typeof s?.model === "string" ? s.model : s?.model?.name],
      ]);
      return { model: model.value, modelSource: model.source, effort: null, effortSource: null };
    }
    case "cursor": {
      const s = readJson(join(home, ".cursor", "cli-config.json"));
      const m = s?.model;
      const value = typeof m === "string" ? m : (m?.modelId ?? m?.name ?? null);
      return { model: value, modelSource: value ? "~/.cursor/cli-config.json" : null, effort: null, effortSource: null };
    }
    case "opencode": {
      const cfg = env.XDG_CONFIG_HOME || join(home, ".config");
      const model = first([
        ["opencode.json", project("opencode.json")?.model],
        ["~/.config/opencode/opencode.json", readJson(join(cfg, "opencode", "opencode.json"))?.model],
      ]);
      return { model: model.value, modelSource: model.source, effort: null, effortSource: null };
    }
    default:
      return { model: null, modelSource: "custom command", effort: null, effortSource: null };
  }
}

/** What an agent in a lineup will actually run with. */
export function describe(agent, { drivers, cwd, home, env } = {}) {
  const d = harnessDefaults(agent.kind, { cwd, home, env });
  return {
    spec: agent.name,
    kind: agent.kind,
    harness: harnessName(agent, drivers),
    model: agent.model ?? d.model,
    modelSource: agent.model ? "chosen" : (d.modelSource ?? "account default"),
    effort: supportsEffort(agent.kind) ? (agent.effort ?? d.effort) : null,
    effortSource: agent.effort ? "chosen" : d.effortSource,
    effortSupported: supportsEffort(agent.kind),
  };
}

/** "Codex · gpt-6.1-sol · effort high" */
export function label(desc) {
  const model = desc.model ?? "default model";
  const effort = desc.effortSupported ? `effort ${desc.effort ?? "default"}` : "effort n/a";
  return `${desc.harness} · ${model} · ${effort}`;
}

/** The note a host agent shows the user when a run starts (judge deliberately left out). */
export function lineupNote(descs) {
  const parts = descs.map((d) => `${d.harness} (${d.model ?? "default model"}${d.effortSupported ? `, effort ${d.effort ?? "default"}` : ""})`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `argue mode will argue between ${list}. To add another harness, change a model, or raise or lower effort, just say so.`;
}

/**
 * The lineup as a markdown card for host agents to show at the very start of an argue session.
 * Rendered by Claude Code, Codex, Pi, OpenCode, Cursor and Gemini as a small table.
 */
export function lineupCard(descs) {
  const rows = descs.map(
    (d, i) => `| ${String.fromCharCode(65 + i)} | ${d.harness} | ${d.model ?? "default model"} | ${d.effortSupported ? (d.effort ?? "default") : "n/a"} |`,
  );
  return [
    "**⚔️ argue lineup**",
    "",
    "| | Harness | Model | Effort |",
    "|---|---|---|---|",
    ...rows,
    "",
    "_Want another harness, a different model, or more or less effort? Just say so._",
  ].join("\n");
}

// ---------------------------------------------------------------- validation

/** Models a harness can list without spending anything, or null if it has no list command. */
export async function listModels(kind, bin) {
  const lines = async (cmd, args) => {
    const r = await run(cmd, args, { timeoutMs: 30_000 });
    return r.code === 0
      ? r.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      : null;
  };
  try {
    switch (kind) {
      case "codex": {
        const r = await run("codex", ["debug", "models"], { timeoutMs: 30_000 });
        if (r.code !== 0) return null;
        const models = JSON.parse(r.stdout).models ?? [];
        return models.map((m) => ({ id: m.slug, efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort) }));
      }
      case "pi": {
        const out = await lines("pi", ["--list-models"]);
        return out?.slice(1).map((l) => {
          const [provider, model] = l.split(/\s+/);
          return { id: `${provider}/${model}`, alias: model };
        });
      }
      case "opencode": {
        const out = await lines("opencode", ["models"]);
        return out?.filter((l) => /^\S+\/\S+$/.test(l)).map((id) => ({ id }));
      }
      case "cursor": {
        const out = await lines(bin || "cursor-agent", ["models"]);
        const ids = out?.flatMap((l) => l.match(/^[-*•]?\s*([A-Za-z0-9][\w.:/-]+)/)?.[1] ?? []).filter((id) => /\d|-/.test(id));
        return ids?.length ? ids.map((id) => ({ id })) : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Check that an agent's model and effort are usable before saving them as the default.
 * Uses the harness's model list when it has one; otherwise makes one tiny test call.
 * Returns { ok, error?, checked: "list" | "call" | "none", costUsd }.
 */
export async function checkAgent(agent, { drivers = DRIVERS, installed }) {
  const name = harnessName(agent, drivers);
  if (!installed[agent.kind]) return { ok: false, error: `${name} is not installed`, checked: "none", costUsd: 0 };
  if (agent.effort && !supportsEffort(agent.kind))
    return { ok: false, error: `${name} has no effort setting; remove "@${agent.effort}"`, checked: "none", costUsd: 0 };
  if (agent.effort && !EFFORTS[agent.kind].includes(agent.effort))
    return { ok: false, error: `${name} effort must be one of: ${EFFORTS[agent.kind].join(", ")}`, checked: "none", costUsd: 0 };
  if (!agent.model && !agent.effort) return { ok: true, checked: "none", costUsd: 0 };

  const list = agent.model ? await listModels(agent.kind, installed[agent.kind]) : null;
  if (list) {
    const hit = list.find((m) => m.id === agent.model || m.alias === agent.model);
    if (!hit) {
      const needle = agent.model.toLowerCase();
      const close = list.filter((m) => m.id.toLowerCase().includes(needle) || needle.includes((m.alias ?? m.id).toLowerCase())).slice(0, 5);
      const hint = close.length ? ` Did you mean: ${close.map((m) => m.id).join(", ")}?` : "";
      return { ok: false, error: `${name} has no model "${agent.model}".${hint}`, checked: "list", costUsd: 0 };
    }
    if (agent.effort && hit.efforts?.length && !hit.efforts.includes(agent.effort))
      return { ok: false, error: `${agent.model} supports effort: ${hit.efforts.join(", ")}`, checked: "list", costUsd: 0 };
    return { ok: true, checked: "list", costUsd: 0 };
  }

  // No list available (Claude Code, Gemini, or the list command failed): one tiny call with that model.
  const dir = mkdtempSync(join(tmpdir(), "argue-check-"));
  try {
    const res = await ask(drivers, installed, agent, { prompt: "Reply with exactly: OK", cwd: dir, tag: "check", write: false, timeoutMs: 120_000 });
    if (res.ok) return { ok: true, checked: "call", costUsd: res.costUsd ?? 0 };
    return { ok: false, error: `${name} could not use ${agent.model ?? "that setting"}: ${res.error}`, checked: "call", costUsd: res.costUsd ?? 0 };
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the user's default lineup

/**
 * Show, set (after checking every model/effort is available) or reset the user's default lineup.
 * Used by `argue lineup` and the argue_lineup MCP tool.
 *   { agents?: "claude:opus,codex@high", reset?: true }
 * -> { lineup, source, note } | { saved: false, errors }
 */
export async function manageLineup(root, { agents: spec, reset } = {}) {
  const config = loadConfig(root);
  const drivers = registry(config);
  const installed = await detect(drivers);
  const path = userConfigPath();
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const view = (agents, source, extra = {}) => {
    const lineup = agents.map((a) => describe(a, { drivers, cwd: root }));
    return { ...extra, lineup, source, note: lineup.length ? lineupNote(lineup) : null, display: lineup.length ? lineupCard(lineup) : null };
  };
  const automatic = () => parseAgents(defaultLineup(Object.keys(installed)) || [], drivers);

  if (reset) {
    delete saved.agents;
    writeConfig(path, saved);
    return view(automatic(), "automatic", { reset: true });
  }
  if (!spec) {
    if (config.agents) return view(parseAgents(config.agents, drivers), "saved");
    const auto = automatic();
    if (!auto.length) throw new Error("no agent CLIs found; run argue doctor");
    return view(auto, "automatic");
  }

  const agents = parseAgents(spec, drivers);
  if (agents.length < 2) throw new Error(`a lineup needs at least two agents (to pit one against itself: ${agents[0].kind},${agents[0].kind})`);
  if (agents.length > 8) throw new Error("at most 8 agents");
  const results = await Promise.all(agents.map((a) => checkAgent(a, { drivers, installed })));
  const errors = results.map((r, i) => (r.ok ? null : { agent: agents[i].name, error: r.error })).filter(Boolean);
  if (errors.length) return { saved: false, errors };
  saved.agents = agents.map((a) => a.name).join(",");
  writeConfig(path, saved);
  return view(agents, "saved", { saved: true, overriddenByProject: loadConfig(root).agents !== saved.agents });
}
