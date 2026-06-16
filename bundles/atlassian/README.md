# Atlassian bundle

A curated bundle of policies for Atlassian MCP servers (JIRA today; Confluence and Bitbucket planned). The goal is a sensible default posture for any organization fronting an Atlassian tool through the DTwo gateway: keep PII, credentials, and secrets from leaking out of issue and page content, and keep writes clean.

## Included policies

| Policy                                                                          | App  | Direction | Purpose                                                                                                  |
| ------------------------------------------------------------------------------- | ---- | --------- | -------------------------------------------------------------------------------------------------------- |
| [redact-sensitive-info](../../apps/jira/redact-sensitive-info/policy.md)        | jira | egress    | Redact PII, credentials, and secrets from JIRA issue-view responses (issues, JQL search, comments, worklogs, remote links). Transform-only — never denies. |
| [deny-view-search-sensitive-projects](../../apps/jira/deny-view-search-sensitive-projects/policy.md) | jira | ingress   | Deny direct views and explicit JQL searches of sensitive projects; silently filter generic searches to exclude them. |
| [deny-write-sensitive-projects](../../apps/jira/deny-write-sensitive-projects/policy.md) | jira | ingress   | Deny write operations (edit/transition/comment/create/move/link, etc.) on issues in sensitive projects. |

> Policy bodies live under [`apps/`](../../apps/). This page only links to them — see the top-level [README](../../README.md#where-policies-live) for the rationale.

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `bundles: ["atlassian"]`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

The bundle's policies are designed to compose cleanly. The redaction policy is transform-only (`default allow := true`) and scoped narrowly to JIRA issue-view tools, so it never denies a call and never interferes with other policies on the same egress pipeline. The `deny-view-search-sensitive-projects` and `deny-write-sensitive-projects` policies run on the ingress pipeline (a separate direction) and only act on JIRA tools — the former on read tools, the latter on write tools — so none of the three collide. Together they give read-path access control, write-path protection for the same project set, and an egress redaction backstop. The two project-restriction policies each carry their own `sensitive_projects` set; keep them in sync.

## What's intentionally not in the bundle

- **Project / board allow-deny lists.** These are tenant-specific (your project keys aren't ours) and belong in your private policy repo.
- **Identity-scoped gates.** IdP claims (`org_id`, `groups`, etc.) vary by deployment. Add these as separate policies in your gateway.
- **Ingress write controls.** Blocking secrets from being *written* into issues is a complementary concern; an ingress companion policy is planned.

## Roadmap

- Confluence equivalents (`apps/confluence/redact-sensitive-info`, …) once a stable Confluence MCP server lands in the catalog.
- Bitbucket equivalents.
- An ingress policy that blocks credentials from being pasted into new JIRA issues and comments.
