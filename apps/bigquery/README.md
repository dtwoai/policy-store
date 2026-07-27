# BigQuery policies

Reusable DTwo policies for Google BigQuery MCP servers — the official Google remote server that the Claude connector uses (`https://bigquery.googleapis.com/mcp`), the self-hosted MCP Toolbox for Databases `bigquery` toolset, and the community servers (`ergut/mcp-bigquery-server`, `LucasHild/mcp-server-bigquery`). BigQuery is unusual among tier-1 apps: nearly the entire attack surface funnels through **one tool** (`execute_sql`) whose single string argument is arbitrary GoogleSQL, so policy here is mostly *SQL-string inspection* plus egress redaction rather than per-tool allowlisting. Its risk profile is dominated by *bulk read and irreversible write*: every read tool is a bulk-read tool (one `SELECT` can return an entire table of customer PII, financial data, or PHI), destructive DML/DDL is irreversible beyond the 7-day time-travel window, and exfiltration constructs (`EXPORT DATA` to GCS, `EXTERNAL_QUERY`, cross-project `CREATE TABLE ... AS SELECT`) never look like a "write tool" at the MCP layer.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Deny any BigQuery tool call whose name suffix is not on the audited per-tenant allowlist; surfaces new, renamed, or newly enabled upstream tools as a drift signal. | soc2, gdpr-ccpa |
| [guard-warehouse-sql](./guard-warehouse-sql/policy.md) | ingress | Deny mutating/destructive SQL (DML, destructive DDL, `GRANT`/`CALL`/`LOAD DATA`/`EXECUTE IMMEDIATE`) on write-capable query tools; the `data-engineering` group is exempt. | soc2, pci-dss, gdpr-ccpa, sox |
| [guard-warehouse-export](./guard-warehouse-export/policy.md) | ingress | Deny SQL exfiltration constructs (`EXPORT DATA`/`EXPORT MODEL`, `EXTERNAL_QUERY`, cross-project persistent writes) and off-allowlist `project_id` targets. | soc2, pci-dss, gdpr-ccpa, sox |
| [fence-sensitive-datasets](./fence-sensitive-datasets/policy.md) | ingress | Deny references to regulated dataset prefixes (`phi_`, `finance_`, `pii_`) on SQL and metadata tools unless the caller holds the mapped data-domain IdP group. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact US SSNs, Luhn-validated payment cards, and email addresses from query-result content (transform-only), with an optional row-truncation guard; the `pii-full-read` group is exempt. | soc2, hipaa, pci-dss, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, so a server registered as `bigquery` surfaces tools like `bigquery-execute_sql`. Both official servers use bare snake_case (`execute_sql`, `execute_sql_readonly`, `list_dataset_ids`) with no vendor prefix, while the community servers diverge: `query` (ergut) and `execute-query`/`list-tables`/`describe-table` (LucasHild, kebab-case). The SQL-inspection policies here match the union of query-tool suffixes (`execute_sql`, `execute_sql_readonly`, `query`, `execute-query`) and deliberately exclude `execute_sql_readonly` from the write/exfil guards by matching its `_readonly` suffix first. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying — and note that `execute_sql` is a suffix of `execute_sql_readonly`, so ordering matters.

## Identity claims

Three of these policies read `input.subject.claims.groups` with **placeholder** group names: `guard-warehouse-sql` (writes exempt for `data-engineering`), `fence-sensitive-datasets` (per-domain groups `clinical-data` / `finance` / `data-privacy` mapped to the `phi_` / `finance_` / `pii_` prefixes), and `redact-pii-egress` (full unredacted reads for `pii-full-read`). Replace these with your own IdP group names at import time. All grants are read through `object.get(input.subject, "claims", {})` chains that **fail closed**: a missing, empty, or malformed claims/groups value means the caller is not exempt.

## Contributing

To add a BigQuery policy:

1. Create `apps/bigquery/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["bigquery"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an existing thematic or framework bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
