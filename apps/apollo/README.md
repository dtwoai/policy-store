# Apollo policies

Reusable Dtwo policies for Apollo.io's MCP server — the Apollo-hosted remote server at `https://mcp.apollo.io/mcp` that the Claude connector uses. Apollo combines a B2B contact database with a lightweight CRM and an outreach engine, so its MCP surface spans three risk classes: *reads of prospect PII at scale* (people search and enrichment return work emails and phone numbers, and spend credits), *CRM writes* (contacts, accounts, deals, lists, tasks), and *outreach that leaves the company* (adding people to sequences and sending emails reaches real prospects and can't be undone).

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [read-only](./read-only/policy.md) | ingress | Block every Apollo write — record creates and updates, sequence enrollment, email sends, imports, purchases; search and enrichment pass through. | gtm-stack-hubspot, gtm-stack-salesforce |
| [cap-search](./cap-search/policy.md) | ingress | Clamp Apollo search `per_page` to 50 (transform-only); reads still work, in smaller pages. | gtm-stack-hubspot, gtm-stack-salesforce |

## Tool naming on the Dtwo gateway

Dtwo prefixes tool names with the MCP server name configured on the gateway. Apollo's own tool names follow its REST API (`apollo_contacts_create`, `apollo_emailer_campaigns_add_contact_ids`, `apollo_mixed_people_api_search`), so a server registered as `apollo` surfaces them as `apollo-apollo_contacts_create` and so on. The policies here scope to tools whose name starts with `apollo` and detect writes by verb token, so they keep working as Apollo adds tools. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Contributing

To add an Apollo policy:

1. Create `apps/apollo/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["apollo"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
