# HubSpot policies

Reusable DTwo policies for HubSpot MCP servers (the HubSpot-hosted MCP server and compatible implementations).

## Available policies

| Policy                                                   | Direction | Purpose                                                                                          |
| -------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| [block-deal-closure](./block-deal-closure/policy.md)     | ingress   | Deny CRM-object calls that move a deal into a closed stage (`closedwon` / `closedlost`); all other deal changes and tools pass through. |
| [protect-associations](./protect-associations/policy.md) | ingress   | Deny CRM-object calls that create or change object associations; all other calls pass through. |
| [protect-deal-owner](./protect-deal-owner/policy.md)     | ingress   | Deny deal-update calls that set or change `hubspot_owner_id`; deal creates and other fields pass through. |
| [protect-lifecycle-stage](./protect-lifecycle-stage/policy.md) | ingress   | Deny contact create/update calls that set or change `lifecyclestage`; all other calls pass through. |
| [read-only](./read-only/policy.md)                       | ingress   | Block all HubSpot writes (the `*-manage-crm-objects` tool); read/search/list tools pass through. |
| [redact-pii](./redact-pii/policy.md)                     | egress    | Redact contact PII (phone, email, fax, SSN) from HubSpot tool responses. Transform-only — never denies. |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A HubSpot MCP server registered as `hubspot` surfaces tools like `hubspot-manage-crm-objects`, while one registered under another name (e.g. `hubspot-mcp`) would surface `hubspot-mcp-manage-crm-objects`. The `block-deal-closure` policy matches on the *suffix* (`-manage-crm-objects`) so it stays portable across naming conventions. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

These policies do not require any specific IdP claims. If you want identity-based exemptions (e.g., a break-glass role that can close deals), gate the relevant rule with `object.get(input.subject.claims, "<claim>", "<default>")`.

## Contributing

To add a HubSpot policy:

1. Create `apps/hubspot/<policy-slug>/` with `policy.md` and optional `tests/` sample inputs.
2. Add a row to the table above.
3. Declare `apps: ["hubspot"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/hubspot`](../../bundles/hubspot/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
