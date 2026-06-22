<!--
Heads up: the catalog launches CURATED-ONLY. External pull requests are for
discussion; they are not merged directly until the automated trust gate opens
external contributions (see GOVERNANCE.md). To propose a policy, open a
"Policy proposal" issue.
-->

## What this changes

<!-- Brief summary. Link the proposal issue if there is one (e.g. Closes #123). -->

## Checklist

- [ ] Commits are signed off (`git commit -s`) per the [DCO](https://github.com/dtwoai/dtwo-policy-store/blob/main/CONTRIBUTING.md#developer-certificate-of-origin-dco).
- [ ] `pnpm manifest:check` passes (manifest regenerated if policies changed).
- [ ] `pnpm test` passes (`opa check --strict` + test cases).
- [ ] New/changed policies include at least one positive and one negative test case in `tests.md`.
- [ ] Policy docs live in the `policy.md` `description` frontmatter (no per-policy README, no `metadata.json`).
- [ ] No tenant-specific data, secrets, or sensitive test data.
