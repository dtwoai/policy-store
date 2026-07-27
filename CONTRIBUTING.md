# Contributing to the DTwo Policy Store

Thanks for considering a contribution. This catalog exists because reusable policies are most valuable when they're reviewed, well-documented, and trustworthy — please read this guide before opening a PR.

By contributing, you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md), and you certify and sign off your work under the [Developer Certificate of Origin](#developer-certificate-of-origin-dco). See [GOVERNANCE.md](./GOVERNANCE.md) for how the catalog is maintained.

## How contributions work (curated launch)

The catalog launches **curated-only**. Because every policy here runs inside other people's gateway decision paths, we do not merge arbitrary external Rego until an automated trust gate (`opa check` + test execution + a security-review checklist in CI) is in place. Until then:

1. **Open an issue** proposing the policy — the app, the problem it solves, the intended `allow` / `deny` / `transform` behavior, and example inputs.
2. **A DTwo maintainer authors or transcribes** the policy, takes it through the review below, and merges it. You are credited as the proposer.
3. **External pull requests are not merged directly** during this phase — merge access is restricted to maintainers via [`CODEOWNERS`](./.github/CODEOWNERS) and branch protection. You may still open a PR for discussion.

We will open the catalog to external, DCO-signed pull requests **once the trust gate exists** — the trigger is the gate, not a date. The authoring rules and review criteria below apply either way.

## Developer Certificate of Origin (DCO)

All contributions to this repository are made under the **Developer Certificate of Origin (DCO)**. The DCO is a lightweight, CLA-free way to certify that you wrote, or otherwise have the right to submit, the code you contribute. We do **not** use a CLA.

You certify the DCO by adding a `Signed-off-by` line to every commit:

```text
Signed-off-by: Your Name <your.email@example.com>
```

Git adds this line automatically when you commit with the `-s` flag:

```bash
git commit -s -m "Add slack.ingress.block_secrets policy"
```

The name and email must match your Git author identity. Sign-off is **required on every commit** and is enforced by a DCO status check on pull requests. To add sign-off to the most recent commit, use `git commit --amend -s`; to sign off a series, use an interactive rebase with `--signoff`.

The full text you are certifying:

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
1 Letterman Drive
Suite D4700
San Francisco, CA, 94129

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Contributions are accepted under the repository's [Apache-2.0 license](./LICENSE), which includes an express patent grant from contributors.

## What belongs here

- **Reusable policies** for popular MCP servers (Slack, Jira, GitHub, databases, etc.) that solve a recurring security, privacy, or governance problem.
- **Industry landing pages** that curate the existing policies most relevant to a regulatory or business domain (healthcare, finance, public sector, etc.).
- **Bundles** that group related policies under a theme (IM messaging hygiene, source-control safety, PII redaction, etc.).

### What does not belong here

- One-off policies tied to a single tenant's internal data (project keys, channel IDs, employee emails). Keep those in your own private repo.
- Policies that require gateway features that aren't generally available.
- Policy bodies under `industries/` or `bundles/` — those directories are landing pages only. The canonical body lives under `apps/`.
- Per-policy `metadata.json` files. Policy metadata lives in `policy.md` frontmatter. (See [Registering a new policy](#registering-a-new-policy) below.)

## Policy authoring rules

Every policy must follow the DTwo Rego conventions:

- One `package` per policy file, named `<app>.<direction>.<purpose>` (e.g., `slack.ingress.block_secrets`).
- **One policy, one job.** Multi-concern policies belong as multiple files composed at gateway-attachment time.
- `default allow := false` for policies that deny; `default allow := true` for transform-only policies.
- `allow`, `reasons`, `reason`, and `transform` are separate top-level rules (no structured decision objects).
- **PARC-compatible only.** Reference `input.resource`, `input.subject`, `input.action`, `input.context` — not the deprecated legacy aliases (`input.payload.name`, `input.kind`, `input.user`). The catalog's import contract assumes PARC, so policies that only work against legacy fields will be rejected.
- Case-insensitive tool name comparisons (`lower(input.resource.name) == "..."`).
- Use `object.get(obj, key, default)` instead of direct access for any field that might be missing.
- Do not rely on stripped claims (`is_admin`, `teams`, `user` inside `subject.claims`). Use IdP-supplied claims (`groups`, `roles`, namespaced custom claims).

The authoritative reference for these conventions is the public [`dtwo-policy-rego` skill](https://github.com/dtwoai/plugins/blob/main/dtwo/skills/dtwo-policy-rego/SKILL.md) in the [`dtwoai/plugins`](https://github.com/dtwoai/plugins) repo. It's a Markdown document you can read directly — it covers the PARC input schema, the `allow`/`reasons`/`reason`/`transform` rule shape, and allow/deny/transform patterns. It also installs as a Claude Code plugin (see that repo's README) if you author policies with Claude Code.

## Directory and file conventions

A new policy looks like this:

```text
apps/<app>/<policy-slug>/
  policy.md          # required — frontmatter (incl. the human docs) plus the fenced Rego policy body
  tests.yaml         # required — a YAML array of test cases (at least one positive and one negative)
```

- `<app>` is the lowercase, hyphenated MCP server name as it would commonly be configured on a gateway (e.g., `slack`, `jira`, `github`, `postgres`).
- `<policy-slug>` is the lowercase, hyphenated purpose (`block-secrets`, `readonly`, `pii-redaction`).
- **No per-policy `README.md`.** A policy's human documentation — what it does, when to use it, assumptions, limitations, examples — lives in the `description` field of the `policy.md` frontmatter. (App, industry, and bundle directories do have `README.md` landing pages; individual policies do not.)
- **No `metadata.json` in the policy directory.** All metadata for the catalog lives in the policy markdown frontmatter.

## Registering a new policy

1. **`policy.md` frontmatter** — add all required fields from [`schema.json`](./schema.json): `name`, `tags`, `publishedAt`, `description`, `direction`, `apps`, and `schemaVersion`. Include `industries`, `bundles`, and `minimumGatewayVersion` when they apply. Set `experimental: true` if the policy has not been manually validated against a test setup of the app (see [Experimental policies](#experimental-policies)).
2. **App landing page** — add a row to `apps/<app>/README.md` linking to the new policy.
3. **Industry / bundle landing pages** — if the policy fits an existing industry or bundle, list `<industry>` / `<bundle>` slugs in the policy's frontmatter **and** add a link from the matching landing page. Do not duplicate the policy body.
4. **New apps, industries, or bundles** — create the corresponding directory and `README.md`; the manifest generator will add the top-level map entry.
5. **Tests** — add at least one positive and one negative test case to the policy's `tests.yaml` (see [Testing](#testing)).
6. **Manifest generation** — run `pnpm manifest` and commit the generated `manifest.json`, then run `pnpm manifest:check` to confirm it is current (this is what CI enforces).
7. **Run the policy tests** — `pnpm test` (requires the OPA CLI on your `PATH`). CI runs the same command.

## Experimental policies

A policy is **experimental** when it compiles and passes its `tests.yaml`, but has **not been manually validated against a test setup of the app** — it is a reviewed starting point whose behavior has not been confirmed end-to-end against a running instance of the app (typically its tool-name suffixes and argument shapes come from research or documentation rather than a captured `tools/list` from a live gateway). Experimental policies are still reviewed and still ship in the catalog; the flag is an honesty signal, not a lower quality bar.

- **Marking one:** add `experimental: true` to the `policy.md` frontmatter. Omit the field (or set `experimental: false`) once the policy has been validated against a test setup of the app.
- **Manifest:** the generator always writes an explicit `experimental` boolean into each `manifest.json` entry (defaulting to `false`), so downstream consumers (Hub, `dtwo-mcp`, the discovery site) can badge or filter experimental policies without guessing.
- **Documentation:** note the experimental status and what still needs live validation in the policy's `description` **Known limitations** section, so a reader sees it without opening the manifest.
- **Graduating:** when a policy is validated against a test setup of the app, drop the flag, regenerate the manifest, and note the change in the `description` frontmatter.

## A note on the manifest schema

`manifest.json` is the generated policy index for both this repo and downstream consumers (Hub, `dtwo-mcp`). It is built from policy markdown frontmatter and validated against [`schema.json`](./schema.json). Until CI enforces this automatically:

- Match the shape of existing policy frontmatter when adding new policies.
- Don't invent new manifest fields. Open an issue first if something is missing.
- Run `pnpm manifest:check` before opening a PR; it exits nonzero when `manifest.json` is stale or a policy is invalid.

## Testing

Every policy ships with a `tests.yaml`, and CI compiles and runs the cases in the file. Install the [OPA CLI](https://www.openpolicyagent.org/docs/latest/#running-opa) (v1.x) — e.g. `brew install opa`, or download a release binary — then:

```bash
pnpm test          # opa check --strict on every policy + run all test cases
```

`pnpm test` requires the `opa` binary on your `PATH`; set `OPA_BIN` to point at a specific binary if it isn't. CI installs OPA with the [`open-policy-agent/setup-opa`](https://github.com/open-policy-agent/setup-opa) action.

The runner (`scripts/test-policies.mjs`) extracts the Rego from each `policy.md`, type-checks it with `opa check --strict`, and evaluates every test case in the policy's `tests.yaml` against the documented outcome.

**Test contract.** A `tests.yaml` is a YAML file holding a top-level array of test cases. Each entry:

```yaml
- description: what this case demonstrates
  input: # the PARC decision object: input.resource / subject / action / payload ...
    resource: { ... }
    action: ...
  output:
    expectedResult: deny          # required — "allow" or "deny" (asserts data.<pkg>.allow)
    expectedReason: exact reason  # optional — data.<pkg>.reason must equal it exactly
  transformApplied: true          # optional — whether data.<pkg>.transform is returned
  transform: { replacement: "..." }       # optional — asserted field by field
  transformedArgsContain: { jql: "..." }          # optional — data.<pkg>.transform.transformed_payload must contain these
```

- Provide **at least one positive and one negative** case. Deny policies use an allow case and a deny case; transform-only policies use a passthrough case (`transformApplied: false`) and a redact case (`transformApplied: true`).
- The PARC object lives under each case's `input` key, and the runner feeds **only** that object to OPA as the input document. Don't hand OPA the whole test object — the policy would read `input.input.*`, every rule would miss, and a deny policy would *wrongly report `allow = true`*. `pnpm test` feeds the right thing, which is why you should use it rather than evaluating cases by hand.
- For policies that touch identity claims, document (in the `description`) which IdP claim names are required and what defaults the policy uses when they're missing.

## PR review

Maintainers review for:

- **Correctness** — does the Rego do what the policy's `description` claims? Are deny conditions tight, and is the `default allow` chosen correctly? Do the fixtures pass under `pnpm test`?
- **PARC compliance** — only PARC fields, no deprecated legacy aliases, no stripped claims used for authorization.
- **Catalog hygiene** — `manifest.json` is regenerated, landing pages link rather than duplicate, no stray per-policy `metadata.json`.
- **Documentation** — a reader can understand the policy's effect and trade-offs from the `description` frontmatter without reading the Rego.

PRs that change an existing policy must regenerate `manifest.json` and note the change in the policy's `description` frontmatter.

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). Be kind — reviews are about the policy, not the contributor. Report unacceptable behavior to [conduct@dtwo.ai](mailto:conduct@dtwo.ai).
