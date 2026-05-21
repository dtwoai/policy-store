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
- Per-policy `metadata.json` files. Policy metadata lives in `catalog.json`. (See [Registering a new policy](#registering-a-new-policy) below.)

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
  policy.rego        # required — the policy body
  README.md          # required — what it does, when to use it, assumptions, examples
  tests/             # optional but encouraged — sample inputs / expected outcomes
    allow.json
    deny.json
```

- `<app>` is the lowercase, hyphenated MCP server name as it would commonly be configured on a gateway (e.g., `slack`, `jira`, `github`, `postgres`).
- `<policy-slug>` is the lowercase, hyphenated purpose (`block-secrets`, `readonly`, `pii-redaction`).
- **No `metadata.json` in the policy directory.** All metadata for the catalog lives in the top-level `catalog.json`.

## Registering a new policy

1. **`catalog.json` entry** — add an object to `policies` with at minimum: `path`, `title`, `summary`, `package`, `direction`, `hook`, `apps`, `industries`, `bundles`, `tags`, `version`. Use the existing entries as a template. The schema is a placeholder (see [the schema note](#a-note-on-the-manifest-schema) below) — match the shape of existing entries and a maintainer will reconcile on review.
2. **App landing page** — add a row to `apps/<app>/README.md` linking to the new policy.
3. **Industry / bundle landing pages** — if the policy fits an existing industry or bundle, list `<industry>` / `<bundle>` slugs in the policy's catalog entry **and** add a link from the matching landing page. Do not duplicate the policy body.
4. **New apps, industries, or bundles** — also add the new top-level entry to `catalog.json` (`apps.<slug>`, `industries.<slug>`, `bundles.<slug>` with at least `title`, `summary`, `path`) and create the corresponding landing page.

## A note on the manifest schema

`catalog.json` is the single source of policy metadata for both this repo and downstream consumers (Hub, `dtwo-mcp`). The **final schema** — required fields, checksum format, ref/release encoding, gateway-compatibility shape, JSON Schema validation — will be defined in a follow-up issue and enforced in CI at that point. Until then:

- Match the shape of existing policy entries when adding new ones.
- Don't invent new top-level fields. Open an issue first if something is missing.
- Expect the manifest to be migrated in a single coordinated change once the schema lands; PRs filed before that may need a small follow-up to align with the final shape.

## Testing

There is no automated Rego test harness in this repo yet — that's a planned addition. Until then, contributors are expected to:

- Validate Rego compiles with `opa parse policy.rego` (or `opa eval -d policy.rego ...`).
- Provide at least one positive and one negative sample in `tests/` (`allow.json`, `deny.json`) with the input shape and expected outcome — see [`apps/slack/block-secrets/tests/`](./apps/slack/block-secrets/tests/) for the current convention. The test-runner contract will be formalized alongside the manifest schema.
- For policies that touch identity claims, document which IdP claim names are required and what defaults the policy uses when they're missing.

## PR review

Maintainers review for:

- **Correctness** — does the Rego do what the README claims? Are deny conditions tight, and is the `default allow` chosen correctly?
- **PARC compliance** — only PARC fields, no deprecated legacy aliases, no stripped claims used for authorization.
- **Catalog hygiene** — `catalog.json` is updated with the new entry, landing pages link rather than duplicate, no stray per-policy `metadata.json`.
- **Documentation** — a reader can understand the policy's effect and trade-offs without reading the Rego.

PRs that change an existing policy must bump `version` on its `catalog.json` entry and note the change in the policy README.

## Code of conduct

Be kind. Reviews are about the policy, not the contributor.
