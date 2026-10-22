import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const artifactDir = mkdtempSync(join(tmpdir(), "argue-package-audit-"));

try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", artifactDir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const [packed] = JSON.parse(packOutput);
  const archivePath = join(artifactDir, packed.filename);
  const paths = packed.files.map(({ path }) => path);
  const pathSet = new Set(paths);
  const requiredPaths = ["package.json", "README.md", "LICENSE", "bin/argue.js", "instructions/turn.md", "skills/argue/SKILL.md"];
  const allowedPaths = ["package.json", "README.md", "LICENSE"];
  const allowedDirectories = ["bin/", "src/", "skills/", "instructions/"];
  const errors = [];

  for (const path of requiredPaths) {
    if (!pathSet.has(path)) errors.push(`npm archive is missing required file: ${path}`);
  }

  for (const path of paths) {
    if (!allowedPaths.includes(path) && !allowedDirectories.some((directory) => path.startsWith(directory))) {
      errors.push(`unexpected file in the public npm archive: ${path}`);
    }
  }

  const packedManifest = JSON.parse(execFileSync("tar", ["-xOzf", archivePath, "package/package.json"], { encoding: "utf8" }));

  if (packedManifest.name !== "argue-ai") errors.push(`unexpected package name: ${packedManifest.name}`);
  if (packedManifest.version !== sourceManifest.version) {
    errors.push(`archive version ${packedManifest.version} differs from source version ${sourceManifest.version}`);
  }
  if (packedManifest.bin?.argue !== "bin/argue.js") errors.push("argue CLI entry point is missing or incorrect");
  if (packedManifest.engines?.node !== ">=20") errors.push("Node.js engine requirement must remain >=20");
  if (packedManifest.private) errors.push("package is marked private and cannot be published");
  if (Object.keys(packedManifest.dependencies ?? {}).length > 0) {
    errors.push("runtime dependencies were added; review the zero-runtime-dependency policy");
  }

  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Audited argue-ai@${packedManifest.version}: manifest and packaged files are release-ready.`);
  }
} finally {
  rmSync(artifactDir, { force: true, recursive: true });
}
