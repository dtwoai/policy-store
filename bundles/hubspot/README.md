# HubSpot bundle

A curated bundle of policies for HubSpot MCP servers. The goal is a sensible default posture for any organization fronting HubSpot through the DTwo gateway: keep high-impact CRM writes (like closing deals) under control while leaving everyday CRM work unaffected.

## Included policies

| Policy                                                                     | App     | Direction | Purpose                                                                                          |
| -------------------------------------------------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------- |
| [block-deal-closure](../../apps/hubspot/block-deal-closure/policy.md)       | hubspot | ingress   | Deny CRM-object calls that move a deal into a closed stage (`closedwon` / `closedlost`); all other deal changes and tools pass through. |

> Policy bodies live under [`apps/`](../../apps/). This page only links to them — see the top-level [README](../../README.md#where-policies-live) for the rationale.

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `bundles: ["hubspot"]`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

The bundle's policies are designed to compose cleanly on the same ingress pipeline. `block-deal-closure` is a single-purpose deny policy (`default allow := false`, re-allowing everything except a deal-closing write), so it never interferes with other HubSpot policies attached to the same direction.

## What's intentionally not in the bundle

- **Pipeline / stage allow-deny lists.** Custom pipeline and stage internal names are tenant-specific (your `dealstage` values aren't ours) and belong in your private policy repo.
- **Identity-scoped gates.** IdP claims (`org_id`, `groups`, etc.) vary by deployment. Add these as separate policies in your gateway.

## Roadmap

- Read-only and field-protection policies (e.g. protect deal owner, lifecycle stage, associations) as they stabilize in the catalog.
- Egress redaction of PII in CRM record responses.
