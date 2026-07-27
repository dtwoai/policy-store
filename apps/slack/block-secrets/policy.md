---
name: Block Secrets in Slack Messages
tags:
  - slack
  - secrets
  - dlp
  - ingress
  - soc2
  - iso27001-nist
publishedAt: 2026-07-12
description: |
  # slack / block-secrets

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `slack.ingress.block_secrets`

  ## What it does

  Blocks Slack send-message tool calls whose message body looks like it contains a secret — API keys, passwords, tokens, or PEM-formatted private keys. All other tool calls pass through unchanged.

  The check runs at ingress, before the call reaches the Slack MCP server, so a blocked message is never delivered to Slack and never appears in any channel's history.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of confidential information by stopping credentials from moving into Slack over the agent channel; **CC6.6** — hardens the boundary by keeping secrets out of a third-party workspace an attacker could read.
  - **PCI DSS 8.6.2** — supports the prohibition on credentials appearing outside secure storage by blocking passwords, keys, and tokens from being posted to Slack.
  - **ISO 27001 A.8.12** — data leakage prevention on the agent's Slack write path.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing: authentication secrets that could expose personal data never land in chat history.

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

  Tune this list for your environment. If your team uses other providers (Twilio, SendGrid, Datadog, etc.), add their token shapes to `secret_patterns` in `policy.md`.

  ## Tool name matching

  The policy matches the Slack send-message tool by suffix:

  - `*slack-post-message`
  - `*slack-send-message`
  - `*postmessage`

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g. `slack-mcp-slack-post-message`), and that prefix is not standardized — different deployments use different server names. Matching on the suffix keeps the policy portable, but you should verify the exact name your gateway sends using the [dump-input debug technique](https://docs.dtwo.ai) before relying on this in production.

  If the Slack MCP server you use exposes a different tool name for send/post, add it to `is_slack_send_tool` in `policy.md`.

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

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - slack
industries: []
bundles:
  - im-messaging
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.ingress.block_secrets

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Patterns that look like secrets in plain text. Anchored to common shapes
# (key=value pairs and provider-specific prefixes) to limit false positives.
secret_patterns := [
    # Generic password / token / api_key / secret_key in `key: value` or `key=value` form
    `(?i)(?:password|passwd|secret|token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+`,
    # AWS access key IDs
    `AKIA[0-9A-Z]{16}`,
    # AWS secret access keys (40-char base64-ish)
    `(?i)aws(.{0,20})?(secret|access)?.{0,20}[\s:=]+[A-Za-z0-9/+=]{40}`,
    # GitHub fine-grained / classic personal access tokens
    `ghp_[A-Za-z0-9]{36}`,
    `github_pat_[A-Za-z0-9_]{82}`,
    # Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-)
    `xox[baprs]-[A-Za-z0-9-]{10,}`,
    # Stripe live secret keys
    `sk_live_[A-Za-z0-9]{24,}`,
    # Google API keys
    `AIza[0-9A-Za-z\-_]{35}`,
    # OpenAI API keys
    `sk-[A-Za-z0-9]{20,}`,
    # Generic private key headers
    `-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`,
]

# Slack send-message tools we want to inspect. The gateway prefixes tool
# names with the configured MCP server name (e.g. `slack-mcp-`), so we match
# on the suffix to stay portable across naming conventions. Verify the exact
# tool name on your gateway with the dump-input debug technique before relying
# on this in production.
is_slack_send_tool if {
    name := lower(input.resource.name)
    endswith(name, "slack-post-message")
}

is_slack_send_tool if {
    name := lower(input.resource.name)
    endswith(name, "slack-send-message")
}

is_slack_send_tool if {
    name := lower(input.resource.name)
    endswith(name, "postmessage")
}

# Allow any tool that isn't a Slack send-message call.
allow if {
    not is_slack_send_tool
}

# Allow Slack send-message calls only when no secret pattern matches the body.
allow if {
    is_slack_send_tool
    not message_contains_secret
}

# Pull the message body from the common argument names Slack MCP servers use.
message_text := text if {
    text := object.get(input.payload.args, "text", "")
    text != ""
}

message_text := text if {
    object.get(input.payload.args, "text", "") == ""
    text := object.get(input.payload.args, "message", "")
    text != ""
}

# Detect a secret pattern in the message body.
message_contains_secret if {
    some pattern in secret_patterns
    regex.match(pattern, message_text)
}

reasons contains "This Slack message looks like it contains a secret (API key, password, token, or private key). Send credentials through your secret manager instead. Contact your InfoSec team if this was a false positive." if {
    is_slack_send_tool
    message_contains_secret
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
