---
name: "Slack: Deny Channel Creation"
tags:
  - slack
  - access-control
  - governance
  - ingress
publishedAt: 2026-06-16
description: |
  # slack / deny-channel-creation

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow, with a targeted deny on channel-creation calls
  **Package:** `slack.ingress.deny_channel_create`

  ## What it does

  Blocks Slack channel-creation tool calls at ingress. Every other Slack tool —
  and every non-Slack tool — passes through untouched. A blocked call returns a
  clear denial reason instead of creating a channel.

  ## Why ingress

  Creating a channel is a write with a permanent side effect on the workspace.
  The violation is fully determined by the request (the tool name alone), so
  denying at ingress prevents the channel from ever being created.

  ## How it matches

  Two conditions must both hold for a call to be denied:

  - **Slack-server scoping.** The first hyphen-separated segment of the tool name
    starts with `slack`. This matches `slack-...`, `slack-prod-...`,
    `slack-mcp-...`, etc., so the policy keeps working regardless of how the Slack
    MCP server is named on a given gateway.
  - **Create-channel detection.** The (lowercased) tool name ends with one of the
    known create-channel suffixes. Both common naming families are covered:
    - verb-first shapes: `-create-conversation`, `-create-channel`, and their
      `_`-separated and concatenated variants;
    - Slack-API-mirroring shapes: `-conversations.create`, `-conversations-create`,
      `-conversations_create`.

  Tool names on the gateway are prefixed with the configured MCP server name and
  that prefix is not standardized, which is why this matches on suffix rather
  than an exact name. Confirm the exact tool name your gateway emits with the
  dump-input debug technique before relying on this in production, and add any
  missing shape to `create_channel_suffixes`.

  ## Examples

  ### Denied (channel creation)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-conversations-create", "type": "tool" },
      "payload": {
        "name": "slack-mcp-conversations-create",
        "args": { "name": "incident-2026-06" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Creating Slack channels is not permitted via this gateway. ..."`.

  ### Allowed (any other Slack tool)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack-post-message", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack-post-message",
        "args": { "channel": "C123", "text": "hello" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ## Composition

  Single-purpose and `default allow := true`, so it composes cleanly with other
  Slack ingress policies (e.g. [`block-secrets`](../block-secrets/policy.md)) on
  the same pipeline.

  ## Known limitations

  - **Suffix list, not an exhaustive catalog.** Only the create-channel tool
    shapes listed in `create_channel_suffixes` are matched. If a Slack MCP server
    exposes channel creation under a different tool name, add its suffix.
  - **No identity-based exemptions.** All callers are treated the same. To allow a
    specific admin/break-glass user to create channels, gate a separate
    `allow if` branch on `input.subject.claims`.
direction: ingress
apps:
  - slack
industries: []
bundles:
  - slack
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.ingress.deny_channel_create

# Default-allow: only deny Slack channel-creation calls.
default allow := true

# -----------------------------------------------------------------------------
# Tool matching
# -----------------------------------------------------------------------------

# Slack channel-creation tool names vary by MCP server implementation. Cover
# the common shapes via endswith on the lowercased resource name.
create_channel_suffixes := {
    # Verb-first ("create conversation/channel") — a common Slack MCP shape.
    "-create-conversation",
    "-create_conversation",
    "-createconversation",
    "-create-channel",
    "-createchannel",
    "-create_channel",

    # Slack-API-mirroring shape (conversations.create) — kept for MCP servers
    # that expose the underlying REST path more literally.
    "-conversations-create",
    "-conversations.create",
    "-conversations_create",
}

# Slack-server detection: the tool name's first hyphen-separated segment starts
# with "slack". Matches "slack-...", "slack3-...", "slack-prod-...", etc., so
# the policy keeps working regardless of how the MCP server is named on a
# given gateway.
is_slack_tool if {
    name := lower(input.resource.name)
    server_name := split(name, "-")[0]
    startswith(server_name, "slack")
}

is_create_channel if {
    is_slack_tool
    name := lower(input.resource.name)
    some suffix in create_channel_suffixes
    endswith(name, suffix)
}

# -----------------------------------------------------------------------------
# Deny rule
# -----------------------------------------------------------------------------

allow := false if {
    is_create_channel
}

reason := "Creating Slack channels is not permitted via this gateway. Contact your InfoSec team if this needs to change." if not allow
```
