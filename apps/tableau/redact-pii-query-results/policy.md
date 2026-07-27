---
name: "Tableau: Redact PII & Mask PANs in Query Results"
tags:
  - tableau
  - redact-pii-egress
  - pii
  - pan
  - dlp
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # tableau / redact-pii-query-results

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `tableau.egress.redact_pii_query_results`

  ## What it does

  Tableau is a warehouse proxy: the data-returning tools stream raw row-level
  content out of whatever the published datasource connects to — PII, PHI,
  payroll, and cardholder data — and Tableau's own row-level security applies
  only if the site configured it. This egress policy scans the CSV / JSON /
  text body of the data-returning Tableau tools and rewrites sensitive values
  in place before the response reaches the agent:

  | Class | Detection | Result |
  |---|---|---|
  | Email address | RFC-shaped `local@domain.tld`, word-boundary anchored | `[REDACTED-EMAIL]` |
  | US phone number | separator-formatted (`206-555-0100`, `(206) 555-0100`, `(206)555-0100`, `+1 206.555.0100`) | `[REDACTED-PHONE]` |
  | National-ID / US SSN | canonical hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Cardholder PAN | Luhn-validated 13–19-digit card shapes | masked to **BIN + last4** (`411111******1111`) |

  Every other value — and every non-matching response — passes through
  byte-identical. The policy never blocks a call: a legitimate query still
  succeeds, it just comes back with identifiers masked. A PAN is only masked
  after it passes the Luhn checksum, so ordinary long numbers (row counts,
  order IDs, epoch timestamps, join keys) are left intact.

  PANs are masked **first**, then SSN, phone, and email are redacted. The four
  classes are shape-disjoint — the PAN mask output (`411111******1111`) contains
  no hyphens, separators, or `@`, so no later step can re-match it; a hyphenated
  SSN (9 digits) and a separator-formatted phone (10 digits) are both too short
  for the 13–19-digit PAN shapes — so the order is safe either way.

  ### Group exemption

  Redaction is gated by IdP group. Callers whose `input.subject.claims.groups`
  contains `data-analysts` (a placeholder name — see Known limitations, matched
  **case-insensitively** so `Data-Analysts`/`DATA-ANALYSTS` also match) receive
  **unredacted, unmasked** responses. The check reads the groups claim via
  `object.get` chains and requires it to be an **array** of strings (a single
  bare string is also accepted): a missing subject, missing claims, missing
  `groups` claim, or a malformed `groups` shape (object, number, null) means the
  caller is *not* exempt and redaction applies. The grant fails closed — a
  caller whose claims fail to arrive gets over-redaction, never disclosure.

  ## Why egress

  The PII/PAN already lives in the warehouse behind the datasource — there is
  nothing to block at ingress, and denying `query-datasource` / `get-view-data`
  outright would make the agent useless for everyday analytics. The leak happens
  when the result set is returned to the MCP client, so the response path is the
  only place to catch it while keeping the result useful.

  ## Compliance alignment

  - **PCI DSS 3.4.1** — supports masking of PAN when displayed: the agent
    channel shows at most BIN+last4, with full-PAN visibility limited to the
    `data-analysts` role. **PCI DSS 3.4.2** — supports preventing PAN
    copy/relocation via remote-access technologies: an agent that only receives
    the masked PAN cannot re-post the full card number into other tools, tickets,
    or files. **PCI DSS 12.10.7** — a PAN returned from an unexpected warehouse
    column is a classic PAN-where-not-expected incident trigger, and the
    gateway's decision/transform audit events give the incident process a signal.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary, role-based
    limits: only the placeholder `data-analysts` group sees raw identifiers.
    **§164.514(a)–(b)** — supports de-identification by stripping Safe-Harbor
    identifier classes (SSN, email, phone) from responses. **§164.530(c)** —
    privacy safeguards on the agent read path.
  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in query results as
    they leave the gateway. **C1.1** — identification and protection of
    confidential information on the warehouse read path. **P4.1** — limiting
    personal-information use to identified purposes. **P6.1** — controls over
    personal-information disclosure to third parties (the agent).
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data.
    **Art. 9** — reduces special-category exposure where identifiers co-occur
    with health/HR columns. **Art. 5(1)(f) / Art. 32** — security of processing.
    **CCPA/CPRA §1798.121** — supports limiting use/disclosure of sensitive PI
    (SSN); **§1798.150** — reduces nonredacted-PI breach exposure.

  This family also aligns with **ISO/IEC 27001 A.8.11 (data masking)** and
  **A.8.12 (data leakage prevention)** on the MCP read path.

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to the data-returning
  Tableau web-server tools, matched case-insensitively **by suffix** on
  `input.resource.name` with `input.tool_metadata.name` as a fallback. The DTwo
  gateway prefixes tool names with the configured MCP server name (e.g.
  `tableau-query-datasource`), and that prefix is not standardized — suffix
  matching keeps the policy portable. All five names are **verified** from the
  landscape research (Tableau `tableau/tableau-mcp` source, v2.24.x):

  - **`-query-datasource`** — VizQL Data Service query → row-level data.
  - **`-get-view-data`** — CSV of a view's underlying data.
  - **`-get-custom-view-data`** — CSV of a custom view's underlying data.
  - **`-generate-pulse-insight-brief`** — Pulse KPI narrative brief.
  - **`-generate-pulse-metric-value-insight-bundle`** — Pulse metric-value insight bundle.

  The `-get-view-data` suffix does **not** collide with `-get-custom-view-data`
  (their tails differ: `...custom-view-data` never ends in `-get-view-data`), so
  each tool matches exactly one entry.

  Deliberately **out of scope:** `-get-view-image` / `-get-custom-view-image`
  return **PNG** renders that text redaction cannot parse — masking pixels is
  impossible, so those surfaces are denied at ingress by the companion
  `fence-datasource-scope` policy rather than handled here. Catalog/metadata
  tools (`list-datasources`, `get-view`, `search-content`) and admin-insights
  tools do not carry row-level warehouse data and are not in scope.

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each **string** block (including
  string blocks containing serialized JSON or CSV row data, since the regexes run
  over the serialized text). Non-string blocks pass through unmodified. When at
  least one block changes, the policy emits `transform.transformed_payload`
  containing the original payload with the rewritten `text` array (all other
  payload keys preserved). When nothing changes, no transform is emitted and the
  response passes through byte-identical.

  ## Examples

  ### Redacted + masked (in-scope tool, non-analyst caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "tableau-query-datasource", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["support"] } },
      "payload": {
        "name": "tableau-query-datasource",
        "text": ["cust 42,jane@acme.com,206-555-0100,4111 1111 1111 1111"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["cust 42,[REDACTED-EMAIL],[REDACTED-PHONE],411111******1111"]`.

  ### Passed through (exempt group)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "tableau-get-view-data", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["data-analysts"] } },
      "payload": {
        "name": "tableau-get-view-data",
        "text": ["cust 42,jane@acme.com,4111111111111111"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `data-analysts` group receives raw content.

  ## Composition

  One policy, one job. This transform-only policy (`default allow := true`)
  composes cleanly on the same egress pipeline as deny/transform companions for
  `apps/tableau`:

  - **`fence-datasource-scope` (ingress)** — denies `-get-view-image` /
    `-get-custom-view-image` for non-analyst groups (those PNG surfaces cannot be
    text-redacted) and enforces the per-group `datasourceLuid` allowlist on
    `-query-datasource`. This egress redaction and that ingress fence are the two
    halves of the same control; attach both.
  - A **`default-deny-unknown-tools` (PF-28) ingress allowlist** — the hosted
    `mcp.tableau.com` server ships new tools automatically as the inventory
    drifts forward, so a default-deny allowlist stops a newly-added (unredacted)
    result tool from silently reaching the agent.
  - A **`cap-bulk-export` (PF-08) ingress guard** that clamps the query `limit`,
    bounding the blast radius of any redaction miss.

  ## Known limitations

  - **Images are not covered here — by design.** `-get-view-image` /
    `-get-custom-view-image` return PNGs that carry the same data as pixels,
    invisible to text-based redaction. They must be denied at ingress
    (`fence-datasource-scope`); this policy cannot mask them.
  - **Luhn-valid non-card numbers are masked too.** The Luhn check eliminates
    most row counts, timestamps, and IDs, but some non-card identifiers (certain
    IMEIs and other checksummed numbers) are Luhn-valid and will be masked to
    BIN+last4. Such false positives usually stay recognizable.
  - **National-ID detection is US-SSN-shaped only.** Only the canonical
    hyphenated `XXX-XX-XXXX` form is matched; bare 9-digit runs collide with row
    IDs and are deliberately not matched, and non-US national-ID formats
    (NINO, SIN, Aadhaar, etc.) are not detected. Add patterns for your
    jurisdiction if needed.
  - **Word-boundary residuals (red-team).** SSN, phone, and PAN patterns are
    `\b`-anchored. A value with an extra digit or letter glued on with no
    delimiter escapes: `123-45-67890` (trailing digit), `id00123-45-6789`
    (leading digits), `206-555-01000` (phone trailing digit), and a PAN fused to
    a word character (`acct_4111111111111111`) all pass through. Loosening the
    anchors would emit partial redactions that still leak a digit, or partially
    mask long identifiers — a deliberate trade-off.
  - **Digit-glued PAN residual (red-team).** An unseparated PAN with an extra
    *digit* glued directly on — `41111111111111110` (trailing 0),
    `94111111111111111` (leading 9) — forms a 17-digit run that the `\d{13,19}`
    shape matches as a whole, fails the Luhn check on all 17 digits, and is
    therefore left unmasked, leaking the embedded card. This is the unseparated
    analogue of grouped shadowing: masking only the embedded 16-digit window
    would mean partially masking an arbitrary long identifier, which the
    length+Luhn gate deliberately avoids. A 20+-digit run still never matches
    (no internal `\b`), so only runs that land inside the 13–19 range are
    affected.
  - **Obfuscation residuals.** Values split across cells/lines/content blocks,
    dot- or space-separated SSNs (`123.45.6789`), PANs with separators other than
    space/dash, spelled-out numbers, base64, and full-width/Unicode digits are
    not caught (RE2 `\d` is ASCII-only). Adjacent grouped digit windows can
    shadow a grouped PAN (`1234 5678 4111 1111 1111 1111`); an unseparated PAN
    with an extra digit glued on is likewise shadowed (see the digit-glued PAN
    residual above). Treat this as a high-signal minimum-necessary layer, not a
    complete DLP solution.
  - **The email pattern can over-match connection strings.** A
    `user:password@host.example.com` substring in a returned DSN matches the
    email shape and is redacted — over-redaction (safe) on egress, never
    disclosure.
  - **Structured (non-string) content blocks and non-array `text` are not
    processed — fail-open.** The policy scans and rewrites only string entries of
    `input.payload.text`, and only when `text` is a JSON array. A PAN/PII value
    carried inside a native JSON *object* block, or a `payload.text` delivered as
    a bare string, passes through untouched. In the DTwo egress shape observed to
    date, tool output arrives as an array of *string* blocks and serialized JSON
    inside a string block **is** scanned; confirm your gateway delivers string
    blocks with the dump-input technique before relying on this.
  - **Official web server only — Tableau Next is not covered (red-team).** The
    five in-scope suffixes are all from the official `tableau/tableau-mcp` web
    server. The separate **Tableau Next** product (Salesforce-hosted,
    `analytics/tableau-next`) exposes disjoint **snake_case** tools —
    `analyze_data` returns a PII-laden natural-language answer over a semantic
    model, `list_dashboards`/`get_visualization`/etc. — none of which end in any
    in-scope suffix, so this policy emits no transform and their results reach the
    agent unredacted. A customer can plausibly run both products at once, so if
    your gateway fronts Tableau Next, attach a **separate** egress redaction
    policy scoped to those snake_case names (`-analyze_data`, `-get_visualization`,
    `-get_dashboard`); this policy will not protect them. Likewise the
    admin-insights tools (`query-admin-insights-ts-events`, `…-site-content`,
    `…-job-performance`) carry user-activity PII rather than warehouse rows and
    are intentionally left to the ingress admin-insights lockdown, not redacted
    here.
  - **Egress masking only.** The full PAN/PII still exists in the warehouse and
    the Tableau UI; this policy controls only what the *agent* sees on the MCP
    path.
  - **Group names are placeholders — replace `data-analysts` with your IdP's
    group name at import time.** The exemption reads `input.subject.claims.groups`
    and requires it to be an array of strings (a single bare string is also
    handled), and matches group names **case-insensitively** (`Data-Analysts`
    matches `data-analysts`) — which slightly widens the grant, so pick a
    placeholder that will not collide with another group under case folding;
    every other shape (object, number, null, missing) fails closed to
    redacted output. Never rely on stripped ContextForge-internal claims
    (`is_admin`, `teams`, `user`) for the exemption. Confirm your IdP emits a
    `groups` claim for your tenant before relying on the exemption.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - tableau
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package tableau.egress.redact_pii_query_results

# Transform-only egress policy: rewrites email, US phone, and hyphenated
# SSN/national-ID patterns to fixed redaction tokens and masks Luhn-valid
# cardholder PANs to BIN+last4 in the row/CSV/narrative content returned by the
# data-returning Tableau tools, before the response reaches the agent. Never
# denies — a legitimate query still succeeds, just with sensitive values masked.
# Callers in the placeholder `data-analysts` IdP group receive unredacted,
# unmasked responses; the group check fails closed, so a caller with missing or
# malformed claims gets over-redaction, never disclosure. Image tools
# (-get-view-image / -get-custom-view-image) are out of scope — PNG pixels
# cannot be text-redacted and are denied at ingress by fence-datasource-scope.
default allow := true

# -----------------------------------------------------------------------------
# Scope: the data-returning Tableau web-server tools. The gateway prefixes tool
# names with the configured MCP server name (not standardised), so we match by
# suffix, case-insensitively. All five suffixes are verified wire names from the
# Tableau tableau/tableau-mcp source. `-get-view-data` does not collide with
# `-get-custom-view-data` (their tails differ), so each tool matches exactly one.
# -----------------------------------------------------------------------------

pii_result_suffixes := {
    # VizQL Data Service query -> row-level data
    "-query-datasource",
    # CSV of a view's underlying data
    "-get-view-data",
    # CSV of a custom view's underlying data
    "-get-custom-view-data",
    # Pulse KPI narrative brief
    "-generate-pulse-insight-brief",
    # Pulse metric-value insight bundle
    "-generate-pulse-metric-value-insight-bundle",
}

is_pii_result_tool if {
    input.mode == "output"
    some suffix in pii_result_suffixes
    endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), suffix)
}

is_pii_result_tool if {
    # Egress hooks also expose the tool name under tool_metadata.name — check
    # both so we match regardless of which surface the gateway populates.
    input.mode == "output"
    some suffix in pii_result_suffixes
    meta := object.get(input, "tool_metadata", {})
    endswith(lower(object.get(meta, "name", "")), suffix)
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP group whose members receive unredacted
# responses. Replace "data-analysts" with your IdP's group name at import time.
# object.get chains + the is_array guard mean a missing subject/claims/groups
# claim, or a groups claim shaped as anything other than an array, is never
# exempt: the grant fails closed and redaction applies. A single bare-string
# groups claim is also accepted (some IdPs emit one group as a string).
# -----------------------------------------------------------------------------

exempt_groups := {"data-analysts"}

caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

is_exempt if {
    is_array(caller_groups)
    some g in caller_groups
    lower(g) in exempt_groups
}

is_exempt if {
    is_string(caller_groups)
    lower(caller_groups) in exempt_groups
}

# -----------------------------------------------------------------------------
# PII detection patterns — anchored and conservative to limit false positives on
# free-text warehouse columns.
# -----------------------------------------------------------------------------

# US SSN / national-ID in the canonical hyphenated form only. Bare 9-digit runs
# collide with row IDs and sequence values, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Email addresses, word-boundary anchored: local part, "@", domain, TLD of at
# least two letters. Conservative TLD class keeps it from firing on stray "@".
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone numbers (e.g. 206-555-0100, (206) 555-0100,
# (206)555-0100, +1 206.555.0100). Bare 10-digit runs are deliberately not
# matched. The separator after a parenthesized area code is optional (so
# `(206)555-0100` with no space still matches), but the bare `\b\d{3}` branch
# still requires a separator so an unformatted 10-digit run is not caught. The
# 3-3-4 grouping is disjoint from the SSN 3-2-4 grouping, so the two never collide.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)[-. ]?|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b`

# -----------------------------------------------------------------------------
# PAN candidate shapes — anchored with \b so digit runs inside longer
# identifiers are never partially matched. Every candidate must also pass the
# Luhn check below before it is masked.
# -----------------------------------------------------------------------------

pan_pattern := concat("|", [
    # 16-digit PANs grouped 4-4-4-4 with space or dash separators
    # (Visa / Mastercard / Discover print format, e.g. 4111 1111 1111 1111).
    `\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b`,
    # 15-digit American Express PANs grouped 4-6-5, 34/37 IIN (e.g. 3782 822463 10005).
    `\b3[47]\d{2}[ -]\d{6}[ -]\d{5}\b`,
    # Unseparated 13-19 digit runs — the ISO/IEC 7812 PAN length range. Runs of
    # 20+ digits never match: there is no word boundary inside a digit run, so
    # this cannot partially mask a longer identifier.
    `\b\d{13,19}\b`,
])

# -----------------------------------------------------------------------------
# Luhn check — filters card-shaped candidates so timestamps, order numbers, row
# counts, and other digit runs that merely look like PANs are left alone.
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

# Mask a PAN to BIN+last4: first six digits (issuer BIN) and last four kept,
# every digit between replaced with `*`; separators dropped.
mask_pan(c) := masked if {
    d := digits_only(c)
    n := count(d)
    masked := concat("", [
        substring(d, 0, 6),
        regex.replace(substring(d, 6, n - 10), `\d`, "*"),
        substring(d, n - 4, 4),
    ])
}

# Rewrite every Luhn-valid PAN in a string to its masked form; unchanged if none.
mask_pans(t) := out if {
    replacements := {c: mask_pan(c) | some c in pan_candidates(t)}
    count(replacements) > 0
    out := strings.replace_n(replacements, t)
}

mask_pans(t) := t if {
    count(pan_candidates(t)) == 0
}

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_phone(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

redact_email(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

# Order: PANs masked first (their masked form has no hyphen/separator/"@", so no
# later step re-matches it), then SSN (3-2-4), phones (3-3-4, disjoint from SSN),
# then emails (contain "@"). The redaction tokens contain no digits-with-
# separators or "@", so no step re-matches a token emitted by an earlier step.
redact_block(b) := redact_email(redact_phone(redact_ssn(mask_pans(b)))) if {
    is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, the caller is not exempt, and at least
# one block actually changed. Otherwise the rule is undefined and the aggregator
# skips this policy, returning the response byte-identical.
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
    is_pii_result_tool
    not is_exempt
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
