import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * Settings come from (later wins):
 *   built-in defaults < ~/.config/argue/config.json < <project>/.argue.json < CLI flags
 */
export const DEFAULTS = {
  agents: null, // null = auto from installed CLIs
  judge: null, // who writes the final answer; null = auto (prefers a CLI that is not in the room)
  check: "auto", // "auto" = detect from the project, "none" = no check
  rounds: 4, // most discussion rounds after the opening (rooms usually settle sooner)
  budget: null, // USD; only enforced for CLIs that report cost
  timeout: 20, // minutes per agent turn
  minutes: 60, // a run starts no new round after this many minutes
  mode: "auto", // "auto" = guess from the task; "code" = agents change files; "answer" = agents argue out an answer
  mcp: [], // MCP servers agents may use, by name (from each CLI's own config); none by default
  custom: {}, // custom agents: { name: { command, readCommand?, title? } }
};

export function userConfigPath() {
  const base =
    process.env.XDG_CONFIG_HOME || (process.platform === "win32" ? process.env.APPDATA || join(homedir(), "AppData", "Roaming") : join(homedir(), ".config"));
  return join(base, "argue", "config.json");
}

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${err.message}`);
  }
}

const KNOWN = new Set([...Object.keys(DEFAULTS), "$schema"]);

/** Load settings for a project. `projectDir` should be the repo root (or the folder for non-git projects). */
export function loadConfig(projectDir) {
  const userPath = userConfigPath();
  const user = readJson(userPath);
  const projectPath = projectDir ? join(projectDir, ".argue.json") : null;
  const project = projectPath ? readJson(projectPath) : {};
  for (const [path, cfg] of [
    [userPath, user],
    [projectPath, project],
  ]) {
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) throw new Error(`${path} must contain a JSON object`);
    const unknown = Object.keys(cfg).filter((k) => !KNOWN.has(k));
    if (unknown.length) throw new Error(`${path}: unknown setting(s) ${unknown.join(", ")} (valid: ${[...KNOWN].filter((k) => k !== "$schema").join(", ")})`);
    for (const [name, def] of Object.entries(cfg.custom ?? {}))
      if (!def || typeof def.command !== "string") throw new Error(`${path}: custom agent "${name}" needs a "command" string`);
    if (cfg.mcp !== undefined && !(Array.isArray(cfg.mcp) && cfg.mcp.every((s) => typeof s === "string")))
      throw new Error(`${path}: "mcp" must be a list of MCP server names, e.g. ["github", "postgres"]`);
  }
  return { ...DEFAULTS, ...user, ...project, custom: { ...(user.custom ?? {}), ...(project.custom ?? {}) } };
}

export function writeConfig(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Best-guess acceptance command for a project, or null. */
export function detectCheck(dir) {
  const has = (f) => existsSync(join(dir, f));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const test = pkg.scripts?.test;
      if (test && !/no test specified/.test(test)) {
        const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
        return pm === "npm" ? "npm test --silent" : `${pm} test`;
      }
    } catch {}
  }
  if (has("Cargo.toml")) return "cargo test --quiet";
  if (has("go.mod")) return "go test ./...";
  const py = onPath("python") && !onPath("python3") ? "python" : onPath("python3") ? "python3" : "python";
  if (
    has("pytest.ini") ||
    has("conftest.py") ||
    /pytest/.test(safeRead(join(dir, "pyproject.toml")) + safeRead(join(dir, "setup.cfg")) + safeRead(join(dir, "tox.ini")))
  )
    return `${py} -m pytest -q`;
  if (has("pyproject.toml") || has("setup.py")) {
    try {
      if (readdirSync(dir).some((f) => /^test_.*\.py$|_test\.py$/.test(f)) || has("tests")) return `${py} -m pytest -q`;
    } catch {}
  }
  if (has("Makefile") && /^test:/m.test(safeRead(join(dir, "Makefile")))) return "make test";
  if (has("mix.exs")) return "mix test";
  if (has("Gemfile") && has("Rakefile")) return "bundle exec rake test";
  if (has("pom.xml")) return "mvn -q test";
  if (has("gradlew")) return "./gradlew test -q";
  return null;
}

function safeRead(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Synchronous PATH lookup (only used for cheap heuristics). */
export function onPath(bin) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    for (const ext of exts) if (dir && existsSync(join(dir, bin + ext))) return true;
  }
  return false;
}
