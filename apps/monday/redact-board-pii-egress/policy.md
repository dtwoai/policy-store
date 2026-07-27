---
name: "monday: Redact PII in Board & Doc Reads"
tags:
  - monday
  - redact-pii
  - pii
  - dlp
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # monday / redact-board-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-first — redacts PII on read responses; denies only the account-directory tool for non-admins)
  **Package:** `monday.egress.redact_board_pii`

  ## What it does

  Two egress controls in one policy, both scoped to the monday MCP read path:

  1. **PII redaction (transform).** On the responses of monday's generic board,
     doc, and update read tools, it rewrites direct identifiers to fixed
     redaction tokens before the payload reaches the model:

     | Class | Detection | Token |
     |---|---|---|
     | US SSN | hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
     | Email address | standard `local@domain.tld` shape | `[REDACTED-EMAIL]` |
     | US phone number | separator-formatted (`206-555-0100`, `(206) 555-0100`, `(206)555-0100`, `+1 206.555.0100`) | `[REDACTED-PHONE]` |
     | National ID | UK-NINO-shaped `AB123456C` / `AB 12 34 56 C` (representative — extend per locale) | `[REDACTED-NATIONAL-ID]` |

     Each class is matched independently — a lone email, phone, SSN, or national
     ID is redacted on its own. Matches are replaced in place, so structural
     fields (column IDs, item IDs, board/group structure, non-PII column values)
     stay intact and the agent can still reason over the rest of the board. The
     redaction is a transform: it never denies these reads, and responses with no
     matches (and all out-of-scope tools) pass through byte-identical.

  2. **Account-directory deny.** `list_users_and_teams` returns account-wide
     names and emails — a harvesting surface for a prompt-injected agent trying
     to exfiltrate the org's directory. Its response is **denied** for callers
     outside the placeholder `monday-admins` group. Admins receive the directory
     unchanged; everyone else is blocked with an actionable reason. The grant
     fails closed: a caller with a missing/oddly-shaped `groups` claim is treated
     as non-admin and denied.

  monday boards are schema-less business databases: HR/recruiting boards
  (candidate PII), CRM/deal boards, and healthcare project boards all live in the
  same account, and email/phone column values are stored as **plain strings inside
  the `columnValues` JSON**, while workdoc and update bodies are free text. So
  regulated data rides back in a *generic* read regardless of which board produced
  it — sensitivity is a property of the board/workspace, not the tool. This makes
  egress redaction the primary minimum-necessary control on the monday read path.
  It is **defense-in-depth behind the ingress board fence** (`fence-sensitive-boards`):
  even a reader authorized for a board should not stream raw identifiers into model
  context.

  ### Redaction exemption group

  Callers whose IdP `groups` claim contains `pii-full` (a placeholder name — see
  Known limitations) receive **unredacted** read responses. The check reads claims
  via `object.get(input.subject, "claims", {})` then `object.get(..., "groups", [])`:
  a missing subject, missing claims, missing `groups`, or a `groups` claim that is
  not a clean array/string of names means the caller is *not* exempt and redaction
  applies — the grant fails closed. The failure mode is over-redaction, never
  disclosure.

  ## Compliance alignment

  Instantiates egress PII redaction (family PF-02) for monday and supports
  alignment with:

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in board/doc/update
    content as it leaves the gateway toward the agent; **C1.1** — supports
    identification and protection of confidential information on the read path;
    **P4.1** — supports limiting personal-information use to identified purposes;
    **P6.1** — supports controls over personal-information disclosure, including
    denying the account directory to callers who do not need it.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary, role-based
    limits: only placeholder `pii-full` members see raw identifiers and only
    `monday-admins` may read the account directory; everyone else gets working
    board content with identifiers masked. **§164.514(a)–(b)** — supports
    de-identification by stripping Safe-Harbor identifier classes (SSN, email,
    phone) from responses; **§164.530(c)** — supports privacy safeguards on the
    agent channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR content in boards, docs, and updates;
    **Art. 5(1)(f) / Art. 32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN) on the agent channel; **§1798.150** —
    reduces nonredacted-PI breach exposure.

  ## Why egress

  The PII already lives in monday — there is nothing to block at ingress on a
  generic board read, and denying reads outright would make the agent useless for
  everyday work-management tasks. The leak happens when board/doc/update text is
  returned to the MCP client, so the response path is the only place to catch it
  while keeping the content useful. The `list_users_and_teams` deny is also placed
  on egress so it composes into this single monday egress policy; the response
  carrying names/emails never reaches the model. This complements — not replaces —
  the ingress board fence.

  ## Tool name matching

  Applies on the output path — scoped when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a gateway
  build that populates only one of the two (keying on `mode` alone would fail open
  if it were unset). The tool name is read from all three egress surfaces —
  `input.resource.name`, `input.tool_metadata.name`, and `input.payload.name` — and
  a suffix hit on **any** of them puts the call in scope.

  monday's official (hosted + local npm) server exposes tools **unprefixed**
  (`get_board_items_page`, not `monday_get_board_items_page`); behind a gateway they
  appear as `<server-name><sep><tool>`. Matching is **separator-anchored**: a
  suffix matches when the tool name equals it, or ends with `-<suffix>` or
  `_<suffix>`. This covers the two realistic gateway prefix separators plus a
  prefix-less emission, and — unlike a bare `endswith` — it does **not** over-match
  on words that merely end in a scope suffix (e.g. `search` will not match a tool
  ending in `research`/`elasticsearch`).

  **Redaction scope** (official monday read tools whose responses carry board-item,
  doc, or update body content):

  - `get_board_items_page`, `get_full_board_data` — board item + column values
    (email/phone live here as plain strings inside `columnValues`)
  - `get_updates` — item update (comment) bodies
  - `read_docs` — full workdoc content
  - `search` — account-wide discovery snippets
  - `fetch_file_content` — attachment content pulled into context

  Community `sakce/mcp-server-monday` equivalents (snake_case, current FastMCP
  code) that return the same body content are also matched: `get_items_by_id`,
  `list_items_in_groups`, `get_item_updates`.

  **Directory-deny scope:** `list_users_and_teams` (official) — matched the same
  separator-anchored way.

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production, and extend `pii_read_suffixes` for any other
  content-returning monday tools your deployment exposes (see Known limitations).

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each block. It handles the two
  content-block shapes a gateway realistically emits:

  - **Plain-string blocks** (`"text": ["...board JSON or doc body..."]`) are
    redacted directly. Because monday board reads serialize `columnValues` (and its
    plain-string email/phone values) into the response text, the regexes run over
    that serialized JSON and catch the values without needing to parse it.
  - **MCP-standard structured text blocks** (`{"type":"text","text":"..."}`) have
    their inner `text` string redacted while every other key is preserved.

  Any other block (an object with no string `text` field, or a non-string/non-object
  value) passes through unmodified — the policy makes no claim over arbitrary
  structured data whose PII sits under other keys. When at least one block changes,
  the policy emits `transform.transformed_payload` with the rewritten `text` array
  (all other payload keys, including `name`, preserved). When nothing changes, no
  transform is emitted and the response passes through byte-identical. Note `text`
  must be an **array**: a gateway that returns a bare scalar string under
  `payload.text` (off the documented shape) is not rewritten — see Known limitations.

  ## Argument shape

  This is an egress policy; it inspects `input.payload.text` (response content), not
  request args. Identity is read from `input.subject.claims.groups` via `object.get`
  chains. No request-argument assumptions are made.

  ## Examples

  ### Redacted (in-scope board read, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "monday-get_board_items_page", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["recruiting"] } },
      "payload": {
        "name": "monday-get_board_items_page",
        "text": ["{\"email_col\":\"jane@acme.com\",\"phone_col\":\"206-555-0100\",\"ssn\":\"123-45-6789\"}"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["{\"email_col\":\"[REDACTED-EMAIL]\",\"phone_col\":\"[REDACTED-PHONE]\",\"ssn\":\"[REDACTED-SSN]\"}"]`.

  ### Denied (account directory, non-admin caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "monday-list_users_and_teams", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["recruiting"] } },
      "payload": { "name": "monday-list_users_and_teams", "text": ["...names + emails..."] }
    }
  }
  ```

  `allow = false`, `reason = "monday list_users_and_teams returns account-wide names and emails and is restricted to the placeholder 'monday-admins' group. Ask your workspace admin to add you to that group, or use a board-scoped read instead. Replace 'monday-admins' with your IdP's admin group name at import time."`

  ### Passed through (exempt caller / admin)

  A caller whose `groups` includes `pii-full` receives read content unredacted
  (`allow = true`, no `transform`); a caller in `monday-admins` receives the
  directory unchanged (`allow = true`, no `transform`).

  ## Composition

  Combines a transform (`default allow := true`) with a single narrow deny; it
  composes cleanly on the monday egress pipeline. Recommended companions in
  `apps/monday`:

  - The ingress **`fence-sensitive-boards`** board allow/deny list, so the agent
    only reads boards it is entitled to. This egress redactor is defense-in-depth
    behind that fence.
  - **`default-deny-unknown-tools`** and **`freeze-standing-automation`** for the
    ingress escape-hatch / persistence surfaces (`all_monday_api`, `create_automation`,
    etc.) that would otherwise bypass per-tool governance.

  ## Known limitations

  - **Pattern-based detection is best-effort and conservative by design.** SSNs are
    matched in hyphenated `XXX-XX-XXXX` form only (bare 9-digit runs collide with
    monday numeric item/board IDs); phone numbers only in separator-formatted US
    shapes (a contiguous digit run like an item ID, or a dotted version string, does
    not match); the national-ID pattern matches a UK-NINO shape only. `\b`-anchored
    identifiers that abut a word character — a run-on like `id123-45-6789`, a
    Markdown-italic `_123-45-6789_`, a trailing `206-555-0100x` — are **not** matched
    (loosening the anchor would re-introduce item-ID false positives). Non-ASCII
    digit forms escape (RE2 `\d` is ASCII-only). Obfuscated, spelled-out,
    split-across-blocks, or base64-encoded values are not caught. Treat this as a
    high-signal minimum-necessary layer, not a complete DLP solution.
  - **National-ID coverage is a locale placeholder.** The shipped pattern is a UK
    National Insurance number (`AB123456C` / `AB 12 34 56 C`). It will **not** catch
    Aadhaar, US ITIN, Codice Fiscale, SIN, or other locale-specific IDs. Extend
    `national_id_pattern` (and add tokens/patterns) for your deployment's formats.
  - **Block coverage and the `text`-array assumption.** Redaction applies to
    plain-string entries of `input.payload.text` (including serialized-JSON strings)
    **and** to MCP-standard structured text blocks (`{"type":"text","text":"..."}`).
    Blocks that are objects with **no string `text` field** (a custom
    `{"field":"ssn","value":"…"}` shape, an embedded-resource block carrying text
    under `resource.text`, an image/audio block, or a nested array of sub-blocks)
    pass through unmodified and stream any embedded identifiers verbatim (confirmed
    by red-team). If your gateway emits board/doc bodies under those shapes (the
    documented contract is a flat array of strings — confirm with the dump-input
    technique), extend `block_text`/`redact_block`, or fence those tools at ingress.
    Redaction is also confined to the block's own `text` string: a structured block
    that carries a string `text` field **and** additional identifiers under a
    *sibling* key (e.g. `{"type":"text","text":"…","note":"jane@acme.com"}`) has only
    `text` rewritten — the sibling value passes through verbatim (confirmed by
    red-team). MCP text blocks normally carry only `type`/`text`/`annotations`, so
    this is an off-contract shape; if your gateway packs body content into sibling
    keys, redact them at the source tool or fence it at ingress.
    Separately, an off-spec `payload.text` that is **not an array** — a bare scalar
    string, or an object/map such as `{"0":"…SSN…"}` — fails the `is_array` transform
    guard and is **not** rewritten (a fail-open residual on a shape off the documented
    flat-array-of-strings contract; both were confirmed by red-team).
  - **Redaction covers only the listed read tools.** Other content-returning monday
    reads (`get_board_info`, `board_insights`, `get_assets`, monday-dev sprint
    readers, the `all_monday_api` / `all_api_read` GraphQL escape hatch) stream body
    content verbatim and are **not** redacted here — the escape hatch in particular
    must be denied at ingress (`default-deny-unknown-tools`), or every egress control
    is bypassable via one `query` string. Add tools your deployment exposes to
    `pii_read_suffixes`, or fence them at ingress.
  - **The `list_users_and_teams` deny is egress, so the upstream call still
    executes** — only the response is blocked before it reaches the model. Names and
    emails are not returned to the agent, but the read did hit monday. To prevent the
    call entirely, add an ingress deny for the same tool.
  - **Group names are placeholders — replace `pii-full` and `monday-admins` with your
    IdP's group names at import time.** Both checks accept a `groups` claim shaped as
    an array of strings (a single bare string is also handled); any other shape fails
    closed (redaction applies / directory denied). A missing subject/claims/`groups`,
    an object/map (e.g. a namespaced `{"department":"pii-full"}` claim — the
    `is_array` guard stops its *values* being read as group names), and
    nested/non-string array elements are all treated as *not exempt* / *not admin*.
    These placeholders are illustrative and are **not** the ContextForge-internal
    `is_admin`/`teams`/`user` claims (which are stripped before reaching a policy and
    must never be used for gating).
  - **Egress `transformed_payload` replaces the response payload wholesale.** Verify
    the rewrite against your gateway version with the dump-input technique before
    production, and mind attachment order if other egress transforms run on the same
    pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - monday
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package monday.egress.redact_board_pii

# Transform-first egress policy with one narrow deny. default allow := true: the
# policy redacts PII in monday board/doc/update read responses (a transform) and
# additionally denies the account-directory tool (list_users_and_teams) to
# non-admin callers (a deny). Everything else passes through unchanged. The deny
# uses the documented `allow := false if { ... }` form over the true default.
default allow := true

# -----------------------------------------------------------------------------
# Egress scope. Match the post-invoke/output path on either mode or action: if we
# keyed on input.mode alone and a gateway build left it unset, the scope checks
# would silently fail and redaction would no-op (fail open, leaking content).
# Ingress (tool_pre_invoke / mode "input") satisfies neither branch.
# -----------------------------------------------------------------------------
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC), tool_metadata.name
# (legacy), and payload.name (tool-hook canonical). Collect all three and match if
# ANY carries a scope suffix — matching only a subset would let a gateway that
# populates a different surface slip content past the scanner.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

# Separator-anchored suffix match: the tool name equals the suffix, or ends with
# `-<suffix>` or `_<suffix>` (the two realistic gateway prefix separators). Unlike a
# bare endswith, this never over-matches a word that merely ends in the suffix
# (e.g. `search` won't match `...research`).
name_has_suffix(n, s) if { n == s }

name_has_suffix(n, s) if { endswith(n, concat("", ["-", s])) }

name_has_suffix(n, s) if { endswith(n, concat("", ["_", s])) }

# -----------------------------------------------------------------------------
# Redaction scope: monday read tools whose responses carry board-item, doc, or
# update body content. Official (hosted + local npm) names are unprefixed; the
# community sakce equivalents (snake_case) surface the same content.
# -----------------------------------------------------------------------------
pii_read_suffixes := {
    # Official monday read tools
    "get_board_items_page",
    "get_full_board_data",
    "get_updates",
    "read_docs",
    "search",
    "fetch_file_content",
    # Community sakce/mcp-server-monday equivalents (same body content)
    "get_items_by_id",
    "list_items_in_groups",
    "get_item_updates",
}

is_pii_read_tool if {
    is_egress
    some suffix in pii_read_suffixes
    some n in candidate_names
    name_has_suffix(n, suffix)
}

# -----------------------------------------------------------------------------
# Directory-deny scope: the account directory tool returns account-wide names and
# emails — a harvesting surface for prompt-injected exfil.
# -----------------------------------------------------------------------------
directory_suffixes := {"list_users_and_teams"}

is_directory_tool if {
    is_egress
    some suffix in directory_suffixes
    some n in candidate_names
    name_has_suffix(n, suffix)
}

# -----------------------------------------------------------------------------
# Identity. Placeholder IdP group names — replace at import time. Claims are read
# via object.get chains so a missing subject/claims/groups is never a grant: both
# the redaction exemption and the admin grant fail closed.
# -----------------------------------------------------------------------------
caller_claims := object.get(object.get(input, "subject", {}), "claims", {})

caller_groups := object.get(caller_claims, "groups", [])

# Members receive UNREDACTED read responses.
exempt_groups := {"pii-full"}

# Members may read the account directory.
admin_groups := {"monday-admins"}

# group_matches(set): true iff caller_groups (array of strings, or a bare string)
# contains a name in `set`. The is_array guard is load-bearing: `some g in obj`
# iterates an object's VALUES, so a namespaced claim like {"department":"pii-full"}
# would else wrongly match. is_string(g) blocks nested/non-string elements. Any
# other shape fails closed.
group_matches(want) if {
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    lower(g) in want
}

group_matches(want) if {
    is_string(caller_groups)
    lower(caller_groups) in want
}

is_exempt if { group_matches(exempt_groups) }

is_admin if { group_matches(admin_groups) }

# -----------------------------------------------------------------------------
# Deny: block the account-directory response for non-admin callers.
# -----------------------------------------------------------------------------
allow := false if {
    is_directory_tool
    not is_admin
}

reasons contains "monday list_users_and_teams returns account-wide names and emails and is restricted to the placeholder 'monday-admins' group. Ask your workspace admin to add you to that group, or use a board-scoped read instead. Replace 'monday-admins' with your IdP's admin group name at import time." if {
    is_directory_tool
    not is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives on
# monday numeric IDs and version strings.
# -----------------------------------------------------------------------------

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# monday numeric item/board IDs, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Standard email address shape: local part, @, domain, 2+ letter TLD. Word-boundary
# anchored so it never fires inside longer alphanumeric runs.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone numbers (206-555-0100, (206) 555-0100,
# (206)555-0100, +1 206.555.0100). When the area code is parenthesized the
# separator before the prefix is optional (a bare `(206)555-0100` is a mainstream
# rendering); when it is a bare 3-digit run a separator IS required, so contiguous
# digit runs (item IDs) and dotted version strings are not matched.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)[-. ]?|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b`

# National ID — representative UK National Insurance number: two prefix letters,
# six digits, one suffix letter, compact (AB123456C) or single-space grouped
# (AB 12 34 56 C). Conservative placeholder; extend for the deployment's
# locale-specific national-ID formats (Aadhaar, ITIN, SIN, Codice Fiscale, ...).
national_id_pattern := `\b[A-Za-z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-Za-z]\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely. SSN and phone run
# before the national-ID pass; the classes are digit-shape-disjoint, so order is
# not load-bearing, but running the separator-delimited classes first avoids any
# accidental capture by the letter-prefixed national-ID pattern.
# -----------------------------------------------------------------------------
redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_email(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

redact_phone(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

redact_national_id(t) := regex.replace(t, national_id_pattern, "[REDACTED-NATIONAL-ID]")

redact_text(t) := redact_national_id(redact_phone(redact_email(redact_ssn(t))))

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

# MCP-standard structured text content blocks {"type":"text","text":"..."}: redact
# the inner `text` string and preserve every other key. Without this branch,
# content delivered as content-block OBJECTS (the canonical MCP wire shape) would
# slip past a string-only redactor untouched.
redact_block(b) := object.union(b, {"text": redact_text(bt)}) if {
    not is_string(b)
    bt := block_text(b)
}

# Any other block — an object with no string `text` field, or a non-string /
# non-object value — passes through unmodified.
redact_block(b) := b if {
    not is_string(b)
    not block_text(b)
}

# -----------------------------------------------------------------------------
# Transform — emitted only when in redaction scope, the caller is not exempt, the
# payload text is an array, and at least one block actually changed. Otherwise the
# rule is undefined and the aggregator skips this policy, returning the response
# byte-identical. Directory-tool calls are not in pii_read_suffixes, so they never
# produce a transform (admins pass through; non-admins are denied above).
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
