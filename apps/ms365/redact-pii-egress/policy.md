---
name: "Microsoft 365: Redact PII from Mail, Files & Transcripts"
tags:
  - ms365
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
  # ms365 / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `ms365.egress.redact_pii`

  ## What it does

  Scans the responses of the highest-density PII read surfaces in Microsoft 365
  — mail bodies, Excel ranges, SharePoint list items, meeting transcripts, and
  Teams messages — and rewrites personally identifiable information to fixed
  redaction tokens before the response reaches the agent:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Payment card (PAN) | 16-digit 4×4 groups, **Luhn-validated** in Rego | `[REDACTED-PAN]` |
  | IBAN | contiguous ISO 13616 shape (either letter case), **mod-97-checksum-validated** in Rego | `[REDACTED-IBAN]` |
  | US phone number | separator-formatted (e.g. `206-555-0100`, `(206) 555-0100`) | `[REDACTED-PHONE]` |

  Matches are replaced in place, leaving the surrounding structure intact so
  message metadata, spreadsheet layout, and transcript flow remain usable. The
  policy is transform-only: it never denies a call, and responses with no
  matches (and all out-of-scope tools) pass through unchanged. Every response
  field is read via `object.get`, so missing or oddly-shaped payloads are never
  an error — they simply pass through.

  Mailboxes are the universal PII sink in an M365 tenant — HR, finance, and
  support mailboxes routinely hold payroll data, PHI, and cardholder data — and
  Excel ranges plus SharePoint lists are where structured financial/HR records
  live. This policy is the primary minimum-necessary control on the M365 MCP
  read path.

  ### Group exemption

  Callers whose IdP `groups` claim contains `pii-readers` (a placeholder name —
  see Known limitations) receive **unredacted** responses. The check reads
  `input.subject.claims.groups` via `object.get` chains: a missing subject,
  missing claims, or missing `groups` claim means the caller is *not* exempt
  and redaction applies — the grant fails closed. This failure mode is safe:
  a caller whose claims fail to arrive gets over-redaction, never disclosure.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in M365 content as
    it leaves the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the read path; **P4.1** — supports limiting personal
    information use to identified purposes; **P6.1** — supports controls over
    personal-information disclosure by keeping raw identifiers out of agent
    context that doesn't need them.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based limits: only placeholder `pii-readers` group members see raw
    identifiers; everyone else gets working content with identifiers masked.
  - **HIPAA §164.514(a)–(b)** — supports de-identification practice by
    stripping Safe-Harbor identifier classes (SSN, account numbers, phone)
    from responses; **§164.530(c)** — supports privacy safeguards on the
    agent channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR content (mailboxes, transcripts);
    **Art. 5(1)(f) / Art. 32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, financial account numbers) on the
    agent channel; **§1798.150** — reduces nonredacted-PI breach exposure.
  - **PCI DSS 3.4.1** — supports masking of the PAN when displayed: 16-digit,
    Luhn-validated card numbers surfaced in M365 mail, Excel ranges, SharePoint
    items, and transcripts are rewritten to `[REDACTED-PAN]` before the response
    reaches the agent, so cardholder data that lands in M365 content is not exposed
    on the MCP read path (see Known limitations for the Amex/Diners and grouping
    coverage gaps).

  ## Why egress

  The PII already lives in the tenant — there is nothing to block at ingress,
  and denying mail/spreadsheet/transcript reads outright would make the agent
  useless for everyday work. The leak happens when content is returned to the
  MCP client, so the response path is the only place to catch it while keeping
  the content useful.

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to tools matched
  case-insensitively **by suffix** (with a leading hyphen, so
  `-get-mail-message` cannot accidentally match `-get-shared-mailbox-message`).
  The tool name is read from `input.resource.name`, with
  `input.tool_metadata.name` as a fallback. Suffix matching keeps the policy
  portable across gateway server-name prefixes (observed live as `ms365-`).

  Tool names are the softeria `ms-365-mcp-server` inventory, verified from a
  live gateway deployment:

  - Mail: `-get-mail-message`, `-list-mail-messages`,
    `-list-mail-folder-messages`, `-get-shared-mailbox-message`
  - Excel / SharePoint: `-get-excel-range`, `-get-excel-used-range`,
    `-list-excel-table-rows`, `-list-sharepoint-site-list-items`
  - Teams: `-get-meeting-transcript-content`, `-list-chat-messages`,
    `-list-channel-messages`

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production, and extend the suffix set for any other
  content-returning tools your deployment exposes (see Known limitations for
  the adjacent read surfaces deliberately not matched here).

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each string block
  (including string blocks containing serialized JSON, since the regexes run
  over the serialized text). Non-string blocks pass through unmodified. When at
  least one block changes, the policy emits `transform.transformed_payload`
  containing the original payload with the rewritten `text` array (all other
  payload keys preserved). When nothing changes, no transform is emitted and
  the response passes through byte-identical.

  ## Examples

  ### Redacted (in-scope tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "ms365-get-mail-message", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["marketing"] } },
      "payload": {
        "name": "ms365-get-mail-message",
        "text": ["Employee SSN: 123-45-6789, card 4111 1111 1111 1111"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["Employee SSN: [REDACTED-SSN], card [REDACTED-PAN]"]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "ms365-get-mail-message", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["pii-readers"] } },
      "payload": {
        "name": "ms365-get-mail-message",
        "text": ["Employee SSN: 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `pii-readers` group receives raw
  content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes
  cleanly with deny policies on the same egress pipeline. Recommended
  companions for `apps/ms365`:

  - **A deny policy for `-download-bytes` and `-get-mail-message-mime`**
    (ingress) — those tools return base64/MIME content this policy cannot
    scan (see Known limitations). A `role-gate-writes`-style baseline leaves
    them reachable because they are reads, so regulated tenants should add a
    companion deny or group-gate for them.
  - A `deny-escape-hatches`-style ingress deny for `-graph-batch`, which
    reaches the same mailbox/file data through raw Graph calls whose response
    shapes this policy does not match.
  - A `cap-bulk-export`-style ingress guard that strips `fetchAllPages` from
    Excel reads, bounding the blast radius of any redaction miss.
  - A `guard-external-send` ingress policy so content redacted on read is not
    simply mailed out instead.

  ## Known limitations

  - **`-download-bytes` and `-get-mail-message-mime` are not covered — deny or
    group-gate them.** Both return base64/MIME-encoded content that regex
    redaction cannot parse, so PII inside attachments, raw MIME messages, and
    binary downloads passes through any pattern-based egress policy untouched.
    This policy deliberately does not match them; pair it with an ingress deny
    (or an IdP-group gate) on those two tools. Note that a read-only baseline
    such as `role-gate-writes` still allows them (they are reads), so a
    companion deny is recommended for regulated tenants.
  - **`fetchAllPages` amplifies misses.** Excel read tools accept a
    `fetchAllPages` argument (up to 100 pages), which turns a single read into
    a bulk export — any PII shape this policy's conservative patterns miss is
    then missed at scale. Pair with an ingress guard that strips or denies
    `fetchAllPages` for non-exempt callers.
  - **`-graph-batch` bypasses per-tool matching.** Arbitrary batched Graph
    requests return the same data under a different tool name and response
    shape. Deny it for non-admin callers.
  - **Adjacent read surfaces are not matched.** The suffix set covers the
    highest-density PII surfaces verified in the landscape inventory. Related
    tools — `-list-shared-mailbox-messages`, `-list-mail-attachments`,
    `-get-chat-message`, `-list-chat-message-replies`,
    `-list-channel-message-replies`, `-search-query`,
    `-get-meeting-recording-content` (binary), OneNote page reads, and drive
    item reads — are not in the set. Extend `pii_read_suffixes` to taste.
  - **Pattern-based detection is best-effort.** Conservative by design:
    SSNs are matched in hyphenated form only (bare 9-digit runs collide with
    Graph object IDs); IBANs only in contiguous form (spaced `DE89 3704 …`
    grouping is not matched) and only when the ISO 13616 mod-97 checksum
    passes; phones only in separator-formatted US shapes. Obfuscated,
    split-across-blocks, spelled-out, or image-embedded values are not caught.
    Treat this as a high-signal minimum-necessary layer, not a complete DLP
    solution.
  - **PAN detection is 16-digit-only, and Luhn is not the sole gate.** A
    card-shaped number is redacted only when it is **16 digits** presented
    contiguously or in single-`[- ]`-separated 4×4 groups **and** passes the
    Luhn check — the length/shape filter runs *before* Luhn. As a result, PANs
    that are Luhn-valid but not 16-digit-4×4 pass through unredacted:
    **15-digit Amex** (4-6-5 grouping), **14-digit Diners**, and 13/19-digit
    card ranges, as well as any 16-digit card grouped with dots
    (`4111.1111.1111.1111`), double spaces, or slashes. If your tenant handles
    Amex/Diners or non-standard groupings on the M365 read path, pair this with
    a broader card DLP control (or extend `pan_pattern` and the `[- ]`
    separator class) — do not rely on this policy alone for full PAN coverage.
  - **Phone detection needs a separator after the area code.** Separator-
    formatted US shapes are matched (`206-555-0100`, `(206) 555-0100`,
    `+1 206.555.0100`), but `(206)555-0100` with no space after the closing
    parenthesis, and bare 10-digit runs, are not.
  - **Non-string content blocks pass through unmodified.** Redaction applies
    to string entries of `input.payload.text` (including serialized-JSON
    strings). If your gateway emits structured non-string blocks, verify their
    shape with the dump-input technique.
  - **Group names are placeholders — replace `pii-readers` with your IdP's
    group name at import time.** The exemption expects the `groups` claim as
    an array of strings (a single bare string is also handled); if your IdP
    emits roles under a namespaced claim, adjust `caller_groups`. Missing
    claims always mean redaction applies — the failure mode is
    over-redaction, not disclosure.
  - **Softeria naming assumed.** Suffixes are the softeria
    `ms-365-mcp-server` names. The Anthropic-hosted Microsoft 365 connector
    does not traverse a customer gateway at all (a coverage gap to flag, not a
    policy target), and Lokka-style single-tool Graph passthrough servers
    defeat name-based matching entirely — this policy will not fire for them.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - ms365
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
package ms365.egress.redact_pii

# Transform-only egress policy: rewrites PII in Microsoft 365 content-returning
# tool responses to fixed redaction tokens before the response reaches the
# agent. Never denies. Callers in the placeholder `pii-readers` IdP group
# receive unredacted responses; the group check fails closed, so a caller with
# missing claims gets over-redaction, never disclosure.
default allow := true

# -----------------------------------------------------------------------------
# Scope: the highest-density PII read surfaces of the softeria
# ms-365-mcp-server (names verified from a live gateway deployment). The
# gateway prefixes tool names with the configured MCP server name (observed
# live as `ms365-`), so we match by suffix; the leading hyphen keeps
# `-get-mail-message` from matching `…-get-shared-mailbox-message` or other
# near-miss names.
# -----------------------------------------------------------------------------

pii_read_suffixes := {
    # Mail bodies — HR/finance/support mailboxes are the universal PII sink
    "-get-mail-message",
    "-list-mail-messages",
    "-list-mail-folder-messages",
    "-get-shared-mailbox-message",
    # Excel ranges + SharePoint list items — structured financial/HR records
    "-get-excel-range",
    "-get-excel-used-range",
    "-list-excel-table-rows",
    "-list-sharepoint-site-list-items",
    # Teams — verbatim recorded conversations and chat history
    "-get-meeting-transcript-content",
    "-list-chat-messages",
    "-list-channel-messages",
}

is_pii_read_tool if {
    input.mode == "output"
    some suffix in pii_read_suffixes
    endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), suffix)
}

is_pii_read_tool if {
    # Egress hooks also expose the tool name under tool_metadata.name — check
    # both so we match regardless of which surface the gateway populates.
    input.mode == "output"
    some suffix in pii_read_suffixes
    meta := object.get(input, "tool_metadata", {})
    endswith(lower(object.get(meta, "name", "")), suffix)
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP group whose members receive unredacted
# responses. Replace "pii-readers" with your IdP's group name at import time.
# object.get chains mean a missing subject/claims/groups claim is never
# exempt: the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"pii-readers"}

caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

is_exempt if {
    some g in caller_groups
    lower(g) in exempt_groups
}

is_exempt if {
    # Some IdPs emit a single group as a bare string rather than an array.
    is_string(caller_groups)
    lower(caller_groups) in exempt_groups
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives.
# -----------------------------------------------------------------------------

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# Graph object IDs and raw phone digits, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# 16-digit card-shaped runs in 4x4 groups with optional space/hyphen
# separators. Candidates are only redacted after passing the Luhn check below —
# a matching shape alone is not enough.
pan_pattern := `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b`

# IBAN in contiguous ISO 13616 form: two country letters (either case, since
# real IBANs are sometimes transmitted lowercased), two check digits, then
# 11-30 alphanumerics (15-34 chars total). Word-boundary anchored, so it never
# fires inside longer alphanumeric runs (base64 blobs, Graph IDs). Candidates
# are only redacted after passing the mod-97 checksum below, which keeps the
# looser letter class from adding false positives.
iban_pattern := `\b[A-Za-z]{2}[0-9]{2}[A-Za-z0-9]{11,30}\b`

# Separator-formatted US phone numbers (e.g. 206-555-0100, (206) 555-0100,
# +1 206.555.0100). Bare 10-digit runs are deliberately not matched.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)|\b\d{3})[-. ]\d{3}[-. ]\d{4}\b`

# -----------------------------------------------------------------------------
# Luhn check — validates card-shaped candidates so invoice/reference numbers
# that merely look like PANs are left alone.
# -----------------------------------------------------------------------------

digits_only(s) := regex.replace(s, `[^0-9]`, "")

luhn_contribution(d, parity) := d if { parity == 0 }

luhn_contribution(d, parity) := 2 * d if {
    parity == 1
    (2 * d) < 10
}

luhn_contribution(d, parity) := (2 * d) - 9 if {
    parity == 1
    (2 * d) >= 10
}

luhn_valid(digits) if {
    chars := split(digits, "")
    n := count(chars)
    total := sum([v |
        some i, c in chars
        v := luhn_contribution(to_number(c), (n - 1 - i) % 2)
    ])
    total % 10 == 0
}

# All card-shaped substrings of t that pass the Luhn check.
pan_candidates(t) := {c |
    some c in regex.find_n(pan_pattern, t, -1)
    luhn_valid(digits_only(c))
}

# -----------------------------------------------------------------------------
# ISO 13616 mod-97 check — validates IBAN-shaped candidates so ID-like
# alphanumeric tokens that merely look like IBANs are left alone.
# -----------------------------------------------------------------------------

# Numeric value of an IBAN character: digits map to themselves, letters to
# 10..35 (A=10 … Z=35).
iban_char_value(c) := to_number(c) if { regex.match(`^[0-9]$`, c) }

iban_char_value(c) := indexof("abcdefghijklmnopqrstuvwxyz", lower(c)) + 10 if {
    regex.match(`^[A-Za-z]$`, c)
}

# 10^k mod 97 for k = 0..67, precomputed because OPA's modulo loses precision
# above float64 magnitude, so the expanded IBAN digit string cannot be taken
# mod 97 as one big number. 68 entries covers the longest possible expansion
# (34 IBAN chars, all letters, at 2 digits each).
pow10_mod97 := [
    1, 10, 3, 30, 9, 90, 27, 76, 81, 34,
    49, 5, 50, 15, 53, 45, 62, 38, 89, 17,
    73, 51, 25, 56, 75, 71, 31, 19, 93, 57,
    85, 74, 61, 28, 86, 84, 64, 58, 95, 77,
    91, 37, 79, 14, 43, 42, 32, 29, 96, 87,
    94, 67, 88, 7, 70, 21, 16, 63, 48, 92,
    47, 82, 44, 52, 35, 59, 8, 80,
]

iban_valid(s) if {
    # Move the country code + check digits to the end and map every char to
    # its numeric value per ISO 13616.
    rearranged := concat("", [substring(s, 4, count(s) - 4), substring(s, 0, 4)])
    numeric := concat("", [d |
        some c in split(rearranged, "")
        d := sprintf("%d", [iban_char_value(c)])
    ])
    # Take the expanded number mod 97 digit-by-digit via the precomputed power
    # table — every intermediate value stays small and exact. A genuine IBAN
    # yields exactly 1.
    digit_chars := split(numeric, "")
    n := count(digit_chars)
    total := sum([v |
        some i, c in digit_chars
        v := to_number(c) * pow10_mod97[n - 1 - i]
    ])
    total % 97 == 1
}

# All IBAN-shaped substrings of t that pass the mod-97 check.
iban_candidates(t) := {c |
    some c in regex.find_n(iban_pattern, t, -1)
    iban_valid(c)
}

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_pans(t) := out if {
    cands := pan_candidates(t)
    count(cands) > 0
    # Candidates contain only digits, spaces, and hyphens, so joining them into
    # an alternation of literals is regex-safe.
    literal := concat("|", sort([c | some c in cands]))
    out := regex.replace(t, literal, "[REDACTED-PAN]")
}

redact_pans(t) := t if { count(pan_candidates(t)) == 0 }

redact_ibans(t) := out if {
    cands := iban_candidates(t)
    count(cands) > 0
    # Candidates are purely alphanumeric, so the alternation is regex-safe.
    literal := concat("|", sort([c | some c in cands]))
    out := regex.replace(t, literal, "[REDACTED-IBAN]")
}

redact_ibans(t) := t if { count(iban_candidates(t)) == 0 }

redact_phones(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

# Order matters: SSNs first (so a later pattern can never half-eat one), then
# Luhn-checked PANs (digit groups), then checksum-valid IBANs (alphanumeric,
# disjoint from the digit patterns), then separator-formatted phones.
redact_block(b) := redact_phones(redact_ibans(redact_pans(redact_ssn(b)))) if {
    is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if { not is_string(b) }

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
