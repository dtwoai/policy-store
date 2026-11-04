# Splunk policies

Reusable DTwo policies for Splunk's official **Splunk MCP Server** app (Splunk Cloud Platform and Splunk Enterprise), whose core tool `splunk_run_query` runs SPL on the agent's behalf, alongside index, metadata, alert, and saved-search tools and the `saia_` / `o11y_` families. The risk profile is shaped by SPL itself: a "search" can delete events, write to indexes and lookups, email results out, call scripts, or query connected databases; a search with no time range scans all time; and raw events routinely carry credentials and personal data.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [block-write-commands](./block-write-commands/policy.md) | ingress | Deny searches that pipe into a command that writes, deletes, or sends data (`delete`, `collect`, `outputlookup`, `sendemail`, `script`, `dbxquery`, …). Read-only searches pass. | engineering-stack-jira, engineering-stack-linear |
| [cap-search](./cap-search/policy.md) | ingress | Add `earliest=-24h` to searches with no time range and trim any `earliest` older than 7 days to `-7d`. Transform-only. | engineering-stack-jira, engineering-stack-linear |
| [redact-secrets-egress](./redact-secrets-egress/policy.md) | egress | Masks credentials (API keys, tokens, JWTs, private keys) and email addresses in every Splunk response before it reaches the agent. Transform-only. | engineering-stack-jira, engineering-stack-linear |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Splunk server registered as `splunk` surfaces tools like `splunk-splunk_run_query`. These policies scope on the `splunk` prefix and read SPL from the `query` argument (the official server), falling back to `search` or `spl` for community servers. If your server is registered under another name, update the prefix check in each policy, and confirm the exact names and arguments your gateway sends with the dump-input debug technique before deploying.

## Identity claims

None of these policies read IdP claims.

## Contributing

To add a Splunk policy:

1. Create `apps/splunk/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["splunk"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
