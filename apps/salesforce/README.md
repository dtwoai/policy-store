# Salesforce policies

Reusable DTwo policies for Salesforce MCP servers (the Salesforce-hosted MCP server and compatible implementations).

## Available policies

| Policy                                                       | Direction | Purpose                                                                                          |
| ------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------- |
| [protect-contact-fields](./protect-contact-fields/policy.md) | ingress   | Deny Contact updates that modify protected fields (ownership, account linkage, PII, name, consent flags); other field updates and tools pass through. |
| [query-allowlist](./query-allowlist/policy.md)               | ingress   | Restrict SOQL queries to Account, Contact, and Opportunity objects; other Salesforce tools and non-Salesforce tools pass through. |
| [read-only](./read-only/policy.md)                           | ingress   | Allowlist Salesforce read tools and deny all writes (fail-closed); non-Salesforce tools pass through. |
| [redact-pii](./redact-pii/policy.md)                         | egress    | Redact contact PII (email, phone, fax, mailing address, birthdate, SSN, card numbers) from Salesforce responses. Transform-only — never denies. |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Salesforce MCP server registered as `salesforce` surfaces tools like `salesforce-updatesobjectrecord`, while one registered under another name would surface `<name>-updatesobjectrecord`. The policies in this directory match on the *suffix* (e.g. `-updatesobjectrecord`) so they stay portable across naming conventions. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

These policies do not require any specific IdP claims. If you want identity-based exemptions (e.g., a break-glass role that can edit protected fields), gate the relevant rule with `object.get(input.subject.claims, "<claim>", "<default>")`.

## Contributing

To add a Salesforce policy:

1. Create `apps/salesforce/<policy-slug>/` with `policy.md` and optional `tests/` sample inputs.
2. Add a row to the table above.
3. Declare `apps: ["salesforce"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/crm`](../../bundles/crm/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
