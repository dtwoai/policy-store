---
name: Block External Team Chat Invites & Members
tags:
  - zoom
  - guard-external-send
  - ingress
  - team-chat
  - soc2
  - gdpr-ccpa
  - hipaa
publishedAt: 2026-07-12
description: |
  # zoom / guard-external-chat-invites

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `zoom.ingress.guard_external_chat_invites`

  ## What it does

  Stops a Zoom Team Chat agent from pulling external parties into the
  organization's chat surface. It guards four write tools and lets every other
  Team Chat tool pass through:

  - **`*zoom_chat_contact_add` — denied outright.** Contact invitations can be
    addressed to arbitrary external email addresses, and the invitee argument is
    not reliably introspectable, so the whole tool is blocked rather than
    filtered. Add people who already have accounts to a channel instead, or route
    a sanctioned external invite through a human.
  - **`*zoom_chat_channel_members_add` — denied when any address in
    `user_email_list` is external.** Members whose email domain is outside the
    corporate-domain allowlist are blocked before they are added to the channel.
  - **`*zoom_chat_channel_update` — denied when any address in `user_email_list`
    is external.** Channel update carries the same `channelId` + `user_email_list`
    signature as `channel_members_add`, so it is a second path to add members to a
    channel. It is guarded identically: a metadata-only update (rename, permission
    change) with no `user_email_list` passes untouched, but one that introduces an
    external address is blocked. Without this, an agent blocked from
    `channel_members_add` could add the same external members via `channel_update`.
  - **`*zoom_chat_channel_create` — denied when
    `new_members_can_see_previous_messages_and_files` is true and any invited
    address is external.** That flag retroactively exposes the channel's prior
    messages and files to new members, so creating a history-visible channel that
    invites an outside domain is blocked. Creating the same channel with the flag
    off (or with only internal invitees) passes.

  Addresses are read from `user_email_list` with `object.get`, lowercased, and
  matched against the domain allowlist. The check is **fail-closed**: if
  `user_email_list` is present but is not a readable list of addresses, the call
  is denied rather than allowed. All non-invite Team Chat tools
  (`*zoom_chat_message_send`, `*zoom_chat_message_update`, channel reads, …) and
  every non-chat Zoom tool pass through untouched. `*zoom_chat_channel_update` is
  guarded like `channel_members_add` because it shares the membership-add
  argument.

  This is an ingress policy because adding a member or sending an invitation is a
  write with an immediate, externally visible effect — once the call reaches the
  Team Chat server the outsider has access. Egress inspection could not undo it.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information outside the boundary: agent-driven Team Chat membership and
    invitations to non-corporate domains are stopped before they take effect;
    **P6.1** — supports limits on disclosure of personal information to third
    parties over the agent's chat path.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing on the
    agent's Team Chat write path by keeping conversation history and files from
    reaching unverified external addresses; **Arts. 44/46** — supports control
    over agent-visible cross-border transfers by pinning chat membership and
    channel-history exposure to reviewed corporate domains.
  - **HIPAA §164.308(a)(4)** — supports information access management by keeping
    non-corporate parties out of Team Chat channels whose messages, files, and
    retroactively exposed history may carry PHI in healthcare tenants;
    **§164.502(e)** — supports the business-associate-contract corollary by
    blocking disclosure of that content to external addresses no BAA covers.

  ## Tool name matching

  The four guarded tools are matched case-insensitively by suffix on the tool
  name — read from **both** the PARC `input.resource.name` and the still-populated
  legacy `input.payload.name` alias, so the tool is caught if either field carries
  the suffix (they hold the same value on `tool_pre_invoke`; checking both means a
  call with `resource.name` absent still fails closed rather than slipping through
  as a passthrough):

  - `*zoom_chat_contact_add`
  - `*zoom_chat_channel_members_add`
  - `*zoom_chat_channel_update`
  - `*zoom_chat_channel_create`

  Zoom's Team Chat sub-server prefixes every tool with `zoom_chat_`, and the DTwo
  gateway further prefixes the configured MCP server name (e.g.
  `zoom-team-chat-zoom_chat_contact_add`), so suffix matching keeps the policy
  portable across server names. Verify the exact name your gateway sends with the
  dump-input debug technique before relying on this in production.

  All other `zoom_chat_*` tools — message send/update, channel reads — are not in
  the guarded set and pass through.

  ## Argument shape

  Invited addresses are read from the `user_email_list` argument, handling both
  shapes seen in the wild:

  - an **array of address strings**, and
  - a **single string** holding a comma- or semicolon-separated list.

  Each entry is lowercased and its domain is taken as the text after a single
  `@`. An entry with zero or several `@` signs yields no domain and is treated as
  **external** (unverifiable), so it is denied rather than skipped. A
  `user_email_list` that is present but is neither a string nor an array (e.g. an
  object or a number) is treated as unverifiable and the call is **denied**.

  Domain matching is a **label-boundary suffix match**: an address is internal
  when its domain equals an allowlisted domain **or** is a subdomain of one
  (`user@eu.example.com` matches `example.com`). The boundary requirement stops a
  look-alike domain such as `evilexample.com` from matching `example.com`. The
  allowlist ships with **placeholder** values (`example.com`, `example.org`) —
  replace them with your organization's real domains at import time.

  ## Examples

  ### Allowed — internal members only

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-team-chat-zoom_chat_channel_members_add", "type": "tool" },
      "payload": {
        "name": "zoom-team-chat-zoom_chat_channel_members_add",
        "args": {
          "channelId": "abc123",
          "user_email_list": ["alice@example.com", "bob@example.org"]
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — external member

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-team-chat-zoom_chat_channel_members_add", "type": "tool" },
      "payload": {
        "name": "zoom-team-chat-zoom_chat_channel_members_add",
        "args": {
          "channelId": "abc123",
          "user_email_list": ["alice@example.com", "partner@vendor-example.net"]
        }
      }
    }
  }
  ```

  `allow = false`, reason names the external-domain problem and the remediation.

  ### Denied — history-visible channel invites an outside domain

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-team-chat-zoom_chat_channel_create", "type": "tool" },
      "payload": {
        "name": "zoom-team-chat-zoom_chat_channel_create",
        "args": {
          "channel_name": "deal-room",
          "new_members_can_see_previous_messages_and_files": true,
          "user_email_list": ["partner@vendor-example.net"]
        }
      }
    }
  }
  ```

  `allow = false`. Creating the same channel with the flag off, or with only
  internal invitees, is allowed.

  ## Composition

  This policy is single-purpose. Useful companions:

  - `guard-chat-sends` (PF-16 / candidate 6) denying `*zoom_chat_message_send` /
    `*zoom_chat_message_update` whose body carries secrets — this policy governs
    *who* is in the channel, not *what* is posted to it.
  - `constrain-aggregator` (PF-14) fencing the workspace `search_zoom` fan-out so
    the agent cannot pull external CRM/HR data into a chat it just opened.
  - A `default-deny-unknown-tools` (PF-28) allowlist policy so a Team Chat write
    tool with an unanticipated name cannot slip past suffix matching.

  ## Known limitations

  - **`zoom_chat_channel_create` invitee field is unverified.** The Team Chat
    child skill lists `channel_name`, `channel_type`, `post_message_permission`,
    `mention_all_permission`, and `new_members_can_see_previous_messages_and_files`
    for channel creation but does **not** publish the invited-members field. This
    policy assumes create carries invitees under the same `user_email_list` key as
    `zoom_chat_channel_members_add`; if your Team Chat server names it differently,
    the external-invitee check on create will not fire (the
    `new_members_can_see_previous_messages_and_files` flag itself is still read as
    documented). Verify the field with the dump-input technique and add its key to
    the address extraction if it differs.
  - **`zoom_chat_channel_update` membership semantics are inferred.** The Team
    Chat child skill lists `channelId` and `user_email_list` for both
    `channel_update` and `channel_members_add`, so this policy treats a
    `channel_update` carrying `user_email_list` as a member-add path and guards it
    with the same external-domain / fail-closed rules. If your Team Chat server's
    `channel_update` does **not** add members from `user_email_list` (e.g. it only
    renames), the guard is a conservative no-op for metadata-only updates and only
    fires when external addresses are present. Verify with the dump-input
    technique.
  - **History-off channel creation with external invitees still passes.**
    `channel_create` is only denied when `new_members_can_see_previous_messages_and_files`
    is true; a brand-new channel that invites an external address with the flag off
    is allowed (a new channel has no prior history to expose). If you need to block
    external invitees on *any* channel creation, extend the create allow rules to
    require `not has_external_address` unconditionally.
  - **History-exposure flag coercion is fail-closed for string values.**
    The flag is treated as enabled when it is the boolean `true`, a non-zero
    number, or **any string that is not an explicit off-token**. The off-tokens
    (read as disabled, case-insensitive, trimmed) are `""`, `"false"`, `"0"`,
    `"no"`, `"off"`, `"disabled"`, `"none"`, and `"null"`. Every other string —
    including `"true"`, `"1"`, `"yes"`, and exotic truthy forms a downstream API
    might honor such as `"on"`, `"enabled"`, or `"y"` — enables the guard, so a
    client cannot slip an external, history-visible channel past it by picking a
    non-canonical truthy encoding. If your Team Chat server treats one of the
    listed off-tokens as truthy, remove it from the off-token set.
  - **`zoom_chat_contact_add` is blocked wholesale.** Its invitee argument shape
    is not documented, so the tool is denied outright rather than filtered by
    domain — including internal-only contact adds. If your team needs a sanctioned
    path, add a companion `allow if` branch gated on an IdP group claim.
  - **Suffix domain matching allows all subdomains.** Any subdomain of an
    allowlisted domain is treated as internal. If a subdomain is operated by a
    third party, list only the specific corporate subdomains rather than the apex
    domain.
  - **Placeholders.** The domain allowlist entries (`example.com`, `example.org`)
    are placeholders — replace them with your corporate domains at import time.
  - **No identity-based exemptions.** All callers are subject to the same checks.
    If you need an InfoSec break-glass user that may invite external parties, gate
    it with `input.subject.claims` as a separate `allow if` branch.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are
  > outside the gateway's reach by design. Validate against your own compliance
  > program before relying on it.
direction: ingress
apps:
  - zoom
industries: []
bundles:
  - soc2
  - gdpr-ccpa
  - hipaa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zoom.ingress.guard_external_chat_invites

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Corporate email domain allowlist — PLACEHOLDER values. Replace with your
# organization's real domains at import time. Matching is a label-boundary
# suffix match, so subdomains of these (e.g. eu.example.com) are internal too.
allowed_domains := {
    "example.com",
    "example.org",
}

# Tool arguments, defaulting safely when payload/args are missing entirely.
args := object.get(object.get(input, "payload", {}), "args", {})

# Tool-name candidates: the PARC resource.name plus the (deprecated but still
# populated on tool hooks) payload.name alias, both lowercased. A tool is
# matched if EITHER carries the suffix. Keying only on resource.name would fail
# OPEN for a call whose resource.name is absent — the guard would be undefined
# and the passthrough `allow if not is_guarded_tool` would permit it. Checking
# both fields (same value on tool_pre_invoke) closes that gap at no cost.
tool_names contains lower(name) if {
    name := object.get(object.get(input, "resource", {}), "name", "")
    name != ""
}

tool_names contains lower(name) if {
    name := object.get(object.get(input, "payload", {}), "name", "")
    name != ""
}

# --- Guarded tools, matched case-insensitively by suffix (Zoom Team Chat
# prefixes every tool with zoom_chat_; the gateway adds a server-name prefix). ---

is_contact_add if {
    some name in tool_names
    endswith(name, "zoom_chat_contact_add")
}

is_members_add if {
    some name in tool_names
    endswith(name, "zoom_chat_channel_members_add")
}

# zoom_chat_channel_update carries the SAME channelId + user_email_list argument
# signature as zoom_chat_channel_members_add (per the Zoom Team Chat child skill),
# so it is a second membership-mutation path: an agent blocked from members_add
# can add external addresses via channel_update instead. Guard it identically —
# deny only when user_email_list introduces an external/unparseable address; a
# metadata-only update (no user_email_list, or internal-only) still passes.
is_channel_update if {
    some name in tool_names
    endswith(name, "zoom_chat_channel_update")
}

is_channel_create if {
    some name in tool_names
    endswith(name, "zoom_chat_channel_create")
}

is_guarded_tool if is_contact_add

is_guarded_tool if is_members_add

is_guarded_tool if is_channel_update

is_guarded_tool if is_channel_create

# Pass through everything that is not one of the four guarded invite tools —
# all other zoom_chat_* tools and every non-chat Zoom tool.
allow if {
    not is_guarded_tool
}

# zoom_chat_contact_add has no allow rule: it is denied outright.

# zoom_chat_channel_members_add: allow only when the address list is not
# malformed and contains no external address. An absent user_email_list yields
# no external address, so it passes (nothing is being added externally).
allow if {
    is_members_add
    not malformed_email_list
    not has_external_address
}

# zoom_chat_channel_update: same rule as members_add — allow only when the
# address list is not malformed and contains no external address. A metadata-only
# update (no user_email_list) yields no external address, so it passes.
allow if {
    is_channel_update
    not malformed_email_list
    not has_external_address
}

# zoom_chat_channel_create: allow when history is not being exposed to new
# members (the retroactive-exposure flag is off).
allow if {
    is_channel_create
    not see_previous_enabled
}

# zoom_chat_channel_create with history exposure on: allow only when the invitee
# list is not malformed and contains no external address.
allow if {
    is_channel_create
    see_previous_enabled
    not malformed_email_list
    not has_external_address
}

# --- new_members_can_see_previous_messages_and_files. Fail-closed against value
# coercion: a client may send the flag as a bool, a stringified bool ("true"),
# a stringified/integer 1, or "yes". Any of these truthy encodings enables the
# history-exposure guard so a non-canonical truthy value cannot slip past it. ---

see_previous_enabled if {
    object.get(args, "new_members_can_see_previous_messages_and_files", false) == true
}

# String forms: fail-closed. Any string that is not an explicit falsy token is
# treated as ENABLED, so a client that sends the flag as "on"/"enabled"/"y" (or
# any other truthy encoding a downstream API might honor) cannot slip an external,
# history-visible channel past the guard. Only the explicit off-tokens below read
# as disabled.
see_previous_enabled if {
    v := object.get(args, "new_members_can_see_previous_messages_and_files", false)
    is_string(v)
    not lower(trim_space(v)) in {"", "false", "0", "no", "off", "disabled", "none", "null"}
}

# Numeric truthy form: any non-zero number (e.g. 1), since some clients coerce a
# boolean flag to an integer.
see_previous_enabled if {
    v := object.get(args, "new_members_can_see_previous_messages_and_files", false)
    is_number(v)
    v != 0
}

# --- Address extraction from user_email_list ---

# Array shape: user_email_list is an array of entries.
addresses contains addr if {
    value := object.get(args, "user_email_list", [])
    is_array(value)
    some addr in value
}

# String shape: a single address or a comma/semicolon-separated list.
addresses contains addr if {
    value := object.get(args, "user_email_list", "")
    is_string(value)
    some part in regex.split(`[,;]`, value)
    addr := trim_space(part)
    addr != ""
}

# user_email_list is present but neither a string nor an array (e.g. an object
# or number) — it cannot be parsed, so treat the call as unverifiable.
malformed_email_list if {
    value := object.get(args, "user_email_list", null)
    value != null
    not is_string(value)
    not is_array(value)
}

# Domain of one address entry. Conservative: the entry must be a string with
# exactly one "@". Entries with zero or several "@" signs yield no domain, so
# is_internal fails and the entry is treated as external.
address_domain(addr) := domain if {
    is_string(addr)
    parts := split(lower(trim_space(addr)), "@")
    count(parts) == 2
    # Strip a trailing ">" (and stray spaces) from a "Name <user@domain>" form.
    domain := trim(parts[1], "> ")
}

# Label-boundary suffix match: exact domain, or a subdomain of an allowlisted
# domain. The boundary stops look-alikes (evilexample.com vs example.com).
domain_internal(domain) if {
    allowed_domains[domain]
}

domain_internal(domain) if {
    some d in allowed_domains
    endswith(domain, concat("", [".", d]))
}

is_internal(addr) if {
    domain_internal(address_domain(addr))
}

has_external_address if {
    some addr in addresses
    not is_internal(addr)
}

# --- Deny reasons ---

reasons contains "Team Chat contact invitations are blocked because they can be addressed to external email accounts. Do not use zoom_chat_contact_add; add people who already have accounts to a channel instead, or ask your InfoSec team to invite an external contact if this collaboration is sanctioned." if {
    is_contact_add
}

reasons contains "One or more addresses in user_email_list are outside the corporate domain allowlist, so this Team Chat channel member add is blocked. Remove the external addresses, or ask your InfoSec team to add the domain to the allowlist if this external collaboration is sanctioned." if {
    is_members_add
    has_external_address
}

reasons contains "user_email_list is present but is not a readable list of email addresses, so this Team Chat channel member add is blocked (fail-closed). Pass user_email_list as an array of email address strings. Contact your InfoSec team if this is a false positive." if {
    is_members_add
    malformed_email_list
}

reasons contains "One or more addresses in user_email_list are outside the corporate domain allowlist, so this Team Chat channel update is blocked (channel updates can add members the same way channel_members_add does). Remove the external addresses, or ask your InfoSec team to add the domain to the allowlist if this external collaboration is sanctioned." if {
    is_channel_update
    has_external_address
}

reasons contains "user_email_list is present but is not a readable list of email addresses, so this Team Chat channel update is blocked (fail-closed). Pass user_email_list as an array of email address strings, or omit it for a metadata-only update. Contact your InfoSec team if this is a false positive." if {
    is_channel_update
    malformed_email_list
}

reasons contains "This channel is being created with new_members_can_see_previous_messages_and_files enabled while one or more invited addresses are outside the corporate domain allowlist, which would expose prior messages and files to external people. Turn that setting off, remove the external invitees, or ask your InfoSec team to approve the external domain." if {
    is_channel_create
    see_previous_enabled
    has_external_address
}

reasons contains "This channel enables new_members_can_see_previous_messages_and_files but user_email_list is not a readable list of email addresses, so it is blocked (fail-closed) to avoid exposing channel history to unverifiable invitees. Pass user_email_list as an array of email address strings, or turn that setting off. Contact your InfoSec team if this is a false positive." if {
    is_channel_create
    see_previous_enabled
    malformed_email_list
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
