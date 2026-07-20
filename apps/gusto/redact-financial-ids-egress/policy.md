---
name: "Gusto: Redact Financial IDs in Responses"
tags:
  - gusto
  - redact-pii-egress
  - redact-pii
  - pii
  - financial-pii
  - dlp
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # gusto / redact-financial-ids-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `gusto.egress.redact_financial_ids`

  ## What it does

  Instantiates **PF-02 (redact-pii-egress)** on the Gusto read path. On the
  response path — for **every** Gusto tool, regardless of which read tool
  produced the output — it scans the returned text and rewrites the most
  regulated financial identifiers to a single fixed masked token before the
  response reaches the agent context:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN (employee tax ID) | canonical hyphenated `XXX-XX-XXXX` form | `[REDACTED-FINANCIAL-ID]` |
  | Bank account number | run of **8 or more** digits immediately preceded by an account label (`account`, `acct`, `a/c`, `bank`) | `[REDACTED-FINANCIAL-ID]` |
  | ABA routing number | run of **9 or more** digits immediately preceded by a routing label (`routing`, `aba`, `rtn`) | `[REDACTED-FINANCIAL-ID]` |

  Matched substrings are replaced in place — the surrounding record/row
  structure and every non-matching character (including the account/routing
  **label**) are left byte-identical, so the agent still gets a usable record
  with only the regulated identifiers masked. Redaction **replaces** the matched
  span with a masked token rather than dropping the field, so tax-locale and
  reconciliation answers that reference the surrounding record still work. This
  is a **transform-only** policy (`default allow := true`): it never denies a
  call. Responses with no matches pass through byte-identical, and every field
  is read via `object.get`, so a missing or oddly-shaped payload is never an
  error — it simply passes through.

  ## Why this is cheap insurance

  Gusto's **official** MCP server is read-only and, per its docs, does not expose
  bank-account/routing or full tax-ID fields. But community wrappers and
  aggregator servers (StackOne, MCPBundles' skill, coretext packages) surface
  pay stubs, company/contractor **bank accounts**, and federal/state tax detail
  the official server does not. Because this policy is **pattern-based and not
  tied to any tool's response schema**, it protects against those wider read
  surfaces without needing to know each tool's exact field names — it keeps
  working the moment a tenant swaps in a community/aggregator server that returns
  bank data.

  Gusto's own docs warn against mixing this server with other connectors in one
  session because of data-leakage risk. This egress guard reduces the blast
  radius of exactly that cross-connector exfiltration: even if the agent pulls a
  bank-account or SSN field and tries to leak it through another connector, the
  most regulated identifiers have already been stripped on the way out of Gusto.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct financial identifiers as they
    leave the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the payroll read path; **P4.1** — supports limiting
    personal-information use to identified purposes by keeping raw identifiers
    out of agent context that does not need them; **P6.1** — supports controls
    over personal-information disclosure by masking it before it reaches the
    agent channel.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on agent reads of personal
    financial data; **Art. 9** — reduces special-category exposure on the MCP
    path where financial identifiers co-occur with HR/payroll data;
    **Art. 5(1)(f) / Art. 32** — supports security of processing on the agent
    channel.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information; under CPRA, SSN and financial-account numbers
    are expressly sensitive PI. **§1798.150** — reduces nonredacted-PI breach
    exposure.

  ## Why egress

  The financial PII already lives in Gusto — there is nothing to block at
  ingress, and denying the read outright would make the agent useless for
  everyday payroll and reconciliation work. The leak happens when the record or
  result is returned to the MCP client, so the response path is the only place to
  catch it while keeping the result useful.

  ## Tool name matching (intentionally none)

  Unlike a tool-scoped redactor, this policy is **not** keyed to a set of tool
  names. It fires on the whole Gusto egress path — any `tool_post_invoke`
  response through the pipeline this policy is attached to. That is deliberate:
  the same regulated data ("employee SSN", "contractor bank account") comes back
  under *different* tool names across implementations — the official server uses
  bare `snake_case` (`get_gusto_employee`, `list_company_contractor_payments`),
  the `Savinda96` community server uses `kebab-case` (`get-employee`), and
  StackOne uses unified `hris_*`-style action IDs. A name-list would silently
  miss whichever implementation a tenant actually wires in. Scanning every
  response instead means the guard does not depend on knowing each tool's exact
  name or response schema.

  Egress scope is detected on **any** of the three signals the gateway may
  populate — `input.mode == "output"`, the PARC `input.action ==
  "tool_post_invoke"`, or the legacy `input.kind == "tool_post_invoke"`. Keying
  on only one fails open (redaction no-ops) on a build that populates a different
  one — an older gateway near the minimum version may emit only the legacy
  `kind`. Ingress calls (`tool_pre_invoke` / mode `"input"`) satisfy no branch,
  so the transform never fires on the request path.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each **string** block (including
  string blocks that carry serialized JSON record data, since the regexes run
  over the serialized text). Non-string (structured) blocks pass through
  unmodified. When at least one block changes, the policy emits
  `transform.transformed_payload` containing the original payload with the
  rewritten `text` array (all other payload keys preserved). When nothing
  changes, no transform is emitted and the response passes through byte-identical.

  ## Examples

  ### Redacted (employee read, canonical SSN)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "gusto-get_gusto_employee", "type": "tool" },
      "payload": {
        "name": "gusto-get_gusto_employee",
        "text": ["employee 214 | ssn 123-45-6789 | dept payroll"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["employee 214 | ssn [REDACTED-FINANCIAL-ID] | dept payroll"]`.

  ### Redacted (contractor bank read from a community server)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "gusto-community-get-contractor-bank", "type": "tool" },
      "payload": {
        "name": "gusto-community-get-contractor-bank",
        "text": ["contractor Acme | account number: 000123456789 | routing 021000021"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["contractor Acme | account number: [REDACTED-FINANCIAL-ID] | routing [REDACTED-FINANCIAL-ID]"]`
  (the `account` / `routing` labels are preserved; only the numbers are masked).

  ### Passed through (clean response)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "gusto-list_company_departments", "type": "tool" },
      "payload": {
        "name": "gusto-list_company_departments",
        "text": ["Engineering, Sales, Support"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — nothing matched.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with the deny/transform policies on the same Gusto pipeline. It is designed to
  sit **behind two ingress fences** so that data blocked at request time cannot
  leak, and data that is still returned is stripped of the most regulated
  identifiers:

  - **A compensation/payroll-read fence (ingress deny)** — blocks
    compensation/payroll reads for callers outside the payroll-admin IdP group,
    so the sensitive data ideally never leaves Gusto; this egress redaction is
    the backstop for identifiers that still come back through allowed reads.
  - **A roster-export cap (ingress transform)** — clamps `per` and strips
    `include=custom_fields` on the broad `list_*` tools, so a caller can't pull
    the whole roster in one call and dilute the value of per-record masking.

  Because egress transforms compose sequentially in pipeline-attachment order,
  mind the ordering if another egress transform (e.g. a home-address redactor)
  runs on the same pipeline. The fixed token contains no digits and no
  account/routing label word, so no later redaction step can re-match a token
  this policy emitted.

  ## Known limitations

  - **Operates on serialized response text — deeply nested or encoded fields are
    a residual.** The regexes run over the string content blocks of
    `input.payload.text`. Values that are base64/hex-encoded, split across
    separate content blocks or JSON cells, or buried in a structured non-string
    block are **not** decoded and so are not caught. Treat this as a high-signal
    minimum-necessary layer, not a complete DLP solution; pair it with the
    ingress compensation-read fence that stops the sensitive read in the first
    place.
  - **SSN detection is canonical-form only.** SSN is matched in the hyphenated
    `XXX-XX-XXXX` form. Bare 9-digit runs are deliberately **not** matched — they
    collide with amounts-in-cents, sequence numbers, and other ordinary figures a
    payroll response carries, which would fire constant false positives. The
    separator is a literal ASCII hyphen: dot-, space-, tab-, or
    **non-ASCII-hyphen**-separated forms (`123.45.6789`, `123 45 6789`, and a
    U+2011 non-breaking hyphen `123‑45‑6789`) and full-width/
    unicode-digit forms are not matched either. The pattern is
    **word-boundary anchored**, so any word character — a digit *or a letter* —
    fused to either end (`123-45-67890`, `4123-45-6789`, `ref123-45-6789`, and a
    *trailing* letter `123-45-6789ref`) breaks
    the boundary and the value passes through unmasked — deliberate, to keep the
    pattern from matching inside longer numeric IDs, but it means an identifier
    stored padded with an adjacent word character evades this class (a padded
    value is also corrupted, limiting its usefulness; and at egress the upstream
    response text, not the agent, controls this formatting). The ingress
    compensation-read fence is the backstop.
  - **Bank/routing detection is label-anchored.** A bank account or routing
    number is only masked when an account label (`account`, `acct`, `a/c`,
    `bank`) or routing label (`routing`, `aba`, `rtn`) appears within 12
    non-digit characters — **on the same line** — before the digit run. The
    connector character class excludes newlines, so a label printed on its own
    line *above* its value (as in pretty-printed JSON or a multi-line record,
    e.g. `account:\n12345678`) is **not** anchored and the number passes through
    unmasked — a residual fail-open on multi-line output; pair with the ingress
    compensation-read fence. This is deliberately conservative:
    an unlabelled bare digit run is indistinguishable from an amount, internal
    ID, or date and is left intact. The 8-digit floor (account) / 9-digit floor
    (routing) also applies to **labelled** runs, so a labelled number shorter than
    the floor passes through unmasked. The label's **start** must sit on a word
    boundary (the `\b` precedes the label), but there is **no** boundary anchor
    after the label. So a word that merely *ends with* or *contains* a label word
    is not anchored and passes through (`subaccount 12345678`, `mybank 12345678`),
    but a word that *begins* with a label word at a boundary **does** match on the
    label prefix and is masked (`bankaccount 12345678` → the `bank` prefix
    anchors, so it is over-masked — safe on egress, never disclosure). The label
    may also sit directly against the digits with no separator (`account12345678`)
    and is still masked (the connector group matches zero characters); this is why
    a trailing `\b` after the label is deliberately omitted — it would fail open on
    that no-separator form. The digit run
    must be **contiguous**: a number printed with internal spaces or hyphens
    (`account 1234 5678 9012`) has no single run reaching the floor and passes
    through. The digit run has **no upper length bound** (greedy `\d{8,}` /
    `\d{9,}`, no trailing word-boundary anchor), so a long labelled run is masked
    in full rather than failing open on over-length runs. The flip side of the
    label anchor is a residual **over-redaction** — an unrelated digit run that
    happens to follow one of those label words (e.g. `account balance is
    12345678`) is masked. On egress this is safe (over-masking, never
    disclosure) but can obscure legitimate figures.
  - **Applies to every tool on the attached pipeline.** By design there is no
    tool-name allowlist, so this must be attached to the **Gusto** egress
    pipeline only. Attaching it to a mixed pipeline would run the same
    financial-ID redaction over unrelated servers' responses (safe, but likely
    unintended over-masking).
  - **No identity-based exemption.** Every caller receives the same redaction;
    there is no `groups`-claim break-glass. If you need a payroll-admin group to
    read raw values, add an `is_exempt` branch reading
    `input.subject.claims.groups` via `object.get` chains (failing closed), as in
    the QuickBooks/Snowflake `redact-pii-egress` model. Group names would be
    placeholders — replace them with your IdP's group name at import time. Never
    rely on stripped ContextForge-internal claims (`is_admin`, `teams`, `user`)
    for such a check.
  - **Tool names in the examples are illustrative.** The gateway prepends the
    configured MCP server-name prefix (e.g. `gusto-`), which is not standardised;
    since this policy does not match on tool names, the prefix does not affect it,
    but verify with the dump-input debug technique that responses arrive on the
    egress path as expected. The official Gusto tool names are verified in the
    landscape note; community/aggregator names (`kebab-case`, `hris_*`) are
    **unverified** and are precisely why this guard scans all responses rather
    than a name list.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input technique
    before production, and mind attachment order if other egress transforms run
    on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - gusto
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gusto.egress.redact_financial_ids

# Transform-only egress policy: rewrites the most regulated financial identifiers
# (US SSN, and label-anchored bank account / ABA routing numbers) in EVERY Gusto
# tool response to a single fixed masked token before the response reaches the
# agent. Never denies — a legitimate read still succeeds, just with financial IDs
# masked. Instantiates PF-02 on the Gusto read path. It is intentionally NOT
# scoped to a tool-name list: the same data comes back under different tool names
# across the official / community / aggregator servers, so scanning all responses
# is the robust posture (see the policy description).
default allow := true

# Fixed masked token. Contains no digits and no account/routing label word, so no
# redaction step can re-match a token emitted by an earlier step — the chain
# order below is therefore safe.
mask_token := "[REDACTED-FINANCIAL-ID]"

# -----------------------------------------------------------------------------
# Egress scope. Match the post-invoke/output path on ANY of the three egress
# signals the gateway may populate — mode ("output"), the PARC action, or the
# legacy `kind` alias. Keying on only a subset fails open (redaction no-ops,
# leaking PII) on a build that populates a different one: an older gateway near
# the minimum version may emit only the legacy `kind` while leaving `action`/
# `mode` unset. Ingress (tool_pre_invoke / mode "input") satisfies no branch.
# -----------------------------------------------------------------------------

is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

is_egress if { input.kind == "tool_post_invoke" }

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives on the
# many ordinary numbers a payroll response carries (amounts, hours, rates, IDs).
# -----------------------------------------------------------------------------

# US SSN (employee tax ID) in the canonical hyphenated 3-2-4 form only. Bare
# 9-digit runs are NOT matched — they collide with amounts-in-cents, sequence
# numbers, and other ordinary figures. Word-boundary anchored so a digit fused to
# either end does not match inside a longer numeric run.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Bank account number: a run of 8-or-more digits immediately preceded by an
# account label (within 12 non-digit chars). Label-anchored so a bare digit run
# (amount, internal ID, date) is never masked. Greedy \d{8,} with no trailing
# word boundary so a long account run is masked in full (a trailing \b can never
# sit inside an all-digit run and would fail open on over-length runs). Capture
# groups $1 (label) and $2 (connector) are preserved in the replacement; only the
# numeric run is masked.
bank_pattern := `(?i)\b(account|acct|a/c|bank)([^0-9\n]{0,12})(\d{8,})`

# ABA routing number: a run of 9-or-more digits immediately preceded by a routing
# label. US routing numbers are exactly 9 digits; \d{9,} masks the full run (and
# any longer malformed run) rather than failing open on it. Same label-anchor and
# group-preservation semantics as the bank pattern.
routing_pattern := `(?i)\b(routing|aba|rtn)([^0-9\n]{0,12})(\d{9,})`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class does not apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_ssn(t) := regex.replace(t, ssn_pattern, mask_token)

# Preserve the account label ($1) and the connector ($2); mask only the numeric run.
redact_bank(t) := regex.replace(t, bank_pattern, sprintf("$1$2%s", [mask_token]))

# Preserve the routing label ($1) and the connector ($2); mask only the numeric run.
redact_routing(t) := regex.replace(t, routing_pattern, sprintf("$1$2%s", [mask_token]))

# Order: SSN (hyphenated, disjoint from the bank/routing digit runs) then the
# label-anchored bank then routing patterns. The mask token contains no digits and
# no label words, so no later step can re-match an earlier step's token.
redact_block(b) := redact_routing(redact_bank(redact_ssn(b))) if {
    is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if {
    not is_string(b)
}

# -----------------------------------------------------------------------------
# Transform — emitted only on the egress path when at least one block actually
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
    is_egress
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
