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

## Policy authoring rules

Every policy must follow the DTwo Rego conventions:

- One `package` per policy file, named `<app>.<direction>.<purpose>` (e.g., `slack.ingress.block_secrets`).
- **One policy, one job.** Multi-concern policies belong as multiple files composed at gateway-attachment time.
- `default allow := false` for policies that deny; `default allow := true` for transform-only policies.
- `allow`, `reasons`, `reason`, and `transform` are separate top-level rules (no structured decision objects).
- Reference only documented DTwo Gateway input schema fields. Prefer PARC names (`input.resource.name`, `input.subject.claims`) over legacy aliases.
- Case-insensitive tool name comparisons (`lower(input.resource.name) == "..."`).
- Use `object.get(obj, key, default)` instead of direct access for any field that might be missing.

The DTwo `dtwo-policy-rego` skill is the authoritative reference for these conventions — see the [DTwo plugin documentation](https://docs.dtwo.ai) for the full spec.

## Directory and file conventions

A new policy looks like this:

```
apps/<app>/<policy-slug>/
  policy.rego        # required — the policy body
  README.md          # required — what it does, when to use it, assumptions
  metadata.json      # required — catalog metadata
```

- `<app>` is the lowercase, hyphenated MCP server name as it would commonly be configured on a gateway (e.g., `slack`, `jira`, `github`, `postgres`).
- `<policy-slug>` is the lowercase, hyphenated purpose (`block-secrets`, `readonly`, `pii-redaction`).
- `metadata.json` must declare `id`, `title`, `summary`, `direction` (`ingress` | `egress`), `app`, `version`, and `tags`. See existing policies for examples.

## Registering a new policy

1. **Catalog entry** — add the policy to `catalog.json` under the matching `apps.<app>.policies` array.
2. **App landing page** — add a row to `apps/<app>/README.md` linking to the new policy.
3. **Industry / bundle landing pages** — if the policy fits an existing industry or bundle, add a link from the matching landing page. Do not duplicate the policy body.
4. **New apps, industries, or bundles** — also add the new top-level entry to `catalog.json` and create the corresponding landing page.

## Testing

There is no automated Rego test harness in this repo yet — that's a planned addition. Until then, contributors are expected to:

- Validate Rego compiles with `opa parse policy.rego` (or `opa eval -d policy.rego ...`).
- Document at least one positive and one negative example in the policy's README (input shape and expected `allow` / `transform` outcome).
- For policies that touch identity claims, document which IdP claim names are required and what defaults the policy uses when they're missing.

## PR review

Maintainers review for:

- **Correctness** — does the Rego do what the README claims? Are deny conditions tight, and is the `default allow` chosen correctly?
- **Schema compliance** — only documented `input.*` fields, PARC names preferred, no `is_admin`/`teams`/`user` from `subject.claims`.
- **Catalog hygiene** — metadata is complete, `catalog.json` is updated, landing pages link rather than duplicate.
- **Documentation** — a reader can understand the policy's effect and trade-offs without reading the Rego.

PRs that change an existing policy must bump `version` in `metadata.json` and note the change in the policy README.

## Code of conduct

Be kind. Reviews are about the policy, not the contributor.
