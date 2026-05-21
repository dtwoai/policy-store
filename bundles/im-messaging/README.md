# IM messaging bundle

A curated bundle of policies for instant-messaging MCP servers (Slack today; Microsoft Teams and Discord planned). The goal is a sensible default posture for any organization fronting an IM tool through the DTwo gateway: prevent secret leaks, redact sensitive data, and keep audit trails clean.

## Included policies

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [block-secrets](../../apps/slack/block-secrets/README.md) | slack | ingress | Deny Slack send-message calls whose body looks like a secret (API key, password, token, private key). |

> Policy bodies live under [`apps/`](../../apps/). This page only links to them — see the top-level [README](../../README.md#where-policies-live) for the rationale.

## How bundle membership works

Bundle membership is declared on each policy's entry in the top-level [`catalog.json`](../../catalog.json) (the policy lists `"bundles": ["im-messaging"]`). This page is a human-readable landing page; the catalog is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

The bundle's policies are designed to compose cleanly on the same ingress pipeline. None of them conflict with the others, and each is `default allow := false` only for the narrow concern it addresses (i.e., they don't accidentally deny tools they don't know about).

## What's intentionally not in the bundle

- **Channel allow/deny lists.** These are tenant-specific (your channel IDs aren't ours) and belong in your private policy repo.
- **Identity-scoped gates.** IdP claims (`org_id`, `groups`, etc.) vary by deployment. Add these as separate policies in your gateway.
- **Egress redaction of historical Slack messages.** Planned — secrets posted before this bundle was attached should be masked when read back via search / history tools.

## Roadmap

- Microsoft Teams equivalents (`apps/teams/block-secrets`, …) once a stable Teams MCP server lands in the catalog.
- Discord equivalents.
- An egress PII redaction policy that applies to `*-search-messages` / `*-conversations-history` tools across IM apps.
