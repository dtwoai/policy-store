---
name: "Slack: Block Agent Posts to External Channels"
tags:
  - slack
  - guard-external-send
  - slack-connect
  - exfiltration
  - ingress
  - soc2
  - gdpr-ccpa
  - hipaa
publishedAt: 2026-07-12
description: |
  # slack / guard-external-send

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `slack.ingress.guard_external_send`
  **Family:** PF-04 (`guard-external-send`)

  ## What it does

  Denies Slack message-write calls whose destination is an externally shared
  Slack Connect channel. A message posted to a Connect channel is visible to
  another organization the instant it lands and is effectively irreversible
  (the external side sees and can export it even if it is later deleted) —
  making these channels the primary exfiltration path when an agent is
  prompt-injected by content it read elsewhere.

  The policy matches the send-class tool suffixes across all three Slack MCP
  servers in real use (`_send_message`, `_schedule_message`, `_post_message`,
  `_reply_to_thread`, `_add_message`) and denies when the call's channel
  argument is in the `external_channel_ids` set maintained at the top of the
  Rego. `slack_schedule_message` is included explicitly because its `post_at`
  argument time-shifts delivery past any live human review of the session.

  Callers whose IdP `groups` claim contains `slack-external-comms` are
  exempt. Missing identity fails closed: no subject, no claims, or no
  matching group means no exemption.

  Sends to channels not in the list — internal channels, DMs, and drafts
  (`slack_send_message_draft` creates an unsent draft and is not matched) —
  pass through untouched.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information by stopping agent-authored messages from moving into
    channels shared with another organization; **P6.1** — supports controls
    over PI disclosure to third parties: an externally shared channel *is* a
    third-party disclosure surface.
  - **GDPR Arts. 44/46** — supports control over cross-border transfers on
    agent-visible flows: the external org behind a Connect channel may be in
    any jurisdiction, so an agent post there is an uncontrolled transfer;
    **Art. 5(1)(f)/32** — supports security of processing by closing the
    highest-blast-radius outbound path on the Slack agent channel.
  - **HIPAA §164.530(c)** — supports privacy safeguards by keeping
    agent-composed content (which may carry PHI read earlier in the session)
    out of channels visible to outside organizations.

  ## Why ingress

  The destination is fully visible in the request, and a send is a write
  with permanent external side effects — once the call reaches Slack, the
  external organization has the message. Egress inspection would run *after*
  delivery. Ingress denial is the only placement that actually prevents the
  disclosure.

  ## Tool name matching

  Matching is case-insensitive and by suffix, because the DTwo gateway
  prefixes tool names with the configured MCP server name (e.g.
  `slack-mcp-slack_send_message`) and that prefix is not standardized.
  Hyphens are normalized to underscores before matching, so deployments
  whose gateway names tools like `slack-mcp-slack-post-message` are also
  covered. The five suffixes and their sources:

  - `_send_message` — official Slack MCP server (`slack_send_message`).
  - `_schedule_message` — official server (`slack_schedule_message`);
    included explicitly because `post_at` delays delivery past live review.
  - `_post_message` — archived reference server (`slack_post_message`).
  - `_reply_to_thread` — archived reference server (`slack_reply_to_thread`).
  - `_add_message` — korotovsky community server
    (`conversations_add_message`).

  The official server's tool names are observed at runtime (`tools/list` is
  Slack's stated source of truth), not contractual — verify the exact names
  your gateway sends with the dump-input debug technique before relying on
  this in production, and extend `send_tool_suffixes` if your server exposes
  additional send-class tools.

  ## Argument shape

  The destination is read from `input.payload.args.channel_id` — the key
  used by all three servers per the mid-2026 landscape research — with a
  defensive fallback to `args.channel`, seen in some deployments. All access
  goes through `object.get`, so a missing argument simply doesn't match (see
  Known limitations for the fail-open consequence). Non-string values (an
  arg passed as an array or number) are skipped, and surrounding whitespace is
  stripped (`trim_space`) before the comparison so a padded value like
  `"C0EXTPARTNER1 "` or `" #acme-partnership"` cannot slip past the set.
  Membership in `external_channel_ids` is otherwise an exact string match,
  which also lets you list korotovsky `#name` / `@username_dm` alias forms
  alongside `C`-prefixed IDs.

  ## Examples

  ### Denied (send to a Slack Connect channel)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_send_message", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack_send_message",
        "args": { "channel_id": "C0EXTPARTNER1", "message": "Q3 roadmap attached" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This channel is shared externally via Slack Connect ..."`.

  ### Denied (scheduled send — time-shifted past live review)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_schedule_message", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack_schedule_message",
        "args": { "channel_id": "C0EXTPARTNER1", "message": "hi", "post_at": 1784000000 }
      }
    }
  }
  ```

  `allow = false`, same reason.

  ### Allowed (send to an internal channel)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_send_message", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack_send_message",
        "args": { "channel_id": "C0123456789", "message": "lunch in 5" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed (exempt caller)

  A caller whose `input.subject.claims.groups` contains
  `slack-external-comms` may post to listed external channels.

  ## Composition

  Single-purpose; composes with the other Slack ingress policies:

  - [`block-secrets`](../block-secrets/policy.md) — content-based DLP on the
    same send path (this policy gates the *destination*, that one gates the
    *body*).
  - [`deny-direct-messages`](../deny-direct-messages/policy.md) — blocks the
    DM send surface this policy does not cover.
  - [`guard-dm-privacy`](../guard-dm-privacy/policy.md) — read-side privacy
    guard; together they bound what an injected agent can read and where it
    can send it.

  ## Known limitations

  - **The channel list must be curated.** The gateway cannot detect Slack
    Connect status dynamically — the request carries only a channel ID, and
    Connect membership lives server-side in Slack. Your Slack workspace
    admin must maintain `external_channel_ids` (Slack admin UI →
    *Administration → Manage organizations / Slack Connect* lists all
    externally shared channels). A Connect channel missing from the list is
    **not** blocked. The shipped IDs are placeholders — replace them at
    import time.
  - **korotovsky `#name` aliases bypass ID matching unless also listed.**
    The community server resolves `#channel-name` aliases to channels
    server-side, so an alias send reaches a listed channel without its
    `C`-ID ever appearing in the request. Residual risk unless you list the
    alias form (e.g. `#acme-partnership`) alongside the ID, as the shipped
    placeholder set demonstrates. Renamed channels change the alias but not
    the ID — the ID entry keeps working.
  - **Missing `channel_id` fails open.** A send call with no `channel_id` /
    `channel` argument (or the destination under a different key) is not
    matched — this is a destination blocklist, not a default-deny on sends.
    The three landscape servers all use `channel_id`; re-verify if yours
    differs.
  - **Exact-match brittleness beyond whitespace.** The destination test is a
    case-sensitive exact match after `trim_space` strips surrounding ASCII/
    Unicode whitespace, so padded forms (`"C0EXTPARTNER1 "`, a trailing
    newline, `" #acme-partnership"`) are now caught. Slack channel IDs are
    case-sensitive and Slack lowercases channel names, so list `C`-IDs exactly
    and aliases in lowercase. Residual: exotic invisible code points (e.g.
    zero-width characters) are not stripped and would not match a listed value
    — but such a value is not a deliverable channel on Slack either, so the
    residual risk is bounded to servers that silently normalize them upstream.
  - **New send-class tool names are not auto-covered.** Slack documents
    capabilities (reactions, channel/DM creation, file ops) whose tool names
    were not verifiable from docs; if the official server ships new
    write tools with other suffixes, add them to `send_tool_suffixes`.
  - **Canvas writes are a separate surface, not covered here.** The official
    server's `slack_create_canvas` / `slack_update_canvas` are a persistent,
    linkable exfil/defacement surface (see the Slack landscape note), but their
    arguments carry no channel destination (`title`/`content`,
    `canvas_id`/`action`/`content`) — a *destination* blocklist has nothing to
    match on, so canvas writes pass through. This is by design (one policy, one
    job): gate canvas content with a body-DLP policy such as
    [`block-secrets`](../block-secrets/policy.md), not with this destination
    guard.
  - **Group name is a placeholder** — replace `slack-external-comms` with
    your IdP's group name at import time. The exemption fails closed when
    the caller has no `groups` claim.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - slack
industries: []
bundles:
  - slack
  - im-messaging
  - soc2
  - gdpr-ccpa
  - hipaa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.ingress.guard_external_send

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# -----------------------------------------------------------------------------
# Externally shared (Slack Connect) channels — CURATE THIS LIST.
# The gateway cannot detect Connect status dynamically; your Slack workspace
# admin maintains this set. Exact string match, so korotovsky #name aliases
# can (and should) be listed alongside the C-prefixed channel IDs.
# The entries below are placeholders — replace them at import time.
# -----------------------------------------------------------------------------
external_channel_ids := {
    "C0EXTPARTNER1",     # placeholder — Slack Connect channel ID
    "C0EXTPARTNER2",     # placeholder — Slack Connect channel ID
    "#acme-partnership", # placeholder — korotovsky #name alias for a listed channel
}

# Placeholder IdP group whose members may post to external channels.
# Replace "slack-external-comms" with your IdP's group name at import time.
external_comms_group := "slack-external-comms"

# Tool arguments, safe against a missing payload/args.
args := object.get(object.get(input, "payload", {}), "args", {})

# -----------------------------------------------------------------------------
# Exemption — fails closed: no subject, no claims, or no groups → not exempt.
# -----------------------------------------------------------------------------

caller_exempt if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    some g in groups
    g == external_comms_group
}

# -----------------------------------------------------------------------------
# Send-class tools across the three Slack MCP servers in real use. Matched by
# suffix because the gateway prefixes tool names with the configured MCP
# server name; hyphens are normalized to underscores so hyphenated gateway
# naming is covered too. Note `slack_send_message_draft` (unsent draft, low
# risk) does NOT end with any of these suffixes and passes through.
# -----------------------------------------------------------------------------

send_tool_suffixes := {
    "_send_message",     # official: slack_send_message
    "_schedule_message", # official: slack_schedule_message (post_at delays delivery past live review)
    "_post_message",     # archived reference server: slack_post_message
    "_reply_to_thread",  # archived reference server: slack_reply_to_thread
    "_add_message",      # korotovsky: conversations_add_message
}

is_send_tool if {
    normalized := replace(lower(input.resource.name), "-", "_")
    some suffix in send_tool_suffixes
    endswith(normalized, suffix)
}

# -----------------------------------------------------------------------------
# Destination extraction. All three landscape servers use `channel_id`;
# `channel` is a defensive fallback seen in some deployments. Non-string
# values (arrays/numbers) are skipped, surrounding whitespace is trimmed so a
# padded channel ID cannot slip past the exact-match set, and empty values are
# dropped so a missing argument cannot match a set entry.
# -----------------------------------------------------------------------------

recipient_values contains v if {
    some key in {"channel_id", "channel"}
    raw := object.get(args, key, "")
    is_string(raw)
    v := trim_space(raw)
    v != ""
}

targets_external_channel if {
    is_send_tool
    some v in recipient_values
    external_channel_ids[v]
}

# -----------------------------------------------------------------------------
# Decision
# -----------------------------------------------------------------------------

# Anything not sending to a listed external channel passes through.
allow if {
    not targets_external_channel
}

# Members of the exemption group may post to listed external channels.
allow if {
    targets_external_channel
    caller_exempt
}

reasons contains "This channel is shared externally via Slack Connect — a message posted here is visible to another organization the moment it lands and cannot be recalled. Posting to externally shared channels requires a human send from the Slack client. If your role requires agent posts to external channels, ask your InfoSec team for the slack-external-comms group; if this channel is no longer externally shared, ask your Slack workspace admin to remove it from the external channel list." if {
    targets_external_channel
    not caller_exempt
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
