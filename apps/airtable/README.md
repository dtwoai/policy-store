# Airtable policies

Reusable DTwo policies for Airtable MCP servers — the official remote server that the Claude connector fronts (`https://mcp.airtable.com/mcp`, OAuth 2.0), plus the dominant community/local implementations (`domdomegg/airtable-mcp-server`, `rashidazarang/airtable-mcp`). The MCP surface is read/discovery tools (list and search records, schema and base discovery, interface pages), data-write tools (create/update records, attachment upload), schema/structure tools (create base/table/field, create/publish interface), and — on the community `domdomegg` server — a batch `delete_records`. Its risk profile is dominated by *bulk PII egress* and *irreversible writes*: a single `list_records` or `search_records` call can drain an entire table of CRM contacts, applicant-tracking rows, or (on HIPAA-eligible Enterprise) health-ops data, and `filterByFormula` enables targeted extraction. The official remote server has **no** record- or table-delete tool, but the community servers do, and `update_records` overwrites are the effective destructive path everywhere. Tool naming diverges sharply between servers (verbose `*_for_table` suffixes on the official server, terse `create_record`/`delete_records` on community ones), so these policies match on the *suffix* to stay portable across both spellings.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Allowlist audited Airtable tool names; deny (and alert on) any unrecognized, renamed, or newly-added upstream tool. | soc2, gdpr-ccpa |
| [fence-base-allowlist](./fence-base-allowlist/policy.md) | ingress | Deny record calls whose `baseId` argument is not in the approved allowlist, confining the agent to sanctioned bases even when the OAuth grant spans the workspace. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [freeze-record-deletion](./freeze-record-deletion/policy.md) | ingress | Deny destructive record/page delete tools so records survive agent error or prompt injection; points users to the web UI for deletions. | soc2, hipaa, gdpr-ccpa, sox |
| [cap-bulk-record-reads](./cap-bulk-record-reads/policy.md) | ingress | Clamp `maxRecords` down to ≤50 on bulk record-list tools (injecting it when absent or invalid) and strip `filterByFormula` for callers outside the analyst group. | soc2, hipaa, gdpr-ccpa |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact SSN, email, and phone patterns from record-read responses for callers outside a data-privileged group. | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, so a server registered as `airtable` surfaces tools like `airtable-list_records_for_table` or `airtable-delete_records`. Airtable's servers also diverge on the tool names themselves: the official remote server uses verbose suffixed names (`list_records_for_table`, `create_records_for_table`, `update_records_for_table`), while `domdomegg` uses terse ones (`list_records`, `create_record`, `delete_records`). The policies here match on the *suffix* (e.g. `*record*`, `*delete*`) so they cover both spellings, but you should confirm the exact tool names your gateway sends with the dump-input debug technique before deploying. The `rashidazarang/airtable-mcp` server (42 advertised tools, including webhook management) has **unverified** individual tool names — treat any per-tool policy against it as requiring live introspection first, as noted in each policy's Known limitations.

## Identity claims

The identity-gated policies (`cap-bulk-record-reads` formula-strip exemption, `redact-pii-egress`) read `input.subject.claims.groups` with **placeholder** group names (e.g. `analyst`, `data-privileged`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt / redaction still applies).

## Contributing

To add an Airtable policy:

1. Create `apps/airtable/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["airtable"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
