# Databricks policies

Reusable DTwo policies for Databricks MCP servers — the official Databricks managed servers that the [Claude Databricks connector](https://claude.com/connectors/databricks) uses (Genie, Databricks SQL, AI Search, UC Functions), plus the deprecated `databrickslabs/mcp` labs server and the community stdio servers (`JustTryAI/databricks-mcp-server`, `RafaelCartenet/mcp-databricks-server`). The MCP surface is small but potent: a handful of fixed snake_case verbs (`genie_ask`, `execute_sql`, `execute_sql_read_only`, `poll_sql_result`, `genie_poll_response`) plus dynamic `{CATALOG}__{SCHEMA}__{NAME}` tools for AI Search indexes and UC functions, and — on the community servers — cluster/job control (`create_cluster`, `terminate_cluster`, `run_job`, `export_notebook`). Its risk profile is dominated by the *SQL string inside one argument*: the managed `execute_sql` is explicitly read **and** write, so `INSERT`/`UPDATE`/`DELETE`/`DROP`/`GRANT` are irreversible data-plane and permission changes, the lakehouse routinely holds PII/PHI/cardholder tables that egress in the async poll responses (not the submit call), community PAT auth bypasses per-user Unity Catalog identity entirely, and `system.ai` proxy services can turn Databricks into a gateway to other SaaS apps. Policies here therefore pair tool-name matching with query-text and response-text inspection.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Pin an audited allowlist of exact Databricks tool names and deny every other Databricks tool (drift-deny + `system.ai` proxy fence); all non-Databricks servers pass through. | soc2, gdpr-ccpa |
| [guard-warehouse-sql](./guard-warehouse-sql/policy.md) | ingress | Deny any `execute_sql*` statement that writes, changes schema, changes permissions, or bulk-exports (INSERT/UPDATE/DELETE/MERGE/DROP/TRUNCATE/ALTER/CREATE/GRANT/REVOKE/VACUUM/REORG); fail closed on a missing SQL argument. | soc2, pci-dss, gdpr-ccpa, sox |
| [fence-sensitive-schemas](./fence-sensitive-schemas/policy.md) | ingress | Deny SQL and UC-describe calls whose target catalog, schema, or table matches a flagged sensitive namespace, unless the caller is in the `data-privacy` group. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [role-gate-compute-ops](./role-gate-compute-ops/policy.md) | ingress | Gate cluster and job control (`create_cluster`, `start_cluster`, `terminate_cluster`, `run_job`, `export_notebook`) behind a platform-engineering group; read-only inventory tools pass through. | soc2, sox |
| [mask-pan-egress](./mask-pan-egress/policy.md) | egress | Mask payment-card numbers (PANs) in SQL/Genie poll responses and AI Search results before the agent sees them (transform-only). | pci-dss, gdpr-ccpa |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact email, SSN, and phone PII from Databricks tool response payloads to fixed tokens (transform-only). | hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Databricks SQL server registered as `databricks-sql` will surface tools like `databricks-sql-execute_sql`, while one registered as `dbx` will surface `dbx-execute_sql`. These policies match on the *suffix* / stem (`execute_sql`, `execute_sql_read_only`, `poll_sql_result`, etc.) so they stay portable across naming conventions and across the three different servers that each expose an `execute_sql`-ish tool with different auth semantics — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying. The single-space Genie invoke tool name and the `genie_ask` question parameter name are **unverified** in Databricks docs (see each policy's Known limitations); the dynamic `{CATALOG}__{SCHEMA}__{NAME}` AI Search / UC-function tools have no stable canonical name and need per-deployment enumeration or the allowlist pin.

## Identity claims

The identity-gated policies (`fence-sensitive-schemas`, `role-gate-compute-ops`) read `input.subject.claims.groups` with **placeholder** group names (e.g. `data-privacy`, and the platform-engineering group used by `role-gate-compute-ops`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt). The remaining policies are single-purpose and require no IdP claims.

## Contributing

To add a Databricks policy:

1. Create `apps/databricks/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["databricks"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework or thematic bundle, link to it from the matching landing page under [`bundles/`](../../bundles/).
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
