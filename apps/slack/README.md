# Slack policies

Reusable DTwo policies for Slack MCP servers (the official Anthropic Slack MCP server and compatible implementations).

## Available policies

| Policy | Direction | Purpose |
|---|---|---|
| [block-secrets](./block-secrets/README.md) | ingress | Deny send-message calls whose body looks like an API key, password, token, or private key. |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Slack MCP server registered as `slack-mcp` will surface tools like `slack-mcp-slack-post-message`, while one registered as `slack` will surface `slack-slack-post-message`. The policies in this directory match on the *suffix* (`slack-post-message`, `slack-send-message`, etc.) so they stay portable across naming conventions — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

These policies do not require any specific IdP claims. If you want to add identity-based exemptions (e.g., an InfoSec break-glass user), gate the relevant `allow` rule with `object.get(input.subject.claims, "<claim>", "<default>")`.

## Contributing

To add a Slack policy:

1. Create `apps/slack/<policy-slug>/` with `policy.rego`, `README.md`, and `metadata.json`.
2. Add a row to the table above.
3. Register the policy in the top-level `catalog.json` under `apps.slack.policies`.
4. If the policy fits an industry or bundle (e.g. [`bundles/im-messaging`](../../bundles/im-messaging/README.md)), link to it from the matching landing page.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
