# Clay policies

Reusable Dtwo policies for Clay's MCP server. Clay is a data enrichment and workflow tool: it searches public people and company data, enriches records through a waterfall of providers, and runs "functions" (subroutines) — reusable workflows that can be simple enrichments or custom automations that push data into a CRM, a sequencer, or a webhook. Its risk profile is dominated by *side effects through functions* (a custom function can change Salesforce or HubSpot records without going through the CRM's own MCP connection or its policies), *credit spend* (every enrichment and every subroutine input consumes credits, and one call can fan out to hundreds of records), and *contact PII* (work emails and mobile numbers).

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [subroutine-allowlist](./subroutine-allowlist/policy.md) | ingress | Only Clay's built-in enrichment functions can run through `run-subroutine*`; custom functions, which can push data into a CRM or webhook, are blocked. | gtm-stack-hubspot, gtm-stack-salesforce |
| [cap-enrichment](./cap-enrichment/policy.md) | ingress | Deny enrichment calls over 50 records (`inputs` / `entityIds`) or 5 data points; the agent splits the batch. | gtm-stack-hubspot, gtm-stack-salesforce |

## Tool naming on the Dtwo gateway

Dtwo prefixes tool names with the MCP server name configured on the gateway. A Clay server registered as `clay` surfaces tools like `clay-search-companies`, `clay-add-contact-data-points` and `clay-run-subroutine-direct`. Subroutines are identified by `subroutine_id` (e.g. `t_0tm6n9mtip5BqhnMv5d`), which `list-subroutines` returns along with each function's name. Always confirm the exact tool names and IDs your gateway sends before deploying.

## Contributing

To add a Clay policy:

1. Create `apps/clay/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["clay"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
