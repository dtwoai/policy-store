# QuickBooks Online policies

Reusable DTwo policies for Intuit QuickBooks Online (QBO) MCP servers — Intuit's first-party open-source server (`intuit/quickbooks-online-mcp-server`, ~144 tools), the Intuit-published Claude connector bundled in Claude for Small Business (tool names unverified — confirm via `tools/list`), the community LibreChat remote server, and the archived `hvkshetry` mega-tool server. The MCP surface is `verb_entity` reads (`get_*`/`search_*` across 29 entities plus 11 financial reports) and writes (`create_*`/`update_*`/`delete_*`). QBO is the general-ledger system of record: nearly every write is a books-of-record mutation, transaction deletes are **hard deletes** recoverable only from the audit log, journal entries restate the ledger directly, and money-movement tools trigger real payments and refunds. There are no send/email tools, so the blast radius is the ledger itself plus anything that syncs downstream (payroll, tax filings, lender feeds) — which is exactly why the SOX and PII exposure concentrates on writes, money movement, vendor banking data, and whole-ledger bulk reads.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny every destructive QBO call — `delete_*`/`void_*`/`deactivate_*` tools and the mega-tool `operation ∈ {delete, void, deactivate}` — since transaction deletes are unrecoverable hard deletes. | sox, soc2 |
| [gate-money-movement](./gate-money-movement/policy.md) | ingress | Gate money-movement creators (`create_payment`, `create_bill_payment`, `create_refund_receipt`, `create_transfer`, `create_deposit`) behind a finance group and an amount ceiling. | sox, soc2 |
| [protect-closed-periods-journal-entries](./protect-closed-periods-journal-entries/policy.md) | ingress | Deny direct journal-entry writes (`create_journal_entry`/`update_journal_entry`) for every caller except the `controller` group. | sox, soc2 |
| [guard-vendor-banking](./guard-vendor-banking/policy.md) | ingress | Deny `create_vendor`/`update_vendor` calls that carry bank-account, routing/ACH, or tax-ID (EIN/SSN) fields. | sox |
| [cap-bulk-export](./cap-bulk-export/policy.md) | ingress | Clamp the bulk-read levers on every `search_*` call — strip `fetchAll` and cap `limit` at 50 (transform-only). | soc2, gdpr-ccpa |
| [redact-pii-egress-employee](./redact-pii-egress-employee/policy.md) | egress | Mask SSN, EIN, bank-account, and home-address PII in `get_employee`/`search_employees`/`get_vendor`/`search_vendors` responses for callers outside HR/finance. | soc2, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, so a QBO server registered as `quickbooks` surfaces tools like `quickbooks-create-invoice`. These policies match on the *suffix* (`_invoice`, `_payment`, `delete_`, `create_vendor`, etc.), normalize separators (snake_case, camelCase, hyphen) for portability across the official, LibreChat, and connector servers, and — for the archived `hvkshetry` mega-tool shape — also inspect the `operation`/`entity_type` arguments. The Claude connector's exact tool names are **unverified**; confirm the live names your gateway sends with the dump-input debug technique before deploying exact-match rules.

## Identity claims

The identity-gated policies (`gate-money-movement`, `protect-closed-periods-journal-entries`, `redact-pii-egress-employee`, and the vendor-banking guard where applicable) read `input.subject.claims.groups` with **placeholder** group names (e.g. `finance`, `controller`, `hr`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt).

## Contributing

To add a QuickBooks policy:

1. Create `apps/quickbooks/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["quickbooks"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle (e.g. [`bundles/sox`](../../bundles/sox/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
