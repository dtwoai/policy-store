# Snowflake policies

Reusable DTwo policies for Snowflake MCP servers — the Snowflake-managed remote MCP server (the GA implementation Anthropic co-announced and the one used as a Claude organization connector), plus the deprecated-but-deployed `snowflake-labs-mcp` OSS server and the `isaacwasserman/mcp-snowflake-server` community server. Snowflake is the app where the "tool name" abstraction is weakest: the dangerous surface is a **SQL string inside a single tool argument**, tool names are admin-chosen and carry no stable semantics, and the server exposes composite tools (Cortex Agents, `GENERIC` UDF/procedure wrappers) whose execution the gateway cannot inspect one statement at a time. Its risk profile is dominated by *data movement and mutation*: a single `run_snowflake_query` / `SYSTEM_EXECUTE_SQL` call can drop a database, unload a regulated table to external cloud storage, share objects out to an external account, or return raw PII/PHI rows to the agent. These policies therefore combine tool-name matching with argument (query-text) inspection, and lean on a default-deny anchor because there is no canonical name to suffix-match.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Pin an allowlist of the exact Snowflake tool names you audited and deny every other tool on the Snowflake server(s); the anchor policy for the whole set. | soc2, gdpr-ccpa |
| [deny-composite-cortex-tools](./deny-composite-cortex-tools/policy.md) | ingress | Deny the opaque composite and generic passthrough tools (Cortex Agent runs, `GENERIC` UDF/stored-procedure wrappers) the gateway cannot inspect statement-by-statement. | — |
| [guard-warehouse-sql](./guard-warehouse-sql/policy.md) | ingress | Deny mutating/destructive SQL (`DROP`/`TRUNCATE`/`DELETE`/`UPDATE`/`INSERT`/`MERGE`/`ALTER`/`CREATE`/`GRANT`/`REVOKE`) and the Labs structured-DDL tools, making any connection effectively read-only. | soc2, pci-dss, sox |
| [guard-warehouse-export](./guard-warehouse-export/policy.md) | ingress | Deny SQL that moves whole tables off the Snowflake perimeter — bulk `COPY INTO` stage/cloud-URL unloads and `GRANT … TO SHARE` external data sharing. | soc2, pci-dss, gdpr-ccpa |
| [fence-sensitive-schemas](./fence-sensitive-schemas/policy.md) | ingress | Deny SQL that references customer-designated sensitive data domains (`PII_`/`PHI_`/`HR_`/`FINANCE_` prefixes, plus `SELECT *`) unless the caller is in the mapped IdP group. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact SSNs, email addresses, and phone numbers from Snowflake query result rows before the response reaches the agent (transform-only). | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and — unlike most apps — Snowflake has **no canonical tool names to suffix-match**: on the managed server every tool is an admin-defined entry with a user-chosen `name` (the SQL tool may be `execute-sql`, `run-query`, `sales-sql`, anything), and on the Labs/community servers the Cortex tools are named after `service_name` entries in the admin's YAML. The SQL-inspection policies (`guard-warehouse-sql`, `guard-warehouse-export`, `fence-sensitive-schemas`) therefore key on the **SQL text in the `query` argument** rather than the tool name, and match the small set of verified stable names (`run_snowflake_query`, `SYSTEM_EXECUTE_SQL`, `write_query`, `read_query`, the Labs `create_object`/`create_or_alter_object`/`drop_object` DDL tools) where they exist. Because renamed or newly published tools cannot be recognized this way, **`default-deny-unknown-tools` is the anchor**: pin it first so the other policies only ever see a request that already passed the allowlist. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

`default-deny-unknown-tools`, `deny-composite-cortex-tools`, `guard-warehouse-sql`, and `guard-warehouse-export` require no IdP claims. The identity-gated policies read `input.subject.claims.groups` with **placeholder** group names — `fence-sensitive-schemas` maps data domains to groups (`pii-cleared`, `phi-cleared`, `hr`, `finance`), and `guard-warehouse-sql`/`guard-warehouse-export` carry a break-glass exemption for a `data-platform-admins` group, and `redact-pii-egress` exempts a cleared group from redaction. Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt / still guarded).

## Contributing

To add a Snowflake policy:

1. Create `apps/snowflake/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["snowflake"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework or thematic bundle, add its slug to `bundles` in the frontmatter and link to it from the matching bundle landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
</content>
</invoke>
