---
name: "NetSuite: Redact Financial PII in Responses"
tags:
  - netsuite
  - redact-pii
  - pii
  - financial-pii
  - dlp
  - redaction
  - egress
  - gdpr-ccpa
  - soc2
publishedAt: 2026-07-12
description: |
  # netsuite / redact-financial-pii

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `netsuite.egress.redact_financial_pii`

  ## What it does

  Instantiates **PF-02 (redact-pii-egress)** on the NetSuite read path. It scans
  the response text returned by the record- and query-reading NetSuite MCP tools
  and rewrites financial-PII patterns to a single fixed masked token before the
  response reaches the agent context:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN / ITIN | canonical hyphenated `XXX-XX-XXXX` form | `[REDACTED-FINANCIAL-PII]` |
  | US TIN / EIN | canonical hyphenated `XX-XXXXXXX` form | `[REDACTED-FINANCIAL-PII]` |
  | IBAN | contiguous `CC` + 2 check digits + 11–30 alphanumerics, upper-case | `[REDACTED-FINANCIAL-PII]` |
  | Bank account / routing number | run of **8 or more** digits **immediately preceded by an account/routing label** (`account`, `acct`, `a/c`, `routing`, `aba`, `rtn`) | `[REDACTED-FINANCIAL-PII]` |

  Matched substrings are replaced in place; the surrounding row/record structure
  and every non-matching character are left byte-identical, so the agent still
  gets a usable record or query result with only the financial-PII values masked.
  This is a **transform-only** policy (`default allow := true`): it never denies a
  call, so a legitimate `ns_getRecord` / SuiteQL / saved-search read still
  succeeds — it just comes back with SSN/TIN, IBAN, and labelled bank/routing
  numbers masked. Responses with no matches (and every out-of-scope tool) pass
  through byte-identical. Every response field is read via `object.get`, so a
  missing or oddly-shaped payload is never an error — it simply passes through.

  **Why bank account numbers rather than card PANs.** NetSuite tokenizes card
  numbers, so full-PAN exposure through the MCP surface is unlikely; the
  realistic financial-PII payload on vendor / customer / employee master records
  is bank account and routing numbers. Cardholder-PAN masking (Luhn-validated,
  PF-01) is therefore intentionally **not** attempted here — see Composition and
  Known limitations.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct financial identifiers in record
    and query results as they leave the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the ERP read path; **P4.1** — supports limiting
    personal-information use to identified purposes; **P6.1** — supports controls
    over personal-information disclosure by keeping raw financial identifiers out
    of agent context that does not need them.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on agent reads of personal
    financial data; **Art. 9** — reduces special-category exposure on the MCP
    path where financial identifiers co-occur with HR/payroll columns;
    **Art. 5(1)(f) / Art. 32** — supports security of processing on the agent
    channel.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, financial-account numbers) on the agent
    channel; **§1798.150** — reduces nonredacted-PI breach exposure.

  ## Why egress

  The financial PII already lives in NetSuite — there is nothing to block at
  ingress, and denying the read outright would make the agent useless for
  everyday finance work. The leak happens when the record or result set is
  returned to the MCP client, so the response path is the only place to catch it
  while keeping the result useful. Ingress SuiteQL/HR fencing and vendor-banking
  guards are separate concerns handled by companion policies (see Composition);
  this policy composes with them rather than replacing them.

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to the three
  content-returning NetSuite read tools, matched case-insensitively **by suffix**
  from `input.resource.name` with `input.tool_metadata.name` as a fallback:

  - `ns_getRecord`
  - `ns_runCustomSuiteQL`
  - `ns_runSavedSearch`

  These are **verified** tool names from Oracle's official MCP Standard Tools
  SuiteApp (the same `ns_*` names are proxied by the community
  `dsvantien/netsuite-mcp-server`, so one policy covers both). Suffix matching
  keeps the policy portable across the gateway's server-name prefix (which is not
  standardised — the DTwo gateway prepends the configured MCP server name, e.g.
  `netsuite-ns_getRecord`). Verify the exact names your gateway emits with the
  dump-input debug technique before relying on this in production.

  Other NetSuite read tools that can surface the same data (`ns_runReport`,
  `ns_getRecordTypeMetadata`) and the ChatFin / glints community servers use
  different naming conventions (`get-*`, `netsuite_*`); they are intentionally
  **out of scope** here — add their suffixes to `financial_pii_read_suffixes` if
  your deployment exposes them.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each string block (including
  string blocks that carry serialized JSON record data, since the regexes run
  over the serialized text). Non-string blocks pass through unmodified. When at
  least one block changes, the policy emits `transform.transformed_payload`
  containing the original payload with the rewritten `text` array (all other
  payload keys preserved). When nothing changes, no transform is emitted and the
  response passes through byte-identical.

  ## Examples

  ### Redacted (in-scope tool, SSN on an employee record)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "netsuite-ns_getRecord", "type": "tool" },
      "payload": {
        "name": "netsuite-ns_getRecord",
        "text": ["employee 214 | ssn 123-45-6789 | dept payroll"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["employee 214 | ssn [REDACTED-FINANCIAL-PII] | dept payroll"]`.

  ### Redacted (SuiteQL result with a labelled bank account + routing number)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "netsuite-ns_runCustomSuiteQL", "type": "tool" },
      "payload": {
        "name": "netsuite-ns_runCustomSuiteQL",
        "text": ["vendor Acme | account number: 000123456789 | routing 021000021"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["vendor Acme | account number: [REDACTED-FINANCIAL-PII] | routing [REDACTED-FINANCIAL-PII]"]`
  (the `account` / `routing` labels are preserved; only the numbers are masked).

  ### Passed through (out-of-scope tool)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "netsuite-ns_createRecord", "type": "tool" },
      "payload": {
        "name": "netsuite-ns_createRecord",
        "text": ["created employee 214 with ssn 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the policy only fires on the three
  content-returning read tools.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with the deny/transform policies on the same NetSuite pipeline. Recommended
  companions in `apps/netsuite`:

  - **`fence-hr-payroll-suiteql` (ingress deny)** — blocks SuiteQL/saved-search
    reads over HR/payroll tables so the sensitive data ideally never leaves
    NetSuite; this egress redaction is the backstop for the financial-PII that
    still comes back through allowed reads.
  - **`guard-vendor-banking` (ingress deny)** — the anti-BEC control on
    `ns_updateRecord` vendor banking edits (a write-path concern this read-path
    policy does not touch).
  - **`default-deny-unknown-tools` (ingress allowlist)** — on the
    `/services/mcp/v1/all` endpoint, custom SuiteScript tools have arbitrary
    developer-chosen names; a default-deny allowlist stops a newly-added
    (unredacted) read tool from silently reaching the agent.
  - A **cardholder-PAN masking policy (PF-01)** if your account stores raw PANs
    outside NetSuite's tokenization — PAN detection/Luhn masking is intentionally
    left to that companion and is not handled here.

  Because egress transforms compose sequentially in pipeline-attachment order,
  mind the ordering if another egress transform runs on the same pipeline.

  ## Known limitations

  - **Operates on serialized response text — deeply nested or encoded fields are
    a residual.** The regexes run over the string content blocks of
    `input.payload.text`. Values that are base64/hex-encoded, split across
    separate content blocks or JSON cells, or buried in a structured non-string
    block are **not** decoded and so are not caught. Treat this as a high-signal
    minimum-necessary layer, not a complete DLP solution; pair it with the
    ingress HR/SuiteQL fences that stop the sensitive query in the first place.
  - **SSN/TIN detection is canonical-form only.** SSN/ITIN is matched in the
    hyphenated `XXX-XX-XXXX` form and EIN/TIN in the `XX-XXXXXXX` form. Bare
    9-digit runs are deliberately **not** matched — they collide with NetSuite
    internal IDs, transaction numbers, and sequence values, which would fire
    constant false positives. Dot- or space-separated forms (`123.45.6789`,
    `123 45 6789`) and full-width/unicode-digit forms are not matched either.
    Both patterns are **word-boundary anchored**, so an extra digit or letter
    fused to either end (`123-45-67890`, `X12-3456789`) breaks the boundary and
    the value passes through unmasked — deliberate, to keep the pattern from
    matching inside longer numeric IDs, but it means an adversary who pads the
    identifier with an adjacent character evades this class (the padded value is
    also corrupted, limiting its usefulness). The label-anchored bank rule and
    the ingress SuiteQL/HR fences are the backstop.
  - **Bank/routing detection is label-anchored.** A bank account or routing
    number is only masked when an account/routing label (`account`, `acct`,
    `a/c`, `routing`, `aba`, `rtn`) appears within 12 non-digit characters before
    a run of 8 or more digits. This is deliberately conservative: an unlabelled
    bare digit run is indistinguishable from an order total, internal ID, or date
    and is left intact. The 8-digit floor also applies to **labelled** runs, so a
    labelled account/routing number **shorter than 8 digits** (`account 1234567`)
    passes through unmasked even though the label makes its intent clear — the
    floor is uniform to keep the pattern simple and avoid masking short
    labelled figures (line items, short internal IDs). US routing numbers are 9
    digits and most bank account numbers are 8+, so the common case is covered;
    the short-account gap is a residual backstopped by the ingress HR/SuiteQL
    fences. Lower `\d{8,}` to `\d{6,}` if your account stores short account
    numbers. The digit run has **no upper length bound** — an earlier
    `\d{8,17}` form silently leaked any labelled run longer than 17 digits (the
    trailing word-boundary anchor could never sit inside an all-digit run, so the
    whole match failed open); the pattern now uses a greedy `\d{8,}` so a long
    labelled account/routing number is masked in full. The label must still sit
    on a **word boundary** immediately before the number, so a label fused into a
    longer word (`bankaccount 12345678`) is not anchored and passes through.
    Likewise the digit run must be **contiguous**: an account or routing number
    printed with internal spaces or hyphens (`account 1234-5678-9012`,
    `acct 1234 5678 9012`) has no single run of 8+ digits — each grouped segment
    falls under the threshold — so the value passes through unmasked (the same
    grouping residual noted for IBANs below). Contiguous runs are the common case
    from `ns_getRecord` / SuiteQL columns; grouped display strings in free-text
    notes are the residual, backstopped by the ingress HR/SuiteQL fences. The
    flip side of the label anchor is a residual **over-redaction** — an unrelated
    run of 8+ digits that happens to follow one of those label words within 12
    characters (e.g. `account balance is 12345678`) is masked. On egress this is
    safe (over-masking, never disclosure) but can obscure legitimate figures;
    tune `bank_pattern` if your results routinely place amounts next to those
    labels.
  - **IBAN detection is contiguous and upper-case only.** The IBAN pattern
    matches a contiguous upper-case `CC` + 2 check digits + 11–30 alphanumerics.
    Space-grouped IBANs (`GB29 NWBK 6016 …`) and lower-case IBANs are not
    matched, and a long upper-case alphanumeric token that happens to start with
    two letters and two digits can be over-redacted. Both are conservative
    trade-offs on the response path.
  - **Tool coverage is the three verified `ns_*` read tools only.**
    `ns_runReport`, metadata tools, and the ChatFin (`get-*`) / glints
    (`netsuite_*`) community servers use different names and are out of scope;
    add their suffixes to `financial_pii_read_suffixes`. Custom SuiteScript tools
    on `/services/mcp/v1/all` have unknowable names — rely on the companion
    `default-deny-unknown-tools` allowlist, not on this policy, to contain them.
  - **No identity-based exemption.** Every caller receives the same redaction;
    there is no `groups`-claim break-glass. If you need a finance/controller
    group to read raw values, add an `is_exempt` branch reading
    `input.subject.claims.groups` (via `object.get` chains, failing closed) as in
    the Snowflake `redact-pii-egress` model. Never rely on stripped
    ContextForge-internal claims (`is_admin`, `teams`, `user`) for such a check.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input technique
    before production, and mind attachment order if other egress transforms run
    on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - netsuite
industries: []
bundles:
  - gdpr-ccpa
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package netsuite.egress.redact_financial_pii

# Transform-only egress policy: rewrites financial-PII patterns (US SSN/ITIN,
# US TIN/EIN, IBAN, and label-anchored bank account/routing numbers) in the
# responses of NetSuite's record- and query-reading MCP tools to a single fixed
# masked token before the response reaches the agent. Never denies — a legitimate
# read still succeeds, just with financial identifiers masked. Instantiates PF-02
# on the NetSuite read path. Cardholder-PAN masking is left to a companion PF-01
# policy (NetSuite tokenizes PANs, so bank account numbers are the realistic
# payload).
default allow := true

# Fixed masked token. Contains no digits, no "@", and no account/routing label
# word, so no redaction step can re-match a token emitted by an earlier step —
# the chain order below is therefore safe.
mask_token := "[REDACTED-FINANCIAL-PII]"

# -----------------------------------------------------------------------------
# Scope: the three VERIFIED content-returning NetSuite read tools (Oracle's
# official MCP Standard Tools SuiteApp; the dsvantien community server proxies
# the same ns_* names). The gateway prefixes tool names with the configured MCP
# server name (not standardised), so we match by suffix, case-insensitively.
# ns_runReport, metadata tools, and the ChatFin/glints community servers use
# different names and are intentionally out of scope — see Known limitations.
# -----------------------------------------------------------------------------

financial_pii_read_suffixes := {
    "ns_getrecord",
    "ns_runcustomsuiteql",
    "ns_runsavedsearch",
}

is_financial_pii_read_tool if {
    input.mode == "output"
    some suffix in financial_pii_read_suffixes
    endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), suffix)
}

is_financial_pii_read_tool if {
    # Egress hooks also expose the tool name under tool_metadata.name — check
    # both so we match regardless of which surface the gateway populates.
    input.mode == "output"
    some suffix in financial_pii_read_suffixes
    meta := object.get(input, "tool_metadata", {})
    endswith(lower(object.get(meta, "name", "")), suffix)
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives on
# free-text and numeric ERP columns.
# -----------------------------------------------------------------------------

# US SSN / ITIN in the canonical hyphenated 3-2-4 form only. Bare 9-digit runs
# collide with NetSuite internal IDs and sequence values, so they are not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# US TIN / EIN in the canonical hyphenated 2-7 form. Disjoint from the SSN 3-2-4
# shape, so the two patterns never fight over the same substring.
ein_pattern := `\b\d{2}-\d{7}\b`

# IBAN: contiguous upper-case country code (2 letters) + 2 check digits + 11-30
# alphanumerics (total 15-34 chars). Space-grouped and lower-case IBANs are not
# matched — conservative on the response path.
iban_pattern := `\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`

# Bank account / routing number: a run of 8-or-more digits immediately preceded
# by an account/routing label with at most 12 non-digit, non-newline characters
# between the label and the number. Label-anchored so a bare digit run (order
# total, internal ID, date) is not masked. The digit run has NO upper bound and
# no trailing word-boundary anchor: an earlier `\d{8,17}\b` form silently LEAKED
# any labelled run longer than 17 digits (the trailing `\b` can never sit inside
# an all-digit run, so the whole match failed and the number passed through). A
# greedy `\d{8,}` masks the full run instead. Capture groups $1 (label) and $2
# (connector) are preserved in the replacement; only the number is masked.
bank_pattern := `(?i)\b(account|acct|a/c|routing|aba|rtn)([^0-9\n]{0,12})(\d{8,})`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class does not apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_ssn(t) := regex.replace(t, ssn_pattern, mask_token)

redact_ein(t) := regex.replace(t, ein_pattern, mask_token)

redact_iban(t) := regex.replace(t, iban_pattern, mask_token)

# Preserve the account/routing label ($1) and the connector ($2); mask only the
# numeric run.
redact_bank(t) := regex.replace(t, bank_pattern, sprintf("$1$2%s", [mask_token]))

# Order: SSN (3-2-4) then EIN (2-7, disjoint) then IBAN (letters+digits) then the
# label-anchored bank/routing number. IBAN runs before the bank step so a labelled
# IBAN is masked as an IBAN rather than being partially consumed by the bank
# pattern. The mask token contains no digits/"@"/label words, so no later step
# can re-match an earlier step's token.
redact_block(b) := redact_bank(redact_iban(redact_ein(redact_ssn(b)))) if {
    is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if {
    not is_string(b)
}

# -----------------------------------------------------------------------------
# Transform — emitted only when the tool is in scope and at least one block
# actually changed. Otherwise the rule is undefined and the aggregator skips this
# policy, returning the response byte-identical.
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
    is_financial_pii_read_tool
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
