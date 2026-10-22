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
