# HubSpot policies

Reusable DTwo policies for HubSpot MCP servers — the HubSpot-hosted remote MCP server that the Claude connector uses, plus the older `@hubspot/mcp-server` local beta and the broader community servers (`@shinzolabs/hubspot-mcp`, `baryhuang/mcp-hubspot`). These families use three incompatible tool vocabularies for the same CRM (`hubspot-*` kebab-case, bare snake_case verbs like `search_crm_objects` / `manage_crm_objects`, and shinzo's `{domain}_{operation}` names), so the policies below match by tool-name suffix to stay portable. Its risk profile is dominated by *PII/PHI at scale and irreversible business writes*: contact, company, and deal records concentrate names, emails, phones, and addresses, and search/list pagination is a bulk-export channel; deal-stage and lifecycle edits fire live workflow automation; and while the official servers expose no delete, the shinzo community server adds destructive `*_archive` and consent-destroying `unsubscribe` tools.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [block-deal-closure](./block-deal-closure/policy.md) | ingress | Deny CRM-object calls that move a deal into a closed stage (`closedwon` / `closedlost`); all other deal changes and tools pass through. | soc2, sox |
| [protect-associations](./protect-associations/policy.md) | ingress | Deny CRM-object calls that create or change object associations (deal↔company, contact↔company, etc.); all other calls pass through. | soc2, gdpr-ccpa, sox |
| [protect-deal-owner](./protect-deal-owner/policy.md) | ingress | Deny deal-update calls that set or change `hubspot_owner_id`; deal creates and other fields pass through. | soc2, sox |
| [protect-lifecycle-stage](./protect-lifecycle-stage/policy.md) | ingress | Deny contact create/update calls that set or change `lifecyclestage`; all other calls pass through. | soc2, gdpr-ccpa |
| [read-only](./read-only/policy.md) | ingress | Block all HubSpot writes (the `*-manage-crm-objects` tool); read/search/list tools pass through. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Gate every HubSpot write tool behind an IdP `crm-writers` group; read-only by default, fail-closed on missing claims. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [role-gate-schema-consent](./role-gate-schema-consent/policy.md) | ingress | Reserve the two highest-blast-radius write classes — portal-schema (property-definition) edits and marketing-consent mutations — for a `hubspot-admins` group. | soc2, gdpr-ccpa |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny every archive/delete/void/purge-class tool plus the consent-destroying contact unsubscribe; no identity exemption. | soc2, hipaa, gdpr-ccpa, sox |
| [cap-bulk-export](./cap-bulk-export/policy.md) | ingress | Clamp bulk-read page size to 50 and truncate ids-style batch reads (transform-only) to cut off the mass-PII export channel. | soc2, hipaa, gdpr-ccpa |
| [redact-pii](./redact-pii/policy.md) | egress | Redact contact PII (phone, email, fax, SSN) from HubSpot tool responses to `[REDACTED]`. Transform-only — never denies. | soc2, hipaa, gdpr-ccpa |

All policies also belong to the thematic [`bundles/crm`](../../bundles/crm/README.md) bundle.

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A HubSpot MCP server registered as `hubspot` surfaces tools like `hubspot-manage-crm-objects`, while one registered under another name (e.g. `hubspot-mcp`) would surface `hubspot-mcp-manage-crm-objects`. The policies in this directory match on the *suffix* (`-manage-crm-objects`, `_create_property`, `_archive`, etc.) so they stay portable across the remote, local-beta, and community naming conventions — but the remote server collapses all writes into one tool (`manage_crm_objects`), so create-vs-update and which-object distinctions can only be made by inspecting arguments. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

Most of these policies are single-purpose and require no IdP claims. The identity-gated ones (`role-gate-writes` and `role-gate-schema-consent`) read `input.subject.claims.groups` with **placeholder** group names (`crm-writers`, `hubspot-admins`). Replace these with your own IdP group names at import time. The group check is fail-closed: a missing `subject.claims`, missing `groups`, or a non-list-of-strings `groups` claim denies the gated write — a missing claim never grants access.

## Contributing

To add a HubSpot policy:

1. Create `apps/hubspot/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["hubspot"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/crm`](../../bundles/crm/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
