# Contributing to the DTwo Policy Store

Thanks for considering a contribution. This catalog exists because reusable policies are most valuable when they're reviewed, well-documented, and trustworthy — please read this guide before opening a PR.

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

The DTwo `dtwo-policy-rego` skill is the authoritative reference for these conventions.

## Directory and file conventions

A new policy looks like this:

```
apps/<app>/<policy-slug>/
  policy.md          # required — frontmatter plus the fenced Rego policy body
  README.md          # required — what it does, when to use it, assumptions, examples
  tests/             # optional but encouraged — sample inputs / expected outcomes
    allow.json
    deny.json
```

- `<app>` is the lowercase, hyphenated MCP server name as it would commonly be configured on a gateway (e.g., `slack`, `jira`, `github`, `postgres`).
- `<policy-slug>` is the lowercase, hyphenated purpose (`block-secrets`, `readonly`, `pii-redaction`).
- **No `metadata.json` in the policy directory.** All metadata for the catalog lives in the policy markdown frontmatter.

## Registering a new policy

1. **`policy.md` frontmatter** — add all required fields from [`schema.json`](./schema.json): `name`, `tags`, `publishedAt`, `description`, `direction`, `apps`, and `schemaVersion`. Include `industries`, `bundles`, and `minimumGatewayVersion` when they apply.
2. **App landing page** — add a row to `apps/<app>/README.md` linking to the new policy.
3. **Industry / bundle landing pages** — if the policy fits an existing industry or bundle, list `<industry>` / `<bundle>` slugs in the policy's frontmatter **and** add a link from the matching landing page. Do not duplicate the policy body.
4. **New apps, industries, or bundles** — create the corresponding directory and `README.md`; the manifest generator will add the top-level map entry.
5. **Manifest generation** — run `pnpm manifest` and commit the generated `manifest.json`.

## A note on the manifest schema

`manifest.json` is the generated policy index for both this repo and downstream consumers (Hub, `dtwo-mcp`). It is built from policy markdown frontmatter and validated against [`schema.json`](./schema.json). Until CI enforces this automatically:

- Match the shape of existing policy frontmatter when adding new policies.
- Don't invent new manifest fields. Open an issue first if something is missing.
- Run `pnpm manifest:check` before opening a PR; it exits nonzero when `manifest.json` is stale or a policy is invalid.

## Testing

There is no automated Rego test harness in this repo yet — that's a planned addition. Until then, contributors are expected to:

- Validate Rego compiles with `opa parse` after extracting the fenced `rego` block from `policy.md` (or `opa eval -d ...` with the extracted policy).
- Provide at least one positive and one negative sample in `tests/` (`allow.json`, `deny.json`) with the input shape and expected outcome — see [`apps/slack/block-secrets/tests/`](./apps/slack/block-secrets/tests/) for the current convention. The test-runner contract will be formalized alongside the manifest schema.
- For policies that touch identity claims, document which IdP claim names are required and what defaults the policy uses when they're missing.

## PR review

Maintainers review for:

- **Correctness** — does the Rego do what the README claims? Are deny conditions tight, and is the `default allow` chosen correctly?
- **PARC compliance** — only PARC fields, no deprecated legacy aliases, no stripped claims used for authorization.
- **Catalog hygiene** — `manifest.json` is regenerated, landing pages link rather than duplicate, no stray per-policy `metadata.json`.
- **Documentation** — a reader can understand the policy's effect and trade-offs without reading the Rego.

PRs that change an existing policy must regenerate `manifest.json` and note the change in the policy README.

## Code of conduct

Be kind. Reviews are about the policy, not the contributor.
