---
name: "Docusign: Redact SSN, Bank & Card Values on Egress"
tags:
  - docusign
  - redact-pii
  - tab-values
  - pii
  - phi
  - pan
  - dlp
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # docusign / redact-tab-values-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `docusign.egress.redact_tab_values`

  ## What it does

  Scans the responses of Docusign envelope- and agreement-reading tools and
  rewrites high-confidence regulated identifiers before the response reaches
  the agent's context:

  | Class | Detection | Result |
  |---|---|---|
  | US SSN | hyphenated `XXX-XX-XXXX` anywhere; label-anchored bare 9 digits (`SSN: 123456789`, `Social Security Number 123456789`); Docusign tab JSON (`"tabLabel":"SSN","value":"123456789"`) | `[REDACTED-SSN]` (labels preserved) |
  | US bank routing number | label-anchored plain text (`routing`/`ABA` + 9 digits) or tab JSON (label containing `routing`/`aba` + `"value"`); only when paired with an account number in the same block | `[REDACTED-BANK-ROUTING]` |
  | US bank account number | label-anchored plain text (`account`/`acct` + 6–17 digits) or tab JSON (label containing `account`/`acct` + `"value"`); only when paired with a routing number in the same block | `[REDACTED-BANK-ACCOUNT]` |
  | Payment card PAN | 16-digit 4×4 groups, **Luhn-validated** in Rego | masked to **BIN + last 4** (e.g. `411111******1111`), per PCI DSS 3.4.1 |

  Matches are replaced in place, leaving the surrounding JSON/text structure
  intact so envelope status, recipient routing, and agreement metadata remain
  usable. The policy is transform-only: it never denies a call, and responses
  with no matches (and all out-of-scope tools) pass through byte-identical.

  `listRecipients` egresses **filled recipient tab values** (form-field data)
  and `getAgreementDetails` egresses **Navigator AI-extracted contract terms**
  — both routinely carry the SSN and bank-account tabs used in HR and
  healthcare signing flows (I-9s, direct-deposit authorizations, patient
  intake). Masking on egress enforces minimum-necessary and data-minimisation
  on the read path without blocking legitimate status lookups.

  ### Group exemption

  Callers whose IdP `groups` claim contains `hr` or `finance` (placeholder
  names — see Known limitations) receive **unredacted** responses. The check
  reads `input.subject.claims.groups` via `object.get` chains: a missing
  subject, missing claims, or missing `groups` claim means the caller is *not*
  exempt and redaction applies — the grant fails closed.

  ## Compliance alignment

  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based access to PHI-bearing envelope data: only placeholder
    `hr`/`finance` group members see raw identifiers; everyone else gets
    working envelope data with identifiers masked. **§164.514(a)–(b)** —
    supports de-identification practice by stripping Safe-Harbor identifier
    classes (SSN, account numbers) from responses; **§164.530(c)** — privacy
    safeguards on the agent read path.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health content in signing flows; **Art.
    5(1)(f)/32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, financial account numbers) on the
    agent channel; **§1798.150** — reduces nonredacted-PI breach exposure.
  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in envelope data as
    it leaves the gateway toward the agent; **C1.1** / **P4.1** — supports
    identification/protection of confidential information and limiting PI use
    to identified purposes.
  - **PCI DSS 3.4.1** — supports PAN masking on display: card numbers found in
    tab values are masked to BIN (first six) + last four, the maximum PCI DSS
    permits for personnel without a documented business need for full PAN.

  ## Why egress

  The identifiers already live in completed envelopes — there is nothing to
  block at ingress, and denying envelope reads outright would break the
  status-lookup and agreement-summary flows agents legitimately need. The leak
  happens when tab values and extracted provisions are returned to the MCP
  client, so the response path is the only place to catch it while keeping the
  data useful.

  ## Tool name matching

  Applies on the output path — scoped when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a
  gateway build that populates only one of the two (keying on `mode` alone
  would fail open if it were unset). The tool name is read from all three
  egress surfaces — `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — and a hit on **any** of them puts the call in scope.
  Matching is case-insensitive:

  - `*getEnvelope*` — **contains** match, covering both `getEnvelope` (single
    envelope, incl. tab metadata) and `getEnvelopes` (status search) from the
    official Docusign MCP Server (names verified against the official tool
    catalog).
  - `*listRecipients` — suffix match; official server (verified). The tool
    that egresses filled tab values.
  - `*getAgreementDetails` / `*getAllAgreements` — suffix match; official
    server, Navigator AI-extracted agreement terms (verified). Both the
    single-agreement detail read and the list variant egress extracted
    provisions and party data, so both are in scope.
  - `*download_envelope_document` — suffix match; **community**
    luthersystems/mcp-server-docusign (name verified from source). The
    official production catalog has **no** document-download tool, so
    whole-document coverage applies only to community servers that expose one
    — and see Known limitations: its base64 payload largely evades regex
    scanning.

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `docusign-mcp-listRecipients`), and that prefix is not standardized —
  suffix/contains matching keeps the policy portable. Verify the exact names
  your gateway emits with the dump-input debug technique before relying on
  this in production.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each string block.
  Official-server responses mirror the mapped eSignature/Navigator REST bodies
  serialized as JSON (recipient `tabs` arrays such as `ssnTabs` carry
  `tabLabel`/`value` pairs); the JSON-aware patterns above target the
  `"tabLabel":"…","value":"…"` shape directly, and the plain-text patterns
  catch identifiers in extracted provisions and free-text summaries.
  Non-string blocks pass through unmodified. When at least one block changes,
  the policy emits `transform.transformed_payload` containing the original
  payload with the rewritten `text` array (all other payload keys preserved).

  ## Examples

  ### Redacted (tab values, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "docusign-mcp-listRecipients", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["legal"] } },
      "payload": {
        "name": "docusign-mcp-listRecipients",
        "text": ["{\"tabLabel\":\"SSN\",\"value\":\"123456789\"} card 4111 1111 1111 1111"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["{\"tabLabel\":\"SSN\",\"value\":\"[REDACTED-SSN]\"} card 411111******1111"]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "docusign-mcp-listRecipients", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["hr"] } },
      "payload": {
        "name": "docusign-mcp-listRecipients",
        "text": ["{\"tabLabel\":\"SSN\",\"value\":\"123456789\"}"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `hr` group receives raw tab values.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes
  cleanly with deny policies on the same egress pipeline. Recommended
  companions in `apps/docusign`:

  - A **group-gated egress deny** on `*download_envelope_document`
    (community servers) — base64-encoded PDFs are the single largest data-out
    channel here and largely evade pattern scanning (see Known limitations),
    so denying the tool outside a `contracts-read` group is the real control.
  - A **force-drafts ingress transform** on `*createEnvelope*` /
    `*create_envelope*` (PF-25) so agents prepare envelopes but only
    authorized senders dispatch them.
  - A **void-protection ingress deny** on `updateEnvelope` with
    `status: "voided"` — voiding a sent envelope is irreversible.

  ## Known limitations

  - **Base64 document content is opaque to pattern scanning.** The community
    `download_envelope_document` tool returns the signed PDF as
    `contentBase64`; identifiers inside the encoded document do not match any
    regex. This policy still scans that tool's response for plain-text
    identifiers (IDs, summaries), but for real control over whole-PDF egress
    pair it with a group-gated deny as described under Composition.
  - **Pattern-based detection is best-effort.** Obfuscated, split-across-line,
    spelled-out, or image-embedded values are not caught. A Luhn-valid
    16-digit number that is not a card can be over-masked — masking to
    BIN+last4 (rather than a fixed token) keeps such false positives usable.
  - **Tab JSON matching assumes label-before-value ordering.** The JSON-aware
    patterns match a tab whose SSN/bank label appears **before** its `value`
    field within the same JSON object. Intervening tab members between the
    label and value (`tabId`, `documentId`, `pageNumber`, `recipientId`, …) are
    tolerated — the `[^{}]*?` skip walks over them but cannot cross the object
    boundary, so one tab's label never pairs with another tab's value. If a
    server serializes `value` **before** the label, only the unlabeled
    detections apply: hyphenated SSNs and Luhn-valid PANs are still caught, but
    a bare 9-digit SSN or bank account number with no preceding label is left
    alone (bare 9-digit runs collide with phone numbers and reference IDs, so
    they are deliberately not matched unlabeled).
  - **Bank pair heuristic is conservative by design.** A routing number
    without an account number in the same content block (and vice versa) is
    *not* redacted — this keeps lone reference numbers usable.
  - **Community metadata tools not matched.** luthersystems
    `get_envelope_status`, `list_envelopes`, and `list_envelope_documents`
    return status/metadata rather than tab values and are not in the match
    list — add suffixes if your deployment routes tab data through them.
  - **Official argument/response shapes are documented REST bodies, not an MCP
    schema dump.** Per the landscape research, verify against a live
    `tools/list` and the dump-input technique before relying on exact response
    shapes in production.
  - **Group names are placeholders — replace `hr` and `finance` with your
    IdP's group names at import time.** The exemption is granted **only** for
    a `groups` claim shaped as an array of strings (a single bare string is
    also handled). Any other shape fails closed → redaction applies: a missing
    subject/claims/`groups`, an object/map (e.g. `{"department": "finance"}` —
    the `is_array` guard stops its *values* from being read as group names),
    and nested/non-string array elements are all treated as *not exempt*.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - docusign
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package docusign.egress.redact_tab_values

# Transform-only egress policy: rewrites regulated identifiers (SSN, bank
# routing/account numbers, Luhn-valid card PANs) in Docusign envelope- and
# agreement-reading tool responses before they reach the agent. Never denies.
# Callers in an exempt IdP group receive unredacted responses.
default allow := true

# -----------------------------------------------------------------------------
# Scope: Docusign tools whose responses carry filled tab values or extracted
# agreement terms. Contains/suffix matching keeps the policy portable across
# gateway server-name prefixes. Official names (getEnvelope, getEnvelopes,
# listRecipients, getAgreementDetails) verified against the official Docusign
# MCP Server tool catalog; download_envelope_document verified from the
# luthersystems community server source. The official production catalog has
# no document-download tool.
# -----------------------------------------------------------------------------

# Egress scope: match the post-invoke/output path on either mode or action. If
# we keyed on input.mode alone and a gateway build left it unset, the scope
# check would silently fail and redaction would no-op (fail open, leaking tab
# values). Ingress (tool_pre_invoke / mode "input") satisfies neither branch.
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC),
# tool_metadata.name (legacy), and payload.name (tool-hook canonical). Collect
# all three and match if ANY carries an in-scope name — matching only a subset
# would let a gateway that populates a different surface slip data past the
# scanner.
candidate_names contains lower(object.get(input.resource, "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

# getEnvelope / getEnvelopes: contains-match so one branch covers both the
# single-envelope read and the status search (both egress envelope metadata
# and, for getEnvelope, tab data).
is_envelope_data_tool if {
    is_egress
    some n in candidate_names
    contains(n, "getenvelope")
}

# Suffix-matched tools: listRecipients (filled tab values), getAgreementDetails
# and getAllAgreements (Navigator AI-extracted terms — the list variant carries
# the same extracted provisions/party data, so both are in scope), and the
# community download_envelope_document (whole signed document; see policy doc
# for the base64 caveat).
envelope_tool_suffixes := {
    "listrecipients",
    "getagreementdetails",
    "getallagreements",
    "download_envelope_document",
}

is_envelope_data_tool if {
    is_egress
    some suffix in envelope_tool_suffixes
    some n in candidate_names
    endswith(n, suffix)
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP groups whose members receive unredacted
# responses. Replace "hr" / "finance" with your IdP's group names at import
# time. object.get chains mean a missing subject/claims/groups claim is never
# exempt: the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"hr", "finance"}

caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

is_exempt if {
    # Only an array of group strings grants the exemption. The is_array guard
    # is load-bearing: `some g in caller_groups` over an OBJECT iterates its
    # values, so a namespaced/metadata claim like {"department": "finance"}
    # would else wrongly exempt the caller. is_string(g) keeps
    # nested/non-string elements from matching. Anything but a clean array of
    # strings fails closed -> redact.
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
# Detection patterns — anchored and conservative to limit false positives.
# Docusign responses are JSON-serialized REST bodies, so each class has a
# plain-text form (extracted provisions, summaries) and, where labels and
# values are separated by JSON structure, a tab-JSON form matching the
# `"tabLabel":"…","value":"…"` shape.
# -----------------------------------------------------------------------------

# US SSN in the canonical hyphenated form, anywhere. Bare 9-digit runs are too
# collision-prone with phone numbers and reference IDs to redact unlabeled.
ssn_hyphenated_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Label-anchored SSN: an ssn/social-security label immediately followed by a
# separator and 9 digits (hyphenated or bare). Captures the label and
# separator so the replacement preserves them.
ssn_label_pattern := `(?i)\b(ssn|social[ _-]?security(?:[ _-]?(?:no|num|number))?)("?\s*[:#=]?\s*"?)\d{3}[- ]?\d{2}[- ]?\d{4}\b`

# Docusign tab JSON: a quoted label containing ssn/social security, then the
# "value" field of the SAME object (label-before-value ordering; see policy
# doc). `[^{}]*?` lazily skips any intervening tab members (tabId, documentId,
# pageNumber, ...) between the label and value but cannot cross an object
# boundary, so it never pairs one tab's label with another tab's value.
ssn_json_pattern := `(?i)("[^"]*(?:ssn|social[ _-]?security)[^"]*"[^{}]*?"value"\s*:\s*")\d{3}[- ]?\d{2}[- ]?\d{4}(")`

# Labeled US bank routing number (exactly 9 digits) and account number (6-17
# digits), plain-text form. Label-anchored so arbitrary digit runs are never
# touched; both classes must appear in the same content block before either is
# redacted (bank_pair).
routing_pattern := `(?i)\b(?:aba|routing)(?:\s+(?:no|num|number)\.?)?\s*[:#]?\s*\d{9}\b`

account_pattern := `(?i)\b(?:account|acct)(?:\s+(?:no|num|number)\.?)?\s*[:#]?\s*\d{6,17}\b`

# Tab-JSON forms of the same two classes (direct-deposit tabs egress this way
# through listRecipients). Same `[^{}]*?` intervening-member skip as the SSN
# tab pattern: label and value may be separated by other tab fields within the
# one object, but the match cannot leak across the object boundary.
routing_json_pattern := `(?i)("[^"]*(?:routing|aba)[^"]*"[^{}]*?"value"\s*:\s*")\d{9}(")`

account_json_pattern := `(?i)("[^"]*(?:account|acct)[^"]*"[^{}]*?"value"\s*:\s*")\d{6,17}(")`

# 16-digit card-shaped runs in 4x4 groups with optional space/hyphen
# separators. Candidates are only masked after passing the Luhn check below —
# a matching shape alone is not enough.
card_pattern := `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b`

# -----------------------------------------------------------------------------
# Luhn check — validates card-shaped candidates so envelope/reference numbers
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
card_candidates(t) := {c |
    some c in regex.find_n(card_pattern, t, -1)
    luhn_valid(digits_only(c))
}

# PCI DSS 3.4.1 masking: keep the BIN (first six digits) and last four, mask
# the middle. 4111111111111111 -> 411111******1111.
mask_pan(c) := masked if {
    d := digits_only(c)
    masked := concat("", [substring(d, 0, 6), "******", substring(d, 12, 4)])
}

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_ssn(t) := out if {
    hyphenated := regex.replace(t, ssn_hyphenated_pattern, "[REDACTED-SSN]")
    tabbed := regex.replace(hyphenated, ssn_json_pattern, "$1[REDACTED-SSN]$2")
    out := regex.replace(tabbed, ssn_label_pattern, "$1$2[REDACTED-SSN]")
}

bank_routing_present(t) if { regex.match(routing_pattern, t) }

bank_routing_present(t) if { regex.match(routing_json_pattern, t) }

bank_account_present(t) if { regex.match(account_pattern, t) }

bank_account_present(t) if { regex.match(account_json_pattern, t) }

bank_pair(t) if {
    bank_routing_present(t)
    bank_account_present(t)
}

redact_bank(t) := out if {
    bank_pair(t)
    r1 := regex.replace(t, routing_pattern, "[REDACTED-BANK-ROUTING]")
    r2 := regex.replace(r1, routing_json_pattern, "$1[REDACTED-BANK-ROUTING]$2")
    r3 := regex.replace(r2, account_pattern, "[REDACTED-BANK-ACCOUNT]")
    out := regex.replace(r3, account_json_pattern, "$1[REDACTED-BANK-ACCOUNT]$2")
}

redact_bank(t) := t if { not bank_pair(t) }

redact_cards(t) := out if {
    cands := card_candidates(t)
    count(cands) > 0
    # Candidates contain only digits, spaces, and hyphens; each is replaced
    # literally with its own BIN+last4 mask via strings.replace_n.
    out := strings.replace_n({c: mask_pan(c) | some c in cands}, t)
}

redact_cards(t) := t if { count(card_candidates(t)) == 0 }

# Order matters: SSNs first (so they can't be half-eaten by later patterns),
# then labeled bank pairs (so a labeled 16-digit account number is classified
# as a bank account, not a card), then Luhn-checked card masking.
redact_block(b) := redact_cards(redact_bank(redact_ssn(b))) if {
    is_string(b)
}

# Non-string content blocks (structured/JSON blocks) pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, the caller is not exempt, and at
# least one block actually changed. Otherwise the rule is undefined and the
# aggregator skips this policy, returning the response byte-identical.
# -----------------------------------------------------------------------------

text_blocks := object.get(input.payload, "text", [])

redacted_blocks := [out |
    some block in text_blocks
    out := redact_block(block)
]

transform := {
    "transformed_payload": object.union(input.payload, {"text": redacted_blocks}),
} if {
    is_envelope_data_tool
    not is_exempt
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
