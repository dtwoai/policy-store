---
name: Gate Zoom Transcripts & Recordings by Group
tags:
  - zoom
  - guard-transcripts
  - ingress
  - hipaa
  - gdpr-ccpa
  - soc2
publishedAt: 2026-07-12
description: |
  # zoom / guard-transcripts-by-group

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `zoom.ingress.guard_transcripts_by_group`

  ## What it does

  Gates retrieval of Zoom meeting **transcripts, AI Companion summaries, and next-steps** on the connector's core egress tools, enforcing minimum-necessary access:

  - `*get_recording_resource`
  - `*get_recording_transcript`
  - `*get_meeting_assets`

  Two independent checks run at ingress, before the call reaches the Zoom MCP server:

  1. **Sensitive-asset gate.** If the requested `types` include `transcript`, `summary`, or `next_steps` — **or** `types` is missing/empty (treated as a full-asset request, fail closed) — the call is denied unless the caller's IdP groups (`input.subject.claims.groups`) include the transcript-reader group (placeholder `zoom-transcript-readers`).
  2. **Passcode gate.** Any of these calls that set `raw_passcode` or `encode_passcode` is denied unless the caller's groups include the recording-admin group (placeholder `zoom-admins`), because recording passcodes are shareable credentials.

  A **`get_recording_resource`** call that requests only non-sensitive assets (e.g. `types: ["playback"]`) and sets no passcode parameter passes through, because that tool honors the `types` selector. **`get_meeting_assets`** and **`get_recording_transcript`** do **not** honor a `types` selector — the server returns the full asset bundle (AI summary, recordings, transcript) regardless — so every call to them is always treated as a sensitive full-asset request and a decoy `types: ["playback"]` cannot downgrade it. All non-guarded tools (search, chat, docs) pass through unchanged — compose separate policies for those surfaces.

  Verbatim transcripts and AI Companion summaries routinely carry PII by default, PHI in healthcare tenants, and deal/HR content elsewhere, so this restricts the connector's primary egress surface to callers whose IdP group entitles them to it.

  ## Compliance alignment

  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary standard and role-based access limits by restricting transcript/summary/recording retrieval to an entitled group; **§164.308(a)(4)** — supports information access management on the agent channel.
  - **SOC 2 CC6.3** — supports role-based access and least privilege by gating a sensitive read on IdP-group membership; **CC6.1** — supports logical access security over protected assets.
  - **GDPR Art. 5(1)(c)** — supports data minimisation by limiting who can pull verbatim meeting content; **Art. 9** — supports the handling of special-category data (health/other sensitive content that surfaces in transcripts); **CCPA/CPRA §1798.121** — supports the right to limit use of sensitive personal information.

  All alignment is on the MCP path only (see the compliance note below).

  ## Tool name matching

  Zoom's official workspace server uses **bare snake_case verbs with no vendor prefix** (`get_recording_resource`, `get_meeting_assets`), so only the gateway server-name prefix disambiguates. The policy therefore matches by **suffix** on `lower(input.resource.name)`:

  - `*get_recording_resource`
  - `*get_recording_transcript`
  - `*get_meeting_assets`

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g. `zoom-workspace-get_recording_resource`); that prefix is not standardized across deployments, so suffix matching keeps the policy portable. Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production. Community-server tool names (`get_recording_transcript` from `echelon-ai-labs/zoom-mcp`) are also matched by suffix.

  ## Argument shape

  - **`types`** is read from `input.payload.args` with `object.get`. It is normalized to a lowercased **set of tokens** whether the server sends an array (`["transcript"]`), a bare string (`"transcript"`), or a delimited/padded string. Each string value is split on commas and whitespace and trimmed, so `"transcript,summary"`, `"transcript summary"`, and `[" transcript"]` all resolve to the sensitive tokens they contain and are gated. The final sensitive-type test is a **substring** check, not exact set membership, so even a selector that uses a delimiter the tokenizer does not split on — a server variant accepting `"transcript;summary"` or `"transcript|playback"` — still trips the gate, because the joined token still *contains* `transcript`. Splitting is on commas/whitespace only, never underscores, so `next_steps` stays intact. A missing or empty `types` is treated as a full-asset request and requires the transcript-reader group (fail closed).
  - **`raw_passcode` / `encode_passcode`** are read from `input.payload.args`. A parameter counts as "set" when present and truthy (a non-empty string, or boolean `true`); `encode_passcode: false` or an empty string is not treated as a passcode request.
  - **Groups** are read via `object.get(input.subject, "claims", {})` → `groups`, defaulting to `[]`. A missing `subject`, missing `claims`, or missing `groups` yields no group and therefore denies (fail closed for the grant).

  ## Examples

  ### Allowed — caller is in the transcript-reader group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-workspace-get_recording_resource", "type": "tool" },
      "payload": {
        "name": "zoom-workspace-get_recording_resource",
        "args": { "meetingId": "8891234567", "types": ["transcript"] }
      },
      "subject": { "claims": { "groups": ["zoom-transcript-readers"] } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — transcript requested without the group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-workspace-get_recording_resource", "type": "tool" },
      "payload": {
        "name": "zoom-workspace-get_recording_resource",
        "args": { "meetingId": "8891234567", "types": ["summary"] }
      },
      "subject": { "claims": { "groups": ["marketing"] } }
    }
  }
  ```

  `allow = false`, transcript-reader reason.

  ### Denied — passcode requested by a non-admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-workspace-get_recording_resource", "type": "tool" },
      "payload": {
        "name": "zoom-workspace-get_recording_resource",
        "args": { "meetingId": "8891234567", "types": ["playback"], "raw_passcode": "Z00m!pass" }
      },
      "subject": { "claims": { "groups": ["zoom-transcript-readers"] } }
    }
  }
  ```

  `allow = false`, recording-admin reason.

  ## Composition

  This policy is single-purpose (an ingress access gate). Useful companions on the Zoom connector:

  - An **egress PII/PHI redaction** policy on `*get_recording_resource` / `*get_meeting_assets` / `*get_file_content` responses, so content that this gate does let through is still masked (defense in depth — this ingress gate cannot inspect what the transcript actually contains).
  - A **fence-agentic-search** policy on `*search_zoom` to stop the connector fanning out into Salesforce/Workday/ServiceNow.
  - A **no-trash / no-passcode** transform on `*recordings_list`.

  ## Known limitations

  - **Group names are placeholders — replace `zoom-transcript-readers` and `zoom-admins` with your IdP's group names at import time.** They are matched exactly against `input.subject.claims.groups`; a case or spelling mismatch denies (fail closed).
  - **Placeholder-claim trust.** The gate trusts `input.subject.claims.groups` as asserted by the IdP-issued JWT. If your IdP does not populate `groups` (Auth0, for example, does not emit role/group claims without explicit configuration), every caller is denied until the claim is wired up. Confirm the claim shape with `dtwo-list-claims` / the dump-input technique before deployment.
  - **Ingress cannot read content.** This gate decides on the request (tool + `types` + passcode + group), not on what the transcript contains. It cannot tell a PHI-laden transcript from a benign one — pair it with an egress redaction policy.
  - **Delimiter robustness (red-team hardened).** The sensitive-type match is a substring test over comma/whitespace-tokenized values, so a `types` selector that joins tokens with an unsupported delimiter (`transcript;summary`, `transcript|playback`) is still gated. The one residual is a delimiter inserted *inside* a sensitive word itself (e.g. `trans;cript`) — that would defeat the substring test, but the upstream server would not recognize it as a valid asset type either, so no transcript is returned. If a real server variant tolerates intra-word separators, add the variant spelling to `sensitive_types`.
  - **`types` key assumption.** The sensitive-asset gate keys off an argument named `types` on `get_recording_resource`, consistent with the workspace server's schema (verified against Zoom's own Claude Code skill). `get_recording_transcript` (community `echelon-ai-labs/zoom-mcp`) and `get_meeting_assets` take no `types` argument, so every call to them is treated as a full-asset request and requires the transcript-reader group. If a server variant carries the asset selector under a different key, that key is not inspected — the fail-closed default still applies, but add the key to the Rego if a variant uses it. The **Meetings / Revenue Accelerator sub-server** tool names could not be verified from public docs (per the landscape note); if those servers expose transcript reads under other suffixes, extend `is_guarded_tool`.
  - **Batch / raw-API passthrough.** Zoom's official server exposes no batch or raw-API tool, so there is no in-connector way to smuggle a guarded call under a different name. A future aggregator or passthrough tool would bypass suffix matching — pair with a `deny-escape-hatches` policy if one appears.
  - **Recording media (`playback`) is not gated by design.** `sensitive_types` covers the text artifacts (`transcript`, `summary`, `next_steps`). A `get_recording_resource` request for `types: ["playback"]` — the audio/video recording itself, which carries the same verbatim content as the transcript — passes through for any caller. This is deliberate (the gate targets transcript/summary text and playback is often a link, not content), but if your tenant treats the recording media as equally sensitive, add `"playback"` (and any recording-media selector your server uses) to `sensitive_types`. This downgrade only applies to `get_recording_resource`; `get_meeting_assets` / `get_recording_transcript` are always gated regardless of `types`.
  - **Bypass residual — no host-ownership check.** This gate does not verify the caller hosted the meeting; it gates purely on group membership. A transcript-reader can retrieve transcripts for meetings they did not attend. Add a host-metadata predicate if your tenant needs per-meeting scoping.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - zoom
industries: []
bundles:
  - hipaa
  - gdpr-ccpa
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zoom.ingress.guard_transcripts_by_group

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group names — map these to your tenant's IdP groups at import.
transcript_reader_group := "zoom-transcript-readers"

admin_group := "zoom-admins"

# Asset types that carry verbatim meeting content (PII/PHI/deal/HR-sensitive).
sensitive_types := {"transcript", "summary", "next_steps"}

# --- Tool identification -------------------------------------------------

# Tool name, lowercased and defended against a missing resource/name.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# The Zoom transcript/recording/assets egress tools. Zoom's official workspace
# server uses bare snake_case verbs with no vendor prefix, so only the gateway
# server-name prefix disambiguates — match by suffix to stay portable.
is_guarded_tool if endswith(tool_name, "get_recording_resource")

is_guarded_tool if endswith(tool_name, "get_recording_transcript")

is_guarded_tool if endswith(tool_name, "get_meeting_assets")

# The only guarded tool that actually honors a `types` asset selector, so a
# `types` value that names no sensitive asset can legitimately downgrade the
# request to a non-sensitive read.
type_selectable_tool if endswith(tool_name, "get_recording_resource")

# Any guarded tool that does NOT honor `types` (get_recording_transcript,
# get_meeting_assets — and any future guarded tool) inherently returns verbatim
# transcript/summary content and is ALWAYS a sensitive-asset request. A decoy
# `types: ["playback"]` on these tools must not downgrade the request, because
# the server ignores the selector and returns the full asset bundle anyway.
always_sensitive_tool if {
    is_guarded_tool
    not type_selectable_tool
}

# --- Argument extraction -------------------------------------------------

# Tool arguments, defended against a missing payload/args.
args := object.get(object.get(input, "payload", {}), "args", {})

# The requested asset selector as provided (array, string, or missing).
raw_types := object.get(args, "types", [])

# Split one string value into lowercased, whitespace-trimmed, non-empty tokens.
# Splits on commas and whitespace (but NOT underscores, so "next_steps" stays
# intact) so a delimited or padded selector like "transcript,summary",
# "transcript summary", or " transcript" cannot smuggle a sensitive type past
# exact set membership.
type_tokens(s) := {tok |
    some part in regex.split(`[,\s]+`, s)
    tok := lower(part)
    tok != ""
}

# Normalize `types` to a lowercased set whether it arrives as an array (of
# strings) or a bare string; each string element is tokenized as above.
requested_types contains tok if {
    is_array(raw_types)
    some elem in raw_types
    is_string(elem)
    some tok in type_tokens(elem)
}

requested_types contains tok if {
    is_string(raw_types)
    some tok in type_tokens(raw_types)
}

# The request names one of the sensitive asset types. Match by SUBSTRING on the
# tokenized value (not just exact set membership) so a selector using a delimiter
# our tokenizer does not split on — e.g. a server variant that accepts
# "transcript;summary" or "transcript|playback" — still trips the gate: the joined
# token "transcript;summary" still contains the sensitive token "transcript".
# Known non-sensitive selectors ("playback", "playback_url") contain no sensitive
# substring, so this does not over-block legitimate non-sensitive reads.
names_sensitive_type if {
    some t in requested_types
    some s in sensitive_types
    contains(t, s)
}

# Fail closed: no usable `types` at all is treated as a full-asset request.
empty_types_request if {
    count(requested_types) == 0
}

# Tools that don't honor a selector are always sensitive.
sensitive_request if always_sensitive_tool

# On the type-selectable tool, a sensitive type name gates the call.
sensitive_request if {
    type_selectable_tool
    names_sensitive_type
}

# On the type-selectable tool, a missing/empty selector is a full-asset request.
sensitive_request if {
    type_selectable_tool
    empty_types_request
}

# --- Passcode detection --------------------------------------------------

# A passcode parameter counts as "set" when present and truthy: a non-empty
# string or boolean true. `encode_passcode: false` / "" is not a request.
passcode_present(v) if {
    v != ""
    v != false
    v != null
}

sets_passcode if {
    passcode_present(object.get(args, "raw_passcode", ""))
}

sets_passcode if {
    passcode_present(object.get(args, "encode_passcode", ""))
}

# --- Identity ------------------------------------------------------------

# Caller's IdP groups; missing subject/claims/groups yields [] (fail closed).
caller_groups := groups if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
}

has_transcript_reader_group if {
    some g in caller_groups
    g == transcript_reader_group
}

has_admin_group if {
    some g in caller_groups
    g == admin_group
}

# --- Deny conditions -----------------------------------------------------

# Block sensitive-asset retrieval without the transcript-reader group.
transcript_block if {
    is_guarded_tool
    sensitive_request
    not has_transcript_reader_group
}

# Block passcode retrieval without the recording-admin group.
passcode_block if {
    is_guarded_tool
    sets_passcode
    not has_admin_group
}

# --- Allow rules ---------------------------------------------------------

# Any tool that isn't a guarded transcript/recording/assets call passes.
allow if not is_guarded_tool

# Guarded calls pass only when neither deny condition fires.
allow if {
    is_guarded_tool
    not transcript_block
    not passcode_block
}

# --- Deny reasons --------------------------------------------------------

reasons contains "Meeting transcripts, summaries, and next-steps are restricted. Retrieving them requires membership in the transcript-reader group (placeholder \"zoom-transcript-readers\"). Ask your workspace administrator to grant you that group, or request a non-transcript asset instead. If you believe you already have this access, ask your admin to verify your IdP group mapping." if {
    transcript_block
}

reasons contains "Retrieving a recording passcode (raw_passcode/encode_passcode) requires membership in the recording-admin group (placeholder \"zoom-admins\"), because recording passcodes are shareable credentials. Ask an administrator to retrieve the passcode-protected recording for you." if {
    passcode_block
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
