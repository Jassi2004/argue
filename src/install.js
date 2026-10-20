import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { onPath } from "./config.js";
import { writeAtomic } from "./fsx.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, which } from "./exec.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = readFileSync(join(ROOT, "skills", "argue", "SKILL.md"), "utf8");

/**
 * Command used by hosts to launch the MCP server.
 * GUI apps (Cursor, Claude Desktop…) don't inherit the shell PATH, so use absolute paths and
 * record the current PATH so the server can find git and the agent CLIs.
 */
async function mcpCommand() {
  const env = { PATH: process.env.PATH ?? "" };
  // Running from an npx cache (temporary): register npx so it always resolves.
  if (/[\\/]_npx[\\/]/.test(ROOT)) return { command: (await which("npx")) ?? "npx", args: ["-y", "argue-ai", "mcp"], env };
  return { command: process.execPath, args: [realpathSync(join(ROOT, "bin", "argue.js")), "mcp"], env };
}

const SLASH_PROMPT = `Use the argue skill to run this task through multiple competing AI agents: $ARGS

If the request above is empty, ask what to argue about. Otherwise follow the argue skill exactly.`;

/**
 * Every integration target. Each knows how to detect, install and uninstall itself.
 * `home` is injectable for tests.
 */
export function targets(home = homedir()) {
  const cfg = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const skillDirs = {
    agents: join(home, ".agents", "skills", "argue"), // Codex, Pi, OpenCode, Cursor, Gemini (Agent Skills standard)
    claude: join(home, ".claude", "skills", "argue"), // Claude Code, OpenCode
    cursor: join(home, ".cursor", "skills", "argue"),
    gemini: join(home, ".gemini", "skills", "argue"),
  };
  return [
    {
      id: "skill",
      title: "Agent skill (Claude Code, Codex, Cursor, Gemini, OpenCode, Pi…)",
      present: () => true,
      install: () => {
        const done = [];
        for (const [key, dir] of Object.entries(skillDirs)) {
          if (key === "cursor" && !existsSync(join(home, ".cursor"))) continue;
          if (key === "gemini" && !onPath("gemini")) continue;
          if (key === "claude" && !existsSync(join(home, ".claude"))) continue;
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "SKILL.md"), SKILL);
          done.push(dir);
        }
        return done;
      },
      uninstall: () =>
        Object.values(skillDirs)
          .filter((d) => existsSync(d))
          .map((d) => (rmSync(d, { recursive: true, force: true }), d)),
    },
    {
      id: "claude",
      title: "Claude Code MCP server",
      present: () => onPath("claude") || existsSync(join(home, ".claude.json")),
      install: async () => {
        const { command, args, env } = await mcpCommand();
        if (!(await which("claude")))
          return mergeJson(join(home, ".claude.json"), (j) => ((j.mcpServers ??= {}).argue = { type: "stdio", command, args, env }));
        await run("claude", ["mcp", "remove", "-s", "user", "argue"], { env: { HOME: home } });
        const res = await run("claude", ["mcp", "add", "-s", "user", "argue", "-e", `PATH=${env.PATH}`, "--", command, ...args], { env: { HOME: home } });
        if (res.code !== 0) throw new Error(res.stderr.trim() || "claude mcp add failed");
        return ["claude mcp (user scope)"];
      },
      uninstall: async () => {
        if (await which("claude")) {
          const res = await run("claude", ["mcp", "remove", "-s", "user", "argue"], { env: { HOME: home } });
          return res.code === 0 ? ["claude mcp"] : [];
        }
        return removeKey(join(home, ".claude.json"), ["mcpServers", "argue"]);
      },
    },
    {
      id: "codex",
      title: "Codex MCP server",
      present: () => onPath("codex") || existsSync(join(home, ".codex", "config.toml")),
      install: async () => {
        const { command, args, env } = await mcpCommand();
        const file = join(home, ".codex", "config.toml");
        const toml = existsSync(file) ? readFileSync(file, "utf8") : "";
        const block = `[mcp_servers.argue]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 120\ndefault_tools_approval_mode = "writes"\n\n[mcp_servers.argue.tools.argue_start]\napproval_mode = "approve"\n\n[mcp_servers.argue.tools.argue_cancel]\napproval_mode = "approve"\n\n[mcp_servers.argue.tools.argue_lineup]\napproval_mode = "approve"\n\n[mcp_servers.argue.env]\nPATH = ${JSON.stringify(env.PATH)}\n`;
        writeAtomic(file, `${stripTomlTable(toml, "mcp_servers.argue").trimEnd()}\n\n${block}`.replace(/^\n+/, ""));
        return [file];
      },
      uninstall: () => {
        const file = join(home, ".codex", "config.toml");
        if (!existsSync(file)) return [];
        const toml = readFileSync(file, "utf8");
        const next = stripTomlTable(toml, "mcp_servers.argue");
        if (next === toml) return [];
        writeAtomic(file, `${next.trimEnd()}\n`);
        return [file];
      },
    },
    {
      id: "cursor",
      title: "Cursor MCP server",
      present: () => existsSync(join(home, ".cursor")),
      install: async () => {
        const { command, args, env } = await mcpCommand();
        return mergeJson(join(home, ".cursor", "mcp.json"), (j) => ((j.mcpServers ??= {}).argue = { command, args, env }));
      },
      uninstall: () => removeKey(join(home, ".cursor", "mcp.json"), ["mcpServers", "argue"]),
    },
    {
      id: "gemini",
      title: "Gemini CLI MCP server + /argue command",
      present: () => onPath("gemini"),
      install: async () => {
        const { command, args, env } = await mcpCommand();
        const files = mergeJson(
          join(home, ".gemini", "settings.json"),
          (j) => ((j.mcpServers ??= {}).argue = { command, args, env, timeout: 600000, trust: false }),
        );
        const cmd = join(home, ".gemini", "commands", "argue.toml");
        mkdirSync(dirname(cmd), { recursive: true });
        writeFileSync(
          cmd,
          `description = "Run a task through multiple competing AI agents (argue)"\nprompt = """\n${SLASH_PROMPT.replace("$ARGS", "{{args}}")}\n"""\n`,
        );
        return [...files, cmd];
      },
      uninstall: () => {
        return [...removeFile(join(home, ".gemini", "commands", "argue.toml")), ...removeKey(join(home, ".gemini", "settings.json"), ["mcpServers", "argue"])];
      },
    },
    {
      id: "opencode",
      title: "OpenCode MCP server + /argue command",
      present: () => onPath("opencode"),
      install: async () => {
        const { command, args, env } = await mcpCommand();
        const files = mergeJson(
          join(cfg, "opencode", "opencode.json"),
          (j) => ((j.mcp ??= {}).argue = { type: "local", command: [command, ...args], environment: env, enabled: true }),
        );
        const cmd = join(cfg, "opencode", "commands", "argue.md");
        mkdirSync(dirname(cmd), { recursive: true });
        writeFileSync(cmd, `---\ndescription: Run a task through multiple competing AI agents (argue)\n---\n${SLASH_PROMPT.replace("$ARGS", "$ARGUMENTS")}\n`);
        return [...files, cmd];
      },
      uninstall: () => {
        return [...removeFile(join(cfg, "opencode", "commands", "argue.md")), ...removeKey(join(cfg, "opencode", "opencode.json"), ["mcp", "argue"])];
      },
    },
    {
      id: "pi",
      title: "Pi /argue prompt",
      present: () => onPath("pi") || existsSync(join(home, ".pi", "agent")),
      install: () => {
        const file = join(home, ".pi", "agent", "prompts", "argue.md");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `---\ndescription: Run a task through multiple competing AI agents (argue)\n---\n${SLASH_PROMPT.replace("$ARGS", "$@")}\n`);
        return [file];
      },
      uninstall: () => removeFile(join(home, ".pi", "agent", "prompts", "argue.md")),
    },
  ];
}

/**
 * Read-modify-write a JSON config file. Creates it if missing (unless `removing`).
 * Refuses to touch files it cannot parse. Only writes when something changed.
 */
export function mergeJson(file, mutate, { removing = false } = {}) {
  if (removing && !existsSync(file)) return [];
  let data = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    if (raw.trim()) {
      try {
        data = JSON.parse(raw);
      } catch {
        try {
          data = JSON.parse(stripJsonComments(raw));
        } catch {
          throw new Error(`${file} is not valid JSON; add argue manually`);
        }
      }
    }
  }
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) return removing ? [] : [file];
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  return [file];
}

/** Remove one key (e.g. ["mcpServers", "argue"]); drops containers argue left empty and files that end up empty. */
const removeKey = (file, path) => {
  const files = mergeJson(
    file,
    (j) => {
      const parent = path.slice(0, -1).reduce((o, k) => o?.[k], j);
      if (!parent || typeof parent !== "object" || !(path.at(-1) in parent)) return;
      delete parent[path.at(-1)];
      if (path.length > 1 && !Object.keys(parent).length) delete j[path[0]];
    },
    { removing: true },
  );
  if (files.length && existsSync(file) && readFileSync(file, "utf8").trim() === "{}") rmSync(file, { force: true });
  return files;
};

function removeFile(file) {
  if (!existsSync(file)) return [];
  rmSync(file, { force: true });
  return [file];
}

function stripJsonComments(s) {
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1");
}

/** Remove a [table] (and its nested [table.x] sub-tables) from TOML text. */
export function stripTomlTable(toml, name) {
  const lines = toml.split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*(#.*)?$/);
    if (header) {
      const key = header[1].replace(/\s*\.\s*/g, ".").replace(/"([^"]*)"/g, "$1");
      skipping = key === name || key.startsWith(`${name}.`);
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

export async function install({ only, home, uninstall: remove = false } = {}) {
  const results = [];
  for (const t of targets(home)) {
    if (only && !only.includes(t.id)) continue;
    if (!only && !t.present()) {
      results.push({ id: t.id, title: t.title, status: "skipped", detail: "not installed" });
      continue;
    }
    try {
      const files = await (remove ? t.uninstall() : t.install());
      if (remove && !files.length) results.push({ id: t.id, title: t.title, status: "skipped", detail: "not installed" });
      else results.push({ id: t.id, title: t.title, status: remove ? "removed" : "installed", detail: files.join(", ") });
    } catch (err) {
      results.push({ id: t.id, title: t.title, status: "error", detail: err.message });
    }
  }
  return results;
}
