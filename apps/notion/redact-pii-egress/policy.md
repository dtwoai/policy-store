---
name: "Notion: Redact PII from Read Responses"
tags:
  - notion
  - redact-pii
  - pii
  - dlp
  - redaction
  - egress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # notion / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `notion.egress.redact_pii`

  ## What it does

  Scans the responses of the Notion hosted MCP server's content-returning read
  tools and rewrites personally identifiable information to fixed redaction
  tokens before the response reaches the agent:

  | Class | Detection | Token |
  |---|---|---|
  | Email address | standard `local@domain.tld` shape | `[REDACTED-EMAIL]` |
  | US phone number | separator-formatted (e.g. `206-555-0100`, `(206) 555-0100`, `+1 206.555.0100`) | `[REDACTED-PHONE]` |

  Each class is matched independently — a lone email or a lone phone number is
  redacted on its own. Matches are replaced in place, so page structure, search
  snippets, query result rows, and comment threads stay usable and the agent
  keeps working context. The policy is transform-only: it never denies a call,
  and responses with no matches (and all out-of-scope tools) pass through
  byte-identical. Every response field is read via `object.get`, so missing or
  oddly-shaped payloads are never an error — they simply pass through.

  Notion page bodies and meeting notes (`notion-fetch`,
  `notion-query-meeting-notes`) routinely carry personal data — contact
  details, HR notes, candidate and customer identifiers — and data-source
  query results (`notion-query-data-sources`) can surface PII columns from HR
  trackers, CRM tables, and incident logs. Search results and comment threads
  quote the same content. Redaction keeps those identifiers out of an agent
  context that lacks a documented HR/legal group claim; this is the primary
  minimum-necessary control on the Notion MCP read path.

  ### Group exemption

  Callers whose IdP `groups` claim contains `hr` or `legal` (placeholder names
  — see Known limitations) receive **unredacted** responses. The check reads
  the claims via `object.get(input.subject, "claims", {})` and then
  `object.get(..., "groups", [])`: a missing subject, missing claims, missing
  `groups` claim, or a `groups` claim that is not a clean array/string of
  group names means the caller is *not* exempt and redaction applies — the
  grant fails closed. This failure mode is safe: a caller whose claims fail to
  arrive gets over-redaction, never disclosure.

  ## Compliance alignment

  Instantiates egress PII redaction (family PF-02) for Notion and supports
  alignment with:

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in Notion content
    as it leaves the gateway toward the agent; **C1.1** — supports
    identification and protection of confidential information on the read
    path; **P4.1** — supports limiting personal-information use to identified
    purposes; **P6.1** — supports controls over personal-information
    disclosure by keeping raw identifiers out of agent context that doesn't
    need them.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based limits: only placeholder `hr`/`legal` group members see raw
    identifiers; everyone else gets working page/query/comment content with
    identifiers masked. **§164.514(a)–(b)** — supports de-identification
    practice by stripping Safe-Harbor identifier classes (email, phone) from
    responses; **§164.530(c)** — supports privacy safeguards on the agent
    channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal
    data; **Art. 9** — reduces special-category exposure on the MCP path
    where identifiers co-occur with health/HR content in pages, meeting
    notes, and database rows; **Art. 5(1)(f) / Art. 32** — supports security
    of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information on the agent channel; **§1798.150** —
    reduces nonredacted-PI breach exposure.

  ## Why egress

  The PII already lives in Notion — there is nothing to block at ingress, and
  denying page/search/query reads outright would make the agent useless for
  everyday knowledge work. The leak happens when page-derived text is returned
  to the MCP client, so the response path is the only place to catch it while
  keeping the content useful. This complements — not replaces — ingress
  fences: the companion `fence-user-directory` policy decides *who* may call
  the member-directory tool at all; this policy strips direct identifiers out
  of whatever content everyone else is allowed to read.

  ## Tool name matching

  Applies on the output path — scoped when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a
  gateway build that populates only one of the two (keying on `mode` alone
  would fail open if it were unset). Tools are matched case-insensitively
  **by suffix**, so the policy stays portable across the MCP server-name
  prefix the gateway adds (e.g. a server named `notion` yields
  `notion-notion-search`). The tool name is read from all three egress
  surfaces — `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — and a suffix hit on **any** of them puts the call in
  scope, so a gateway that populates a different surface can't slip content
  past the scanner.

  Notion hosted MCP server (the Claude-connector default; all five names
  verified against Notion's supported-tools documentation). The `notion-`
  prefix is baked into the hosted server's tool names, so the suffixes below
  include it to prevent near-miss matches on other servers' generic
  `-search`/`-fetch` tools:

  - `notion-search`
  - `notion-fetch`
  - `notion-query-data-sources`
  - `notion-query-meeting-notes`
  - `notion-get-comments`

  `notion-get-users` is **deliberately not matched** — its entire purpose is
  returning member names and emails, so redacting it would return useless
  content while still burning the call. That tool is gated at ingress by the
  companion `fence-user-directory` policy instead. Verify the exact names your
  gateway emits with the dump-input debug technique before relying on this in
  production, and see Known limitations for read surfaces deliberately not
  matched.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each block. It
  handles the two content-block shapes a gateway realistically emits:

  - **Plain-string blocks** (`"text": ["...page body..."]`) are redacted
    directly, including string blocks that carry serialized JSON (query
    result rows), since the regexes run over the serialized text.
  - **MCP-standard structured text blocks** (`{"type":"text","text":"..."}`)
    have their inner `text` string redacted while every other key (`type`,
    `annotations`, …) is preserved. This branch is deliberate: without it,
    page and meeting-note body delivered as content-block *objects* — the
    canonical MCP wire shape — would slip past a string-only redactor
    untouched.

  Any other block (an object with no string `text` field, or a non-string /
  non-object value) passes through unmodified — the policy makes no claim
  over arbitrary structured data whose PII sits under other keys. When at
  least one block changes, the policy emits `transform.transformed_payload`
  containing the original payload with the rewritten `text` array (all other
  payload keys, including `name`, preserved). When nothing changes, no
  transform is emitted and the response passes through byte-identical. Note
  the `text` field must be an **array**: a gateway that returns a bare scalar
  string under `payload.text` (off the documented shape) is not rewritten —
  see Known limitations.

  ## Examples

  ### Redacted (in-scope tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "notion-notion-fetch", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["marketing"] } },
      "payload": {
        "name": "notion-notion-fetch",
        "text": ["Candidate contact: jane@acme.com or 206-555-0100"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["Candidate contact: [REDACTED-EMAIL] or [REDACTED-PHONE]"]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "notion-notion-fetch", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["hr"] } },
      "payload": {
        "name": "notion-notion-fetch",
        "text": ["Candidate contact: jane@acme.com"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — HR group members receive raw content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes
  cleanly with deny/transform policies on the same egress pipeline.
  Recommended companions in `apps/notion`:

  - The **`fence-user-directory`** ingress policy, which gates
    `notion-get-users` — the workspace member/guest email directory — by IdP
    group. This redactor deliberately leaves that tool out of scope (see
    above).
  - An ingress guard on `notion-query-data-sources` SQL (family PF-07 style)
    so sensitive HR/comp databases aren't queried at all by callers outside
    the owning team — this redactor is defense-in-depth behind it, not a
    substitute.
  - An ingress constraint on `notion-search` connected-tool fan-out (family
    PF-14): Notion search reaches into connected Slack, Google Drive, and
    Jira content, and this policy redacts whatever comes back either way.

  ## Known limitations

  - **Pattern-based detection is best-effort.** Conservative by design so it
    does not fire on Notion page IDs (32-hex UUIDs), dates, or version
    strings: phone numbers are matched only in separator-formatted US shapes
    (a contiguous digit run, a UUID segment, or a dotted version string does
    not match). Obfuscated, spelled-out, split-across-blocks, base64-encoded,
    or image-embedded values are not caught. Treat this as a high-signal
    minimum-necessary layer, not a complete DLP solution.
  - **Phone detection needs a separator after the area code.**
    Separator-formatted US shapes match (`206-555-0100`, `(206) 555-0100`,
    `+1 206.555.0100`), but `(206)555-0100` with no space after the closing
    parenthesis, bare 10-digit runs, most non-US formats, and a number with a
    directly-appended extension (`206-555-0100x123` — the trailing
    word-boundary anchor requires a non-word character after the final digit,
    so an adjacent letter/digit suppresses the match) are not matched
    (documented residual — the anchor is deliberate so the pattern does not
    fire inside longer digit/ID runs).
  - **Email regex is standard-shape.** It matches `local@domain.tld` and will
    also match an email embedded in a `user:pass@host` connection string; it
    will not match addresses split across markup or obfuscated as
    `jane [at] acme [dot] com`.
  - **Block coverage and the `text`-array assumption.** Redaction applies to
    plain-string entries of `input.payload.text` (including serialized-JSON
    strings) **and** to MCP-standard structured text blocks shaped as
    `{"type":"text","text":"..."}` (the inner `text` is redacted, other keys
    preserved). Blocks that are objects with **no string `text` field** (e.g.
    a custom `{"column":"email","value":"…"}` shape) pass through unmodified
    — the policy does not chase PII under arbitrary keys, so verify such
    shapes with the dump-input technique and extend `block_text` /
    `redact_block` if needed. Separately, the `text` field is assumed to be
    an **array**: a gateway that returns a bare scalar string under
    `payload.text` fails the `is_array` transform guard and the response is
    **not rewritten** (a fail-open residual on an off-spec shape — the
    documented gateway contract always emits an array; confirm yours with the
    dump-input technique before relying on this).
  - **Adjacent read surfaces are not matched.** Only the five hosted-server
    tools above are in scope. Content-returning tools **outside** that set
    stream content verbatim, unredacted:
    - `notion-get-users` — deliberately excluded; gate it at ingress with
      `fence-user-directory` (see Composition);
    - `notion-query-database-view` (returns database view rows) and
      `notion-get-async-task` (returns the eventual result of async
      operations, which can carry page content) — both verified hosted-server
      tools, not matched here; add their suffixes to `pii_read_suffixes` if
      your deployment relies on them for content reads;
    - the official **local** server (`search`, `retrieve-page-markdown`,
      `query-data-source`, …), the suekou community server (`notion_find`,
      `notion_read_page`, …), and the awkoy meta-tool server
      (`notion_execute`) use entirely different tool names — their generic /
      unprefixed names are deliberately not matched here (a bare `-search`
      suffix would collide with other servers). Instantiate a separate policy
      per implementation if you run one of those; note the suekou server's
      raw tool names are unverified in the landscape research.
  - **Group names are placeholders — replace `hr` and `legal` with your
    IdP's group names at import time.** The exemption is granted **only** for
    a `groups` claim shaped as an array of strings (a single bare string is
    also handled). Any other shape fails closed → redaction applies: a
    missing subject/claims/`groups`, an object/map (e.g. a namespaced or
    metadata claim like `{"department": "hr"}` — the `is_array` guard stops
    its *values* from being read as group names), and nested/non-string array
    elements are all treated as *not exempt*. If your IdP emits roles under a
    namespaced claim, adjust `caller_groups` to point at the array before
    matching. Missing claims always mean redaction applies — the failure mode
    is over-redaction, not disclosure. Note the placeholder group names are
    illustrative only and are not the ContextForge-internal
    `is_admin`/`teams`/`user` claims (which are stripped before reaching a
    policy and must never be used for gating).
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - notion
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package notion.egress.redact_pii

# Transform-only egress policy: rewrites email addresses and phone numbers in
# Notion read-tool responses to fixed redaction tokens before the response
# reaches the agent. Never denies. Callers in the placeholder HR/legal IdP
# groups receive unredacted responses; the group check fails closed, so a
# caller with missing or oddly-shaped claims gets over-redaction, never
# disclosure.
default allow := true

# -----------------------------------------------------------------------------
# Scope: Notion hosted-server read tools whose responses carry page-body,
# meeting-note, search-snippet, query-row, or comment content. The hosted
# server bakes the `notion-` prefix into its tool names, so the suffixes below
# include it — a bare `-search`/`-fetch` suffix would collide with other MCP
# servers' generic tools. Suffix matching keeps the policy portable across the
# gateway server-name prefix (e.g. a server named `notion` emits
# `notion-notion-search`). `notion-get-users` is deliberately absent: it is
# gated at ingress by the companion fence-user-directory policy.
# -----------------------------------------------------------------------------

pii_read_suffixes := {
    "notion-search",
    "notion-fetch",
    "notion-query-data-sources",
    "notion-query-meeting-notes",
    "notion-get-comments",
}

# Egress scope: match the post-invoke/output path on either mode or action. If
# we keyed on input.mode alone and a gateway build left it unset,
# is_pii_read_tool would silently fail and redaction would no-op (fail open,
# leaking content). Ingress (tool_pre_invoke / mode "input") satisfies neither
# branch, so it stays out of scope.
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC),
# tool_metadata.name (legacy), and payload.name (tool-hook canonical). Collect
# all three and match if ANY carries a read-tool suffix — matching only a
# subset would let a gateway that populates a different surface slip content
# past the scanner.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

is_pii_read_tool if {
    is_egress
    some suffix in pii_read_suffixes
    some n in candidate_names
    endswith(n, suffix)
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP groups whose members receive unredacted
# responses. Replace "hr" and "legal" with your IdP's group names at import
# time. Claims are read via object.get(input.subject, "claims", {}); the
# object.get chains mean a missing subject/claims/groups claim is never
# exempt: the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"hr", "legal"}

caller_claims := object.get(object.get(input, "subject", {}), "claims", {})

caller_groups := object.get(caller_claims, "groups", [])

is_exempt if {
    # Only an array of group strings grants the exemption. The is_array guard
    # is load-bearing: `some g in caller_groups` over an OBJECT iterates its
    # values, so a namespaced/metadata claim like {"department": "hr"} would
    # else wrongly exempt the caller. is_string(g) keeps nested/non-string
    # elements from matching. Anything but a clean array of strings fails
    # closed -> redact.
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    lower(g) in exempt_groups
}

is_exempt if {
    # Some IdPs emit a single group as a bare string rather than an array.
    is_string(caller_groups)
    lower(caller_groups) in exempt_groups
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives on
# Notion page IDs (32-hex UUIDs), dates, and version strings.
# -----------------------------------------------------------------------------

# Standard email address shape: local part, @, domain, 2+ letter TLD. Word-
# boundary anchored so it never fires inside longer alphanumeric runs.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone numbers (e.g. 206-555-0100, (206) 555-0100,
# +1 206.555.0100). A separator after the area code is required, so contiguous
# digit runs (IDs), UUID segments, dates (2026-07-15), and dotted version
# strings are not matched.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)|\b\d{3})[-. ]\d{3}[-. ]\d{4}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_email(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

redact_phone(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

# Both classes in one pass over a string. Each class is matched independently
# — no pairing required.
redact_text(t) := redact_phone(redact_email(t))

# Helper: the inner `text` string of an MCP structured content block
# ({"type":"text","text":"..."}); undefined for anything else.
block_text(b) := t if {
    is_object(b)
    t := object.get(b, "text", null)
    is_string(t)
}

# Plain-string content blocks: redact in place.
redact_block(b) := redact_text(b) if {
    is_string(b)
}

# MCP-standard structured text content blocks {"type":"text","text":"..."}:
# redact the inner `text` string and preserve every other key (type,
# annotations). Without this branch, page/meeting-note body delivered as
# content-block OBJECTS (the canonical MCP wire shape) would slip past a
# string-only redactor untouched — the exact PII this policy targets, leaked
# verbatim.
redact_block(b) := object.union(b, {"text": redact_text(bt)}) if {
    not is_string(b)
    bt := block_text(b)
}

# Any other block — an object with no string `text` field, or a non-string /
# non-object value — passes through unmodified. The policy makes no claim over
# arbitrary structured data whose PII lives under other keys.
redact_block(b) := b if {
    not is_string(b)
    not block_text(b)
}

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, the caller is not exempt, and at
# least one block actually changed. Otherwise the rule is undefined and the
# aggregator skips this policy, returning the response byte-identical.
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
    is_pii_read_tool
    not is_exempt
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
