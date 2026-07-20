---
name: Redact Attendee PII and Meeting Links in Calendar Reads
tags:
  - google-calendar
  - redact-pii
  - pii
  - phi
  - dlp
  - redaction
  - egress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # google-calendar / redact-attendee-pii

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never blocks the read)
  **Package:** `google_calendar.egress.redact_attendee_pii`

  ## What it does

  Scrubs sensitive fields from the **responses** of Google Calendar read tools
  before they reach the agent, for callers who lack the placeholder
  `calendar-full-read` IdP group. It is a response transform, not a block: the
  read still executes and returns, but what the agent sees is redacted.

  It redacts three classes of content:

  1. **Attendee identifiers** — the `email` field wherever it appears
     (`attendees[].email`, `organizer.email`, `creator.email`), the
     `displayName` field on those same objects (an attendee's or organizer's
     name is attendee PII too and would otherwise survive email-only
     redaction), and flat `attendeeEmails[]` arrays (the shape
     `suggest_time`-style tools use).
  2. **Meeting join links** — the whole `conferenceData` object is removed
     (its `entryPoints[].uri` values are live meeting links that grant join
     access to anyone who reads them), and the top-level `hangoutLink` field is
     redacted too — Google populates `hangoutLink` with the Meet URL
     independently of `conferenceData`, so a link would otherwise survive when
     only `conferenceData` is stripped. A conservative `redact_patterns` entry
     also catches conferencing URLs (Meet / Zoom / Teams / Webex hosts) pasted
     into `description` or `location` free text.
  3. **Free-text PII/PHI in `description` / `location` / `summary` bodies** —
     matched by conservative regex (SSN, email, phone, and a small set of
     health-context terms). The Calendar landscape note observes these bodies
     routinely carry health appointments, candidate interviews, and M&A meeting
     names.

  Because `nspady/google-calendar-mcp` supports multi-account merge, a single
  read can span every calendar the OAuth grant covers — so egress scrubbing
  enforces minimum-necessary against that widened blast radius, not just the
  caller's own calendar.

  ## Why egress and not ingress

  The sensitive data lives in the **response**, not the request: a read tool's
  arguments (`timeMin`, `calendarId`, a search `query`) don't reveal attendee
  lists, meeting URLs, or private event bodies — only the returned events do.
  Ingress can't see what a read will surface, so redaction has to happen on the
  way back. The read itself is harmless and is allowed to proceed.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    confidential information by masking attendee PII, meeting links, and
    health/deal context on the agent read path (PF-02). **C1.1 / P4.1 / P6.1** —
    supports identifying and protecting confidential info, limiting personal
    information to identified purposes, and constraining PI disclosure to third
    parties (here, the agent) — all Partial on the MCP path.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard by returning only the non-identifying slice of a calendar read to
    callers outside the `calendar-full-read` group. **§164.514(a)–(b)** —
    supports de-identification by stripping Safe-Harbor identifier classes
    (email, phone, and health-context free text). **§164.530(c)** — supports
    administrative privacy safeguards on the agent channel.
  - **GDPR Art. 5(1)(c)** — supports data minimisation by scrubbing identifiers
    not needed for the agent's task. **Art. 9** — supports the special-category
    (health) restriction via the PHI-context patterns. **Art. 5(1)(f) / Art. 32**
    — supports security of processing. **CCPA/CPRA §1798.121** — supports the
    consumer right to limit use of sensitive personal information; **§1798.150**
    — reduces nonredacted-PI breach exposure.

  ## Tool name matching

  Calendar read tools across the four servers in scope share an `[-_]events?$`
  suffix, so matching is **suffix-based** for portability rather than pinned to
  exact fully-qualified names (the gateway prepends its own configured
  server-name prefix, which is not standardized):

  - `list_events` / `list-events` / `get_events` (Google, community, taylorwilsdon)
  - `get_event` / `get-event` (Google, nspady)
  - `search-events` (nspady)
  - `gcal_list_events` (Claude connector — also ends in `_events`)

  A second rule matches the Claude connector's `gcal_` segment
  (`(^|[-_])gcal_`) so connector reads are covered even if a future connector
  tool name doesn't end in the `events?` suffix. Verify the exact tool name your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  The policy is scoped to the egress path when **either** `input.mode ==
  "output"` **or** `input.action == "tool_post_invoke"` holds, so redaction
  still fires on a gateway build that populates only one of the two (keying on
  `mode` alone would fail open if it were unset). The tool name is read from all
  three egress surfaces — `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — and a calendar-read hit on **any** of them puts the
  call in scope, so a gateway that populates a different surface can't slip a
  read past the scanner.

  ## Argument / response shape

  This is an egress policy: it inspects nothing in the request. Redaction is
  expressed structurally (`redact_fields` on JSON key names, applied
  recursively and case-insensitively) plus `redact_patterns` (regex over the
  serialized response text). `redact_fields` catches the structured attendee
  and conference fields regardless of nesting; `redact_patterns` catches PII/PHI
  that appears in free-text bodies.

  ## Examples

  ### Redacted (caller lacks `calendar-full-read`)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "google-calendar-mcp-list-events", "type": "tool" },
      "subject": { "sub": "google-apps|agent@dtwo.ai", "claims": { "groups": ["sales"] } },
      "payload": {
        "name": "google-calendar-mcp-list-events",
        "text": ["{\"attendees\":[{\"email\":\"cfo@target.com\"}],\"summary\":\"Project Atlas M&A sync\"}"]
      }
    }
  }
  ```

  `allow = true`, `transform` present — `email` / `attendeeEmails` /
  `conferenceData` fields and any matching PII/PHI substrings are replaced with
  `[REDACTED]`.

  ### Passed through unredacted (caller in `calendar-full-read`)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "google-calendar-mcp-list-events", "type": "tool" },
      "subject": { "sub": "google-apps|exec@dtwo.ai", "claims": { "groups": ["calendar-full-read"] } },
      "payload": { "name": "google-calendar-mcp-list-events", "text": ["{}"] }
    }
  }
  ```

  `allow = true`, no `transform` — the exempt group sees the full response.

  ### Untouched (non-event tool)

  A `list-calendars`, `get-freebusy`, or `manage-accounts` response does not end
  in the `events?` suffix and carries no `gcal_` segment, so `transform` is
  undefined and the aggregator skips this policy for that call.

  ## Composition

  Single-purpose. Useful companions from the Calendar candidate set:

  - An **ingress external-attendee guard** on `create-event` / `update-event`
    so the write side is controlled too.
  - An **ingress `sendUpdates` transform** that defaults agent writes to silent.
  - A generic **egress PAN mask** (PF-01) if calendar bodies ever carry card
    data.

  These stay separate policies so each is independently testable; egress
  transforms attached to the same direction compose in pipeline order.

  ## Known limitations

  - **Group names are placeholders** — replace `calendar-full-read` with your
    IdP's group name at import time. The exemption reads
    `input.subject.claims.groups` via `object.get` chains; if the gateway has no
    IdP configured or the claim is absent, the caller is treated as **not
    exempt** and the response is scrubbed (fail-closed for the grant). The
    exemption is granted **only** when `groups` is an array of strings (a single
    bare string is also handled). Any other shape fails closed → redaction
    applies: a missing subject/claims/`groups`, and — critically — an
    object/map claim such as `{"role": "calendar-full-read"}` (the `is_array`
    guard stops its *values* from being read as group names). If your IdP emits
    roles under a namespaced claim, adjust `caller_groups` to point at the array
    before matching.
  - **Regex over serialized text, not field-scoped.** `redact_patterns` runs
    byte-level over the whole response, so PII/PHI is caught wherever it appears,
    not only in `description`/`location`/`summary`. Phone/SSN patterns are
    anchored with separators and word boundaries to avoid eating the RFC3339
    timestamps that fill calendar payloads, but tune them against representative
    data before publishing.
  - **Free-text meeting-link coverage is host-scoped.** The structured
    `conferenceData` and `hangoutLink` fields are always removed, but a join
    URL pasted into `description`/`location` free text is only caught if its
    host matches the conferencing allowlist in `redact_patterns`
    (`meet.google.com`, `zoom.us`, `teams.microsoft.com`, `webex.com`). Links
    on other conferencing hosts (or bare `goo.gl`/`bit.ly` shorteners) in free
    text are not matched — add their hosts to the pattern for your environment.
  - **Semantic content is not fully caught.** A regex cannot reliably recognize
    "candidate interview" or an M&A code name as sensitive; the health-context
    term list is a small, conservative signal and redacts only the matched term,
    not the surrounding sentence. Field-level redaction (attendee `email` /
    `displayName`, conference links) is the high-confidence part of this control;
    free-text pattern matching is best-effort. A person's **name** is only
    redacted where it sits in the structured `displayName` field — a name
    written into a `summary`/`description` free-text body (e.g. "1:1 with Jane
    Roe") is not caught unless it also trips a pattern.
  - **Free/busy reads are out of scope (residual attendee-email leak).** The
    tool rule matches only the `[-_]events?$` and `gcal_` families, so
    availability tools — nspady `get-freebusy`, taylorwilsdon `query_freebusy`,
    the official `suggest_time` — match **neither** branch and emit **no**
    transform. Their responses key busy blocks by calendar ID, which for a
    person calendar **is an email address** (`{"calendars":{"a@corp.com":...}}`),
    so a non-`calendar-full-read` caller sees those addresses unscrubbed. The
    leak is bounded (the caller supplied those IDs in the request, and the
    Calendar landscape note does not list free/busy among the attendee-list leak
    channels), so it is documented rather than force-fit into an events-shaped
    matcher. If free/busy exposure matters in your environment, add a
    `free[-_]?busy` branch to `is_calendar_read_tool` — the email
    `redact_patterns` entry then scrubs the calendar-ID keys.
  - **`gcal_` prefix over-matches by design.** The connector rule also matches
    reads like `gcal_find_my_free_time`; those responses carry no attendee or
    conference fields, so redaction is a harmless no-op there.
  - **The `[-_]events?$` suffix also matches write/destructive event tools.**
    `create-event` / `create_event`, `update-event`, `delete-event`,
    `respond-to-event`, and the consolidated `manage_event` all end in
    `-event`, so their **responses** are scrubbed on egress too. This is
    intentional and harmless: the policy is transform-only and never blocks the
    write — it only masks attendee PII, join links, and PHI/PII free text in the
    echoed-back event, which is consistent with minimum-necessary. Control the
    write *path* with a separate ingress policy (see Composition); this policy
    governs only what a non-`calendar-full-read` caller sees returned.
  - **Unverified connector tools.** Beyond `gcal_list_events` /
    `gcal_find_my_free_time`, Anthropic does not publish the connector's full
    tool list (per the landscape note); any other `gcal_*` read is matched by
    the prefix rule but its response shape is unverified.
  - **Output shape assumption.** Redaction assumes the tool returns JSON (or
    JSON-ish text) in `payload.text`. If a server returns an unusual envelope,
    confirm the shape with the dump-input technique.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - google-calendar
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_calendar.egress.redact_attendee_pii

# Transform-only egress policy: it never blocks the read, it only scrubs the
# response. Default allow is true so unrelated tools pass through untouched and
# a missing transform condition means "nothing to redact", not "deny".
default allow := true

# --- Egress scope -------------------------------------------------------------
# Match the post-invoke/output path on EITHER mode or action. Keying on
# input.mode alone would fail open (no redaction) on a gateway build that leaves
# mode unset; requiring either keeps the scanner from silently no-opping.
# Ingress (tool_pre_invoke / mode "input") satisfies neither branch.
is_egress if {
	input.mode == "output"
}

is_egress if {
	input.action == "tool_post_invoke"
}

# --- Tool matching ------------------------------------------------------------
# The tool name is exposed on egress under resource.name (PARC),
# tool_metadata.name (legacy), and payload.name (tool-hook canonical). Collect
# all three (lower-cased) and match if ANY carries a calendar-read signature, so
# a gateway that populates a different surface can't slip a read past the
# scanner. object.get chains keep a missing surface from failing the rule.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

# Calendar read tools across the servers in scope share an [-_]events? suffix:
#   list_events / list-events / get_events (Google, community, taylorwilsdon)
#   get_event / get-event                  (Google, nspady)
#   search-events                          (nspady)
#   gcal_list_events                       (Claude connector — also ends _events)
# The gateway prepends its configured server-name prefix, so we match on the
# suffix, never on an exact fully-qualified name.
is_calendar_read_tool if {
	some n in candidate_names
	regex.match(`[-_]events?$`, n)
}

# The Claude connector prefixes its read tools with `gcal_`. Match that segment
# too, so connector reads are covered even if a future connector tool name does
# not end in the events? suffix.
is_calendar_read_tool if {
	some n in candidate_names
	regex.match(`(^|[-_])gcal_`, n)
}

# --- Identity exemption -------------------------------------------------------
# Callers whose IdP groups include the placeholder `calendar-full-read` see the
# unredacted response. object.get chains fail closed: no subject / no claims /
# no groups -> not exempt -> the response is scrubbed.
caller_groups := object.get(
	object.get(object.get(input, "subject", {}), "claims", {}),
	"groups",
	[],
)

# Only a clean array of group strings grants the exemption. The is_array guard
# is load-bearing: `some g in caller_groups` over an OBJECT iterates its values,
# so a namespaced/metadata claim like {"role": "calendar-full-read"} would else
# wrongly exempt the caller. is_string(g) keeps nested/non-string elements out.
# Anything but an array of strings fails closed -> redaction applies.
caller_has_full_read if {
	is_array(caller_groups)
	some g in caller_groups
	is_string(g)
	lower(g) == "calendar-full-read"
}

# Some IdPs emit a single group as a bare string rather than an array.
caller_has_full_read if {
	is_string(caller_groups)
	lower(caller_groups) == "calendar-full-read"
}

# --- Redaction transform ------------------------------------------------------
# Applies only to calendar reads, only on egress, only for non-exempt callers.
# When any condition is false the rule is undefined and the aggregator skips it.
transform := {
	"redact_fields": [
		"email", # attendees[].email, organizer.email, creator.email
		"displayName", # attendees[].displayName / organizer.displayName / creator.displayName — a person name is attendee PII too and survives email-only redaction
		"attendeeEmails", # flat email arrays (suggest_time-style shapes)
		"conferenceData", # entryPoints[].uri join links = live meeting access
		"hangoutLink", # top-level Meet URL — populated independently of conferenceData
	],
	"redact_patterns": [
		`\b\d{3}-\d{2}-\d{4}\b`, # US SSN (word-bounded; not 4-2-2 date shape)
		`[\w.+-]+@[\w-]+\.[\w.-]+`, # email address in free-text bodies
		`\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b`, # NANP phone with separators
		`\+\d{6,15}\b`, # E.164 international phone
		`(?i)\b(?:diagnosis|prognosis|biopsy|chemo(?:therapy)?|oncolog\w*|psychiatr\w*|dialysis|colonoscopy|prescription)\b`, # PHI / health-context terms
		`(?i)https?://[\w.-]*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|webex\.com)/\S*`, # conferencing join links pasted into description/location free text
	],
	"replacement": "[REDACTED]",
} if {
	is_egress
	is_calendar_read_tool
	not caller_has_full_read
}
```
