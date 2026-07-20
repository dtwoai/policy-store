---
name: Block Secrets in Zoom Team Chat
tags:
  - zoom
  - block-secrets
  - dlp
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # zoom / block-secrets-chat

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `zoom.ingress.block_secrets_chat`

  ## What it does

  Blocks Zoom **Team Chat** send/update tool calls whose `message_content` looks
  like it contains a live secret — API keys, passwords, bearer tokens, or
  PEM-formatted private keys. All other tool calls pass through unchanged.

  The two guarded tools are the Team Chat write verbs:

  - `*zoom_chat_message_send`
  - `*zoom_chat_message_update`

  The check runs at ingress, before the call reaches the Zoom Team Chat MCP
  server, so a blocked message is never posted into Team Chat history — where it
  would be visible to other channel members immediately and retained by channel
  search permanently. This is the same conservative, anchored pattern set used by
  the Slack `block-secrets` model policy, retargeted at Zoom Team Chat's argument
  shape and tool names.

  ## Compliance alignment

  - **SOC 2 CC6.6** — supports boundary protection against external threats by keeping credentials out of a third-party workspace (Zoom Team Chat) whose history an attacker or over-broad member could read.

  All alignment is on the MCP path only (see the compliance note below).

  ## Why ingress and not egress

  Sending or updating a Team Chat message is a write with permanent, externally
  visible side effects — once the call reaches Zoom the message exists in the
  channel and may already be surfaced to other members, notifications, and Zoom's
  agentic search (`search_zoom`). Egress redaction would only mask a response to
  the caller, not the posted message itself. Ingress denial is the only way to
  actually prevent the leak.

  ## Patterns matched

  The policy uses a small set of conservative regex patterns. Adding too many
  patterns dramatically increases false positives, so the list is intentionally
  focused on high-confidence shapes:

  - `password:`, `token:`, `api_key:`, `client_secret:`, etc. in `key: value` or `key=value` form (case-insensitive)
  - `Bearer <token>` authorization values
  - AWS access key IDs (`AKIA…`) and likely secret access keys
  - GitHub personal access tokens (`ghp_…`, `github_pat_…`)
  - Slack bot/user/admin tokens (`xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`)
  - Stripe live secret keys (`sk_live_…`)
  - Google API keys (`AIza…`)
  - OpenAI-style API keys (`sk-…`)
  - PEM private key headers (`-----BEGIN … PRIVATE KEY-----`)

  Tune this list for your environment. If your team uses other providers
  (Twilio, SendGrid, Datadog, etc.), add their token shapes to `secret_patterns`
  in `policy.md`.

  ## Tool name matching

  Zoom's Team Chat sub-server prefixes every tool with `zoom_chat_` (verified from
  Zoom's team-chat child skill). The DTwo gateway further prefixes tool names with
  the configured MCP server name, so the full name the gateway sends looks like
  `zoom-team-chat-zoom_chat_message_send`. The policy therefore matches by
  **suffix** on `lower(input.resource.name)`:

  - `*zoom_chat_message_send`
  - `*zoom_chat_message_update`

  Matching on the suffix keeps the policy portable across gateway server-name
  conventions. Verify the exact name your gateway sends with the
  [dump-input debug technique](https://docs.dtwo.ai) before relying on this in
  production. Only the send/update write verbs are guarded — other `zoom_chat_`
  tools (e.g. `zoom_chat_contact_add`, `zoom_chat_channel_create`) are out of
  scope for this policy and pass through unchanged; compose separate policies for
  those surfaces.

  ## Argument shape

  Team Chat send/update tools carry the message body in `message_content`
  (verified from the team-chat child skill: `chat_session_id`, `message_content`,
  `message_format`, and — for update — `messageId`). The policy reads
  `message_content` via `object.get`, so a call that omits it (or omits `args`
  entirely) yields an empty body and is allowed — there is nothing to leak.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-team-chat-zoom_chat_message_send", "type": "tool" },
      "payload": {
        "name": "zoom-team-chat-zoom_chat_message_send",
        "args": { "chat_session_id": "abc123", "message_content": "standup in 5" }
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
      "resource": { "name": "zoom-team-chat-zoom_chat_message_send", "type": "tool" },
      "payload": {
        "name": "zoom-team-chat-zoom_chat_message_send",
        "args": {
          "chat_session_id": "abc123",
          "message_content": "here's the api_key: sk-abcdef0123456789abcdef0123456789"
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Zoom Team Chat message looks like it contains a secret (...)"`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - `apps/zoom/block-external-chat-targets` — deny inviting external parties into chat.
  - An egress PII/secret redaction policy on `search_zoom` results so any secret already in chat history is masked when read back.
  - A transform-only variant that **redacts** rather than blocks, for environments where rejecting the call is too disruptive.

  ## Known limitations

  - **Regex over plain text.** As with the Slack model policy, this is a high-signal first line of defense, not a complete DLP solution. Secrets that don't match a known shape (rotating short-lived tokens, custom-format keys) will not be caught. A multi-line body is inspected in full — a secret on any line still denies (the patterns are unanchored and `\s` spans newlines) — but a secret written as prose with no `key: value`/`key=value` delimiter and no provider prefix (e.g. "the password is Hunter2…") is **not** caught. See the `tests.yaml` red-team cases that assert these residuals.
  - **Encoding and obfuscation evade the patterns.** A secret that is base64-encoded, hex-encoded, split across characters, or written with unicode look-alike characters in the key (e.g. fullwidth `ｐａssword:`) will not match and is allowed through. This is inherent to any regex-over-text DLP check; do not treat this policy as a defense against a caller deliberately obfuscating a secret. Pair it with response-side redaction and human review of what agents post.
  - **`message_content` only.** The policy inspects the top-level `message_content` string. Team Chat's `message_format` and any structured/rich-content fields are not inspected — a secret placed in `message_format` (or any non-`message_content` argument) is allowed through (see the `tests.yaml` residual case). Extend the body-extraction rule if your deployment routinely sends secret-laden content through other fields.
  - **Only send/update are guarded — other Zoom write surfaces are an open escape hatch.** Other `zoom_chat_` write tools are not inspected by this policy (they don't carry a free-text message body). More importantly, a secret this policy blocks from Team Chat can still be **written verbatim into a Zoom Doc** via the workspace/docs write tools `create_new_file_with_markdown` / `create_file_with_content` (both names occur — the workspace and docs sub-servers diverge; suffix-match both), **or into a Zoom Whiteboard** via the Whiteboard sub-server's content-bearing create tools (`create_a_whiteboard_by_script`, `create_a_whiteboard_for_meeting_summary`, and the other `create_a_whiteboard_for_*` verbs). This chat-scoped policy matches none of them. Zoom Docs are the app's documented data-landing/exfil channel, and script-driven whiteboards are a second text-write route. Compose companion `block-secrets` policies that guard those doc- and whiteboard-write tools' content arguments to close these routes; this policy alone does not. The `tests.yaml` red-team cases assert each of these residuals (a secret sails through `create_new_file_with_markdown`, `create_file_with_content`, and `create_a_whiteboard_by_script`).
  - **No identity-based exemptions.** All callers are subject to the same check. If you need an InfoSec break-glass user that can post anything, gate it with `input.subject.claims.groups` as a separate `allow if` branch.
  - **Unverified sub-server naming.** The landscape note records that Team Chat's endpoint naming diverges (`/mcp/team_chat/` vs `/mcp/chat/`); the tool names themselves (`zoom_chat_message_send`/`zoom_chat_message_update`) are verified from Zoom's team-chat child skill, but confirm the gateway-sent prefix with the dump-input technique.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - zoom
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zoom.ingress.block_secrets_chat

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Patterns that look like secrets in plain text. Anchored to common shapes
# (key=value pairs and provider-specific prefixes) to limit false positives.
# This is the conservative set reused from the Slack block-secrets model policy,
# plus a Bearer-token shape.
secret_patterns := [
    # Generic password / token / api_key / secret_key in `key: value` or `key=value` form
    `(?i)(?:password|passwd|secret|token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+`,
    # HTTP Bearer authorization tokens
    `(?i)bearer\s+[A-Za-z0-9._~+/-]{20,}=*`,
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

# Zoom Team Chat send/update tools we want to inspect. The Team Chat sub-server
# prefixes every tool with `zoom_chat_`, and the gateway further prefixes the
# configured MCP server name, so we match on the suffix to stay portable across
# naming conventions. Verify the exact tool name on your gateway with the
# dump-input debug technique before relying on this in production.
is_chat_send_tool if {
    name := lower(input.resource.name)
    endswith(name, "zoom_chat_message_send")
}

is_chat_send_tool if {
    name := lower(input.resource.name)
    endswith(name, "zoom_chat_message_update")
}

# Allow any tool that isn't a Team Chat send/update call.
allow if {
    not is_chat_send_tool
}

# Allow Team Chat send/update calls only when no secret pattern matches the body.
allow if {
    is_chat_send_tool
    not message_contains_secret
}

# Pull the message body from the Team Chat `message_content` argument. Nested
# object.get so a call missing `args` entirely yields "" (nothing to leak) rather
# than silently failing the rule body.
message_content := object.get(object.get(input.payload, "args", {}), "message_content", "")

# Detect a secret pattern in the message body.
message_contains_secret if {
    some pattern in secret_patterns
    regex.match(pattern, message_content)
}

reasons contains "This Zoom Team Chat message looks like it contains a secret (API key, password, bearer token, or private key). Store the credential in your secret manager and share a reference instead of the raw value. Contact your InfoSec team if this was a false positive." if {
    is_chat_send_tool
    message_contains_secret
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
