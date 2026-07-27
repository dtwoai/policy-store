# Intercom policies

Reusable DTwo policies for Intercom MCP servers — the official Intercom remote server (`mcp.intercom.com`) that the Claude connector uses, plus compatible community implementations (`raoulbia-ai/mcp-server-for-intercom`, `fabian1710/mcp-intercom`). The MCP surface is overwhelmingly read tools (conversation search/fetch, contact and company lookups, Help Center article reads) plus a small pair of externally visible article writes (`create_article`/`update_article`). Its risk profile is dominated by *data egress*, not destructive writes: there are no delete or conversation-reply tools, but conversations are raw customer free-text (card numbers, IDs, credentials, health details pasted into support chats), contacts are structured customer PII with email-domain search enabling bulk enumeration, and a published article puts agent-authored HTML on the public Help Center immediately.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [cap-contact-enumeration](./cap-contact-enumeration/policy.md) | ingress | Deny the bulk-enumeration query shape on contact search (email-domain sweeps, broad `contains`/`~` matches) unless the caller is a CRM admin; clamp page size on the rest. | soc2, hipaa, gdpr-ccpa |
| [deny-article-publish](./deny-article-publish/policy.md) | ingress | Keep agent-authored Help Center articles in draft — deny (or rewrite) `state: "published"` on article create/update unless the caller is in a content-admin group. | — |
| [fence-contact-reads](./fence-contact-reads/policy.md) | ingress | Gate the structured-PII contact and company read surface (`get_contact`, `search_contacts`, `get_company`, `list_companies`, and `contact_`/`company_`-prefixed `fetch`) behind a support/CRM IdP group. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [mask-pan-egress](./mask-pan-egress/policy.md) | egress | Mask payment-card numbers (PANs, Luhn-validated) in Intercom conversation content returned to the agent. | pci-dss, gdpr-ccpa |
| [redact-conversation-pii](./redact-conversation-pii/policy.md) | egress | Redact PII (SSN, credential-shaped strings, and contact identifiers) from the free-text returned by conversation- and contact-read tools before it reaches the agent. | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. An Intercom MCP server registered as `intercom` will surface tools like `intercom-get_conversation`, while one registered as `support-mcp` will surface `support-mcp-get_conversation`. The policies in this directory match on the *suffix* (`get_conversation`, `search_contacts`, `_article`, etc.) so they stay portable across naming conventions. Two divergences to watch for, both flagged in the landscape note: community servers use kebab-case (`search-conversations`) where the official server uses snake_case (`search_conversations`), and the generic `search`/`fetch` pair aliases the typed tools (a `search` with `object_type: "contacts"`, or a `fetch` of a `contact_`-prefixed ID, reaches the same data as `search_contacts`). The policies here cover both paths — but always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

The identity-gated policies (`cap-contact-enumeration`, `deny-article-publish`, `fence-contact-reads`) read `input.subject.claims.groups` with **placeholder** group names (e.g. `crm-admins`, `support-content-admins`, `support`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt). The community Intercom servers authenticate with a single workspace-level access token and carry no per-user identity, so IdP-claim gating at the DTwo layer is the only per-user control available for those deployments.

## Contributing

To add an Intercom policy:

1. Create `apps/intercom/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["intercom"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
