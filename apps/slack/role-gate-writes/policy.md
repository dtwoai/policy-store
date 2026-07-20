---
name: Slack Role-Gate Writes
tags:
  - slack
  - role-gate-writes
  - access-control
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # slack / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `slack.ingress.role_gate_writes`

  ## What it does

  Gates every Slack write-class tool behind an IdP group: callers whose JWT
  `groups` claim contains `slack-writers` may send and schedule messages, add
  or remove reactions, create and update canvases, and manage saved items and
  user groups; everyone else gets a read-only Slack posture through the agent
  channel. All read tools (search, history, channel/user lookups, profile and
  canvas reads) pass for every caller.

  The group check is **fail-closed**: if the caller has no `subject.claims`,
  no `groups` claim, or a `groups` claim that is not a list of strings, write
  tools are denied. A missing claim never grants write access.

  Even the official server's low-risk `slack_send_message_draft` (creates an
  unsent draft) is treated as a write — drafts are staged sends, and gating
  them keeps the read-only posture unambiguous.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.3** — logical access security and role-based least
    privilege: Slack mutations through the agent channel require an explicit
    IdP group membership; the default posture is read-only.
  - **HIPAA §164.308(a)(4); §164.312(a)(1)** — information access management
    and access control on the MCP path: for workspaces where channel and DM
    content can carry health-related disclosures, writes are authorized per
    caller identity, keyed to live IdP claims.
  - **PCI DSS 7.2.1; 7.2.2; 7.2.5** — least-privilege access model: agent-channel
    users get the minimum access (read) unless their role requires write, and
    the broad OAuth grant the Slack MCP server holds is narrowed per caller.
  - **GDPR Art. 25; Art. 29** — data protection by default on the agent
    channel, and processing of personal data only by persons acting under the
    controller's authorization.
  - **SOX ITGC — access to programs and data** — least-privilege write access
    through the agent channel to a communication system whose messages can
    move market-relevant and financial information, keyed to live IdP group
    membership.

  ## Why ingress

  Slack writes are externally visible the instant they land — a sent message
  reaches humans (including external orgs via Slack Connect shared channels)
  and is effectively irreversible, a scheduled message time-shifts the send
  past any live session review, and user-group mutations change org paging
  and escalation structure. Denying at ingress means an unauthorized write
  never reaches Slack.

  ## Tool name matching

  The policy keys on the **tool name only**. It reads the tool name from
  **both** the PARC `input.resource.name` and the legacy `input.payload.name`
  — both are populated on tool hooks and carry the same value, and
  `payload.name` is the actual invocation target — lowercases and normalizes
  each (hyphens → underscores; a missing **or non-string** name coerces to the
  empty string), and treats the call as a write if **either** name matches the
  write vocabulary by suffix. Checking both fields means a request cannot
  disable the gate by carrying the write name only under `payload.name`, by
  leaving `resource.name` empty, or by planting a non-string value (an
  object/number/array) in one field to poison the other — each field is
  normalized independently, so a garbage value in one never suppresses
  detection of a real write name in the other. The write vocabulary
  covers all three server generations in real use (the DTwo gateway prefixes
  tool names with the configured server name, so suffix matching stays
  portable; normalization covers deployments that observed kebab-case naming):

  - **Official Slack MCP server** (`mcp.slack.com`, the Claude connector's
    server): `slack_send_message`, `slack_schedule_message`,
    `slack_send_message_draft`, `slack_create_canvas`, `slack_update_canvas`.
  - **korotovsky community server**: `conversations_add_message`,
    `reactions_add`, `reactions_remove`, `conversations_mark`,
    `saved_update`, `saved_clear_completed`, `usergroups_create`,
    `usergroups_update`, `usergroups_users_update`.
  - **Archived reference server** (legacy, still widely forked):
    `slack_post_message`, `slack_reply_to_thread`, `slack_add_reaction`.

  Anything not on the write list — including every read tool of all three
  server generations — is allowed for all callers. Verify the exact tool
  names your gateway sends with the dump-input debug technique before
  relying on this in production, and extend `write_suffixes` if your server
  exposes additional mutating tools.

  ## Argument shape

  None assumed. The policy decides on the tool name alone and never inspects
  `input.payload.args`.

  The identity check reads `input.subject.claims.groups` via `object.get`
  chains and expects an array of strings (the common IdP shape for a groups
  claim). Group comparison is exact (case-sensitive).

  ## Examples

  ### Allowed (read tool, any caller)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_read_channel", "type": "tool" },
      "subject": { "sub": "auth0|reader", "claims": { "groups": ["support"] } },
      "payload": { "name": "slack-mcp-slack_read_channel", "args": { "channel_id": "C0123456789" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed (write tool, group member)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_send_message", "type": "tool" },
      "subject": { "sub": "auth0|writer", "claims": { "groups": ["slack-writers"] } },
      "payload": { "name": "slack-mcp-slack_send_message", "args": { "channel_id": "C0123456789", "message": "shipping at 3" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (write tool, non-member)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack_send_message", "type": "tool" },
      "subject": { "sub": "auth0|reader", "claims": { "groups": ["support"] } },
      "payload": { "name": "slack-mcp-slack_send_message", "args": { "channel_id": "C0123456789", "message": "shipping at 3" } }
    }
  }
  ```

  `allow = false`, `reason = "Slack write tools are limited to members of the 'slack-writers' group — your Slack access through the agent channel is read-only. If you believe this is a false positive, ask your administrator to add you to the writers group."`.

  ## Composition

  This policy is the baseline least-privilege layer for Slack; it **composes
  with** (does not replace) the targeted deny policies:

  - [`slack/deny-channel-creation`](../deny-channel-creation/policy.md) and
    [`slack/deny-direct-messages`](../deny-direct-messages/policy.md) still
    apply to members of the writers group — a `slack-writers` member can
    post, but still cannot create channels or write into DMs while those
    policies are attached.
  - [`slack/block-secrets`](../block-secrets/policy.md) — DLP on the message
    body for the sends this policy permits.
  - [`slack/guard-dm-privacy`](../guard-dm-privacy/policy.md) — the read-side
    counterpart, gating DM/private-channel search and history.
  - [`slack/redact-sensitive-info`](../redact-sensitive-info/policy.md) —
    egress masking on what comes back.

  See the [`bundles/slack`](../../../bundles/slack/README.md) and
  [`bundles/im-messaging`](../../../bundles/im-messaging/README.md) bundles
  for the curated sets.

  ## Known limitations

  - **Group name is a placeholder.** Replace `slack-writers` (the
    `writers_group` constant in the Rego) with your IdP's real group name at
    import time. Group comparison is exact and case-sensitive.
  - **Groups claim must be an array of strings.** The Rego guards on
    `is_array(caller_groups)`, so every other shape fails closed and denies
    all writes: a single string (e.g. `"slack-writers"`), an object/map (a
    map's values are *not* treated as memberships — this guard is why), a
    number, or `null`. If your IdP emits `groups` as a string, a map, or a
    namespaced custom claim (e.g. `https://acme.com/groups`), point
    `caller_groups` at the real array location — until then, all writes are
    denied for every caller (fail-closed).
  - **Official tool names are observed-current, not contractual.** Slack
    publishes exact names only at runtime and says to treat `tools/list` as
    the source of truth; names can change. The five official write names here
    are corroborated across catalogs and integration guides as of mid-2026 —
    re-verify after server updates.
  - **Write list is a blocklist.** New mutating tools added by a server
    upgrade are allowed until added to `write_suffixes`. Slack's docs also
    describe reaction, file, and channel/DM-creation capabilities on the
    official server whose tool names were not verifiable — they are
    deliberately not matched here (do not police guessed names). For a
    fail-closed posture on unknown tools, compose with a default-deny
    allowlist policy instead.
  - **Suffix over-match.** Generic suffixes like `reactions_add` or
    `saved_update` could match a non-Slack tool with the same ending on a
    shared pipeline. Scope the pipeline to the Slack server, or narrow the
    suffixes, if that is a concern.
  - **Nameless requests pass.** If a request carries no tool name under
    *either* `resource.name` or `payload.name` — or carries a non-string value
    (an object/number/array) in *both* fields, which each coerce to the empty
    string — no write suffix can match and the call is allowed; there is no
    tool name for this policy to gate. (A non-string in only *one* field does
    **not** open the gate: the other field is still checked, so a real write
    name there is still caught — see the poison-proof note under Tool name
    matching.) A normal `tool_pre_invoke` always names its tool, so this
    affects only malformed or mis-routed hooks; compose with a default-deny
    allowlist policy if you need unknown-shape requests denied outright.
  - **Name-only decision.** The policy cannot distinguish destinations or
    content — a writers-group member can post anywhere the token reaches.
    Compose with the targeted policies above to constrain *what* writers can
    do.

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
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.ingress.role_gate_writes

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group allowed to call Slack write tools.
# Replace with your IdP's real group name at import time.
writers_group := "slack-writers"

# Write-tool suffixes across the three Slack MCP server generations in real
# use. Matched against the lowercased, hyphen-normalized resource name (the
# gateway prefixes tool names with the configured server name, so we match
# by suffix to stay portable). Verify exact names with the dump-input debug
# technique before deploying.
write_suffixes := [
    # --- Official Slack MCP server (mcp.slack.com; names observed via
    #     tools/list — Slack says to treat tools/list as source of truth) ---
    "slack_send_message",
    "slack_schedule_message",
    "slack_send_message_draft",
    "slack_create_canvas",
    "slack_update_canvas",

    # --- korotovsky community server (Slack-Web-API-style object_verb) ---
    "conversations_add_message",
    "reactions_add",
    "reactions_remove",
    "conversations_mark",
    "saved_update",
    "saved_clear_completed",
    "usergroups_create",
    "usergroups_update",
    "usergroups_users_update",

    # --- Archived reference server (legacy, still widely forked) ---
    "slack_post_message",
    "slack_reply_to_thread",
    "slack_add_reaction",
]

# The tool identity can arrive under the PARC `resource.name` or the legacy
# `payload.name`. Both are populated on tool hooks and documented to carry the
# same value, and `payload.name` is the actual invocation target — so we check
# BOTH. Keying on `resource.name` alone lets a request disable the write gate
# by carrying the write name only under `payload.name` (or by leaving
# `resource.name` empty/absent), which would let every write through as a
# non-writer. `object.get(..., "")` makes a missing name normalize to the empty
# string, which matches no suffix, so a missing field never opens the gate.
#
# Hyphens are normalized to underscores so both kebab-case and snake_case
# deployments match the same suffix list (e.g. `slack-mcp-slack-send-message`
# and `slack-mcp-slack_send_message` both normalize to `..._slack_send_message`).
#
# A missing OR non-string name coerces to "" (matches no suffix). This is
# fail-closed for detection AND poison-proof: `lower()` errors on a non-string,
# which without the `is_string` guard would leave the rule undefined and make
# the `[resource_tool_name, payload_tool_name]` array undefined — silently
# disabling the write gate whenever EITHER field carried a non-string value
# (an object/number/array), even while the other field carried a real write
# name. Coercing per field keeps a non-string in one field from disabling
# detection of the write name in the other.
normalized_name(obj) := replace(lower(name), "-", "_") if {
    name := object.get(obj, "name", "")
    is_string(name)
}

normalized_name(obj) := "" if {
    not is_string(object.get(obj, "name", ""))
}

resource_tool_name := normalized_name(object.get(input, "resource", {}))

payload_tool_name := normalized_name(object.get(input, "payload", {}))

is_slack_write_tool if {
    some candidate in [resource_tool_name, payload_tool_name]
    some suffix in write_suffixes
    endswith(candidate, suffix)
}

# Fail-closed groups lookup: missing subject, missing claims, or a missing
# groups claim all resolve to [] and grant nothing.
caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

# Exact, case-sensitive group match. The `is_array` guard makes every
# non-array shape fail closed: a string groups claim (e.g. "slack-writers")
# yields no bindings anyway, but an OBJECT/map claim would otherwise have
# `some group in caller_groups` iterate its VALUES — so a map whose value
# happened to equal the writers group would wrongly grant. Requiring an
# array first honors the documented "must be a list of strings" contract:
# string, object, number, and null groups claims all deny.
caller_is_writer if {
    is_array(caller_groups)
    some group in caller_groups
    group == writers_group
}

# Read tools (anything not on the write list) pass for every caller.
allow if {
    not is_slack_write_tool
}

# Write tools pass only for members of the writers group.
allow if {
    is_slack_write_tool
    caller_is_writer
}

reasons contains "Slack write tools are limited to members of the 'slack-writers' group — your Slack access through the agent channel is read-only. If you believe this is a false positive, ask your administrator to add you to the writers group." if {
    is_slack_write_tool
    not caller_is_writer
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
