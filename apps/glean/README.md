# Glean policies

Reusable DTwo policies for the Glean MCP server — primarily the official Glean managed remote MCP server that the Claude connector uses (default server: `search`, `chat`, `read_document`, `employee_search`, `user_activity`, `memory`, `memory_schema`), plus the deprecated `gleanwork/local-mcp-server` and thin community wrappers. Glean is an *aggregation layer*: a single tool call fans out across everything the tenant has indexed (Drive, Confluence, Slack, Jira, Gmail/Outlook, GitHub, Salesforce, Gong, HR systems…), and Glean ships its own MCP Gateway that proxies third-party servers and data-source write actions. Its risk profile is therefore closer to *all-corp-data egress* than to any single app: read tools return whatever the authenticated user can see across every source, `read_document` fetches arbitrary public URLs (a covert exfiltration channel), the `memory` tool is a writable cross-session persistence surface, and the tool inventory is admin-mutable — agents-as-tools and gateway-proxied writes can appear without warning.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [cap-search-export](./cap-search-export/policy.md) | ingress | Clamp bulk-export params on `search` — lower over-broad `num_results` to a ceiling and strip `exhaustive:true` (transform-only). | soc2, hipaa, gdpr-ccpa |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Pin a per-tenant allowlist of verified built-in Glean read tools; deny every other tool suffix on the Glean server (agents-as-tools, gateway-proxied writes). | soc2, gdpr-ccpa |
| [fence-datasource-scope](./fence-datasource-scope/policy.md) | ingress | Restrict which indexed datasource a `search` may target via the `app` argument; deny restricted sources (Gong, Salesforce, HR) unless the caller is in the cleared IdP group. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [gate-memory-writes](./gate-memory-writes/policy.md) | ingress | Deny mutating `memory`/`read_memory` calls (add/update/delete) unless the caller is in the pilot group; memory reads and all other tools pass. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact SSNs, payment-card numbers (PANs), and IBAN/bank accounts from Glean read-tool responses before they reach the agent context (transform-only). | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and Glean's built-in tools use bare, generic snake_case names (`search`, `chat`, `read_document`). A Glean MCP server registered as `glean` surfaces `glean-search`; one registered as `glean-mcp` surfaces `glean-mcp-search`. The policies here match on the *suffix* (`search`, `read_document`, `meeting_lookup`, etc.) so they stay portable across naming conventions, and the `default-deny-unknown-tools` policy anchors on the configured Glean server prefix so Glean's generic names are never confused with a same-named tool on a different server. Confirm the exact tool names your gateway sends using the dump-input debug technique before deploying. The deprecated local server used *different* names for the same functions (`company_search`, `people_profile_search`); add those aliases only if a tenant still runs the archived package. Agents-as-tools and gateway-proxied tools have arbitrary org-specific names — inventory them per tenant before writing match rules.

## Identity claims

The identity-gated policies (`fence-datasource-scope`, `gate-memory-writes`, and the exemption logic in others) read `input.subject.claims.groups` with **placeholder** group names (e.g. `glean-memory-pilot`, `sales`, `revops`, `hr`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt / not cleared). `cap-search-export` and `redact-pii-egress` are single-purpose transforms and require no claims.

## Contributing

To add a Glean policy:

1. Create `apps/glean/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["glean"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework or thematic bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
