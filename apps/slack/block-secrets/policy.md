---
name: Block Secrets in Slack Messages
tags:
  - slack
  - secrets
  - dlp
  - ingress
publishedAt: 2026-06-02
description: Blocks Slack send-message tool calls whose message body appears to contain a secret such as an API key, password, token, or private key.
direction: ingress
apps:
  - slack
industries: []
bundles:
  - im-messaging
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
