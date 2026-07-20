---
name: "Box: Redact PII from File Content on Egress"
tags:
  - box
  - redact-pii
  - pii
  - phi
  - dlp
  - redaction
  - egress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # box / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `box.egress.redact_pii`

  ## What it does

  Scans the responses of Box content-returning tools and rewrites personally
  identifiable information to fixed redaction tokens before the response reaches
  the agent:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Payment card | 16-digit 4×4 groups, **Luhn-validated** in Rego | `[REDACTED-CC]` |
  | US bank routing number | label-anchored (`routing`/`ABA` + 9 digits), only when paired with an account number in the same block | `[REDACTED-BANK-ROUTING]` |
  | US bank account number | label-anchored (`account`/`acct` + 6–17 digits), only when paired with a routing number in the same block | `[REDACTED-BANK-ACCOUNT]` |
  | Email address | standard shape, only when paired with a phone number in the same block | `[REDACTED-EMAIL]` |
  | US phone number | separator-formatted, only when paired with an email in the same block | `[REDACTED-PHONE]` |

  Matches are replaced in place, leaving the surrounding structure intact so
  citations, extraction fields, and search snippets remain usable. The policy is
  transform-only: it never denies a call, and responses with no matches (and all
  out-of-scope tools) pass through byte-identical.

  Box is a system of record for contracts, HR files, and PHI/financials, so this
  is the primary minimum-necessary control on the MCP read path.

  ### Group exemption

  Callers whose IdP `groups` claim contains `hr` or `finance` (placeholder
  names — see Known limitations) receive **unredacted** responses. The check
  reads `input.subject.claims.groups` via `object.get` chains: a missing
  subject, missing claims, or missing `groups` claim means the caller is *not*
  exempt and redaction applies — the grant fails closed.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in Box content as it
    leaves the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the read path; **P4.1** — supports limiting personal
    information use to identified purposes by keeping direct identifiers out of
    agent context that doesn't need them.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based access: only placeholder `hr`/`finance` group members see raw
    identifiers; everyone else gets working documents with identifiers masked.
  - **HIPAA §164.514(a)–(b)** — supports de-identification practice by
    stripping Safe-Harbor identifier classes (SSN, account numbers, email,
    phone) from responses.
  - **PCI DSS 3.4.1** — supports masking the primary account number when
    displayed: Luhn-validated 16-digit card numbers in Box content are rewritten
    to `[REDACTED-CC]` before the response reaches the agent, so a PAN that lands
    in a Box document is not surfaced in full on the MCP read path.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path for
    documents where identifiers co-occur with health/financial content.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, financial account credentials) on the
    agent channel.

  ## Why egress

  The PII already lives in Box — there is nothing to block at ingress, and
  denying reads outright would make the documents unusable. The leak happens
  when file-derived text is returned to the MCP client, so the response path is
  the only place to catch it while keeping the content useful.

  ## Tool name matching

  Applies on the output path — scoped when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a
  gateway build that populates only one of the two (keying on `mode` alone would
  fail open if it were unset). Tools are matched case-insensitively **by
  suffix**, so it works regardless of the MCP server name prefix the gateway
  adds (`box-mcp-…`, `box-prod-…`, etc.). The tool name is read from all three
  egress surfaces — `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — and a suffix hit on **any** of them puts the call in
  scope, so a gateway that populates a different surface can't slip content past
  the scanner.

  Official Box remote server (mcp.box.com — names verified against Box's docs):
  `get_file_content`, `get_file_preview`, `ai_qa_single_file`,
  `ai_qa_multi_file`, `ai_qa_hub`, `ai_extract_freeform`,
  `ai_extract_structured`, `ai_extract_structured_from_fields`,
  `ai_extract_structured_from_fields_enhanced`,
  `ai_extract_structured_from_metadata_template`,
  `ai_extract_structured_from_metadata_template_enhanced`,
  `search_files_keyword`, `search_files_metadata` (search responses leak
  matched snippets when the search scope includes file content).

  Community server (box-community/mcp-server-box — names verified from repo
  docs): `box_file_text_extract_tool`, `box_search_tool`.

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production, and add suffixes for any other
  content-returning tools your deployment exposes.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each string block.
  Non-string blocks pass through unmodified. When at least one block changes,
  the policy emits `transform.transformed_payload` containing the original
  payload with the rewritten `text` array (all other payload keys preserved).

  ## Examples

  ### Redacted (content tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "box-mcp-get_file_content", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["marketing"] } },
      "payload": {
        "name": "box-mcp-get_file_content",
        "text": ["Employee SSN: 123-45-6789, card 4111 1111 1111 1111"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["Employee SSN: [REDACTED-SSN], card [REDACTED-CC]"]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "box-mcp-get_file_content", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["hr"] } },
      "payload": {
        "name": "box-mcp-get_file_content",
        "text": ["Employee SSN: 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `hr` group receives raw content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes
  cleanly with deny policies on the same egress pipeline. Recommended
  companions in `apps/box`:

  - **fence-sensitive-folders** (ingress) — keeps agents out of sensitive
    folder trees entirely, and covers the `get_download_url` bypass below.
  - An external-sharing guard on `create_collaboration` / `*shared_link*`
    (ingress) so redacted-on-read content isn't simply shared out instead.

  ## Known limitations

  - **Pattern-based detection is best-effort.** Obfuscated, split-across-lines,
    spelled-out, base64-encoded, or image-embedded values are not caught; a
    Luhn-valid 16-digit number that is not a card can be over-redacted. Treat
    this as a high-signal minimum-necessary layer, not a complete DLP solution.
  - **`get_download_url` bypass.** That tool returns a URL rather than content,
    so files fetched out-of-band are never seen by egress scanning. This policy
    deliberately does not match it — pair with `fence-sensitive-folders` to
    keep sensitive trees off the read path altogether.
  - **Pair heuristics are conservative by design.** A lone email address, a
    lone phone number, a routing number without an account number (and vice
    versa) are *not* redacted — this keeps corporate contact info and order
    numbers usable. Bank labels are matched in plain text (`Routing number:
    021000021`), not as JSON keys (`"routing_number": "…"` won't match).
  - **SSN matching is hyphenated-form only.** Bare 9-digit runs collide with
    Box file IDs and are left alone.
  - **Group names are placeholders — replace `hr` and `finance` with your
    IdP's group names at import time.** The exemption is granted **only** for a
    `groups` claim shaped as an array of strings (a single bare string is also
    handled). Any other shape fails closed → redaction applies: a missing
    subject/claims/`groups`, an object/map (e.g. a namespaced or metadata claim
    like `{"department": "finance"}` — the `is_array` guard stops its *values*
    from being read as group names), and nested/non-string array elements are
    all treated as *not exempt*. If your IdP emits roles under a namespaced
    claim, adjust `caller_groups` to point at the array before matching.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms run on the same pipeline.
  - **Community-server AI tools not matched.** The box-community server's AI
    module tool names are not individually verified in the landscape research,
    so they are not in the suffix list — add them if your deployment exposes
    them.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - box
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package box.egress.redact_pii

# Transform-only egress policy: rewrites PII in Box content-returning tool
# responses to fixed redaction tokens before the response reaches the agent.
# Never denies. Callers in an exempt IdP group receive unredacted responses.
default allow := true

# -----------------------------------------------------------------------------
# Scope: Box tools whose responses carry file-derived content. Suffix matching
# keeps the policy portable across gateway server-name prefixes and covers both
# the official remote server (bare verb_noun names) and the community server
# (box_*_tool names). Verified against the Box landscape research.
# -----------------------------------------------------------------------------

content_tool_suffixes := {
    # Official remote server (mcp.box.com)
    "get_file_content",
    "get_file_preview",
    "ai_qa_single_file",
    "ai_qa_multi_file",
    "ai_qa_hub",
    "ai_extract_freeform",
    "ai_extract_structured",
    "ai_extract_structured_from_fields",
    "ai_extract_structured_from_fields_enhanced",
    "ai_extract_structured_from_metadata_template",
    "ai_extract_structured_from_metadata_template_enhanced",
    "search_files_keyword",
    "search_files_metadata",
    # Community server (box-community/mcp-server-box)
    "box_file_text_extract_tool",
    "box_search_tool",
}

# Egress scope: match the post-invoke/output path on either mode or action. If
# we keyed on input.mode alone and a gateway build left it unset, is_content_tool
# would silently fail and redaction would no-op (fail open, leaking content).
# Ingress (tool_pre_invoke / mode "input") satisfies neither branch, so it stays
# out of scope.
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC), tool_metadata.name
# (legacy), and payload.name (tool-hook canonical). Collect all three and match if
# ANY carries a content-tool suffix — matching only a subset would let a gateway
# that populates a different surface slip file content past the scanner.
candidate_names contains lower(object.get(input.resource, "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

is_content_tool if {
    is_egress
    some suffix in content_tool_suffixes
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
    # Only an array of group strings grants the exemption. The is_array guard is
    # load-bearing: `some g in caller_groups` over an OBJECT iterates its values,
    # so a namespaced/metadata claim like {"department": "finance"} would else
    # wrongly exempt the caller. is_string(g) keeps nested/non-string elements
    # from matching. Anything but a clean array of strings fails closed → redact.
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
# -----------------------------------------------------------------------------

# US SSN in the canonical hyphenated form only. Bare 9-digit runs are too
# collision-prone with Box file/folder IDs to redact safely.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# 16-digit card-shaped runs in 4x4 groups with optional space/hyphen
# separators. Candidates are only redacted after passing a Luhn check below —
# a matching shape alone is not enough.
card_pattern := `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b`

# Labeled US bank routing number (exactly 9 digits) and account number (6-17
# digits). Label-anchored so arbitrary digit runs are never touched; both must
# appear in the same content block before either is redacted (bank_pair).
routing_pattern := `(?i)\b(?:aba|routing)(?:\s+(?:no|num|number)\.?)?\s*[:#]?\s*\d{9}\b`

account_pattern := `(?i)\b(?:account|acct)(?:\s+(?:no|num|number)\.?)?\s*[:#]?\s*\d{6,17}\b`

# Email address and separator-formatted US phone number. Redacted only when
# both appear in the same content block (a contact-record signature) so lone
# corporate email addresses stay usable (contact_pair).
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

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
card_candidates(t) := {c |
    some c in regex.find_n(card_pattern, t, -1)
    luhn_valid(digits_only(c))
}

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

bank_pair(t) if {
    regex.match(routing_pattern, t)
    regex.match(account_pattern, t)
}

redact_bank(t) := out if {
    bank_pair(t)
    routed := regex.replace(t, routing_pattern, "[REDACTED-BANK-ROUTING]")
    out := regex.replace(routed, account_pattern, "[REDACTED-BANK-ACCOUNT]")
}

redact_bank(t) := t if { not bank_pair(t) }

redact_cards(t) := out if {
    cands := card_candidates(t)
    count(cands) > 0
    # Candidates contain only digits, spaces, and hyphens, so joining them into
    # an alternation of literals is regex-safe.
    literal := concat("|", sort([c | some c in cands]))
    out := regex.replace(t, literal, "[REDACTED-CC]")
}

redact_cards(t) := t if { count(card_candidates(t)) == 0 }

contact_pair(t) if {
    regex.match(email_pattern, t)
    regex.match(phone_pattern, t)
}

redact_contact(t) := out if {
    contact_pair(t)
    emailed := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")
    out := regex.replace(emailed, phone_pattern, "[REDACTED-PHONE]")
}

redact_contact(t) := t if { not contact_pair(t) }

# Order matters: SSNs first (so they can't be half-eaten by later patterns),
# then labeled bank pairs (so a labeled 16-digit account number is classified
# as a bank account, not a card), then Luhn-checked cards, then contact pairs.
redact_block(b) := redact_contact(redact_cards(redact_bank(redact_ssn(b)))) if {
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
    is_content_tool
    not is_exempt
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
