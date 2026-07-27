# Salesforce policies

Reusable DTwo policies for Salesforce MCP servers — the Salesforce-hosted `sobject-*` servers that the Claude connector uses (`sobject-all`, `sobject-reads`, `sobject-mutations`, `sobject-deletes`), plus the community implementations power users run locally (`tsmztech/mcp-server-salesforce`, `smn2gnt/MCP-Salesforce`). The MCP surface is generic CRUD over every sobject: read/query tools (SOQL, SOSL search, schema, related records), write tools (create/update by object), destructive delete tools, and — on the community servers — raw code/API escape hatches (`execute_anonymous`, `apex_execute`, `tooling_execute`, `restful`). Its risk profile is dominated by *breadth and irreversibility*: one generic tool fronts every object (so policy is argument-shaped, not tool-shaped), SOQL/SOSL can bulk-read the org's PII/PHI in a single call, deletes are only recycle-bin recoverable for ~15 days and cascade to child records, and the escape hatches bypass every object-level control by design.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [read-only](./read-only/policy.md) | ingress | Allowlist Salesforce read tools and deny all writes (fail-closed); non-Salesforce tools pass through. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Allow reads for everyone, gate create/update writes behind an IdP group, and fail closed on unrecognized Salesforce tools; deletes pass to `freeze-record-deletes`. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [query-allowlist](./query-allowlist/policy.md) | ingress | Restrict SOQL queries to Account, Contact, and Opportunity objects; other Salesforce and non-Salesforce tools pass through. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [cap-bulk-export](./cap-bulk-export/policy.md) | ingress | Require a `LIMIT` ≤ 1000 on SOQL reads of Contact/Lead/Account and gate org-wide SOSL search behind an IdP group, to block bulk PII extraction. | soc2, hipaa, gdpr-ccpa |
| [protect-contact-fields](./protect-contact-fields/policy.md) | ingress | Deny Contact updates that modify protected fields (ownership, account linkage, PII, name, consent flags); other field updates and tools pass through. | soc2, hipaa, gdpr-ccpa |
| [guard-opportunity-pipeline](./guard-opportunity-pipeline/policy.md) | ingress | Deny Opportunity updates that move `StageName`, `Amount`, or `CloseDate` unless the caller is in a sales-managers IdP group; other fields and objects pass through. | soc2, sox, gdpr-ccpa |
| [freeze-record-deletes](./freeze-record-deletes/policy.md) | ingress | Deny all record-delete capability (hosted, community, and the `salesforce_dml_records` delete verb) unless the caller is in an `sf-admins` IdP group. | soc2, hipaa, gdpr-ccpa, sox |
| [deny-escape-hatches](./deny-escape-hatches/policy.md) | ingress | Unconditionally deny the community raw-code/raw-API tools (`execute_anonymous`, `write_apex`, `apex_execute`, `tooling_execute`, `restful`, `manage_field_permissions`) that bypass object-level policy. | — |
| [redact-pii](./redact-pii/policy.md) | egress | Redact contact PII (email, phone, fax, mailing address, birthdate, SSN, card numbers) from Salesforce responses. Transform-only — never denies. | soc2, hipaa, pci-dss, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Salesforce MCP server registered as `salesforce` surfaces tools like `salesforce-updatesobjectrecord`, while one registered under another name would surface `<name>-updatesobjectrecord`. Because the hosted sibling servers use *different* names for the same capability (`soql_query` vs `executeQuery` vs `querySobjects`; `createSobjectRecord` vs `createRecord`) and the community servers add their own prefixes (`salesforce_` for tsmztech, unprefixed snake_case for smn2gnt), these policies match on the *suffix* case-insensitively and cover every known variant. The GA hosted docs use camelCase names; beta-era snake_case names (`run_soql_query`, `create_records`) also appear in the wild. Always confirm the exact tool names your gateway sends using the dump-input debug technique before deploying, and re-check any `sobject-reads` names against a live `tools/list` (not fully verified in the landscape research).

## Identity claims

Several policies are single-purpose and require no IdP claims (`read-only`, `query-allowlist`, `protect-contact-fields`, `deny-escape-hatches`, `redact-pii`). The identity-gated ones read `input.subject.claims.groups` with **placeholder** group names: `role-gate-writes` and `cap-bulk-export` use `sales` / `support`, `guard-opportunity-pipeline` uses `sales-managers`, and `freeze-record-deletes` uses `sf-admins`. Replace these with your own IdP group names at import time. Missing or non-array claims fail closed for grants (no group → not exempt). `deny-escape-hatches` has **no** group exemption by design — an identity carve-out there would hand that identity a bypass of every other Salesforce policy.

## Contributing

To add a Salesforce policy:

1. Create `apps/salesforce/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["salesforce"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/crm`](../../bundles/crm/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
