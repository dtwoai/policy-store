---
name: "Zoom: Redact PII in Meeting Intelligence"
tags:
  - zoom
  - redact-pii
  - pii
  - dlp
  - redaction
  - egress
  - hipaa
  - gdpr-ccpa
  - soc2
publishedAt: 2026-07-12
description: |
  # zoom / redact-pii-meeting-intelligence

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `zoom.egress.redact_pii_meeting_intelligence`

  ## What it does

  Scans the responses of Zoom's meeting-intelligence read surfaces — AI
  summaries, verbatim transcripts, recording resources, and Zoom Docs content —
  and rewrites personally identifiable information to typed redaction
  placeholders before the response reaches the agent:

  | Class | Detection | Placeholder |
  |---|---|---|
  | Email address | conservative local-part `@` domain shape, word-boundary anchored | `[REDACTED_EMAIL]` |
  | US phone number | separator-formatted (e.g. `206-555-0100`, `(206) 555-0100`, `+1 206.555.0100`) | `[REDACTED_PHONE]` |
  | US SSN | hyphen- or space-separated 3-2-4 form (`XXX-XX-XXXX`, `XXX XX XXXX`) | `[REDACTED_SSN]` |

  Matches are replaced in place, leaving surrounding transcript flow, summary
  structure, and document text intact so the content remains usable to the
  agent. The policy is transform-only: it never denies a call, and responses
  with no matches (and all out-of-scope tools) pass through byte-identical.
  Every response field is read via `object.get`, so a missing or oddly-shaped
  payload is never an error — it simply passes through.

  Zoom transcripts and AI summaries are verbatim records of internal
  conversations. They routinely carry direct identifiers — attendee emails,
  callback numbers, and (in healthcare tenants) SSNs read aloud during intake —
  so masking them on the response path is the primary minimum-necessary control
  on the Zoom meeting-intelligence read surface.

  ### Defense-in-depth, not the access gate

  This policy sits **behind** the `guard-transcripts-by-group` access gate: that
  ingress policy decides *who* may retrieve a transcript at all; this egress
  policy minimizes *what* they receive once retrieval is authorized. There is
  **no group exemption** here by design — even an authorized transcript reader
  receives PII-minimized content, because the identifiers a reader is entitled
  to see for the meeting are rarely the identifiers they need in agent context.
  Callers who genuinely need raw identifiers should be routed around the agent
  channel, not exempted here.

  ## Compliance alignment

  - **HIPAA §164.514(a)–(b)** — supports Safe-Harbor de-identification practice
    by stripping direct-identifier classes (email, phone, SSN) from meeting
    intelligence before it reaches the agent; **§164.502(b) / §164.514(d)** —
    supports minimum-necessary limits on the transcript read path;
    **§164.530(c)** — supports privacy safeguards on the agent channel.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on agent reads of
    meeting personal data; **Art. 9** — reduces special-category exposure where
    identifiers co-occur with health/HR content in intake or case-review calls;
    **Art. 5(1)(f) / Art. 32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN) on the agent channel; **§1798.150** —
    reduces nonredacted-PI breach exposure from transcript reads.
  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers as meeting content
    leaves the gateway toward the agent; **C1.1** — supports identification and
    protection of confidential information on the read path; **P4.1** — supports
    limiting personal-information use to identified purposes; **P6.1** —
    supports controls over personal-information disclosure.

  ## Why egress

  The PII already lives in Zoom's recorded content — there is nothing to block
  at ingress, and denying transcript/summary/doc reads outright would defeat the
  meeting-intelligence use case. The leak happens when content is returned to
  the MCP client, so the response path is the only place to catch it while
  keeping the content useful.

  ## Tool name matching

  Applies on the output path — in scope when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a
  gateway build that populates only one of the two (keying on `mode` alone would
  fail open if it were unset). Tools are matched case-insensitively **by suffix**.
  The tool name is read from all three egress surfaces — `input.resource.name`,
  `input.tool_metadata.name`, and `input.payload.name` — and a suffix hit on
  **any** of them puts the call in scope, so a gateway that populates a different
  surface can't slip transcript content past the scanner. Suffix matching keeps
  the policy portable across the gateway server-name prefix (Zoom's official
  server exposes bare snake_case verbs with no vendor prefix, so the gateway
  server name is what disambiguates).

  Tool names are the Zoom workspace/Docs server verbs, verified from Zoom's own
  Claude Code skill (`zoom/skills` — `zoom-mcp` SKILL.md), plus the
  source-verified community transcript tool:

  - `get_recording_resource` — transcript / AI summary / next-steps egress
    (workspace server; verified)
  - `get_meeting_assets` — AI summary, docs, recordings for a meeting
    (workspace server; verified)
  - `get_file_content` — Zoom Docs content in Markdown (workspace + Docs
    sub-server; verified)
  - `get_recording_transcript` — transcript with optional speaker labels
    (`echelon-ai-labs/zoom-mcp` community server; source-verified)

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each string block
  (including string blocks containing serialized JSON, since the regexes run
  over the serialized text). Non-string blocks pass through unmodified. When at
  least one block changes, the policy emits `transform.transformed_payload`
  containing the original payload with the rewritten `text` array (all other
  payload keys preserved). When nothing changes, no transform is emitted and the
  response passes through byte-identical.

  ## Examples

  ### Redacted (transcript with an email and phone)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "zoom-get_recording_resource", "type": "tool" },
      "payload": {
        "name": "zoom-get_recording_resource",
        "text": ["Reach Dana at dana@example.com or 206-555-0100."]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["Reach Dana at [REDACTED_EMAIL] or [REDACTED_PHONE]."]`.

  ### Passed through (out-of-scope tool)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "zoom-search_meetings", "type": "tool" },
      "payload": {
        "name": "zoom-search_meetings",
        "text": ["Contact: dana@example.com"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — this policy only touches the four
  meeting-intelligence read tools.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny policies and other transforms on the same egress pipeline.
  Recommended companions for `apps/zoom`:

  - **`guard-transcripts-by-group` (ingress)** — the access gate this policy
    sits behind. It decides who may retrieve a transcript at all; this policy
    minimizes what authorized readers then receive. Attach both.
  - **A PF-01 `mask-pan-egress` companion** — this policy performs **no PAN
    (payment-card) masking**. In sales-call or Revenue-Accelerator transcripts
    where card numbers are read aloud, pair with a Luhn-validated
    `mask-pan-egress` policy on the same egress pipeline.
  - A `constrain-aggregator`-style ingress guard on `*search_zoom` so the
    agentic-search fan-out into Salesforce/Workday/ServiceNow cannot pull HR/CRM
    records (with their own PII) through the Zoom connector around this policy.

  ## Known limitations

  - **Structured/nested fields that vary by `types` may pass through
    unredacted.** Zoom returns transcript text in structured fields whose shape
    depends on the requested `types` (transcript / summary / next_steps /
    playback). This policy walks the `input.payload.text` content-block array
    and rewrites **string** blocks (including serialized-JSON strings). Custom or
    deeply nested non-string fields the policy does not walk are not redacted.
    Verify your gateway's response shape with the dump-input technique and treat
    this as a high-signal minimum-necessary layer, not a complete DLP solution.
  - **No PAN (payment-card) masking.** Card numbers are out of scope here — pair
    with a PF-01 `mask-pan-egress` companion where card data appears in
    transcripts (see Composition).
  - **Pattern-based detection is best-effort and conservative by design.** SSNs
    are matched in the 3-2-4 grouping with hyphen or space separators
    (`XXX-XX-XXXX`, `XXX XX XXXX`); the **dotted** form (`123.45.6789`) and bare
    contiguous 9-digit runs are **not** matched (the latter collide with
    meeting/recording IDs, and Zoom's 3-4-4 / 10-digit meeting IDs are safe from
    the 3-2-4 shape). Phones are matched only in separator-formatted US shapes
    (`(206)555-0100` with no space after the parenthesis, and bare 10-digit
    runs, are not matched); emails require a `local@domain.tld` shape.
    Obfuscated, spelled-out, split-across-blocks, or image/audio-embedded values
    are not caught.
  - **Suffix matching is server-name-agnostic.** Because Zoom's official verbs
    are bare snake_case, the policy matches on the tool-name suffix. A
    same-named tool on an unrelated MCP server would also be redacted — this is
    harmless for a transform-only PII policy (worst case is over-redaction of an
    unrelated response), but confirm the tool inventory on your gateway.
  - **A renamed or version-suffixed upstream tool evades the scope list
    (fail-open leak).** Scope is an exact suffix match against four verb names,
    so a tool Zoom (or a community server) ships as e.g.
    `get_recording_resource_v2`, `get_recording_resource_beta`, or any renamed
    variant is **not** in scope and its response is returned unredacted. This is
    inherent to any suffix-scoped egress transform: an unmatched tool means no
    redaction, not a deny. Re-verify the exact verb names your gateway emits
    with the dump-input technique after any Zoom MCP server upgrade, and extend
    `meeting_intel_suffixes` to cover new/renamed transcript-bearing verbs.
  - **Cross-connector PII pulled through `search_zoom` is not redacted.** Zoom's
    agentic search (`search_zoom`) fans out into Salesforce, Workday, and
    ServiceNow and can return their PII (e.g. Workday SSNs) through the Zoom
    connector. That tool is deliberately **out of scope** here — redacting a
    general-purpose search surface would over-redact, and the correct control is
    to fence the fan-out at ingress. Pair with the `constrain-aggregator`-style
    ingress guard on `*search_zoom` (see Composition); this egress policy does
    not backstop it.
  - **Community `get_recording_transcript` runs under account-wide S2S
    credentials.** The `echelon-ai-labs/zoom-mcp` server acts as the account,
    not the end user, so egress redaction here does not substitute for gating
    *who* may call it — that is the job of the ingress access gate.
  - **Non-string content blocks pass through unmodified.** Redaction applies to
    string entries of `input.payload.text`. If your gateway emits structured
    non-string blocks, verify their shape with the dump-input technique.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version before production, and mind
    attachment order if other egress transforms (e.g. the PAN companion) run on
    the same pipeline.
  - **This policy carries no identity-based exemptions and reads no IdP claims.**
    All authorized readers receive minimized content; if a break-glass
    raw-identifier path is required, route it off the agent channel rather than
    adding a claims-based exemption here.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - zoom
industries: []
bundles:
  - hipaa
  - gdpr-ccpa
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zoom.egress.redact_pii_meeting_intelligence

# Transform-only egress policy: rewrites email addresses, US phone numbers, and
# US SSNs in Zoom meeting-intelligence responses (transcripts, AI summaries,
# recording resources, Zoom Docs) to typed redaction placeholders before the
# response reaches the agent. Never denies. It sits behind the
# guard-transcripts-by-group access gate as defense-in-depth: there is no group
# exemption, so even authorized readers receive PII-minimized content.
default allow := true

# -----------------------------------------------------------------------------
# Scope: Zoom's meeting-intelligence read surfaces. Names are the workspace/Docs
# server verbs (verified from Zoom's zoom-mcp SKILL.md) plus the source-verified
# community transcript tool. Zoom's official verbs are bare snake_case with no
# vendor prefix, so the gateway server-name prefix is what disambiguates — we
# match by suffix to stay portable across server names.
# -----------------------------------------------------------------------------

meeting_intel_suffixes := {
    "get_recording_resource",
    "get_meeting_assets",
    "get_file_content",
    "get_recording_transcript",
}

# Egress scope: match the post-invoke/output path on either mode or action. If we
# keyed on input.mode alone and a gateway build left it unset, is_meeting_intel_tool
# would silently fail and redaction would no-op (fail open, leaking transcript
# content). Ingress (tool_pre_invoke / mode "input") satisfies neither branch, so
# it stays out of scope.
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC), tool_metadata.name
# (legacy), and payload.name (tool-hook canonical). Collect all three and match if
# ANY carries a meeting-intelligence suffix — matching only a subset would let a
# gateway that populates a different surface slip transcript content past the scanner.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

is_meeting_intel_tool if {
    is_egress
    some suffix in meeting_intel_suffixes
    some n in candidate_names
    endswith(n, suffix)
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives.
# -----------------------------------------------------------------------------

# Email: a conservative local-part, an "@", a dotted domain, and a 2+ letter
# TLD. Word-boundary anchored so it does not fire inside longer tokens.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone numbers (e.g. 206-555-0100, (206) 555-0100,
# +1 206.555.0100). A separator after the area code is required; bare 10-digit
# runs are deliberately not matched.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)|\b\d{3})[-. ]\d{3}[-. ]\d{4}\b`

# US SSN in hyphen- or space-separated 3-2-4 form (XXX-XX-XXXX / XXX XX XXXX).
# The 3-2-4 grouping is the distinguishing SSN shape: bare contiguous 9-digit
# runs and Zoom's 3-4-4 / 10-digit meeting-recording IDs do NOT match, so they
# are not over-redacted. Dotted form (123.45.6789) is deliberately excluded as
# too ambiguous (version/IP-like).
ssn_pattern := `\b\d{3}[- ]\d{2}[- ]\d{4}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_emails(t) := regex.replace(t, email_pattern, "[REDACTED_EMAIL]")

redact_phones(t) := regex.replace(t, phone_pattern, "[REDACTED_PHONE]")

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED_SSN]")

# Order: emails first (the "@" makes them disjoint from the digit patterns),
# then SSNs (3-2-4 digit groups), then phones (3-3-4 digit groups). SSN and
# phone shapes do not overlap, so either order is safe between them.
redact_block(b) := redact_phones(redact_ssn(redact_emails(b))) if {
    is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope and at least one block actually
# changed. Otherwise the rule is undefined and the aggregator skips this policy,
# returning the response byte-identical.
# -----------------------------------------------------------------------------

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

redacted_blocks := [out |
    some block in text_blocks
    out := redact_block(block)
]

transform := {
    "transformed_payload": object.union(response_payload, {"text": redacted_blocks}),
} if {
    is_meeting_intel_tool
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
