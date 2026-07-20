---
name: "Slack: Deny Sending Direct Messages"
tags:
  - slack
  - access-control
  - governance
  - ingress
  - soc2
  - iso27001-nist
  - finserv-comms
publishedAt: 2026-07-12
description: |
  # slack / deny-direct-messages

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow, with a targeted deny on direct-message writes
  **Package:** `slack.ingress.deny_direct_messages`

  ## What it does

  Blocks Slack message-write calls whose destination resolves to a direct
  conversation — a 1:1 DM, a message posted to a user ID (which Slack auto-opens
  as a DM), or a multi-party/group DM. Posts to regular channels, and every
  non-write Slack tool, pass through untouched. A blocked call returns a clear
  denial reason instead of delivering the DM.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of information
    by keeping agent output out of 1:1 and group-DM destinations on the MCP path.
  - **ISO 27001 A.5.14 / NIST 800-53 AC-4** — information transfer / flow enforcement:
    agent messages stay in channels where they are visible and reviewable.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing: the agent cannot
    open unsupervised person-to-person disclosure paths for personal data it has read.
  - **FINRA 3110(b)(4) / SEC 17a-4(b)(4)** — supports supervision and preservation of
    business communications (channel discipline): agent-generated messages cannot land
    in DM surfaces that evade supervisory review flows.

  ## Why ingress

  Sending a message is a write with a permanent side effect — once it reaches
  Slack the DM exists in the recipient's history. The destination is fully
  visible in the request, so denying at ingress prevents the message from ever
  being delivered.

  ## How it matches

  A call is denied only when all three conditions hold:

  - **Slack-server scoping.** The first hyphen-separated segment of the tool name
    starts with `slack`, so the policy works regardless of how the Slack MCP
    server is named on a given gateway (`slack-...`, `slack-prod-...`,
    `slack-mcp-...`).
  - **Write-tool detection.** The (lowercased) tool name ends with one of the
    known message-write suffixes — the post/send, update/edit, scheduled,
    ephemeral, and me-message families, with `-`, `_`, and concatenated naming
    variants covered.
  - **DM-recipient detection.** The destination is identified by Slack's
    ID-prefix conventions, not by name. On the channel argument (`channel`,
    `channel_id`, `channelId`) a value beginning with `D` (1:1 DM channel),
    `U`/`W` (user ID — Slack auto-opens a DM when posting to a user ID), or `G`
    (multi-party/group DM) is treated as a DM. A dedicated recipient argument
    (`user`, `user_id`, `userId`) is matched only against user IDs (`U`/`W`).

  Channel names and other non-matching ID shapes are intentionally **not** treated
  as DMs — the policy fails open on uncertainty rather than over-blocking. Confirm
  the exact tool and argument names your gateway emits with the dump-input debug
  technique, and extend `write_tool_suffixes` or the recipient lookups if your
  Slack MCP server differs.

  ## Examples

  ### Denied (posting to a 1:1 DM channel)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack-post-message", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack-post-message",
        "args": { "channel": "D0123456789", "text": "hi" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Sending direct messages via Slack is not permitted via this gateway. ..."`.

  (A post addressed to a user ID such as `"channel": "U0123456789"` is denied the
  same way, since Slack would open a DM.)

  ### Allowed (posting to a regular channel)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack-post-message", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack-post-message",
        "args": { "channel": "C0123456789", "text": "hi team" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ## Composition

  Single-purpose and `default allow := true`, so it composes cleanly with other
  Slack ingress policies (e.g. [`block-secrets`](../block-secrets/policy.md),
  [`deny-channel-creation`](../deny-channel-creation/policy.md)) on the same
  pipeline.

  ## Known limitations

  - **ID-based detection.** Recipients are identified by Slack ID prefixes. A tool
    that accepts a DM destination as a plain name or under an unrecognized
    argument will not be matched — add the argument to the recipient lookups.
  - **Suffix list, not an exhaustive catalog.** Only the message-write shapes
    listed in `write_tool_suffixes` are matched. Add the suffix for any additional
    write tool your Slack MCP server exposes.
  - **No identity-based exemptions.** All callers are treated the same. To allow a
    specific break-glass user, gate a separate `allow if` branch on
    `input.subject.claims`.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - slack
industries: []
bundles:
  - slack
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.ingress.deny_direct_messages

# Default-allow: only deny writes whose destination resolves to a direct
# conversation (1:1 DM, user-ID-as-channel, MPIM, or user/userId arg).
default allow := true

# -----------------------------------------------------------------------------
# Slack-server detection: any tool whose first hyphen-separated segment starts
# with "slack" (slack-, slack3-, slack-prod-, etc.).
# -----------------------------------------------------------------------------

is_slack_tool if {
    name := lower(input.resource.name)
    server_name := split(name, "-")[0]
    startswith(server_name, "slack")
}

# -----------------------------------------------------------------------------
# Write-tool detection — covers common shapes for the message-posting family.
# -----------------------------------------------------------------------------

write_tool_suffixes := {
    # postMessage family
    "-postmessage",
    "-post-message",
    "-post_message",
    "-sendmessage",
    "-send-message",
    "-send_message",

    # update / edit
    "-updatemessage",
    "-update-message",
    "-update_message",

    # scheduled posts
    "-schedulemessage",
    "-schedule-message",
    "-schedule_message",

    # ephemeral posts
    "-postephemeral",
    "-post-ephemeral",
    "-post_ephemeral",
    "-postephemeralmessage",
    "-post-ephemeral-message",

    # me-style messages
    "-memessage",
    "-me-message",
    "-me_message",
}

is_slack_write_tool if {
    is_slack_tool
    name := lower(input.resource.name)
    some suffix in write_tool_suffixes
    endswith(name, suffix)
}

# -----------------------------------------------------------------------------
# DM-recipient detection — match any destination value that resolves to a
# direct conversation in Slack's ID conventions:
#   D...  → 1:1 DM channel ID
#   U.../W...  → user ID (Slack's chat.postMessage auto-opens a DM and posts
#                when the channel arg is a user ID)
#   G...  → multi-party DM / group DM (in workspaces where private channels
#           moved to C, G is effectively MPIM-only)
# Channel arg names checked: channel, channel_id, channelId.
# Separately checks user/user_id/userId args for tools that take the recipient
# under a dedicated user field.
# Names (non-ID strings) and other ID shapes don't match — fail-open on
# uncertainty.
# -----------------------------------------------------------------------------

# DM via the channel arg (channel ID OR user ID auto-converted to DM).
is_dm_recipient if {
    v := object.get(input.payload.args, "channel", "")
    regex.match(`^[DUWG][A-Z0-9]{7,}$`, v)
}

is_dm_recipient if {
    v := object.get(input.payload.args, "channel_id", "")
    regex.match(`^[DUWG][A-Z0-9]{7,}$`, v)
}

is_dm_recipient if {
    v := object.get(input.payload.args, "channelId", "")
    regex.match(`^[DUWG][A-Z0-9]{7,}$`, v)
}

# DM via a dedicated user arg (only user IDs are valid here).
is_dm_recipient if {
    v := object.get(input.payload.args, "user", "")
    regex.match(`^[UW][A-Z0-9]{7,}$`, v)
}

is_dm_recipient if {
    v := object.get(input.payload.args, "user_id", "")
    regex.match(`^[UW][A-Z0-9]{7,}$`, v)
}

is_dm_recipient if {
    v := object.get(input.payload.args, "userId", "")
    regex.match(`^[UW][A-Z0-9]{7,}$`, v)
}

# -----------------------------------------------------------------------------
# Deny rule
# -----------------------------------------------------------------------------

allow := false if {
    is_slack_write_tool
    is_dm_recipient
}

reason := "Sending direct messages via Slack is not permitted via this gateway. Contact your InfoSec team if this needs to change." if not allow
```
