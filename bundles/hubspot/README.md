# HubSpot bundle

A curated bundle of policies for HubSpot MCP servers. The goal is a sensible default posture for any organization fronting HubSpot through the DTwo gateway: keep high-impact CRM writes (like closing deals) under control while leaving everyday CRM work unaffected.

## Included policies

| Policy                                                                     | App     | Direction | Purpose                                                                                          |
| -------------------------------------------------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------- |
| [block-deal-closure](../../apps/hubspot/block-deal-closure/policy.md)       | hubspot | ingress   | Deny CRM-object calls that move a deal into a closed stage (`closedwon` / `closedlost`); all other deal changes and tools pass through. |
| [protect-associations](../../apps/hubspot/protect-associations/policy.md)   | hubspot | ingress   | Deny CRM-object calls that create or change object associations; all other calls pass through. |
| [protect-deal-owner](../../apps/hubspot/protect-deal-owner/policy.md)        | hubspot | ingress   | Deny deal-update calls that set or change `hubspot_owner_id`; deal creates and other fields pass through. |
| [protect-lifecycle-stage](../../apps/hubspot/protect-lifecycle-stage/policy.md) | hubspot | ingress   | Deny contact create/update calls that set or change `lifecyclestage`; all other calls pass through. |
| [read-only](../../apps/hubspot/read-only/policy.md)                          | hubspot | ingress   | Block all HubSpot writes (the `*-manage-crm-objects` tool); read/search/list tools pass through. |
| [redact-pii](../../apps/hubspot/redact-pii/policy.md)                        | hubspot | egress    | Redact contact PII (phone, email, fax, SSN) from HubSpot tool responses. Transform-only — never denies. |

> Policy bodies live under [`apps/`](../../apps/). This page only links to them — see the top-level [README](../../README.md#where-policies-live) for the rationale.

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `bundles: ["hubspot"]`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

The bundle's policies are designed to compose cleanly on the same ingress pipeline. `block-deal-closure`, `protect-associations`, `protect-deal-owner`, and `protect-lifecycle-stage` are each single-purpose deny policies (`default allow := false`, re-allowing everything except their own narrow concern — a deal-closing write, an association change, a deal-owner change, and a contact lifecycle-stage change respectively), so they never interfere with each other or with other HubSpot policies attached to the same direction.

`read-only` is the broad-strokes alternative: it blocks the entire `*-manage-crm-objects` write tool, which supersedes all four narrow deny policies above (they each gate a subset of the same tool). Pick `read-only` when you want a fully read-only connection, or the narrow policies when you want to allow most writes but block specific high-impact ones — combining both is redundant but harmless.

`redact-pii` is the bundle's only **egress** policy — it attaches to the egress (response) pipeline rather than ingress, is transform-only (`default allow := true`), and is orthogonal to the ingress write controls above, so it composes cleanly alongside any of them.

## What's intentionally not in the bundle

- **Pipeline / stage allow-deny lists.** Custom pipeline and stage internal names are tenant-specific (your `dealstage` values aren't ours) and belong in your private policy repo.
- **Identity-scoped gates.** IdP claims (`org_id`, `groups`, etc.) vary by deployment. Add these as separate policies in your gateway.

## Roadmap

- Additional field-protection and read-only policies as they stabilize in the catalog.
- Egress redaction of PII in CRM record responses.
