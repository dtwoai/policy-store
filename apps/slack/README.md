# Slack policies

Reusable DTwo policies for Slack MCP servers (the official Anthropic Slack MCP server and compatible implementations).

## Available policies

| Policy                                     | Direction | Purpose                                                                                    |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------------------------ |
| [block-secrets](./block-secrets/policy.md) | ingress   | Deny send-message calls whose body looks like an API key, password, token, or private key. |
| [deny-channel-creation](./deny-channel-creation/policy.md) | ingress   | Deny Slack channel-creation tool calls; all other Slack tools pass through. |
| [deny-read-search-summarize-sensitive-channels](./deny-read-search-summarize-sensitive-channels/policy.md) | ingress   | Deny read, search, and summarize operations targeting sensitive channels (matched by channel ID). |
| [deny-direct-messages](./deny-direct-messages/policy.md) | ingress   | Deny message-write calls addressed to a direct conversation (1:1 DM, user ID, or group DM). |
| [redact-sensitive-info](./redact-sensitive-info/policy.md) | ingress   | Redact secrets and PII from outgoing message content to `[REDACTED]` (transform-only); all other Slack tools pass through. |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Slack MCP server registered as `slack-mcp` will surface tools like `slack-mcp-slack-post-message`, while one registered as `slack` will surface `slack-slack-post-message`. The policies in this directory match on the *suffix* (`slack-post-message`, `slack-send-message`, etc.) so they stay portable across naming conventions — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

These policies do not require any specific IdP claims. If you want to add identity-based exemptions (e.g., an InfoSec break-glass user), gate the relevant `allow` rule with `object.get(input.subject.claims, "<claim>", "<default>")`.

## Contributing

To add a Slack policy:

1. Create `apps/slack/<policy-slug>/` with `policy.md` and a `tests.md` test file.
2. Add a row to the table above.
3. Declare `apps: ["slack"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/slack`](../../bundles/slack/README.md) or [`bundles/im-messaging`](../../bundles/im-messaging/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
