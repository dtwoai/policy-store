# slack / block-secrets

**Direction:** ingress (`tool_pre_invoke`)
**Default:** deny on match, allow otherwise
**Package:** `slack.ingress.block_secrets`

## What it does

Blocks Slack send-message tool calls whose message body looks like it contains a secret — API keys, passwords, tokens, or PEM-formatted private keys. All other tool calls pass through unchanged.

The check runs at ingress, before the call reaches the Slack MCP server, so a blocked message is never delivered to Slack and never appears in any channel's history.

## Why ingress and not egress

Sending a Slack message is a write with permanent side effects — once the call reaches Slack the message exists in channel history and may already be syndicated to email digests, search indexes, or DMs to other workspace members. Egress redaction would only mask the response to the caller, not the message itself. Ingress denial is the only way to actually prevent the leak.

## Patterns matched

The policy uses a small set of conservative regex patterns. Adding too many patterns dramatically increases false positives, so the list is intentionally focused on high-confidence shapes:

- `password:`, `token:`, `api_key:`, `client_secret:`, etc. in `key: value` or `key=value` form (case-insensitive)
- AWS access key IDs (`AKIA…`) and likely secret access keys
- GitHub personal access tokens (`ghp_…`, `github_pat_…`)
- Slack bot/user/admin tokens (`xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`)
- Stripe live secret keys (`sk_live_…`)
- Google API keys (`AIza…`)
- OpenAI API keys (`sk-…`)
- PEM private key headers (`-----BEGIN … PRIVATE KEY-----`)

Tune this list for your environment. If your team uses other providers (Twilio, SendGrid, Datadog, etc.), add their token shapes to `secret_patterns` in `policy.rego`.

## Tool name matching

The policy matches the Slack send-message tool by suffix:

- `*slack-post-message`
- `*slack-send-message`
- `*postmessage`

The DTwo gateway prefixes tool names with the configured MCP server name (e.g. `slack-mcp-slack-post-message`), and that prefix is not standardized — different deployments use different server names. Matching on the suffix keeps the policy portable, but you should verify the exact name your gateway sends using the [dump-input debug technique](https://docs.dtwo.ai) before relying on this in production.

If the Slack MCP server you use exposes a different tool name for send/post, add it to `is_slack_send_tool` in `policy.rego`.

## Argument shape

The policy reads the message body from two common argument keys, in order:

1. `input.payload.args.text` (used by the official Anthropic Slack MCP server and most community implementations)
2. `input.payload.args.message` (used by a few alternatives)

If your MCP server exposes the body under a different key, add another `message_text` rule.

## Examples

### Allowed

```jsonc
{
  "input": {
    "action": "tool_pre_invoke",
    "resource": { "name": "slack-mcp-slack-post-message", "type": "tool" },
    "payload": {
      "name": "slack-mcp-slack-post-message",
      "args": { "channel": "C123", "text": "lunch in 5" }
    }
  }
}
```

`allow = true`, no reason.

### Denied

```jsonc
{
  "input": {
    "action": "tool_pre_invoke",
    "resource": { "name": "slack-mcp-slack-post-message", "type": "tool" },
    "payload": {
      "name": "slack-mcp-slack-post-message",
      "args": { "channel": "C123", "text": "here's the api_key: sk-abcdef0123456789abcdef0123456789" }
    }
  }
}
```

`allow = false`, `reason = "This Slack message looks like it contains a secret (...)"`.

## Composition

This policy is single-purpose. Useful companions:

- A separate ingress policy that **redacts** rather than blocks (for environments where rejecting the call is too disruptive — replace this policy with a transform-only version that rewrites `text`).
- An egress PII redaction policy on Slack search/history tools so previously-posted secrets are masked when read back.

See the [`bundles/im-messaging`](../../../bundles/im-messaging/README.md) bundle for the curated set.

## Known limitations

- **Regex over plain text.** Secrets concatenated into longer sentences may still match; secrets that don't match a known shape (rotating short-lived tokens, custom-format keys) will not. Treat this as a high-signal first line of defense, not a complete DLP solution.
- **Attachments and blocks not inspected.** Slack send-message tools accept `attachments` and `blocks` arguments containing structured content. This policy only inspects the top-level `text` / `message` string. Extend `message_text` rules if your environment routinely sends secret-laden content through those fields.
- **No identity-based exemptions.** All callers are subject to the same check. If you need an InfoSec break-glass user that can post anything, gate it with `input.subject.claims` as a separate `allow if` branch.
