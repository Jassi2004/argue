# Published release verification

GitHub remains the source repository. Its existing CI checks pull requests. The independent [GitLab project](https://gitlab.com/bedijaskirat2004/argue-release-checks) checks the package users actually install from npm.

## Automatic flow

1. A push to `main` starts `release`.
2. If the package version already exists on npm, publication and verification are skipped.
3. After `npm publish` succeeds, GitHub triggers GitLab with the exact version and full source SHA.
4. GitLab schedules its three jobs with `when: delayed` and `start_in: 10 minutes`.
5. GitLab matches npm's `gitHead` to that SHA, installs the exact published version, and checks Node 20, 22 and 24.
6. Each job checks version/help/doctor, runs a deterministic room using scripted agents, checks records and worktree cleanup, and applies/tests the winning patch in a disposable repository.

These checks do not invoke real models or require model API keys. Reports and room records are GitLab job artifacts retained for 30 days. GitHub shows a separate `gitlab/release-verification` commit status, whose Details link opens the GitLab pipeline. It remains pending during the delay and execution, becomes success only after GitLab succeeds, and becomes failure/error if GitLab fails, is cancelled/skipped, or cannot be monitored. The release workflow also has a separate **GitLab release verification** job that waits for this actual outcome. Verification runs after publication and cannot prevent or undo an npm release.

## Status reporting

The status belongs to the exact released source commit, not every subsequent commit or an open PR. GitHub polls the public GitLab pipeline every 30 seconds, with a 25-minute limit. Transient read failures are retried; repeated failures or an expired deadline report an error instead of success. Cancelling the watcher marks the status interrupted and links to GitLab, where the pipeline may still be running.

The watcher uses the built-in GitHub Actions token with `statuses: write`. That token is sent only to GitHub. No new personal token, GitLab read token or GitHub App is required for this public verification project. GitHub maintains a runner while waiting; GitLab holds its delayed jobs without starting a runner. Publication concurrency covers the publishing job, so waiting for GitLab does not block publication of the next release.

Registry metadata is requested fresh. After the delay, unavailable versions are retried 11 times at 30-second intervals, with a timeout on each request.

## Retry an existing release

Open [verify-release](https://github.com/Jassi2004/argue/actions/workflows/verify-release.yml), choose **Run workflow**, and provide the exact version and full source commit. Obtain that commit using `npm view argue-ai@VERSION gitHead`. This rechecks the published artifact without publishing or bumping a version.

Alternatively use [GitLab's new pipeline page](https://gitlab.com/bedijaskirat2004/argue-release-checks/-/pipelines/new) and set `ARGUE_VERSION` and `ARGUE_SOURCE_SHA`. Defaults describe the initial verified release; override both for another version. A pipeline started directly in the GitLab UI is not watched by GitHub; use the GitHub manual workflow when you also want the commit status updated.

## Maintainer configuration

GitHub Actions repository settings contain:

- Secret `GITLAB_TRIGGER_TOKEN`: pipeline trigger token scoped to the verification project. Never use a personal access token here.
- Variable `GITLAB_VERIFICATION_PROJECT_ID`: `87943783`.

The GitLab project restricts pipeline variable overrides to Maintainers; the trigger belongs to the project owner so it can pass the version and source SHA.

To rotate access, create a replacement token in the GitLab project's **Settings → CI/CD → Pipeline trigger tokens**, replace the GitHub secret, test a manual run, and revoke the old token. The trigger token is sent only to GitLab's fixed API endpoint and is never printed by the trigger script.

This integration is independent of MAYA. It has a per-release delay, not a recurring schedule.
