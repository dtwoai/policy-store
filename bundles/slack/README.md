# Slack bundle

A curated bundle of policies for Slack MCP servers. The goal is a sensible default posture for any organization fronting Slack through the DTwo gateway: keep sensitive content from leaking into messages and keep workspace-shape changes (like channel creation) under control.

## Included policies

| Policy                                                                  | App   | Direction | Purpose                                                                              |
| ----------------------------------------------------------------------- | ----- | --------- | ------------------------------------------------------------------------------------ |
| [deny-channel-creation](../../apps/slack/deny-channel-creation/policy.md) | slack | ingress   | Deny Slack channel-creation tool calls; all other Slack tools pass through.           |
| [deny-read-search-summarize-sensitive-channels](../../apps/slack/deny-read-search-summarize-sensitive-channels/policy.md) | slack | ingress   | Deny read, search, and summarize operations targeting sensitive channels (matched by channel ID). |
| [deny-direct-messages](../../apps/slack/deny-direct-messages/policy.md) | slack | ingress   | Deny message-write calls addressed to a direct conversation (1:1 DM, user ID, or group DM). |
| [redact-sensitive-info](../../apps/slack/redact-sensitive-info/policy.md) | slack | ingress   | Redact secrets and PII from outgoing message content (transform-only — never denies). |

> Policy bodies live under [`apps/`](../../apps/). This page only links to them — see the top-level [README](../../README.md#where-policies-live) for the rationale.

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `bundles: ["slack"]`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

The bundle's policies are designed to compose cleanly on the same ingress pipeline. `deny-channel-creation`, `deny-read-search-summarize-sensitive-channels`, and `deny-direct-messages` are each `default allow := true` and deny only their own narrow concern (channel creation; reads/search/summarize of specific channels; message writes to direct conversations), so they never interfere with each other or with other Slack policies attached to the same direction. `redact-sensitive-info` is also `default allow := true` but transform-only — it rewrites matching content to `[REDACTED]` rather than denying, so it layers cleanly with the deny policies on the same direction.

## Related policies

The [`block-secrets`](../../apps/slack/block-secrets/policy.md) Slack policy lives in the [`im-messaging`](../im-messaging/README.md) bundle (a cross-app instant-messaging hygiene pack). It composes cleanly with this bundle's policies on the same ingress pipeline; add it to your gateway alongside `deny-channel-creation` if you also want secret-leak protection on Slack messages.

## What's intentionally not in the bundle

- **Channel allow/deny lists.** These are tenant-specific (your channel IDs aren't ours) and belong in your private policy repo.
- **Identity-scoped gates.** IdP claims (`org_id`, `groups`, etc.) vary by deployment. Add these as separate policies in your gateway.

## Roadmap

- Egress redaction of secrets / PII in `*-conversations-history` and `*-search-messages` responses.
- Controls for other workspace-shape changes (archiving channels, inviting external users) as the need arises.
