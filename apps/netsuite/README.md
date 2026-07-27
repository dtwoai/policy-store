# NetSuite policies

Reusable DTwo policies for Oracle NetSuite MCP servers — the official NetSuite AI Connector Service + MCP Standard Tools SuiteApp (the endpoint the Claude connector uses directly), the `dsvantien/netsuite-mcp-server` community proxy that surfaces the same `ns_*` tools, and adjacent community wrappers. The MCP surface is read tools (`ns_getRecord`, `ns_runCustomSuiteQL` arbitrary read-only SQL over the whole ERP, `ns_runSavedSearch`/`ns_runReport`, metadata helpers) and two write tools (`ns_createRecord`, `ns_updateRecord`) that create or overwrite any REST-exposed record type. Its risk profile is dominated by *financial integrity and exfiltration*, not deletion: there is no delete tool, but `ns_runCustomSuiteQL` is a one-query path to employee PII/HR data, full vendor/customer master data (including bank details), and pre-earnings GL results; `ns_updateRecord` on a vendor is the classic BEC payment-fraud vector; a posted journal in a closed period is a restatement risk; and the `/v1/all` endpoint can expose arbitrary account-specific SuiteScript tools whose side effects are unknowable in advance.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Default-deny any NetSuite tool whose suffix is not in the audited standard `ns_*` allowlist, so custom SuiteScript tools on `/v1/all` must be explicitly allow-listed before agents can call them. | soc2, gdpr-ccpa |
| [guard-vendor-banking](./guard-vendor-banking/policy.md) | ingress | Deny `ns_createRecord`/`ns_updateRecord` on vendor records that touch bank/payment fields (account, routing, sort code, IBAN, payment method) unless the caller is in an AP-manager group — anti-BEC. | sox, soc2 |
| [protect-closed-periods](./protect-closed-periods/policy.md) | ingress | Deny financial-transaction writes (journalentry, vendorbill, vendorpayment, and peers) unless the caller is in a finance group, protecting posted/closed-period books. | sox, soc2 |
| [fence-hr-payroll-suiteql](./fence-hr-payroll-suiteql/policy.md) | ingress | Deny `ns_runCustomSuiteQL` over HR/payroll tables and `ns_runSavedSearch` identifiers naming payroll/HR unless the caller is in an HR group. | gdpr-ccpa, soc2 |
| [cap-bulk-export](./cap-bulk-export/policy.md) | ingress | Clamp the `ns_runCustomSuiteQL` `pageSize` argument down to a configurable ceiling (default 100), throttling one-shot mass export of ERP master data (transform-only). | soc2, gdpr-ccpa |
| [redact-financial-pii](./redact-financial-pii/policy.md) | egress | Redact SSN/TIN, bank-account, routing/ABA, and IBAN-shaped strings from NetSuite read responses before they reach the agent context (transform-only). | gdpr-ccpa, soc2 |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A NetSuite MCP server registered as `netsuite` will surface tools like `netsuite-ns_createRecord`, while one registered as `ns` will surface `ns-ns_createRecord`. The official server and the `dsvantien` proxy share the `ns_` prefix with camelCase verbs (`ns_runCustomSuiteQL`), so the policies in this directory match on the *suffix* (`ns_createrecord`, `ns_runcustomsuiteql`, etc., case-insensitively) to stay portable across naming conventions. The independent community wrappers use incompatible conventions (`get-*` for ChatFin, `netsuite_*` for glints-dev) with different argument shapes and are **not** covered by these `ns_*`-keyed policies. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying — and on `/v1/all` accounts, pin `default-deny-unknown-tools` to your audited full gateway tool names rather than relying on suffix matching alone (see that policy's Known limitations).

## Identity claims

Several of these policies are single-purpose and require no IdP claims (`default-deny-unknown-tools`, `cap-bulk-export`, `redact-financial-pii`). The identity-gated ones read `input.subject.claims.groups` with **placeholder** group names: `guard-vendor-banking` exempts an AP-manager group, `protect-closed-periods` gates on a `finance` group, and `fence-hr-payroll-suiteql` exempts an `hr` group. Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt).

## Contributing

To add a NetSuite policy:

1. Create `apps/netsuite/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["netsuite"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle (`soc2`, `sox`, `gdpr-ccpa`, …), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
