---
name: "Airtable: Redact PII in Record Reads"
tags:
  - airtable
  - redact-pii
  - pii
  - dlp
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # airtable / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `airtable.egress.redact_pii`

  ## What it does

  Scans the responses of the Airtable **record-read** tools — the calls that
  return row `fields` values — and rewrites high-confidence PII shapes to a
  fixed `[REDACTED]` token before the response reaches the agent:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | hyphenated `XXX-XX-XXXX` form | `[REDACTED]` |
  | Email address | conservative `mailbox@domain.tld` shape | `[REDACTED]` |
  | Phone number | E.164 (`+14155550100`) and separator-formatted NANP (`206-555-0100`, `(206) 555-0100`, `(206)555-0100`, `+1 206.555.0100`) | `[REDACTED]` |
  | National ID | UK National Insurance number (`AB123456C` shape) as the shipped national-ID class | `[REDACTED]` |

  Matches are replaced in place, leaving the surrounding record structure
  (record IDs, field names, table/base IDs, JSON scaffolding) intact so the
  response stays usable. The policy is transform-only: it never denies a call,
  and responses with no matches (and all out-of-scope tools) pass through
  unchanged. Every response field is read via `object.get`, so missing or
  oddly-shaped payloads are never an error — they simply pass through.

  Redaction operates on the **response payload only** and never alters stored
  records — the row in Airtable is untouched; only the copy handed to the agent
  is masked.

  Because Airtable bases routinely hold CRM contacts, ATS candidate rows, and —
  on HIPAA-eligible Enterprise — patient-ops data, a single `list_records*`
  call can dump an entire table. That makes the record-read path the primary
  PII-egress surface for Airtable, which is why this policy sits on egress.

  ### Group exemption

  Callers whose IdP `groups` claim contains the placeholder `data-privileged`
  group (see Known limitations) receive **unmasked** responses. The check reads
  `input.subject.claims.groups` via `object.get` chains: a missing subject,
  missing claims, or missing `groups` claim means the caller is *not* exempt and
  redaction applies — the grant fails closed. This failure mode is safe: a
  caller whose claims fail to arrive gets over-redaction, never disclosure.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in Airtable record
    content as it leaves the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the read path; **P4.1** — supports limiting personal
    information use to identified purposes; **P6.1** — supports controls over
    personal-information disclosure by keeping raw identifiers out of agent
    context that does not need them.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR content in a base; **Art. 5(1)(f) /
    Art. 32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, national-ID numbers) on the agent
    channel; **§1798.150** — reduces nonredacted-PI breach exposure.

  ## Why egress

  The PII already lives in the base — there is nothing to block at ingress, and
  denying record reads outright would make the agent useless for everyday work.
  The leak happens when record `fields` are returned to the MCP client, so the
  response path is the only place to catch it while keeping the data useful.
  (For bases or tables that should never be read at all, pair with an ingress
  fence or a bulk-read clamp — see Composition.)

  ## Tool name matching

  Applies on the output path (`input.mode == "output"` **or**
  `input.action == "tool_post_invoke"` — either satisfies scope, so a gateway
  build that leaves one unset still redacts rather than failing open). The tool
  name is read from all three egress surfaces — `input.resource.name` (PARC),
  `input.tool_metadata.name` (legacy), and `input.payload.name` — and the
  policy matches if **any** of them carries a record-read suffix.

  Matching is case-insensitive and **by suffix**, anchored with a leading
  hyphen so generic verbs cannot accidentally match unrelated tools once the
  gateway server-name prefix is stripped. The DTwo gateway prefixes tool names
  with the configured MCP server name (e.g. `airtable-list_records_for_table`),
  so the suffixes below include that hyphen.

  The suffix set covers the record-read tools of the two verified Airtable MCP
  server families — the official remote server (verbose `*_for_table` /
  `*_for_page` names) and domdomegg's community server (terse names):

  - `-list_records` (domdomegg) / `-list_records_for_table` (official)
  - `-search_records` (both)
  - `-get_record` (domdomegg) / `-get_record_for_page` (official)
  - `-list_records_for_page` (official)
  - `-display_records_for_table` (official interactive record widget;
    disabled by default on the server, covered here so it redacts safely if
    enabled)

  Because the concise and verbose spellings differ only by suffix, each is
  listed explicitly (e.g. `-list_records` does **not** match
  `-list_records_for_table`, which ends in `_for_table`). Verify the exact names
  your gateway emits with the dump-input debug technique before relying on this
  in production, and extend `pii_read_suffixes` for any other record-returning
  tools your deployment exposes.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke`. Airtable record responses arrive as
  serialized JSON (an array of records, each with a `fields` object), so the
  regexes run over the serialized text of each string block and match values
  inside `"Field": "value"` pairs without eating the surrounding quotes
  (patterns are `\b`-anchored). It also redacts the inner `text` of MCP-standard
  structured content blocks (`{"type":"text","text":"..."}`), preserving every
  other key. When at least one block changes, the policy emits
  `transform.transformed_payload` containing the original payload with the
  rewritten `text` array (all other payload keys preserved). When nothing
  changes, no transform is emitted and the response passes through
  byte-identical.

  If a gateway or tool emits `payload.text` as a **bare string** rather than a
  content-block array, that shape is redacted too (string in, string out — the
  rewrite is shape-preserving); it does not fall through unredacted.

  ## Examples

  ### Redacted (in-scope tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "airtable-list_records_for_table", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["sales"] } },
      "payload": {
        "name": "airtable-list_records_for_table",
        "text": ["{\"records\":[{\"id\":\"rec1\",\"fields\":{\"Email\":\"jane.doe@example.com\",\"SSN\":\"123-45-6789\"}}]}"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["{\"records\":[{\"id\":\"rec1\",\"fields\":{\"Email\":\"[REDACTED]\",\"SSN\":\"[REDACTED]\"}}]}"]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "airtable-get_record", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["data-privileged"] } },
      "payload": {
        "name": "airtable-get_record",
        "text": ["SSN 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `data-privileged` group receives raw
  content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny/transform policies on the same pipeline. Recommended companions for
  `apps/airtable`:

  - **`mask-pan-egress` (PF-01)** — cardholder-number masking is intentionally
    **out of scope here**. Pair this policy with a Luhn-validated
    `mask-pan-egress` companion so PANs in payment-tracker bases are masked to
    BIN+last4; this policy does not touch card numbers.
  - **`cap-bulk-export` (PF-08, ingress)** — clamps `maxRecords` and strips
    `filterByFormula` on `list_records*`, throttling the mass enumeration that
    turns a single redaction miss into a full-table leak.
  - **A base/table fence (PF-23, ingress)** — blocks reads of the most
    sensitive bases outright; redaction is the wrong tool for data no agent
    should read at all.

  ## Known limitations

  - **rashidazarang/airtable-mcp tool names are unverified.** The landscape
    note could not verify that 42-tool community server's per-tool names from
    source; its record-read tools are therefore **not** in the suffix set. If
    you run it, introspect its live tool names and add the record-read suffixes
    before relying on this policy against it.
  - **Base64 / attachment content cannot be regex-scanned.** Attachment fields
    return URLs, and any file content fetched separately is opaque to a
    text-pattern policy; PII inside binary attachments passes through untouched.
  - **Pattern-based detection is best-effort.** Conservative by design: SSNs are
    matched in hyphenated form only (bare 9-digit runs collide with Airtable
    record IDs and other numerics); phones only in E.164 or separator-formatted
    NANP shapes (bare 10-digit runs are not matched, and the NANP separator set
    is hyphen/dot/space only — a tab-, comma-, or slash-separated grouping is
    deliberately not matched); the national-ID class
    ships with the UK National Insurance shape only (uppercase) — add your
    jurisdictions' formats to `national_id_pattern`; the email pattern will also
    match `user@host` substrings inside URLs and connection strings (a
    documented false-positive cost). Because every pattern is `\b`-anchored, a
    value glued directly to surrounding word characters with no separator (e.g.
    a free-text notes field reading `NotesSSN123-45-6789end`) is **not** matched
    — the leading boundary fails. Obfuscated (e.g. full-width digits),
    split-across-blocks, spelled-out, or image-embedded values are not caught.
    Treat this as a high-signal minimum-necessary layer, not a complete DLP
    solution.
  - **Only string and MCP `{type,text}` content blocks are scanned.** PII that
    a gateway delivers under some other structured key (a content block that is
    an object with no string `text` field, or a non-string/non-object element
    such as a nested array) is not scanned and passes through. If your gateway
    emits such shapes, flatten them upstream or add an object-aware redaction
    step.
  - **Only array and bare-string `payload.text` shapes are scanned.** The two
    transform rules fire when `payload.text` is a content-block array or a bare
    string. If a gateway delivers the top-level `payload.text` as some other
    container (for example an object like `{"content": "..."}`), neither rule
    matches and the response passes through unredacted. This is not a shape the
    documented `tool_post_invoke` schema emits, but confirm your gateway's
    actual egress shape with the dump-input technique before relying on this.
  - **Comment reads are out of scope.** This policy scans record-read tools
    only. Comment-read surfaces (`list_comments`, and any
    `*recordComments*`-style reads on the official server) can carry customer
    emails/phones in comment bodies and are **not** redacted by this policy. If
    your agents read Airtable comments, add the comment-read suffixes to
    `pii_read_suffixes` or attach a companion egress redaction policy scoped to
    them.
  - **Suffix matching assumes the hyphen server-name prefix.** The suffix set is
    anchored with a leading hyphen (`-list_records`), matching the documented
    gateway naming `<server-name>-<tool-name>`. A deployment that joins the
    prefix with a different separator, or exposes an unprefixed bare tool name,
    will not match and the response will pass through unredacted. Confirm the
    emitted names with the dump-input technique and adjust `pii_read_suffixes`.
  - **Group names are placeholders — replace `data-privileged` with your IdP's
    group name at import time.** The exemption expects the `groups` claim as an
    array of strings (a single bare string is also handled); a claim that is
    neither (e.g. an object) fails closed → redaction applies. If your IdP emits
    roles under a namespaced claim, adjust `caller_groups`. Missing claims always
    mean redaction applies — the failure mode is over-redaction, not disclosure.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input technique
    before production, and mind attachment order if other egress transforms (for
    example the `mask-pan-egress` companion) run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - airtable
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package airtable.egress.redact_pii

# Transform-only egress policy: rewrites US SSNs, email addresses, phone
# numbers (E.164 + NANP), and national-ID numbers in Airtable record-read
# responses to a fixed [REDACTED] token before the response reaches the agent.
# Never denies, and never touches the stored record — only the response copy.
# Callers in the placeholder `data-privileged` IdP group receive unredacted
# responses; the group check fails closed, so a caller with missing or
# oddly-shaped claims gets over-redaction, never disclosure.
default allow := true

# -----------------------------------------------------------------------------
# Scope: the record-read tools of the two verified Airtable MCP server families
# (official remote server: verbose `*_for_table` / `*_for_page` names;
# domdomegg community server: terse names). The gateway prefixes tool names
# with the configured MCP server name (e.g. `airtable-list_records_for_table`),
# so we match by suffix; the leading hyphen keeps generic verbs from matching
# unrelated tools once the prefix is stripped. Concise and verbose spellings
# differ only by suffix, so each is listed explicitly.
# -----------------------------------------------------------------------------

pii_read_suffixes := {
    # domdomegg community server (terse) / official remote server (verbose)
    "-list_records",
    "-list_records_for_table",
    "-list_records_for_page",
    "-search_records",
    "-get_record",
    "-get_record_for_page",
    # Official interactive record widget (records-returning; disabled by
    # default, but redacts safely when enabled). Distinct suffix from
    # -list_records_for_table, so it must be listed explicitly.
    "-display_records_for_table",
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
# all three and match if ANY carries a record-read suffix — matching only a
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
# Group exemption — placeholder IdP group whose members receive unredacted
# responses. Replace "data-privileged" with your IdP's group name at import
# time. Claims are read via object.get(input.subject, "claims", {}); the
# object.get chains mean a missing subject/claims/groups claim is never
# exempt: the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"data-privileged"}

caller_claims := object.get(object.get(input, "subject", {}), "claims", {})

caller_groups := object.get(caller_claims, "groups", [])

is_exempt if {
    # Only an array of group strings grants the exemption. The is_array guard
    # is load-bearing: `some g in caller_groups` over an OBJECT iterates its
    # values, so a namespaced/metadata claim like {"department": "sales"} would
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
# Airtable record IDs (rec...), base/table IDs (app.../tbl...), and dates.
# -----------------------------------------------------------------------------

# Standard email address shape: local part, @, domain, 2+ letter TLD. Word-
# boundary anchored so it never fires inside longer alphanumeric runs and never
# eats the surrounding JSON quotes.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# record IDs and raw numeric fields, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# National-ID class: UK National Insurance number — two prefix letters
# (excluding D, F, I, Q, U, V), six digits, suffix letter A-D. Uppercase only;
# add your jurisdictions' national-ID shapes alongside this one.
national_id_pattern := `\b[A-CEGHJ-PR-TW-Z]{2}[0-9]{6}[A-D]\b`

# E.164 international numbers: a leading + and 8-15 contiguous digits, the first
# non-zero. Anchored on the + so it never matches bare digit runs / IDs.
e164_pattern := `\+[1-9]\d{7,14}\b`

# Separator-formatted NANP phone numbers (e.g. 206-555-0100, (206) 555-0100,
# (206)555-0100, +1 206.555.0100). A parenthesized area code may be followed by
# an optional separator; a bare area code still requires a separator, so bare
# 10-digit runs are deliberately not matched.
nanp_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)[-. ]?|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings (regex.replace returns the input
# unchanged when its pattern doesn't match), so the steps chain safely. Every
# class maps to the same [REDACTED] token per the policy spec.
# -----------------------------------------------------------------------------

redact_emails(t) := regex.replace(t, email_pattern, "[REDACTED]")

redact_ssns(t) := regex.replace(t, ssn_pattern, "[REDACTED]")

redact_national_ids(t) := regex.replace(t, national_id_pattern, "[REDACTED]")

redact_e164(t) := regex.replace(t, e164_pattern, "[REDACTED]")

redact_nanp(t) := regex.replace(t, nanp_pattern, "[REDACTED]")

# Order matters: emails first, so the digit patterns can never half-eat a
# digit-bearing local part; then SSNs (tightest digit shape), national IDs
# (alphanumeric, disjoint from the digit patterns), E.164 (anchored on +), and
# separator-formatted NANP last (loosest).
redact_text(t) := redact_nanp(redact_e164(redact_national_ids(redact_ssns(redact_emails(t)))))

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
# annotations). Without this branch, record content delivered as content-block
# OBJECTS (a canonical MCP wire shape) would slip past a string-only redactor
# untouched — the exact PII this policy targets, leaked verbatim.
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

# Some gateways/tools emit `payload.text` as a bare string rather than a
# content-block array. Redact that shape too (string in, string out — the
# rewrite is shape-preserving) so PII is not leaked on this fail-open path.
# Mutually exclusive with the array rule above (is_string vs is_array), so the
# two complete-value transform rules never both fire.
transform := {
    "transformed_payload": object.union(response_payload, {"text": redacted_text}),
} if {
    is_pii_read_tool
    not is_exempt
    is_string(text_blocks)
    redacted_text := redact_text(text_blocks)
    redacted_text != text_blocks
}
```
