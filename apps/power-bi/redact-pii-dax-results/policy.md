---
name: "Power BI: Redact PII in Query Results"
tags:
  - power-bi
  - redact-pii
  - pii
  - dlp
  - dax
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # power-bi / redact-pii-dax-results

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `power_bi.egress.redact_pii_dax_results`

  ## What it does

  Scans the content returned by Power BI's result-returning tools and rewrites
  high-confidence PII shapes to fixed, non-recoverable redaction tokens before
  the response reaches the agent:

  | Class | Detection | Token |
  |---|---|---|
  | Email address | `local@domain.tld` shape | `[REDACTED-EMAIL]` |
  | US SSN | hyphenated `\d{3}-\d{2}-\d{4}` form | `[REDACTED-SSN]` |
  | Payment card (PAN) | 16-digit 4×4 groups, **Luhn-validated** in Rego | `[REDACTED-CARD]` |

  Matches are replaced in place over the serialized result content, so the row
  structure the agent sees stays intact — only the identifier substrings change.
  The policy is transform-only: it never denies a call. Responses with no
  matches and all out-of-scope tools pass through byte-identical. Every response
  field is read via `object.get`, so a missing or oddly-shaped payload is never
  an error — it simply passes through.

  ### Why this matters for Power BI

  Semantic models front warehouse/lakehouse tables that hold customer PII, and
  the DAX query tools return raw rows: a bare `EVALUATE 'Customers'` dumps an
  entire table. DAX is read-only, so the risk is wholesale read-back
  exfiltration, not corruption — the response path is the last enforcement point
  against it. This policy is a **backstop for semantic models that lack
  column-level masking**; it does not replace model-side RLS or Object-Level
  Security. It also covers `GetReportMetadata`, whose textbox content can surface
  hidden columns/measures and embedded literal values.

  ### Caller exemption (fail-closed, off by default)

  The policy ships a data-steward exemption branch: callers whose IdP `groups`
  claim contains `full-pii` (a placeholder name — see Known limitations) receive
  the **full, unredacted** response. The check reads the claims via
  `object.get(input.subject, "claims", {})` chains, so a missing subject, missing
  claims, or missing `groups` claim means the caller is **not** exempt and the
  transform applies. Because most tenants have not wired up a `full-pii` group,
  **no caller is exempt by default** — the grant fails closed, and the safe
  failure mode is over-redaction, never disclosure. Remove the exemption rules
  entirely if you want redaction with no carve-out.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in DAX query results
    as they leave the gateway toward the agent; **C1.1** — supports the
    identification and protection of confidential information on the read path.
  - **PCI DSS 3.4.1** — supports masking the primary account number (PAN) on
    display: Luhn-validated 16-digit card numbers in returned DAX rows are rewritten
    to `[REDACTED-CARD]` before the response reaches the agent, so a CHD value that a
    semantic model surfaces from the warehouse it fronts is not disclosed in full on
    the agent MCP path.
  - **GDPR Art. 9** — reduces special-category exposure on the MCP path, where
    direct identifiers co-occur with health/HR columns in the warehouse tables a
    semantic model imports or DirectQueries. **CPRA §1798.121** — supports the
    consumer's right to limit the use and disclosure of sensitive personal
    information (SSN, financial account numbers) on the agent channel.

  ## Why egress

  The PII already lives in the model's underlying tables — there is nothing to
  block at ingress, and denying `ExecuteQuery`/`execute_dax` outright would make
  the agent useless for analytics. The leak happens when result rows are returned
  to the MCP client, so the response path is the only place to catch it while
  keeping the results useful. This composes with ingress guards (whole-table
  dump guard, model-ID fencing, RLS-bypass session block) that keep dangerous
  reads off the path in the first place; this policy handles what a permitted
  read returns.

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to the result-returning
  Power BI tools, matched case-insensitively **by lowercased suffix**. The tool
  name is read from `input.resource.name`, with `input.tool_metadata.name` as a
  fallback. Suffix matching keeps the policy portable across the gateway
  server-name prefix (which is not standardized) and across the three
  incompatible Power BI naming conventions:

  - `executequery`, `valuesearch` — the remote official server (PascalCase
    `ExecuteQuery` / `ValueSearch`; `ValueSearch` searches real data values).
  - `execute_dax`, `desktop_execute_dax` — the community server
    (sulaiman013/powerbi-mcp) cloud and desktop DAX tools. `desktop_execute_dax`
    also ends with `execute_dax`; listing it explicitly is harmless.
  - `dax_query_operations` — the official modeling server's read query
    multiplexer.
  - `getreportmetadata` — the remote server's report-metadata tool, whose
    textbox content can surface hidden columns/measures and embedded values.

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production, and extend `result_tool_suffixes` for any
  other content-returning tools your deployment exposes.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each **string** block. Because
  the redaction regexes run over the serialized block text rather than a parsed
  row model, the transform is **shape-agnostic**: it does not matter whether the
  server nests rows under `results`, `rows`, `data`, or some other envelope — the
  identifier substrings are caught wherever they appear in the serialized string.
  This is deliberate: the Power BI preview servers are marked "schemas may change"
  and the exact result envelope is unverified (see Known limitations), so the
  transform walks string values defensively instead of assuming a fixed key.
  Non-string blocks pass through unmodified. When at least one block changes, the
  policy emits `transform.transformed_payload` containing the original payload
  with the rewritten `text` array (all other payload keys preserved). When
  nothing changes, no transform is emitted and the response passes through
  byte-identical.

  If a preview server returns `text` as a **bare string** rather than a
  content-block array (off-spec, but the servers warn their schemas may change),
  that single string is redacted too, so an unexpected non-array envelope does
  not fail open into an unredacted PII leak. Payload shapes that are neither a
  string nor an array of strings (a number, an object, or an array whose
  elements are themselves objects/arrays) are still passed through untouched —
  see Known limitations.

  ## Examples

  ### Redacted (in-scope tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "powerbi-mcp-ExecuteQuery", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["analytics"] } },
      "payload": {
        "name": "powerbi-mcp-ExecuteQuery",
        "text": ["{\"results\":[{\"email\":\"jane@acme.com\",\"ssn\":\"123-45-6789\",\"card\":\"4111 1111 1111 1111\"}]}"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` holding the block
  rewritten so `email`, `ssn`, and `card` become their respective tokens.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "powerbi-mcp-execute_dax", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["full-pii"] } },
      "payload": {
        "name": "powerbi-mcp-execute_dax",
        "text": ["{\"rows\":[{\"ssn\":\"123-45-6789\"}]}"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `full-pii` data-steward group receives raw
  content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny policies on the same egress pipeline. Recommended companions for
  `apps/power-bi`:

  - **A whole-table dump guard (ingress)** on `ExecuteQuery` / `execute_dax` /
    `dax_query_operations` that denies bare `EVALUATE 'Table'` DAX, so redaction
    is a backstop rather than the only defense.
  - **A model-ID fencing ingress policy** that keeps regulated semantic models
    off the agent path entirely.
  - **A block-RLS-bypass-session ingress policy** that denies `ExecuteQuery` /
    `ValueSearch` when the session is service-principal-authenticated (the remote
    server does not enforce RLS under service-principal auth).
  - **A dedicated PF-01 `mask-pan-egress` policy** if your tenant needs full
    cardholder-data coverage — this policy's card detection is 16-digit-4×4 +
    Luhn only (see Known limitations).

  ## Known limitations

  - **Result envelope is unverified.** The Power BI query servers are in public
    preview and their docs warn that tool schemas may change; the exact result
    shape (rows under `results` / `rows` / `data`, or another envelope) is **not
    verified**. The transform sidesteps this by running detection over the
    serialized block text rather than a parsed row model, so it catches
    identifiers regardless of the envelope — but it also means detection is
    best-effort regex, not a structured field walk.
  - **Regex redaction over serialized result content is best-effort.** Values
    split across columns (e.g. an SSN stored as three separate fields), base64-
    or otherwise-encoded fields, and non-standard national-ID formats will not
    match. Treat this as a high-signal minimum-necessary layer, not a complete
    DLP solution.
  - **Redaction masks the response to the caller only — it does not alter data at
    rest.** The rows in the warehouse/model are unchanged; the mask exists solely
    in what the gateway returns to the agent. This is a disclosure-minimisation
    control on the read path, not de-identification of the source.
  - **Card detection is heuristic and display-side.** A card-shaped number is
    redacted only when it is 16 digits in contiguous or single-`[- ]`-separated
    4×4 groups **and** passes the Luhn check. Luhn-valid cards that are not
    16-digit-4×4 (15-digit Amex, 14-digit Diners, 13/19-digit ranges) and
    16-digit cards grouped with dots or slashes pass through. For full
    cardholder-data coverage pair this with a dedicated PF-01 `mask-pan-egress`
    policy; do not rely on this policy alone for PAN masking.
  - **Non-string content blocks pass through unmodified.** Redaction applies to
    string entries of `input.payload.text` (including serialized-JSON strings) and
    to a bare-string `text` value. It does **not** descend into structured blocks:
    an array element that is itself a JSON object/array (e.g. a content block
    `{"ssn":"123-45-6789"}` returned as a parsed object rather than a serialized
    string) is emitted unchanged, so PII carried in a structured non-string block
    leaks. This is the cost of the deliberate string-walking design (the result
    envelope is unverified); if your gateway emits structured non-string blocks,
    verify their shape with the dump-input technique and add a structured-field
    walk or pair this with a schema-specific redactor.
  - **Group names are placeholders — replace `full-pii` with your IdP's group
    name at import time.** The exemption expects the `groups` claim as an array of
    strings (a single bare string is also handled); if your IdP emits roles under
    a namespaced claim, adjust `caller_groups`. On Auth0 tenants without
    RBAC/permissions configured, no `groups` claim reaches the policy, so the
    exemption never fires — the transform applies to everyone until the claim is
    wired up (fail-closed: over-redaction, not disclosure).
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input technique
    before production, and mind attachment order if other egress transforms run on
    the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - power-bi
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package power_bi.egress.redact_pii_dax_results

# Transform-only egress policy: rewrites high-confidence PII in Power BI
# result-returning tool responses to fixed, non-recoverable tokens before the
# response reaches the agent. Never denies. Semantic models front warehouse
# tables holding customer PII and DAX tools return raw rows, so egress is the
# last enforcement point against read-back exfiltration; this policy is a
# backstop for models lacking column-level masking. Callers in the placeholder
# `full-pii` IdP group receive the full unredacted response; the group check
# fails closed, so a caller with missing claims gets over-redaction, never
# disclosure.
default allow := true

# -----------------------------------------------------------------------------
# Scope: Power BI result-returning tools across the three servers in the
# landscape inventory. The gateway prefixes tool names with the configured MCP
# server name (not standardized), so match by lowercased suffix. The remote
# server uses PascalCase verbs, the modeling server uses `<object>_operations`
# multiplexers, and the community server uses snake_case with surface prefixes —
# suffix matching normalizes all three.
# -----------------------------------------------------------------------------

result_tool_suffixes := {
	"executequery", # remote official server — arbitrary DAX against a model
	"valuesearch", # remote official server — searches real data values
	"execute_dax", # community server (cloud); also a suffix of desktop_execute_dax
	"desktop_execute_dax", # community server (desktop)
	"dax_query_operations", # official modeling server — read query multiplexer
	"getreportmetadata", # remote server — textbox content, hidden columns/measures
}

is_result_tool if {
	input.mode == "output"
	some suffix in result_tool_suffixes
	endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), suffix)
}

is_result_tool if {
	# Egress hooks also expose the tool name under tool_metadata.name — check both
	# so we match regardless of which surface the gateway populates.
	input.mode == "output"
	some suffix in result_tool_suffixes
	endswith(lower(object.get(object.get(input, "tool_metadata", {}), "name", "")), suffix)
}

# -----------------------------------------------------------------------------
# Data-steward exemption — placeholder IdP group whose members receive the full
# response. Replace "full-pii" with your IdP's group name at import time. The
# object.get chains mean a missing subject/claims/groups claim is never exempt:
# the grant fails closed and the transform applies. Most tenants have no such
# group wired up, so by default no caller is exempt.
# -----------------------------------------------------------------------------

exempt_groups := {"full-pii"}

caller_groups := object.get(
	object.get(object.get(input, "subject", {}), "claims", {}),
	"groups",
	[],
)

is_exempt if {
	# Require an array of strings — a groups claim shaped as an object/number/null
	# is never exempt, so a malformed claim fails closed (over-redaction, never
	# disclosure) rather than accidentally matching an object's values.
	is_array(caller_groups)
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

# Email addresses: local part, @, domain, dot, 2+ letter TLD.
email_pattern := `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# object IDs and raw phone digits, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# 16-digit card-shaped runs in 4x4 groups with optional space/hyphen separators.
# Candidates are only redacted after passing the Luhn check below — a matching
# shape alone is not enough.
card_pattern := `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b`

# -----------------------------------------------------------------------------
# Luhn check — validates card-shaped candidates so invoice/reference numbers that
# merely look like PANs are left alone.
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

redact_emails(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_cards(t) := out if {
	cands := card_candidates(t)
	count(cands) > 0
	# Candidates contain only digits, spaces, and hyphens, so joining them into an
	# alternation of literals is regex-safe.
	literal := concat("|", sort([c | some c in cands]))
	out := regex.replace(t, literal, "[REDACTED-CARD]")
}

redact_cards(t) := t if { count(card_candidates(t)) == 0 }

# Order: emails first, then SSNs, then Luhn-checked cards. The three patterns are
# disjoint (an email contains an "@" that neither numeric pattern matches, and
# SSN's 3-2-4 hyphenation cannot occur inside a 4x4 card), so ordering only
# guards against incidental overlap.
redact_block(b) := redact_cards(redact_ssn(redact_emails(b))) if { is_string(b) }

# Non-string content blocks pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — redacts every string block. Emitted only when in scope, the caller
# is not exempt, and at least one block actually changed. Otherwise the rule is
# undefined and the aggregator skips this policy, returning the response
# byte-identical.
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
	is_result_tool
	not is_exempt
	is_array(text_blocks)
	redacted_blocks != text_blocks
}

# Bare-string `text` fallback. The documented egress shape is a content-block
# array, but the Power BI preview servers warn their schemas may change, so a
# server that returns `text` as a single serialized string would otherwise fail
# open (no array -> no redaction -> PII leaks). Redact the lone string too. This
# clause is mutually exclusive with the array clause above: `text` is a string
# XOR an array, never both, so the two transform definitions never conflict.
transform := {
	"transformed_payload": object.union(response_payload, {"text": redact_block(text_blocks)}),
} if {
	is_result_tool
	not is_exempt
	is_string(text_blocks)
	redact_block(text_blocks) != text_blocks
}
```
