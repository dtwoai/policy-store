# ServiceNow policies

Reusable DTwo policies for ServiceNow MCP servers — the official ServiceNow MCP Server (behind the Claude connector) and the two community servers whose vocabulary most wrappers copy, [echelon-ai-labs/servicenow-mcp](https://github.com/echelon-ai-labs/servicenow-mcp) and [michaelbuckner/servicenow-mcp](https://github.com/michaelbuckner/servicenow-mcp). The surface is broad and high-blast-radius: alongside routine incident and catalog reads/writes it exposes change-approval control gates (SOX-relevant), identity and group-membership mutation (ServiceNow ACL escalation primitives), server-side code paths (`update_script`, script includes, workflows, changeset publication), and generic Table-API tools that reach *any* table the credential can read — `sys_user`, HRSD case tables, CMDB, and custom PII tables. These policies default-deny the unknown, fence the sensitive tables, keep identity and change-approval planes off the agent path, gate writes behind IdP groups, and force agent-drafted comments into internal work notes.

## Available policies

| Policy                                                                       | Direction | Purpose                                                                                                                       | Bundles                              |
| ---------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md)         | ingress   | Deny any ServiceNow tool call whose name is not on the audited allowlist; everything unrecognized fails closed.               | soc2, gdpr-ccpa                      |
| [fence-sensitive-tables](./fence-sensitive-tables/policy.md)                 | ingress   | Deny generic Table-API and record reads targeting sensitive tables (`sys_user`, HRSD, CMDB) unless the caller is in the owning group. | soc2, hipaa, pci-dss, gdpr-ccpa      |
| [force-internal-comments](./force-internal-comments/policy.md)               | ingress   | Rewrite `add_comment` calls to internal work notes for callers outside the service-desk group (transform-only).              | —                                    |
| [freeze-identity-plane](./freeze-identity-plane/policy.md)                   | ingress   | Deny identity- and access-mutation tools (user, group, membership) unless the caller is in an identity-admin group.          | —                                    |
| [require-human-approval-changes](./require-human-approval-changes/policy.md) | ingress   | Unconditionally deny change-management control-gate tools (`approve_change`, `reject_change`, `submit_change_for_approval`) on the agent path. | soc2, sox, gdpr-ccpa                 |
| [role-gate-writes](./role-gate-writes/policy.md)                             | ingress   | Read-only by default: read tools pass for everyone, write tools deny unless the caller is in a writer group.                 | soc2, hipaa, pci-dss, gdpr-ccpa, sox |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, so a server registered as `servicenow` surfaces tools like `servicenow-create_incident`. The community servers use `verb_noun` snake_case with no vendor prefix (`create_incident`, `perform_query`), so these policies match on the *suffix* to stay portable across gateway naming. Note two important caveats from the landscape research:

- **The official ServiceNow MCP Server has no fixed tool inventory.** Admins publish tools (Now Assist Skills, Knowledge Graph queries, Subflows/Actions, Scripted REST APIs) from the MCP Server Console, so tool names are *instance-defined*. Policies keyed to community-server suffixes will not automatically match official-server tools — pin the allowlist in [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) to your instance's published tool list.
- **Naming diverges across community servers.** echelon and buckner use `verb_noun`; LokiMCPUniverse uses `noun_verb` (`incident_create`). Suffix matching covers the two big `verb_noun` servers; confirm the exact tool name your gateway sends with the dump-input debug technique before deploying.

## Identity claims

The group-gated policies (`fence-sensitive-tables`, `force-internal-comments`, `freeze-identity-plane`, `role-gate-writes`) read IdP groups from `input.subject.claims.groups`. The group names in each policy (e.g. `service_desk`, an identity-admin group, a writer group) are **placeholders — replace them with your IdP's group names at import time.** Missing or malformed claims fail closed (no group → no grant). `default-deny-unknown-tools` and `require-human-approval-changes` require no claims.

## Contributing

To add a ServiceNow policy:

1. Create `apps/servicenow/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["servicenow"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle, link to it from the matching bundle landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
