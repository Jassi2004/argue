# Published release verification

GitHub remains the source repository. Its existing CI checks pull requests. The independent [GitLab project](https://gitlab.com/bedijaskirat2004/argue-release-checks) checks the package users actually install from npm.

## Automatic flow

1. A push to `main` starts `release`.
2. If the package version already exists on npm, publication and verification are skipped.
3. After `npm publish` succeeds, GitHub triggers GitLab with the exact version and full source SHA.
4. GitLab matches npm's `gitHead` to that SHA, installs the exact published version, and checks Node 20, 22 and 24.
5. Each job checks version/help/doctor, runs a deterministic room using scripted agents, checks records and worktree cleanup, and applies/tests the winning patch in a disposable repository.

These checks do not invoke real models or require model API keys. Reports and room records are GitLab job artifacts retained for 30 days. The GitHub step summary links to the GitLab pipeline. A successful trigger means GitLab accepted the job; read that pipeline for the verification outcome. Verification runs after publication and cannot prevent or undo an npm release.

## Retry an existing release

Open [verify-release](https://github.com/Jassi2004/argue/actions/workflows/verify-release.yml), choose **Run workflow**, and provide the exact version and full source commit. Obtain that commit using `npm view argue-ai@VERSION gitHead`. This rechecks the published artifact without publishing or bumping a version.

Alternatively use [GitLab's new pipeline page](https://gitlab.com/bedijaskirat2004/argue-release-checks/-/pipelines/new) and set `ARGUE_VERSION` and `ARGUE_SOURCE_SHA`. Defaults describe the initial verified release; override both for another version.

## Maintainer configuration

GitHub Actions repository settings contain:

- Secret `GITLAB_TRIGGER_TOKEN`: pipeline trigger token scoped to the verification project. Never use a personal access token here.
- Variable `GITLAB_VERIFICATION_PROJECT_ID`: `87943783`.

To rotate access, create a replacement token in the GitLab project's **Settings → CI/CD → Pipeline trigger tokens**, replace the GitHub secret, test a manual run, and revoke the old token. The trigger token is sent only to GitLab's fixed API endpoint and is never printed by the trigger script.

This integration is independent of MAYA and has no scheduled runs.
