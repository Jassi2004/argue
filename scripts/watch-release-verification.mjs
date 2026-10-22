import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const CONTEXT = "gitlab/release-verification";

function configuration(env) {
  const { ARGUE_SOURCE_SHA: sha, GITLAB_PIPELINE_ID: pipeline, GITLAB_VERIFICATION_PROJECT_ID: project, GITHUB_TOKEN: token } = env;
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full ARGUE_SOURCE_SHA is required.");
  if (!/^\d+$/.test(pipeline ?? "") || project !== "87943783") throw new Error("Invalid GitLab verification pipeline.");
  if (!token) throw new Error("GitHub status permission is required.");
  return { sha, pipeline, project, token, url: `https://gitlab.com/bedijaskirat2004/argue-release-checks/-/pipelines/${pipeline}` };
}

async function report(config, state, description, request) {
  let response;
  try {
    response = await request(`https://api.github.com/repos/Jassi2004/argue/statuses/${config.sha}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ state, context: CONTEXT, description, target_url: config.url }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new Error("Could not report the GitLab result to GitHub.");
  }
  if (!response.ok) throw new Error(`GitHub status update failed (HTTP ${response.status}).`);
}

export async function cancelVerification(env = process.env, request = fetch) {
  const config = configuration(env);
  await report(config, "error", "GitHub stopped watching; open GitLab for the pipeline result.", request);
}

export async function watchVerification(
  env = process.env,
  { request = fetch, sleep = setTimeout, now = Date.now, timeoutMs = 25 * 60_000, intervalMs = 30_000 } = {},
) {
  const config = configuration(env);
  const deadline = now() + timeoutMs;
  let previous;
  let errors = 0;
  await report(config, "pending", "Scheduled on GitLab: verification starts after a 10-minute delay.", request);
  try {
    while (now() < deadline) {
      let pipeline;
      try {
        // This public endpoint needs no credential. GitHub's token never leaves api.github.com.
        const response = await request(`https://gitlab.com/api/v4/projects/${config.project}/pipelines/${config.pipeline}`, {
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Pipeline unavailable");
        pipeline = await response.json();
        if (String(pipeline.id) !== config.pipeline) throw new Error("Unexpected pipeline");
        errors = 0;
      } catch {
        if (++errors >= 5) throw new Error("GitLab could not be reached repeatedly; verification result is unknown.");
        await sleep(intervalMs);
        continue;
      }
      const state = pipeline.status;
      if (state === "success") {
        await report(config, "success", "Published package passed on Node 20, 22 and 24.", request);
        return config.url;
      }
      if (["failed", "canceled", "skipped"].includes(state)) {
        await report(config, state === "failed" ? "failure" : "error", `GitLab pipeline ${state}; open Details for logs.`, request);
        throw new Error(`GitLab pipeline ${state}: ${config.url}`);
      }
      if (!["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "manual"].includes(state))
        throw new Error("GitLab returned an unknown pipeline state.");
      if (state !== previous) {
        await report(
          config,
          "pending",
          state === "running" ? "GitLab is verifying the published package." : `GitLab pipeline ${state}; waiting for verification.`,
          request,
        );
        previous = state;
      }
      await sleep(intervalMs);
    }
    throw new Error("Timed out waiting for GitLab; open Details for the pipeline result.");
  } catch (error) {
    if (!/^GitLab pipeline (failed|canceled|skipped):/.test(error.message))
      await report(config, "error", "Verification could not finish; open Details for the pipeline.", request);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes("--cancel")) await cancelVerification();
    else {
      const url = await watchVerification();
      console.log(`GitLab verification passed: ${url}`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nGitLab verification **passed**: [pipeline](${url})\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
