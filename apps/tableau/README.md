# Tableau policies

Reusable DTwo policies for the official **Tableau MCP** server (`tableau/tableau-mcp`, Salesforce), the "Tableau Supported" analytics/BI connector that Claude and Cowork users hit at the hosted `mcp.tableau.com` endpoint (or self-hosted via npx/Docker). Its MCP surface is 39 web tools across 11 groups: data-returning reads (`query-datasource` VizQL queries, `get-view-data` CSV, view/image renders), catalog and Pulse-KPI metadata, admin-insights telemetry, session-token minting (`get-embed-token`), and a destructive/mutation set (delete datasource/workbook/extract-task, update cloud extract schedule). Its risk profile is dominated by *warehouse-proxy exfiltration*: `query-datasource` and `get-view-data` return raw row-level data — PII, PHI, payroll, financials — from whatever the published datasource connects to, and Tableau's own row-level security applies only where the site configured it. Deletes are recycle-bin recoverable for only a limited window, and `get-embed-token` mints credential-shaped JWTs. These policies pin the tool surface, fence the query and content-mutation paths, and redact sensitive egress. The separate **Tableau Next** product (Salesforce-hosted, snake_case tool names) is a disjoint server and is **not** covered here.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Fail closed on tool drift: allow only the 39 pinned official web tools by suffix; deny every new, renamed, or misspelled name until an operator re-verifies. | soc2, gdpr-ccpa |
| [freeze-destructive-content](./freeze-destructive-content/policy.md) | ingress | Deny the irreversible content-mutation tools (delete datasource/workbook/extract-task, update cloud extract schedule, and their `confirm-` twins) unless the caller is in `tableau-admins`. | soc2, hipaa, gdpr-ccpa, sox |
| [fence-datasource-scope](./fence-datasource-scope/policy.md) | ingress | Fence the warehouse-proxy surface: deny `query-datasource` unless its `datasourceLuid` is in a per-tenant allowlist, and deny view-image renders for non-analyst groups. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [guard-query-calculation](./guard-query-calculation/policy.md) | ingress | Deny `query-datasource` for callers outside `data-analysts` whenever the VDS query carries an arbitrary `calculation` expression (the column-match escape hatch). | pci-dss, gdpr-ccpa |
| [redact-pii-query-results](./redact-pii-query-results/policy.md) | egress | Redact email/phone/national-ID and mask payment-card numbers in the CSV/JSON bodies of the data-returning Tableau tools unless the caller is in `data-analysts` (transform-only). | soc2, hipaa, pci-dss, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Tableau MCP server registered as `tableau-mcp` will surface tools like `tableau-mcp-query-datasource`, while one registered as `tableau` will surface `tableau-query-datasource`. The official server uses **kebab-case with no vendor prefix** (`query-datasource`, `delete-workbook`), so these policies match on the *suffix* (`-query-datasource`, `-get-view-data`, `-delete-workbook`, etc.) to stay portable across naming conventions. Generic suffixes (`list-users`, `search-content`, `list-jobs`) collide with other servers; the policies anchor on the distinctive ones and pin exact names where the landscape note verifies them. The hosted `mcp.tableau.com` server ships new tools automatically as Tableau releases them, so re-verify the exact names your gateway sends (via the dump-input debug technique) and re-check `tools/list` after each upgrade before deploying.

## Identity claims

The identity-gated policies (`freeze-destructive-content`, `fence-datasource-scope`, `guard-query-calculation`, and the exemption branch of `redact-pii-query-results`) read `input.subject.claims.groups` with **placeholder** group names (`tableau-admins`, `data-analysts`). Replace these with your own IdP group names at import time. Missing or malformed claims fail closed for grants (no group → not exempt / not admin). `default-deny-unknown-tools` is a name-only gate and requires no claims.

## Contributing

To add a Tableau policy:

1. Create `apps/tableau/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["tableau"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an existing thematic bundle under [`bundles/`](../../bundles), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
