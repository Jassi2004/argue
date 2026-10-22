import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function triggerVerification(env = process.env, request = fetch) {
  const { ARGUE_VERSION: version, ARGUE_SOURCE_SHA: sha, GITLAB_TRIGGER_TOKEN: token, GITLAB_VERIFICATION_PROJECT_ID: project } = env;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("An exact ARGUE_VERSION is required.");
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full ARGUE_SOURCE_SHA is required.");
  if (!token || !/^\d+$/.test(project ?? "")) throw new Error("GitLab verification credentials are missing.");
  let response;
  try {
    response = await request(`https://gitlab.com/api/v4/projects/${project}/trigger/pipeline`, {
      method: "POST",
      body: new URLSearchParams({ token, ref: "main", "variables[ARGUE_VERSION]": version, "variables[ARGUE_SOURCE_SHA]": sha }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch {
    throw new Error("GitLab verification request failed; retry using the verify-release workflow.");
  }
  if (!response.ok) throw new Error(`GitLab verification rejected the request (HTTP ${response.status}).`);
  const { id } = await response.json();
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("GitLab returned an invalid pipeline ID.");
  return `https://gitlab.com/bedijaskirat2004/argue-release-checks/-/pipelines/${id}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const url = await triggerVerification();
    console.log(`Published package verification: ${url}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pipeline_id=${url.split("/").pop()}\npipeline_url=${url}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nPublished package verification: [GitLab pipeline](${url})\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
