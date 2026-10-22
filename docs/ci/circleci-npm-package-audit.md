# CircleCI npm package audit

CircleCI checks the npm archive built from each push to `main`. It starts immediately; there is no release delay or npm registry polling.

## What it checks

The `npm-package-content-audit` workflow runs `scripts/audit-npm-package.mjs`, which:

1. Builds the release archive with `npm pack`.
2. Requires the public README, license, CLI entry point, skill, and agent instructions.
3. Rejects files outside the intended npm package directories.
4. Checks the packed manifest's name, version, CLI entry point, Node.js requirement, and zero-runtime-dependency policy.

GitHub Actions remains responsible for the full test suite and CLI smoke tests. This CircleCI audit checks release packaging policy on `main`, so it adds a separate GitHub status check without repeating the existing test matrix or running on feature branches.

Native CircleCI configuration belongs at [`.circleci/config.yml`](../../.circleci/config.yml). CircleCI expects that path; `.github/workflows/` is for GitHub Actions YAML. The job is named `audit-npm-package-content` and appears in GitHub when the repository is connected to CircleCI.

No npm token is needed. The workflow only creates and inspects a local archive; it does not publish it.
