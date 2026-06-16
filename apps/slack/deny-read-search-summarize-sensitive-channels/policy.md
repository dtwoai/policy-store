---
name: "Slack: Deny Read/Search/Summarize of Sensitive Channels"
tags:
  - slack
  - access-control
  - data-protection
  - ingress
publishedAt: 2026-06-16
description: |
  # slack / deny-read-search-summarize-sensitive-channels

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow, with a targeted deny on sensitive-channel reads
  **Package:** `slack.ingress.deny_sensitive_channel_read`

  ## What it does

  Blocks read, search, and summarize operations that target a configurable set of
  "sensitive" Slack channels. Every other Slack tool — and every channel not in
  the set — passes through untouched. A blocked call returns a clear denial
  reason instead of returning channel contents.

  The set of sensitive channel IDs is configured once at the top of the Rego
  (`sensitive_channel_ids`).

  ## Why ingress

  The risk is *reading* content out of a protected channel, and that intent is
  fully visible in the request (the tool name plus the channel argument). Denying
  at ingress stops the read before it reaches Slack, so no protected message,
  thread, or summary is ever returned to the caller.

  ## How it matches

  A call is denied only when all three conditions hold:

  - **Slack-server scoping.** The first hyphen-separated segment of the tool name
    starts with `slack`, so the policy works regardless of how the Slack MCP
    server is named on a given gateway (`slack-...`, `slack-prod-...`,
    `slack-mcp-...`).
  - **Restricted-tool detection.** The (lowercased) tool name ends with one of
    the known suffixes across three operation families — channel history/replies
    reads, search, and summarize — with `-`, `_`, and concatenated naming
    variants covered.
  - **Sensitive-channel detection.** The channel is matched by **ID** against the
    configured set, both as a direct argument (`channel`, `channel_id`,
    `channelId`) and as a substring of search-query arguments (`query`, `q`), so
    channel-mention syntax inside a query (e.g. `in:<#C…>` or
    `<#C…|team-name>`) is also caught.

  Matching is on channel **IDs**, not names, because these tools receive resolved
  channel IDs at call time — a name-based approach does not fire. ID comparisons
  are case-sensitive, mirroring Slack's own behavior. Confirm the exact tool and
  argument names your gateway emits with the dump-input debug technique, and
  extend `restricted_tool_suffixes` or the channel-arg lookups if your Slack MCP
  server differs.

  ## Examples

  ### Denied (reading a sensitive channel's history)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-conversations-history", "type": "tool" },
      "payload": {
        "name": "slack-mcp-conversations-history",
        "args": { "channel": "SLACK_CHANNEL_ID", "limit": 50 }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Reading, searching, or summarizing this Slack channel is not permitted via this gateway. ..."`.

  ### Allowed (reading a non-sensitive channel)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-conversations-history", "type": "tool" },
      "payload": {
        "name": "slack-mcp-conversations-history",
        "args": { "channel": "C0PUBLIC001", "limit": 50 }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ## Configuration

  Edit the `sensitive_channel_ids` set at the top of the policy. The shipped value
  (`SLACK_CHANNEL_ID`) is a **placeholder** — replace it with your real Slack
  channel IDs (uppercase, case-sensitive, e.g. `C0B5LHR8DQV`).

  ## Composition

  Single-purpose and `default allow := true`, so it composes cleanly with other
  Slack ingress policies (e.g. [`block-secrets`](../block-secrets/policy.md),
  [`deny-channel-creation`](../deny-channel-creation/policy.md)) on the same
  pipeline.

  ## Known limitations

  - **ID-based, not name-based.** The policy keys off channel IDs; it does not
    resolve channel names to IDs. Populate the ID set with the real IDs of the
    channels you need to protect.
  - **Suffix list, not an exhaustive catalog.** Only the tool shapes listed in
    `restricted_tool_suffixes` are matched. Add the suffix for any additional
    read/search/summarize tool your Slack MCP server exposes.
  - **No identity-based exemptions.** All callers are treated the same. To allow a
    specific break-glass user, gate a separate `allow if` branch on
    `input.subject.claims`.
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
package slack.ingress.deny_sensitive_channel_read

# Default-allow: only deny restricted operations on the configured channel IDs.
default allow := true

# -----------------------------------------------------------------------------
# CONFIG: Sensitive Slack channel IDs. Edit to add or remove. Slack channel
# IDs are uppercase alphanumeric and case-sensitive (e.g. "C0B5LHR8DQV").
# -----------------------------------------------------------------------------

sensitive_channel_ids := {
    "SLACK_CHANNEL_ID", #placeholder value, replace with your Slack channel_id
}

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
# Restricted-tool detection — covers read (channel history / replies), search,
# and summarize operation families. Suffix matching tolerates different MCP
# naming conventions across implementations.
# -----------------------------------------------------------------------------

restricted_tool_suffixes := {
    # ---- Read: channel history / messages ----
    "-conversations-history",
    "-conversations_history",
    "-conversationshistory",
    "-channel-history",
    "-channel_history",
    "-channelhistory",
    "-get-history",
    "-get_history",
    "-gethistory",
    "-get-messages",
    "-get_messages",
    "-getmessages",
    "-read-channel",
    "-read_channel",
    "-readchannel",

    # ---- Read: replies / threads ----
    "-conversations-replies",
    "-conversations_replies",
    "-conversationsreplies",
    "-get-replies",
    "-get_replies",
    "-getreplies",
    "-thread-history",
    "-thread_history",
    "-threadhistory",

    # ---- Search ----
    "-search-messages",
    "-search_messages",
    "-searchmessages",
    "-search-all",
    "-search_all",
    "-searchall",
    "-search-files",
    "-search_files",
    "-searchfiles",

    # ---- Summarize ----
    "-summarize-channel",
    "-summarize_channel",
    "-summarizechannel",
    "-channel-summary",
    "-channel_summary",
    "-channelsummary",
    "-summarize-conversation",
    "-summarize_conversation",
    "-summarizeconversation",
    "-summarize",
    "-summary",
}

is_restricted_tool if {
    is_slack_tool
    name := lower(input.resource.name)
    some suffix in restricted_tool_suffixes
    endswith(name, suffix)
}

# -----------------------------------------------------------------------------
# Sensitive-channel-ID detection — match the channel arg against the
# configured ID set, OR find an ID inside a search query.
#
# Slack channel IDs are uppercase letter+digit strings (e.g. C0B5LHR8DQV).
# Comparisons are exact (case-sensitive) since the Slack API itself preserves
# case.
# -----------------------------------------------------------------------------

# Direct channel arg shapes
channel_id_is_sensitive if {
    v := object.get(input.payload.args, "channel", "")
    sensitive_channel_ids[v]
}

channel_id_is_sensitive if {
    v := object.get(input.payload.args, "channel_id", "")
    sensitive_channel_ids[v]
}

channel_id_is_sensitive if {
    v := object.get(input.payload.args, "channelId", "")
    sensitive_channel_ids[v]
}

# Search-query substring check — catches Slack channel-mention syntax inside
# queries (e.g. 'in:<#C0B5LHR8DQV>' or '<#C0B5LHR8DQV|fin-team>').
channel_id_is_sensitive if {
    q := object.get(input.payload.args, "query", "")
    is_string(q)
    some id in sensitive_channel_ids
    contains(q, id)
}

channel_id_is_sensitive if {
    q := object.get(input.payload.args, "q", "")
    is_string(q)
    some id in sensitive_channel_ids
    contains(q, id)
}

# -----------------------------------------------------------------------------
# Deny rule
# -----------------------------------------------------------------------------

allow := false if {
    is_restricted_tool
    channel_id_is_sensitive
}

reason := "Reading, searching, or summarizing this Slack channel is not permitted via this gateway. Contact your InfoSec team if this needs to change." if not allow
```
