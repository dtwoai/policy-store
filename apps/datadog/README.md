# Datadog policies

Reusable DTwo policies for Datadog's official hosted MCP server, which gives agents structured access to logs, APM spans and traces, metrics, events, RUM, monitors, incidents, dashboards, and notebooks. Most of its tools are reads, and Datadog ships **MCP Write Access** switched off by default, so the main risks are *what* the agent reads and how far back it looks (a single broad search can reach months of logs full of personal data and credentials) and, once write access is on, changes to the monitors and dashboards your on-call team depends on.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [read-only-except-notebooks](./read-only-except-notebooks/policy.md) | ingress | Datadog is read-only for the agent, except it can create and edit notebooks to write up an investigation. Dashboard, monitor, and every other write is blocked. | engineering-stack-jira, engineering-stack-linear |
| [cap-search-window](./cap-search-window/policy.md) | ingress | Caps log, span, RUM, and event searches at a 7-day lookback window. Transform-only — searches still run, just over a bounded period. | engineering-stack-jira, engineering-stack-linear |
| [redact-secrets-egress](./redact-secrets-egress/policy.md) | egress | Masks credentials (API keys, tokens, JWTs, private keys) and email addresses in every Datadog response before it reaches the agent. Transform-only. | engineering-stack-jira, engineering-stack-linear |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Datadog server registered as `datadog` surfaces tools like `datadog-search_datadog_logs` (some clients show `datadog-search-datadog-logs`). These policies scope on the `datadog` prefix and accept either `_` or `-` separators. If your server is registered under another name, update the prefix check in each policy, and confirm the exact names your gateway sends with the dump-input debug technique before deploying.

## Identity claims

None of these policies read IdP claims.

## Contributing

To add a Datadog policy:

1. Create `apps/datadog/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["datadog"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
