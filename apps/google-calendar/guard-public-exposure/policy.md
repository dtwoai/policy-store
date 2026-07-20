---
name: Block Public Visibility & Guest Delegation
tags:
  - google-calendar
  - guard-public-exposure
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # google-calendar / guard-public-exposure

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `google_calendar.ingress.guard_public_exposure`

  ## What it does

  Blocks Google Calendar **create** and **update** event calls that would expose
  the event to the world or hand control of it to guests. A call is denied when
  any of these appear in its arguments:

  - `visibility` set to `"public"` — publishes the event body (summary,
    description, attendees, time) so anyone can read it.
  - `guestsCanModify` set to `true` — grants every guest, including external
    ones, edit rights over the event.
  - `guestsCanInviteOthers` set to `true` — lets guests invite additional people
    and widen who can see the event.
  - `anyoneCanAddSelf` set to `true` — lets anyone add themselves as a guest and
    read the event body.

  These flags — documented on the `nspady/google-calendar-mcp` `create-event`
  argument surface — turn a private meeting that carries PHI or deal-sensitive
  detail into a broadly readable or attacker-editable object. The check runs at
  ingress, before the call reaches the Calendar MCP server, so the exposed event
  is never created and never propagated to Google's sharing surfaces.

  Every other tool call passes through unchanged, and a create/update call with
  none of these flags set (or all of them at their safe defaults) is allowed.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission, movement, and
    removal of confidential information (PF-05) by stopping the agent from
    publishing an internal event to a publicly readable scope or delegating its
    control to outside guests. **P6.1** — supports constraining disclosure of
    personal information to third parties, since a public or guest-delegable
    event exposes attendee lists and free-text bodies beyond the org (Partial on
    the MCP path).
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing by
    preventing the agent from exposing attendee personal data (names, email
    addresses) and event free-text bodies to a publicly readable scope or to
    externally-delegable guests. **Art. 5(1)(c)** — supports data minimisation
    by keeping personal data in event bodies from being disclosed beyond its
    intended internal audience. **CCPA/CPRA §1798.150** — reduces nonredacted-PI
    exposure by blocking public publication of attendee data.

  ## Tool name matching

  The three server families expose the same write operations under different
  delimiter styles — `create_event` / `update_event` (Google, snake),
  `create-event` / `update-event` (nspady, kebab), and the consolidated
  `manage_event` (taylorwilsdon). The policy normalizes `-` to `_` in the tool
  name and matches the suffixes `create_event`, `update_event`, and
  `manage_event`. The gateway prepends its own configured server-name prefix
  (which is not standardized), so matching is by suffix rather than by exact
  fully-qualified name — a name like `gcal-mcp-create-event` still matches.
  Both `input.resource.name` (PARC) and `input.payload.name` (legacy tool-hook
  field) are checked; if **either** names a write-event tool the call is
  inspected, so a missing or divergent `resource.name` cannot fail the match
  open. Verify the exact tool name your gateway sends with the dump-input debug
  technique before relying on this in production.

  Read tools (`list-events`, `get-event`, …) and destructive tools
  (`delete-event`, `respond-to-event`) do **not** end in a `create`/`update`/
  `manage` `_event` suffix, so they pass through untouched. `manage_event` also
  spans delete: a delete carries none of the exposure flags, so it is read at its
  safe defaults and allowed — this policy governs exposure, not deletion (pair it
  with a destructive-ops guard for that).

  ## Argument shape

  Each flag is read with `object.get(args, key, default)` against a **safe**
  default, so an omitted flag is treated as its non-exposing value and the call
  is allowed:

  - `visibility` defaults to `""` (compared case-insensitively to `"public"`,
    ignoring surrounding whitespace).
  - `guestsCanModify`, `guestsCanInviteOthers`, `anyoneCanAddSelf` default to
    `false`.

  Boolean flags match `true` whether sent as a JSON boolean, as the string
  `"true"` or `"1"` (any casing, surrounding whitespace ignored — some clients
  coerce booleans to strings), or as the number `1` (numeric-boolean clients),
  so a coerced flag cannot slip past the check.

  If a **write-event** call carries an `args` value that is not a JSON object
  (a string, array, or number), the exposure checks cannot inspect it, so the
  call is **denied** (fail closed) with a reason asking for a standard
  arguments object. A `null` or absent `args` is treated as "no flags set" and
  allowed. Non-write tools are never affected by this check.

  ## Examples

  ### Allowed — no exposure flags

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-calendar-mcp-create-event", "type": "tool" },
      "payload": {
        "name": "google-calendar-mcp-create-event",
        "args": { "summary": "1:1", "start": "…", "end": "…", "visibility": "private" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — public visibility

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-calendar-mcp-create-event", "type": "tool" },
      "payload": {
        "name": "google-calendar-mcp-create-event",
        "args": { "summary": "Project Atlas M&A sync", "visibility": "public" }
      }
    }
  }
  ```

  `allow = false`, reason explains that public visibility publishes the event and
  how to fix it.

  ### Denied — guest control delegated

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-calendar-mcp-update-event", "type": "tool" },
      "payload": {
        "name": "google-calendar-mcp-update-event",
        "args": { "eventId": "abc123", "guestsCanInviteOthers": true }
      }
    }
  }
  ```

  `allow = false`, reason names the `guestsCanInviteOthers` flag.

  ## Composition

  Single-purpose. Useful companions from the Calendar candidate set:

  - An **ingress external-attendee guard** on create/update so invitations to
    outside domains are controlled alongside public exposure.
  - An **ingress `sendUpdates` transform** that defaults agent writes to silent
    so a mistaken create never emails an invitation.
  - An **egress attendee/PII scrub** on the read tools so previously-created
    public events are masked when read back.

  These stay separate policies so each is independently testable and attachable.

  ## Known limitations

  - **No break-glass group by default.** Public or self-serve visibility is
    rarely a legitimate agent action, so no IdP group is exempted. If a tenant
    needs a break-glass path, add a single `allow if` branch keyed on
    `input.subject.claims.groups` — e.g. allow when the caller's groups contain a
    placeholder like `calendar-public-publishers` — using an
    `object.get(input.subject, "claims", {})` chain so a missing claim fails
    closed (no group → not exempt → still denied). **Group names are
    placeholders — replace `calendar-public-publishers` with your IdP's group
    name at import time.**
  - **Flag set is fixed.** The policy checks the four documented exposure/
    delegation flags. Calendar sharing also has an ACL surface
    (`acl.insert` with `role: reader` / `scope.type: default`) that the MCP
    servers in scope do **not** expose as a tool; if a future server surfaces
    calendar-level ACL writes, extend the matcher and flag list to cover them.
  - **Argument-key assumptions.** Flag names follow the `nspady` `create-event`
    surface (Calendar v3 camelCase). A server that renames these (e.g.
    `guests_can_modify` snake-case) would not be matched — confirm the exact
    argument keys your server accepts with the dump-input technique and add them
    to the flag list if they differ.
  - **Top-level keys only.** Flags are read from the top level of `args`, which
    is where every in-scope server documents them. A hypothetical server that
    nests the event body (e.g. `args.event.visibility`) would not be inspected
    and the call would be allowed — confirm your server's argument shape with
    the dump-input technique and extend the detections if it nests the body.
  - **`manage_event` action not inspected.** The consolidated tool is matched by
    suffix regardless of its action argument; a delete or a read-shaped action
    simply carries none of the exposure flags and is allowed. This policy does
    not restrict what `manage_event` does beyond exposure — compose a
    destructive-ops guard for deletes.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - google-calendar
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_calendar.ingress.guard_public_exposure

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Tool matching ------------------------------------------------------------
# The write operations appear under three delimiter styles across servers:
#   create_event / update_event   (Google, snake_case)
#   create-event / update-event   (nspady, kebab-case)
#   manage_event                  (taylorwilsdon, consolidated create/update/delete)
# Normalize `-` to `_` and match by suffix so the gateway's configured
# server-name prefix (e.g. `google-calendar-mcp-`) does not defeat the match.
# Both the PARC field (resource.name) and the legacy tool-hook field
# (payload.name) are checked: if either names a write-event tool the call is
# inspected, so a missing or divergent resource.name cannot fail the match open.
normalized_name(raw) := replace(lower(raw), "-", "_")

tool_names contains normalized_name(object.get(object.get(input, "resource", {}), "name", ""))

tool_names contains normalized_name(object.get(object.get(input, "payload", {}), "name", ""))

write_suffixes := {"create_event", "update_event", "manage_event"}

is_write_event_tool if {
	some name in tool_names
	some suffix in write_suffixes
	endswith(name, suffix)
}

# --- Arguments ----------------------------------------------------------------
# Read the args bag defensively; a missing (or null) payload/args yields {} so
# every flag below resolves to its safe default. A present-but-non-object args
# value (string, array, number) is flagged as malformed instead — see
# malformed_args below — because none of the detections could inspect it.
raw_args := object.get(object.get(input, "payload", {}), "args", {})

tool_args := raw_args if is_object(raw_args)

tool_args := {} if not is_object(raw_args)

# Fail closed when a write-event call carries args the detections cannot read.
# (null is treated like missing args — safe defaults — not as malformed.)
malformed_args if {
	not is_object(raw_args)
	raw_args != null
}

# A flag counts as "on" when it is boolean true, the string "true" or "1"
# (compared case-insensitively, ignoring surrounding whitespace — some clients
# coerce booleans to strings on the wire), or the number 1 (numeric-boolean
# clients).
flag_true(key) if {
	object.get(tool_args, key, false) == true
}

flag_true(key) if {
	v := object.get(tool_args, key, false)
	is_string(v)
	truthy_strings[lower(trim_space(v))]
}

truthy_strings := {"true", "1"}

flag_true(key) if {
	object.get(tool_args, key, false) == 1
}

# --- Exposure / delegation detections -----------------------------------------
public_visibility if {
	v := object.get(tool_args, "visibility", "")
	is_string(v)
	lower(trim_space(v)) == "public"
}

guests_can_modify if {
	flag_true("guestsCanModify")
}

guests_can_invite_others if {
	flag_true("guestsCanInviteOthers")
}

anyone_can_add_self if {
	flag_true("anyoneCanAddSelf")
}

exposes_event if {
	public_visibility
}

exposes_event if {
	guests_can_modify
}

exposes_event if {
	guests_can_invite_others
}

exposes_event if {
	anyone_can_add_self
}

# --- Allow rules --------------------------------------------------------------
# Pass through anything that is not a create/update event write.
allow if {
	not is_write_event_tool
}

# Allow create/update writes that carry no exposure or delegation flag and
# whose arguments were actually inspectable.
allow if {
	is_write_event_tool
	not exposes_event
	not malformed_args
}

# --- Deny reasons -------------------------------------------------------------
reasons contains "This event sets visibility to \"public\", which publishes its summary, description, attendees, and time to anyone. Set visibility to \"private\" or \"default\" before creating or updating the event. Contact your security team if a public event is genuinely required." if {
	is_write_event_tool
	public_visibility
}

reasons contains "This event sets guestsCanModify to true, granting every guest — including any external attendees — edit rights over the event. Remove guestsCanModify (or set it to false) before creating or updating the event. Contact your security team if delegated edit access is genuinely required." if {
	is_write_event_tool
	guests_can_modify
}

reasons contains "This event sets guestsCanInviteOthers to true, letting guests invite others and widen who can see the event. Remove guestsCanInviteOthers (or set it to false) before creating or updating the event. Contact your security team if this is genuinely required." if {
	is_write_event_tool
	guests_can_invite_others
}

reasons contains "This event sets anyoneCanAddSelf to true, letting anyone add themselves as a guest and read the event body. Remove anyoneCanAddSelf (or set it to false) before creating or updating the event. Contact your security team if this is genuinely required." if {
	is_write_event_tool
	anyone_can_add_self
}

reasons contains "This event write's arguments are not a JSON object, so the exposure checks cannot inspect them. Resend the call with a standard arguments object. Contact your security team if this keeps happening." if {
	is_write_event_tool
	malformed_args
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
