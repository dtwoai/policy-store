# Gusto policies

Reusable DTwo policies for Gusto MCP servers — the official Gusto remote MCP server (`https://mcp.api.gusto.com`) that Claude connector users get, plus compatible community wrappers (`Savinda96/gusto-mcp`, MCPBundles) and write-capable aggregators (StackOne). The official server's MCP surface is **read-only** (36 tools spanning company, employee, contractor, payroll, and time-tracking data), so the dominant risk is not deletion but **egress of regulated payroll data and PII** — salaries, home addresses, contractor payments, termination history, and (on community/aggregator servers) bank-account and tax identifiers. Nearly every tool returns regulated data, a single broad list call can pull the whole roster, and Gusto's own docs warn against mixing this server with others in one session — exactly the cross-connector exfiltration a gateway addresses. Write and delete surfaces (including payroll deletion) exist only via third-party aggregators, so these policies also hold a deny-by-default line against write-shaped tools that the official server does not yet expose.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [fence-comp-payroll-reads](./fence-comp-payroll-reads/policy.md) | ingress | Deny compensation and payroll read tools (`get_compensation`, `list_job_compensations`, `get_payroll`, `list_company_payrolls`, `list_company_contractor_payments`) unless the caller's IdP claims include the payroll-admin group. | soc2, gdpr-ccpa, sox, hr |
| [freeze-payroll-writes](./freeze-payroll-writes/policy.md) | ingress | Deny all write-shaped Gusto tools (create/update/delete/submit), including camelCase and aggregator name forms — a no-op on the read-only official server, a guardrail for StackOne-style write surfaces. | sox, soc2 |
| [cap-roster-export](./cap-roster-export/policy.md) | ingress | Clamp pagination `per` to ≤25 and strip `include=custom_fields` on `list_company_employees` / `list_company_contractors` for non-HR callers (transform-only) to throttle full-roster exfiltration. | gdpr-ccpa, soc2 |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Strict allowlist of the 36 official read-only Gusto tools; deny anything else (write-shaped, aggregator, renamed, or otherwise unknown). | soc2, gdpr-ccpa |
| [redact-financial-ids-egress](./redact-financial-ids-egress/policy.md) | egress | Mask SSN, bank-account, and routing-number strings in Gusto MCP responses regardless of tool (transform-only). | soc2, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Gusto MCP server registered as `gusto` will surface tools like `gusto-get_payroll`, while one registered as `gusto-mcp` will surface `gusto-mcp-get_payroll`. The official server uses bare `snake_case` names with **no vendor prefix** (two exceptions carry `gusto` mid-name: `list_gusto_companies`, `get_gusto_employee`), so the read-gating policies here anchor on the full official names by suffix rather than on a `gusto_` prefix that mostly does not exist. Community servers (`Savinda96/gusto-mcp`) use `kebab-case` and aggregators (StackOne) use unified `hris_*`-style names that were **not verified verbatim** — per-server pipelines with per-implementation name lists are safer than one generic Gusto policy. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

The read-gating policies (`fence-comp-payroll-reads`, and the exemption branch of `cap-roster-export`) read `input.subject.claims.groups` with a **placeholder** group name (`hr-payroll-admins`). Replace it with your own IdP group name at import time. Missing claims fail closed for grants (no group → not exempt). The remaining policies (`freeze-payroll-writes`, `default-deny-unknown-tools`, `redact-financial-ids-egress`) require no IdP claims.

## Contributing

To add a Gusto policy:

1. Create `apps/gusto/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["gusto"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
