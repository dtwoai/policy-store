---
name: "Slack: Deny DM and Private-Conversation Reads and Search"
tags:
  - slack
  - privacy
  - dm
  - access-control
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # slack / guard-dm-privacy

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `slack.ingress.guard_dm_privacy`

  ## What it does

  Denies the agent read reach into Slack DMs and private conversations on the
  paths below — the workspace's highest concentration of PII/PHI (HR issues,
  health disclosures, credentials, M&A chatter). Three independent deny
  branches (see Known limitations for read surfaces outside these branches):

  1. **Private-scope search tools** — any tool whose (lowercased) name ends
     with `_search_public_and_private`. The official Slack MCP server splits
     private scope into this dedicated tool name, so the name alone is
     sufficient to detect the private reach.
  2. **DM-filtered message search** — the korotovsky community server's
     `conversations_search_messages` when its `filter_in_im_or_mpim` argument
     is set truthy (boolean `true`, the number `1`, or the strings `"true"` /
     `"1"` / `"yes"`).
  3. **DM history reads** — the history/read tool family
     (`slack_read_channel`, `slack_read_thread`, `conversations_history`,
     `conversations_replies`, `slack_get_channel_history`,
     `slack_get_thread_replies`) when the `channel_id` argument starts with
     `D` (a 1:1 DM channel ID) or `@` (the korotovsky `@username_dm` alias).

  Callers whose IdP `groups` claim contains `slack-private-ok` are exempt.
  Missing identity fails closed: no subject, no claims, or no matching group
  means no exemption.

  Public-channel reads and search (`slack_search_public`,
  `slack_search_channels`, history reads on `C`-prefixed channel IDs) pass
  through untouched. This closes the read-side gap left by
  [`deny-direct-messages`](../deny-direct-messages/policy.md), which only
  blocks DM *sends*.

  ## Compliance alignment

  This policy fences the agent's read reach into DMs and private
  conversations — the workspace's highest concentration of personal and
  special-category data — behind an explicit, IdP-asserted group, supporting
  minimum-necessary and access-management controls on the MCP path:

  - **SOC 2 CC6.3** — supports role-based least privilege: DM and
    private-conversation reads require the explicit `slack-private-ok` group,
    with a read-only-public default for everyone else; **C1.1** — supports
    identifying and protecting confidential information held in private
    conversations.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard when DMs and private channels carry health-related disclosures;
    **§164.308(a)(4)** — supports information access management by restricting
    which conversations the agent may read.
  - **GDPR Art. 9 / Art. 5(1)(c)** — supports limiting access to
    special-category data (health and HR disclosures common in DMs) and data
    minimisation on the agent channel; **CPRA §1798.121** — supports the
    consumer's right to limit use of sensitive personal information by keeping
    private-conversation content out of agent context absent an explicit role.

  ## Why ingress

  The private reach is fully visible in the request (tool name, filter
  argument, channel ID), so the call can be stopped before any DM content
  ever leaves Slack. Egress redaction would already have pulled the private
  content into the gateway; ingress denial means it is never fetched.

  ## Tool name matching

  All matching is case-insensitive and by suffix, because the DTwo gateway
  prefixes tool names with the configured MCP server name (e.g.
  `slack-mcp-slack_read_channel`) and that prefix is not standardized:

  - `*_search_public_and_private` — official server private-scope search.
  - `*conversations_search_messages` — korotovsky message search (denied
    only when the DM filter is set).
  - History suffixes: `*slack_read_channel`, `*slack_read_thread` (official);
    `*conversations_history`, `*conversations_replies` (korotovsky);
    `*slack_get_channel_history`, `*slack_get_thread_replies` (archived
    reference server).

  Verify the exact names your gateway sends with the dump-input debug
  technique before relying on this in production, and extend
  `history_tool_suffixes` if your Slack MCP server exposes additional
  history readers.

  ## Argument shape

  - Branch 2 reads `input.payload.args.filter_in_im_or_mpim` (korotovsky).
  - Branch 3 reads `input.payload.args.channel_id` — the key used by all six
    history tools listed above. All argument access goes through
    `object.get`; a missing argument simply doesn't match (see Known
    limitations for the fail-open consequence).
  - The exemption reads `input.subject.claims.groups` via `object.get`
    chains, so missing claims deterministically deny.

  ## Examples

  ### Denied (official private-scope search)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_search_public_and_private", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack_search_public_and_private",
        "args": { "query": "salary review" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Searching Slack DMs and private conversations is not permitted through this gateway. ..."`.

  ### Denied (DM history read)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_read_channel", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack_read_channel",
        "args": { "channel_id": "D0123456789", "limit": 50 }
      }
    }
  }
  ```

  `allow = false`, `reason = "Reading Slack DM and private-conversation history is not permitted through this gateway. ..."`.

  ### Allowed (public search; public-channel history)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_search_public", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack_search_public",
        "args": { "query": "deploy schedule" }
      }
    }
  }
  ```

  `allow = true`, no reason. Same for `slack_read_channel` with
  `"channel_id": "C0123456789"`.

  ### Allowed (exempt caller)

  A caller whose `input.subject.claims.groups` contains `slack-private-ok`
  may run any of the calls above.

  ## Composition

  Single-purpose; composes with the other Slack ingress policies:

  - [`deny-direct-messages`](../deny-direct-messages/policy.md) — the write
    side of the same boundary (blocks DM sends; this policy blocks DM reads).
  - [`deny-read-search-summarize-sensitive-channels`](../deny-read-search-summarize-sensitive-channels/policy.md) —
    channel-ID-specific denies for named sensitive channels, including
    private channels this policy cannot identify by ID shape.
  - [`block-secrets`](../block-secrets/policy.md) — outbound DLP on sends.

  ## Known limitations

  - **Group-DM and private-channel history reads are not caught by branch 3's
    ID-shape check.** Branch 3 denies history reads only on `D` (1:1 DM) and the
    korotovsky `@username_dm` alias, per this policy's spec. Group DMs / legacy
    private channels carry a `G` prefix, and Slack now assigns *newly created*
    private channels the same `C` prefix as public channels — neither is
    distinguishable from a public read by ID shape here, so a direct history read
    on a `G`- or `C`-prefixed private conversation passes through. Use the
    [`deny-read-search-summarize-sensitive-channels`](../deny-read-search-summarize-sensitive-channels/policy.md)
    companion policy to pin specific private/group channel IDs. korotovsky also
    accepts a `#channel-name` string alias as `channel_id`; a private channel
    referenced by `#name` is likewise not caught by the `D`/`@` shape check and
    falls under the same companion-policy pinning. Branches 1 and 2 still cover
    private channels and group DMs for *search*, because those surfaces declare
    their scope (dedicated tool name / `filter_in_im_or_mpim`).
  - **Read surfaces beyond the six history tools are not covered.** Branch 3
    matches only the six enumerated history/thread readers on a DM-shaped
    `channel_id`. Other read tools that can surface DM/private content are out
    of scope by design: the korotovsky `conversations_unreads` (unread messages
    across all conversations, DMs included under a browser-token deployment) and
    `saved_list` (saved messages, which may include saved DM messages), and the
    official `slack_read_canvas` (a canvas that may live in a private channel or
    DM). None of these takes a DM-shaped `channel_id` this policy can key on, so
    each passes through. If these surfaces are in scope for your deployment, add
    the tool to a companion deny policy or pair with a group-scoped egress
    redaction policy on their responses.
  - **Unfiltered korotovsky search may still surface DM content.** Branch 2
    denies `conversations_search_messages` only when `filter_in_im_or_mpim` is
    set. Under a browser-token deployment the community server inherits the
    human user's full visibility, so a search *without* the filter can still
    return DM/mpim matches server-side. This policy trusts the filter as the
    DM-scope signal (per the landscape research); if your deployment returns
    private matches on unfiltered search, pair this with an egress redaction
    policy on search responses.
  - **Missing `channel_id` fails open on branch 3.** A history tool called
    with no `channel_id` (or with the target under a different key) is not
    matched. The six covered tools all take `channel_id` per the mid-2026
    landscape research; re-verify if your server differs.
  - **Official tool names are observed, not contractual.** Slack publishes
    exact names only at runtime (`tools/list` is the source of truth); the
    names here are corroborated from mid-2026 research but may change.
  - **ID matching is exact-case.** Slack channel IDs are uppercase; a
    lowercase `d…` value is not a valid Slack ID and is not matched.
  - **Group name is a placeholder** — replace `slack-private-ok` with your
    IdP's group name at import time. The exemption fails closed when the
    caller has no `groups` claim.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - slack
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.ingress.guard_dm_privacy

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group whose members may reach DMs and private conversations.
# Replace "slack-private-ok" with your IdP's group name at import time.
private_ok_group := "slack-private-ok"

# Tool arguments, safe against a missing payload/args.
args := object.get(object.get(input, "payload", {}), "args", {})

# -----------------------------------------------------------------------------
# Exemption — fails closed: no subject, no claims, or no groups → not exempt.
# -----------------------------------------------------------------------------

caller_exempt if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    some g in groups
    g == private_ok_group
}

# -----------------------------------------------------------------------------
# Branch 1 — official Slack MCP server: the dedicated private-scope search
# tool. The server splits DM/private reach into its own tool name, so the
# name alone identifies the private scope.
# -----------------------------------------------------------------------------

private_scope_search if {
    endswith(lower(input.resource.name), "_search_public_and_private")
}

# -----------------------------------------------------------------------------
# Branch 2 — korotovsky/slack-mcp-server: conversations_search_messages
# scopes the search into DMs/group DMs via the filter_in_im_or_mpim argument.
# -----------------------------------------------------------------------------

dm_filtered_search if {
    endswith(lower(input.resource.name), "conversations_search_messages")
    dm_filter_set
}

# Boolean form of the filter.
dm_filter_set if {
    object.get(args, "filter_in_im_or_mpim", false) == true
}

# String forms of the filter ("true", "1", "yes") — defensive against clients
# that serialize booleans as strings.
dm_filter_set if {
    v := object.get(args, "filter_in_im_or_mpim", "")
    is_string(v)
    lower(v) in {"true", "1", "yes"}
}

# Numeric form of the filter (1) — defensive against clients that serialize the
# flag as a JSON number rather than a boolean or string.
dm_filter_set if {
    object.get(args, "filter_in_im_or_mpim", false) == 1
}

# -----------------------------------------------------------------------------
# Branch 3 — history/read tools targeting a direct conversation. Covers the
# official server, korotovsky, and the archived reference server. Matched by
# suffix because the gateway prefixes tool names with the MCP server name.
# -----------------------------------------------------------------------------

history_tool_suffixes := {
    "slack_read_channel",        # official
    "slack_read_thread",         # official
    "conversations_history",     # korotovsky
    "conversations_replies",     # korotovsky
    "slack_get_channel_history", # archived reference server
    "slack_get_thread_replies",  # archived reference server
}

is_history_tool if {
    name := lower(input.resource.name)
    some suffix in history_tool_suffixes
    endswith(name, suffix)
}

# D-prefixed value → 1:1 DM channel ID (Slack IDs are uppercase).
private_history_read if {
    is_history_tool
    startswith(object.get(args, "channel_id", ""), "D")
}

# @-prefixed value → korotovsky's @username_dm alias for a DM.
private_history_read if {
    is_history_tool
    startswith(object.get(args, "channel_id", ""), "@")
}

# -----------------------------------------------------------------------------
# Decision
# -----------------------------------------------------------------------------

denied if private_scope_search

denied if dm_filtered_search

denied if private_history_read

# Anything that doesn't reach into DMs/private conversations passes through.
allow if {
    not denied
}

# Members of the exemption group may reach private conversations.
allow if {
    caller_exempt
}

reasons contains "Searching Slack DMs and private conversations is not permitted through this gateway. Use the public-channel search tool instead, or ask your InfoSec team for the slack-private-ok group if your role requires private-scope access." if {
    private_scope_search
    not caller_exempt
}

reasons contains "Slack message search scoped to DMs and group DMs (filter_in_im_or_mpim) is not permitted through this gateway. Re-run the search without the DM filter, or ask your InfoSec team for the slack-private-ok group if your role requires it." if {
    dm_filtered_search
    not caller_exempt
}

reasons contains "Reading Slack DM and private-conversation history is not permitted through this gateway. Read public channels instead, or ask your InfoSec team for the slack-private-ok group if your role requires DM access. Contact your InfoSec team if this block is a false positive." if {
    private_history_read
    not caller_exempt
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
