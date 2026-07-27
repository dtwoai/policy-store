---
name: Freeze Destructive and Series-Wide Calendar Changes
tags:
  - google-calendar
  - freeze-destructive-ops
  - ingress
  - integrity
  - soc2
publishedAt: 2026-07-12
description: |
  # google-calendar / freeze-destructive-events

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `google_calendar.ingress.freeze_destructive_events`

  ## What it does

  Denies irreversible Google Calendar mutations on the agent channel:

  1. **Event deletes** — the dedicated destructive tools (`delete_event` /
     `delete-event`) and taylorwilsdon's consolidated `manage_event` tool when its
     `action` argument is a destructive verb (`delete`, `remove`, `cancel`, and
     related synonyms) — for every caller **outside** the placeholder
     `calendar-admins` group. `manage_event` is the known trap here: a single tool
     name spans write *and* destructive operations, so the policy inspects the
     action argument rather than trusting the name.
  2. **Series-wide recurring-event changes** — any create/update/delete whose
     `modificationScope` is not a single instance (e.g. `all`, `thisAndFollowing`,
     `future`) is denied **for all callers, including `calendar-admins`**, because
     recurring-series-wide edits and deletes can silently wipe or move standing
     meetings and Calendar offers no MCP-level undo.
  3. **Fail closed on `manage_event` ambiguity** — a `manage_event` call whose
     `action` argument is absent (or not a string) cannot be distinguished from a
     delete and is denied for non-admins; a `manage_event` call whose
     `modificationScope` is absent (or not a string) has an unverifiable
     series blast radius and is denied for everyone.

  The check runs at ingress, before the call reaches the Calendar MCP server, so a
  blocked delete or series rewrite never executes. This preserves record integrity
  against both agent error and prompt injection.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports integrity of stored records by preventing
    agent-driven destruction and mass rewrite of calendar entries. **CC6.7** —
    supports the restriction on removal of information by refusing irreversible
    agent-driven deletes and series-wide rewrites on the calendar path.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name, and
  Calendar servers disagree on delimiters (`delete_event` — official Google
  server, snake_case — vs `delete-event` — nspady, kebab-case). The policy
  lowercases the tool name, normalizes `-` to `_`, and matches by suffix:

  - `*delete_event` — dedicated destructive tools (Google `delete_event`, nspady
    `delete-event`)
  - `*manage_event` — taylorwilsdon's consolidated create/update/delete tool
  - `*create_event`, `*update_event` — write tools, inspected only for the
    series-wide `modificationScope` check

  Read tools (`list_events`, `get-event`, `search-events`, `respond_to_event`,
  …) do not match any suffix and pass through. Verify the exact names your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  ## Argument shape

  - `input.payload.args.action` — `manage_event`'s operation selector. The policy
    treats any string containing a destructive verb (`delete`, `remove`,
    `cancel`, `trash`, `purge`, `destroy`; case-insensitive) as destructive.
    Missing/non-string → fail closed (deny for non-admins).
  - `modificationScope` (recurring-series blast radius, documented on nspady's
    `update-event`) — the policy **normalizes the argument key** the same way it
    normalizes tool names (lowercase, strip `-`/`_`), so `modificationScope`,
    `modification_scope`, `modification-scope`, and `ModificationScope` are all
    treated as the same key. Every string value under any matching key is
    normalized (case and `-`/`_` stripped) and checked against a single-instance
    allowlist (`single`, `thisEventOnly`). If **any** provided value is not
    single-instance, the call is series-wide and denied — so a caller cannot pair
    a safe value under one spelling with a series-wide value under another to slip
    past a server that reads the other spelling. On `manage_event`, a call with no
    usable scope value under any spelling is denied outright (fail closed); on
    dedicated create/update/delete tools a missing value passes the scope check,
    since single-instance is the servers' default and `create` calls normally have
    no scope argument.
  - `futureStartDate` (also `future_start_date` or any delimiter/case variant,
    matched with the same key normalization) — nspady's alternate
    "this-and-following" split control. A non-empty string value is treated as
    series-wide and denied for everyone on any event-mutation tool, the same as a
    series-wide `modificationScope`.

  ## Identity

  Callers whose `input.subject.claims.groups` contains `calendar-admins`
  (case-insensitive) are exempt from the delete rules (1 and the non-admin half
  of 3) but **not** from the series-wide rules. Missing claims fail closed: no
  groups claim means no exemption.

  ## Examples

  ### Allowed — single-instance update

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-calendar-mcp-update-event", "type": "tool" },
      "payload": {
        "name": "google-calendar-mcp-update-event",
        "args": { "eventId": "abc123", "summary": "Standup (moved)", "modificationScope": "thisEventOnly" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — non-admin delete

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-calendar-mcp-delete-event", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "google-calendar-mcp-delete-event",
        "args": { "calendarId": "primary", "eventId": "abc123" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Deleting calendar events through the agent is limited to the calendar-admins group (...)"`.

  ### Denied — series-wide edit, even for admins

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-calendar-mcp-update-event", "type": "tool" },
      "subject": { "sub": "google-apps|admin@example.com", "claims": { "groups": ["calendar-admins"] } },
      "payload": {
        "name": "google-calendar-mcp-update-event",
        "args": { "eventId": "abc123", "modificationScope": "all" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Series-wide recurring-event changes are blocked for all callers (...)"`.

  ## Composition

  This policy is single-purpose (destructive/series-wide freeze). Useful
  companions in the same app directory:

  - `guard-external-attendees` — blocks invite-based exfiltration to external
    domains.
  - `guard-public-exposure` — blocks `visibility: public` and guest-privilege
    delegation.
  - `redact-attendee-pii` — egress redaction of attendee emails and meeting
    links on read tools.

  ## Known limitations

  - **Group names are placeholders** — replace `calendar-admins` with your IdP's
    group name at import time. The exemption reads `input.subject.claims.groups`;
    if your IdP emits roles under a different claim, adjust `is_calendar_admin`.
  - **`manage_event` argument schema is partially unverified.** taylorwilsdon's
    README verifies that `manage_event` consolidates create/update/delete behind
    an action argument, but the exact argument key (`action`) and its value enum
    are not published in the landscape research; the `modificationScope` key on
    `manage_event` is likewise unverified (it is documented on nspady's
    `update-event`). The policy fails closed when the action or scope argument is
    **missing or non-string**, so that class of schema mismatch shows up as a
    deny. It does **not** fail closed on a *present* action string that the server
    maps to a delete but that contains none of the known destructive verbs
    (`delete`/`remove`/`cancel`/`trash`/`purge`/`destroy`): such a call is treated
    as a non-destructive create/update and allowed for non-admins. Verify your
    server's action enum with the dump-input technique and extend
    `destructive_action_verbs` if it uses a delete verb outside this set. The
    series-wide freeze (rule 4) is unaffected by this residual, and admins remain
    exempt from the delete rule regardless.
  - **Single-instance scope allowlist is conservative.** Only `single` and
    `thisEventOnly` (after normalization) pass; nspady's exact enum values are
    unverified, so legitimate single-instance spellings not on the list will be
    denied. Extend `single_instance_scopes` for your server.
  - **Non-string `modificationScope` *value* on dedicated tools fails open.** The
    argument *key* is normalized (case and `-`/`_` stripped), so an alternate key
    spelling no longer slips past the series-wide check. What still fails open is
    a recognized scope key carrying a non-string *value* (array, number, `null`)
    on a dedicated `create`/`update`/`delete` tool: it passes the scope check
    (the server will typically reject such a value anyway). Only `manage_event`
    fails closed on an unusable scope value. The `action` key on `manage_event` is
    matched by its exact name; an alternate-cased `action` key reads as a missing
    action and therefore fails closed for non-admins (rule 3), so it is not a
    bypass.
  - **Series-wide freeze applies to `calendar-admins` too.** Series-wide changes
    must be made in the Google Calendar UI, by design. This includes calls
    carrying a `futureStartDate` split control, which is treated as series-wide.
  - **Tool-name source.** The policy matches on `input.resource.name`, falling
    back to the legacy `input.payload.name` alias if the former is empty. Both
    are populated on tool hooks per the input schema; the fallback is defence in
    depth against a caller that populates only the legacy field.
  - **Deletes are still possible outside MCP.** Web-UI and native-API deletes are
    out of the gateway's reach; this policy only freezes the agent channel.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - google-calendar
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_calendar.ingress.freeze_destructive_events

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, and
# Calendar servers disagree on delimiters (`delete_event` vs `delete-event`),
# so we lowercase, normalize `-` to `_`, and match by suffix.
# Prefer the PARC `resource.name`, but fall back to the legacy `payload.name`
# alias so a call that only populates the latter still gets matched (defence
# in depth — both are populated on tool hooks per the input schema).
raw_resource_name := object.get(object.get(input, "resource", {}), "name", "")

effective_name := raw_resource_name if raw_resource_name != ""

effective_name := object.get(object.get(input, "payload", {}), "name", "") if raw_resource_name == ""

normalized_name := replace(lower(effective_name), "-", "_")

# Dedicated destructive tools: Google official `delete_event`, nspady `delete-event`.
is_delete_tool if endswith(normalized_name, "delete_event")

# taylorwilsdon's consolidated tool — one name spans create/update/delete, so
# the destructive check below inspects the action argument, not the name.
is_manage_event if endswith(normalized_name, "manage_event")

# The full event-mutation family this policy inspects (`[-_]event$` verbs).
is_event_mutation_tool if is_delete_tool

is_event_mutation_tool if is_manage_event

is_event_mutation_tool if endswith(normalized_name, "create_event")

is_event_mutation_tool if endswith(normalized_name, "update_event")

# --- Identity ----------------------------------------------------------------
# `calendar-admins` is a placeholder group name — replace it with your IdP's
# group at import time. Missing claims fail closed: no groups, no exemption.
is_calendar_admin if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    some g in object.get(claims, "groups", [])
    lower(g) == "calendar-admins"
}

# --- Arguments ---------------------------------------------------------------
args := object.get(object.get(input, "payload", {}), "args", {})

# manage_event's operation selector. Only usable when it is a non-empty string;
# anything else fails closed via the deny rules below.
action_raw := object.get(args, "action", "")

manage_action := lower(action_raw) if is_string(action_raw)

has_usable_action if {
    is_string(action_raw)
    action_raw != ""
}

# Destructive-action verbs on the consolidated manage_event tool. The exact
# enum is unverified (see Known limitations), so we match a set of destructive
# synonyms as a substring rather than trusting only the literal `delete` — a
# `cancel`/`remove`/`purge` action is as irreversible as a delete.
destructive_action_verbs := {"delete", "remove", "cancel", "trash", "purge", "destroy"}

is_destructive_action if {
    some verb in destructive_action_verbs
    contains(manage_action, verb)
}

# Recurring-series blast radius. Servers spell this argument key differently
# (`modificationScope`, `modification_scope`, and plausibly kebab/Pascal/all-
# lowercase variants), so we normalize the KEY exactly as we normalize tool
# names — lowercase and strip `-`/`_` — and collect every value whose normalized
# key is `modificationscope`. Inspecting EVERY matching key (not a first-key-wins
# precedence) means a caller cannot pair a safe value under one spelling with a
# series-wide value under another to slip past a server that reads the other
# spelling.
scope_values := [v |
    some k, raw in args
    replace(replace(lower(k), "-", ""), "_", "") == "modificationscope"
    is_string(raw)
    raw != ""
    v := raw
]

has_usable_scope if count(scope_values) > 0

# Scope values that touch exactly one instance (normalized). Anything else —
# `all`, `thisandfollowing`, `future`, unknown spellings — is treated as
# series-wide and denied: a deliberate fail-closed allowlist.
single_instance_scopes := {"single", "thiseventonly"}

# Any provided scope value (across either key) that is not single-instance makes
# the change series-wide.
has_series_wide_scope if {
    some v in scope_values
    normalized := replace(replace(lower(v), "-", ""), "_", "")
    not single_instance_scopes[normalized]
}

# nspady's `futureStartDate` (also `future_start_date`, or any delimiter/case
# variant) is an alternate series blast-radius control ("this and following"
# from a split date); its presence means the mutation is not confined to a
# single instance, so treat it as series-wide too. The key is matched with the
# same normalization as the scope key, so no alternate spelling fails open.
has_future_start if {
    some k, v in args
    replace(replace(lower(k), "-", ""), "_", "") == "futurestartdate"
    is_string(v)
    v != ""
}

# --- Allow rules -------------------------------------------------------------

# Pass through every tool outside the event-mutation family (reads, freebusy,
# respond_to_event, and all non-Calendar tools).
allow if {
    not is_event_mutation_tool
}

# Allow event mutations only when no deny condition fired.
allow if {
    is_event_mutation_tool
    count(reasons) == 0
}

# --- Deny reasons ------------------------------------------------------------

# 1. Dedicated delete tools are admin-only: deletes have no MCP-level undo.
reasons contains "Deleting calendar events through the agent is limited to the calendar-admins group because Google Calendar offers no MCP-level undo. Ask a calendar administrator to remove the event, or contact your IT team if you believe this is a false positive." if {
    is_delete_tool
    not is_calendar_admin
}

# 2. manage_event acting as a destructive op — same restriction as a dedicated
#    delete. Matches any destructive verb, not just the literal `delete`.
reasons contains "Deleting calendar events through the agent is limited to the calendar-admins group because Google Calendar offers no MCP-level undo. Ask a calendar administrator to remove the event, or contact your IT team if you believe this is a false positive." if {
    is_manage_event
    is_destructive_action
    not is_calendar_admin
}

# 3. manage_event with no usable action cannot be distinguished from a delete —
#    fail closed for non-admins.
reasons contains "This manage_event call did not include a usable action argument, so it cannot be distinguished from a delete and was denied. Retry with an explicit action such as create or update, or contact your IT team if you believe this is a false positive." if {
    is_manage_event
    not has_usable_action
    not is_calendar_admin
}

# 4. Explicit series-wide scope on any event mutation — denied for everyone,
#    including calendar-admins: series rewrites can silently wipe standing
#    meetings.
reasons contains "Series-wide recurring-event changes are blocked for all callers because they can silently move or wipe standing meetings with no MCP-level undo. Retry with modificationScope set to a single instance, or make series-wide changes in the Google Calendar UI." if {
    is_event_mutation_tool
    has_series_wide_scope
}

# 4b. A `futureStartDate` (this-and-following split) is series-wide too — denied
#     for everyone.
reasons contains "Series-wide recurring-event changes are blocked for all callers because they can silently move or wipe standing meetings with no MCP-level undo. Retry with modificationScope set to a single instance, or make series-wide changes in the Google Calendar UI." if {
    is_event_mutation_tool
    has_future_start
}

# 5. manage_event without a usable modificationScope has an unverifiable series
#    blast radius — fail closed for everyone.
reasons contains "This manage_event call did not include a usable modificationScope argument, so its recurring-series blast radius cannot be verified and it was denied. Retry with modificationScope set to a single instance, or contact your IT team if you believe this is a false positive." if {
    is_manage_event
    not has_usable_scope
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
