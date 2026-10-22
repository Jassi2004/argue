import assert from "node:assert/strict";
import { test } from "node:test";
import { triggerVerification } from "../scripts/trigger-release-verification.mjs";

const env = { ARGUE_VERSION: "0.3.1", ARGUE_SOURCE_SHA: "a".repeat(40), GITLAB_TRIGGER_TOKEN: "secret-test-value", GITLAB_VERIFICATION_PROJECT_ID: "87943783" };

test("release verification sends the exact published version and source commit", async () => {
  const url = await triggerVerification(env, async (endpoint, options) => {
    assert.equal(endpoint, "https://gitlab.com/api/v4/projects/87943783/trigger/pipeline");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.body.get("variables[ARGUE_VERSION]"), env.ARGUE_VERSION);
    assert.equal(options.body.get("variables[ARGUE_SOURCE_SHA]"), env.ARGUE_SOURCE_SHA);
    assert.equal(options.body.get("token"), env.GITLAB_TRIGGER_TOKEN);
    assert.equal(options.body.get("ref"), "main");
    return { ok: true, json: async () => ({ id: 123 }) };
  });
  assert.match(url, /\/pipelines\/123$/);
});

test("invalid or missing release inputs never send credentials", async () => {
  for (const overrides of [
    { ARGUE_VERSION: "latest" },
    { ARGUE_SOURCE_SHA: "main" },
    { GITLAB_TRIGGER_TOKEN: "" },
    { GITLAB_VERIFICATION_PROJECT_ID: "../other" },
  ]) {
    await assert.rejects(triggerVerification({ ...env, ...overrides }, () => assert.fail("must not request")));
  }
});

test("transport and rejection errors do not reveal credentials or response bodies", async () => {
  await assert.rejects(
    triggerVerification(env, async () => {
      throw new Error(env.GITLAB_TRIGGER_TOKEN);
    }),
    { message: "GitLab verification request failed; retry using the verify-release workflow." },
  );
  await assert.rejects(
    triggerVerification(env, async () => ({ ok: false, status: 403, text: async () => env.GITLAB_TRIGGER_TOKEN })),
    { message: "GitLab verification rejected the request (HTTP 403)." },
  );
});

const watchEnv = {
  ARGUE_SOURCE_SHA: "b".repeat(40),
  GITLAB_PIPELINE_ID: "123",
  GITLAB_VERIFICATION_PROJECT_ID: "87943783",
  GITHUB_TOKEN: "github-test-secret",
};

async function simulate(states, options = {}) {
  const { watchVerification } = await import("../scripts/watch-release-verification.mjs");
  const reported = [];
  let time = 0;
  const result = watchVerification(watchEnv, {
    now: () => time,
    sleep: async () => {
      time += 1000;
    },
    timeoutMs: 5000,
    request: async (url, request = {}) => {
      if (url.startsWith("https://api.github.com/")) {
        assert.equal(request.headers.Authorization, `Bearer ${watchEnv.GITHUB_TOKEN}`);
        assert.ok(url.endsWith(`/statuses/${watchEnv.ARGUE_SOURCE_SHA}`));
        reported.push(JSON.parse(request.body));
        return { ok: true };
      }
      assert.equal(url, "https://gitlab.com/api/v4/projects/87943783/pipelines/123");
      assert.equal(request.headers, undefined, "GitHub credentials never go to GitLab");
      const state = states.length > 1 ? states.shift() : states[0];
      if (state instanceof Error) throw state;
      return { ok: true, json: async () => ({ id: 123, status: state }) };
    },
    ...options,
  });
  return { result, reported };
}

test("external GitLab status remains pending through the delay and succeeds only after GitLab", async () => {
  const { result, reported } = await simulate(["scheduled", "pending", "running", "success"]);
  assert.match(await result, /pipelines\/123$/);
  assert.deepEqual(
    reported.map((s) => s.state),
    ["pending", "pending", "pending", "pending", "success"],
  );
  assert.ok(reported.every((s) => s.context === "gitlab/release-verification" && s.target_url.endsWith("/pipelines/123")));
});

test("failed, cancelled and skipped GitLab pipelines never give GitHub a green status", async () => {
  for (const state of ["failed", "canceled", "skipped"]) {
    const { result, reported } = await simulate([state]);
    await assert.rejects(result, new RegExp(`pipeline ${state}`));
    assert.equal(reported.at(-1).state, state === "failed" ? "failure" : "error");
    assert.ok(!reported.some((s) => s.state === "success"));
  }
});

test("network interruptions recover, while persistent errors and timeouts finish with an error status", async () => {
  const recovered = await simulate([new Error("network"), "success"]);
  await recovered.result;
  assert.equal(recovered.reported.at(-1).state, "success");
  for (const states of [[new Error("network")], ["running"], ["unknown"]]) {
    const { result, reported } = await simulate(states);
    await assert.rejects(result);
    assert.equal(reported.at(-1).state, "error");
  }
});

test("workflow cancellation explicitly clears the pending external status", async () => {
  const { cancelVerification } = await import("../scripts/watch-release-verification.mjs");
  await cancelVerification(watchEnv, async (url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.state, "error");
    assert.equal(body.context, "gitlab/release-verification");
    return { ok: true };
  });
});

test("watcher validates the commit, project and credentials before making requests", async () => {
  const { watchVerification } = await import("../scripts/watch-release-verification.mjs");
  for (const overrides of [{ ARGUE_SOURCE_SHA: "main" }, { GITLAB_PIPELINE_ID: "../other" }, { GITLAB_VERIFICATION_PROJECT_ID: "456" }, { GITHUB_TOKEN: "" }]) {
    await assert.rejects(watchVerification({ ...watchEnv, ...overrides }, { request: () => assert.fail("must not request") }));
  }
});
