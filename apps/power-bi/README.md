# Power BI policies

Reusable DTwo policies for Microsoft Power BI MCP servers — Microsoft's hosted, read-only **query** server (`https://api.fabric.microsoft.com/v1/mcp/powerbi`, Entra OAuth, `ExecuteQuery`/`ValueSearch`/`GetSemanticModelSchema`), the local **modeling** server (`microsoft/powerbi-modeling-mcp`, ~21 coarse `<object>_operations` multiplexers including `security_role_operations` and `dax_query_operations`), and the most-referenced community server (`sulaiman013/powerbi-mcp`, `execute_dax`/`desktop_execute_dax`/RLS tooling). Its risk profile is dominated by *exfiltration and governance drift*, not deletion: DAX is read-only, so a single argument can dump a whole warehouse-fronting table (`EVALUATE 'Customers'`); row-level security is silently skipped under service-principal auth and is itself editable through MCP (a one-line `TRUE()` filter disables row security for everyone); and the modeling server's `*_operations` tool names do not reveal whether a call is a read or a delete.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [block-rls-bypass-service-principal](./block-rls-bypass-service-principal/policy.md) | ingress | Deny the DAX read/query tools (`ExecuteQuery`, `ValueSearch`, `execute_dax`, `dax_query_operations`) when the session identity is a service principal rather than a named user — SP auth skips RLS on the remote server. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [guard-warehouse-sql-dax](./guard-warehouse-sql-dax/policy.md) | ingress | Deny bare full-table `EVALUATE` DAX (no `FILTER`/`TOPN`/`SUMMARIZE`) on the query tools; block wholesale table exports while letting bounded queries through. | pci-dss, gdpr-ccpa |
| [freeze-rls-role-edits](./freeze-rls-role-edits/policy.md) | ingress | Deny RLS-role management tools (`security_role_operations` and community RLS-role suffixes) so row-security filter definitions cannot be rewritten from a Cowork session. | — |
| [default-deny-unknown-modeling-ops](./default-deny-unknown-modeling-ops/policy.md) | ingress | Allowlist gate: deny any Power BI tool whose name suffix is not on the per-tenant reviewed list, blocking unaudited and future `*_operations` tools before they reach the server. | soc2, gdpr-ccpa |
| [redact-pii-dax-results](./redact-pii-dax-results/policy.md) | egress | Redact high-confidence PII shapes (email, SSN, payment-card) from Power BI query results before the response reaches the agent — a backstop for models without column masking. | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and Power BI's three server families use three incompatible conventions: the remote server uses PascalCase verbs (`ExecuteQuery`), the modeling server uses snake_case `<object>_operations` multiplexers (`security_role_operations`), and the community server uses snake_case verbs with surface prefixes (`desktop_`, `cloud_`, `pbip_`). The policies here match on the *suffix* so they stay portable across gateway naming, but two caveats matter: suffix matching on `_operations` identifies the object type but **not** the action (a `measure_operations` call may be a list or a delete), and several community/discovery tool names are unverified — confirm the exact wire names your gateway sends with the dump-input debug technique before deploying.

## Identity claims

The identity-gated policies (`block-rls-bypass-service-principal`, `freeze-rls-role-edits`) read `input.subject.claims` with **placeholder** values — a service-principal indicator for the RLS-bypass gate and a governance/`bi-governance` group for RLS-role edits. Replace these with your own IdP claim and group names at import time. Missing or malformed claims fail closed (no valid named-user identity → the RLS-bypass gate denies the query tools; no governance group → RLS-role edits stay frozen).

## Contributing

To add a Power BI policy:

1. Create `apps/power-bi/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["power-bi"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle (`soc2`, `hipaa`, `pci-dss`, `gdpr-ccpa`, `sox`) or a thematic bundle, declare it in the frontmatter `bundles` list and link from the matching bundle landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
</content>
</invoke>
