---
name: "BigQuery: Redact PII in Query Results"
tags:
  - bigquery
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
  # bigquery / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `bigquery.egress.redact_pii`

  ## What it does

  Scans the content returned by BigQuery's result-returning tools and rewrites
  high-confidence PII shapes to fixed, non-recoverable redaction tokens before
  the response reaches the agent:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | hyphenated `\d{3}-\d{2}-\d{4}` form | `[REDACTED-SSN]` |
  | Payment card (PAN) | 16-digit 4×4 groups, **Luhn-validated** in Rego | `[REDACTED-CARD]` |
  | Email address | `local@domain.tld` shape | `[REDACTED-EMAIL]` |

  Matches are replaced in place over the serialized result content, so the row
  structure the agent sees stays intact — only the identifier substrings change.
  The policy is transform-only: it never denies a call. Responses with no
  matches, calls by exempt callers, and all out-of-scope tools pass through
  unchanged. Every response field is read via `object.get`, so a missing or
  oddly-shaped payload is never an error — it simply passes through.

  Every BigQuery read is a bulk read: a single `SELECT` can return an entire
  table, up to the server's ~3,000-row result cap. Redaction masks the
  *identifiers* in whatever comes back, but it does not bound *how much* comes
  back. To blunt bulk exfiltration, the policy also ships an **optional
  row-truncation guard** (see below) that clamps oversized JSON-array result
  blocks to a configured row count.

  ### Group exemption

  Callers whose IdP `groups` claim contains `pii-full-read` (a placeholder name
  — see Known limitations) receive the **full, unredacted, untruncated**
  response. The check reads `input.subject.claims.groups` via `object.get`
  chains: a missing subject, missing claims, or missing `groups` claim means the
  caller is *not* exempt and the transform applies — the grant fails closed. The
  safe failure mode is over-redaction, never disclosure.

  ### Optional row-truncation guard

  A configurable ceiling (`row_cap` in `policy.md`, default **1000**) bounds how
  many rows a single result can hand the agent. When a content block is a
  serialized JSON array longer than `row_cap`, it is truncated to the first
  `row_cap` elements and a `{"notice": …}` element is appended so the agent knows
  the result is policy-bounded. Set `row_cap := 0` to disable truncation and run
  redaction only, or raise it toward the ~3,000-row server cap. Truncation runs
  *before* redaction, so redaction only scans the rows that survive the cap.
  Exempt (`pii-full-read`) callers bypass truncation along with redaction.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in query results as
    they leave the gateway toward the agent; **C1.1** — supports identification
    and protection of confidential information on the read path; **P4.1** —
    supports limiting personal-information use to identified purposes; **P6.1** —
    supports controls over personal-information disclosure by keeping raw
    identifiers out of agent context that does not need them.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard with role-based limits: only placeholder `pii-full-read` group
    members see raw identifiers; everyone else gets working result rows with
    identifiers masked. **§164.514(a)–(b)** — supports de-identification practice
    by stripping Safe-Harbor identifier classes (SSN, account/card numbers,
    email) from warehouse reads; **§164.530(c)** — supports privacy safeguards on
    the agent channel.
  - **PCI DSS 3.4.1** — supports masking PAN on display by redacting
    Luhn-validated card numbers in query results before they reach the agent
    (this is display-side masking — see Known limitations); **3.4.2** — supports
    the prohibition on relocating PAN via remote access by masking card numbers
    on the agent read path.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR columns in warehouse tables;
    **Art. 5(1)(f) / Art. 32** — supports security of processing. **CCPA/CPRA
    §1798.121** — supports limiting the use and disclosure of sensitive personal
    information (SSN, financial account numbers) on the agent channel;
    **§1798.150** — reduces nonredacted-PI breach exposure.

  ## Why egress

  The PII already lives in the warehouse — there is nothing to block at ingress,
  and denying `SELECT`s outright would make the agent useless for analytics. The
  leak happens when result rows are returned to the MCP client, so the response
  path is the only place to catch it while keeping the results useful. This is a
  companion to the ingress `guard-warehouse-sql` policy, which keeps writes and
  DDL off the agent path; this policy handles what a permitted read can return.

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to the result-returning
  BigQuery tools, matched case-insensitively **by suffix**. The tool name is read
  from `input.resource.name`, with `input.tool_metadata.name` as a fallback.
  Suffix matching keeps the policy portable across the gateway server-name prefix
  (which is not standardized). The union covers all four servers in the landscape
  inventory:

  - `execute_sql`, `execute_sql_readonly` — Google official remote server + MCP
    Toolbox `bigquery` toolset (snake_case, no vendor prefix). **Unlike the
    ingress SQL guard, this egress policy deliberately matches the read-only tool
    too** — a `SELECT` through `execute_sql_readonly` returns exactly the same PII
    and must be redacted.
  - `query` — ergut/mcp-bigquery-server (single `query` tool).
  - `execute-query` — LucasHild/mcp-server-bigquery (kebab-case). Also ends with
    `query`; listing it explicitly is harmless.
  - `get_table_info` — official/Toolbox metadata tool that returns **preview
    rows** of the table alongside schema, so its output can carry PII.

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production, and extend `result_tool_suffixes` for any
  other content-returning tools your deployment exposes.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each string block (including
  string blocks containing serialized JSON, since the regexes run over the
  serialized text). Non-string blocks pass through unmodified. When at least one
  block changes (from truncation, redaction, or both), the policy emits
  `transform.transformed_payload` containing the original payload with the
  rewritten `text` array (all other payload keys preserved). When nothing
  changes, no transform is emitted and the response passes through byte-identical.

  ## Examples

  ### Redacted (in-scope tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["analytics"] } },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "text": ["[{\"email\":\"jane@acme.com\",\"ssn\":\"123-45-6789\",\"card\":\"4111 1111 1111 1111\"}]"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` holding the block
  rewritten to `[{"email":"[REDACTED-EMAIL]","ssn":"[REDACTED-SSN]","card":"[REDACTED-CARD]"}]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["pii-full-read"] } },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "text": ["[{\"ssn\":\"123-45-6789\"}]"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `pii-full-read` group receives raw content.

  ### Truncated (oversized result, non-exempt caller)

  A `bigquery-mcp-query` response whose single block is a JSON array of more than
  `row_cap` (default 1000) rows is sliced to the first `row_cap` rows with a
  `{"notice": …}` element appended, then redacted. `allow = true`, transform
  applied.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny policies on the same egress pipeline. Recommended companions for
  `apps/bigquery`:

  - **`guard-warehouse-sql` (ingress)** — the read-only SQL guard, so writes/DDL
    never reach the warehouse; this policy handles what the permitted reads
    return.
  - **A PF-01 `mask-pan-egress` policy** if your tenant needs full cardholder-data
    coverage — this policy's card detection is 16-digit-4×4 + Luhn only and is
    display-side (see Known limitations).
  - **A PF-23 `fence-sensitive-schemas` ingress policy** to keep regulated
    datasets (`pii_*`, `finance_*`, `phi_*`) off the agent path entirely, so
    redaction is a backstop rather than the only line of defense.
  - **A PF-14 gate on the Toolbox AI-analytics tools** (`ask_data_insights`,
    `forecast`, `analyze_contribution`), which move table contents to another
    Google API and whose responses this policy does not match.

  ## Known limitations

  - **Regex redaction over serialized result content is best-effort.** Detection
    runs over the serialized response text, not a parsed row model. Values split
    across columns (e.g. an SSN stored as three separate fields), base64- or
    otherwise-encoded fields, and non-standard national-ID formats will not
    match. Treat this as a high-signal minimum-necessary layer, not a complete
    DLP solution. Two SSN-format specifics worth calling out: only the canonical
    hyphenated `123-45-6789` form is matched — an SSN written with space or dot
    separators (`123 45 6789`, `123.45.6789`) or as a bare 9-digit run
    (`123456789`) passes through, the last of these *deliberately* (bare
    9-digit runs collide with object IDs and phone digits, so masking them would
    over-redact non-PII). Detection is also **per content block**: each string
    entry of `payload.text` is scanned on its own, so an identifier split across
    two blocks (`"...123-45-"` in one block, `"6789..."` in the next) has no
    single block that matches, and passes through — the same failure mode as an
    identifier split across columns, applied at the content-block boundary.
    Fullwidth/unicode digit forms, and JSON that serializes the hyphen as an
    escape sequence, are likewise not matched (encoded-field caveat above).
  - **The SSN and card patterns are `\b`-anchored, so identifiers glued to adjacent
    alphanumerics escape.** The SSN and card regexes require a word boundary at
    each end. An identifier fused directly to a neighbouring letter or digit with
    no delimiter or whitespace — e.g. `note4111111111111111`, `id123-45-6789x` —
    has no word boundary and is *not* matched. In practice serialized JSON
    delimits every value with quotes, commas, or braces (all non-word
    characters), so a card or SSN sitting in its own field is bounded correctly
    and redacted; this residual only bites when an identifier is concatenated
    into a longer alphanumeric token inside a single string value. The anchoring
    is intentional (it is what keeps a 16-digit card from being pulled out of the
    middle of a longer numeric ID) — do not remove the boundaries to close this
    gap, or false positives rise sharply. Pair with a dedicated PF-01
    `mask-pan-egress` / PF-02 policy tuned to your data if concatenated
    identifiers are a real risk in your tables.
  - **Redaction masks the response to the caller only — it does not alter data at
    rest.** The rows in BigQuery are unchanged; the mask exists solely in what the
    gateway returns to the agent. This is a disclosure-minimisation control on the
    read path, not de-identification of the warehouse.
  - **PAN masking here is display-side (PF-01 territory) and card detection is
    heuristic.** A card-shaped number is redacted only when it is 16 digits in
    contiguous or single-`[- ]`-separated 4×4 groups **and** passes the Luhn
    check. Luhn-valid cards that are not 16-digit-4×4 — 15-digit Amex (4-6-5),
    14-digit Diners, 13/19-digit ranges — and 16-digit cards grouped with dots or
    slashes pass through. For full cardholder-data coverage pair this with a
    dedicated PF-01 `mask-pan-egress` policy; do not rely on this policy alone for
    PCI PAN masking.
  - **Row truncation approximates rows as JSON-array elements.** The guard clamps
    a content block only when that block is a serialized JSON array; servers that
    return one row per content block, CSV/TSV text, or a nested `{rows: [...]}`
    envelope are not truncated by the default logic. Verify your server's result
    shape with the dump-input technique and adjust `row_cap` / the truncation rule
    accordingly, or set `row_cap := 0` to disable it and rely on an ingress
    `cap-bulk-export` guard instead.
  - **Non-string content blocks — and a non-array `text` — pass through
    unmodified.** Redaction and truncation apply only to *string* entries of an
    *array* `input.payload.text` (including serialized-JSON strings). A structured
    non-string block (e.g. an object `{"email": …}` rather than a serialized
    string) is returned verbatim, and if a server delivers `payload.text` as a
    bare string rather than the MCP content-block array, the transform does not
    fire and the response passes through unredacted. The gateway normally
    normalizes tool output to a string content-block array; verify your server's
    shape with the dump-input technique and, if it emits structured blocks, add a
    companion policy or a parse step.
  - **AI-analytics tool responses are out of scope for redaction.** This policy
    matches only the SQL/result and `get_table_info` tools listed under Tool name
    matching. The MCP Toolbox AI-analytics tools — `ask_data_insights`,
    `forecast`, `analyze_contribution` — are **not** matched, so PII that appears
    in a natural-language `ask_data_insights` answer (for example, an answer that
    quotes a customer email or SSN) is returned to the agent unredacted. Gate
    those tools with the PF-14 companion (see Composition), or add their suffixes
    to `result_tool_suffixes` if you want this policy's regexes to run over their
    output too.
  - **Group names are placeholders — replace `pii-full-read` with your IdP's group
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
  - bigquery
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package bigquery.egress.redact_pii

# Transform-only egress policy: rewrites high-confidence PII in BigQuery
# result-returning tool responses to fixed, non-recoverable tokens before the
# response reaches the agent, and optionally clamps oversized JSON-array results
# to blunt bulk exfil. Never denies. Callers in the placeholder `pii-full-read`
# IdP group receive the full unredacted/untruncated response; the group check
# fails closed, so a caller with missing claims gets over-redaction, never
# disclosure.
default allow := true

# -----------------------------------------------------------------------------
# Optional row-truncation guard. row_cap bounds how many rows a single result
# can return to the agent. When > 0, any content block that is a serialized JSON
# array longer than row_cap is clamped to the first row_cap elements (a notice
# element is appended). Set to 0 to disable truncation and run redaction only,
# or raise it toward the server's ~3,000-row cap. See Known limitations for the
# rows-as-JSON-array-elements caveat.
row_cap := 1000

# -----------------------------------------------------------------------------
# Scope: BigQuery result-returning tools across all four servers in the landscape
# inventory. The gateway prefixes tool names with the configured MCP server name
# (not standardized), so match by suffix, case-insensitively. Unlike the ingress
# SQL guard, the read-only tool IS matched here: a SELECT through
# execute_sql_readonly returns the same PII and must be redacted.
# -----------------------------------------------------------------------------

result_tool_suffixes := {
	"execute_sql", # Google official remote server + MCP Toolbox (also matches _readonly via its own entry)
	"execute_sql_readonly", # Google official read-only tool
	"query", # ergut/mcp-bigquery-server (also a suffix of execute-query)
	"execute-query", # LucasHild/mcp-server-bigquery
	"get_table_info", # official/Toolbox metadata tool — returns preview rows
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
# Group exemption — placeholder IdP group whose members receive the full
# response. Replace "pii-full-read" with your IdP's group name at import time.
# object.get chains mean a missing subject/claims/groups claim is never exempt:
# the grant fails closed and the transform applies.
# -----------------------------------------------------------------------------

exempt_groups := {"pii-full-read"}

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
# object IDs and raw phone digits, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# 16-digit card-shaped runs in 4x4 groups with optional space/hyphen separators.
# Candidates are only redacted after passing the Luhn check below — a matching
# shape alone is not enough.
card_pattern := `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b`

# Email addresses: local part, @, domain, dot, 2+ letter TLD. Unanchored (no
# \b, unlike the SSN and card patterns): the character class — which excludes
# quotes, commas, and braces — is what keeps it from eating adjacent JSON
# punctuation.
email_pattern := `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`

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

redact_emails(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

# Order: SSNs first, then Luhn-checked cards (digit groups), then emails. The
# three patterns are disjoint (SSN's 3-2-4 hyphenation cannot occur inside a
# 4x4 card, and neither contains an "@"), so ordering only guards against
# incidental overlap.
redact_block(b) := redact_emails(redact_cards(redact_ssn(b))) if { is_string(b) }

# Non-string content blocks pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Row truncation — clamps a content block that is a serialized JSON array longer
# than row_cap to the first row_cap elements, appending a notice element. Blocks
# that aren't oversized JSON arrays are returned unchanged.
# -----------------------------------------------------------------------------

truncation_notice := sprintf(
	"Result truncated to the first %d rows by gateway policy. Ask for the pii-full-read role or narrow the query if you need the full result set.",
	[row_cap],
)

truncate_block(b) := out if {
	row_cap > 0
	is_string(b)
	parsed := json.unmarshal(b)
	is_array(parsed)
	count(parsed) > row_cap
	out := json.marshal(array.concat(
		array.slice(parsed, 0, row_cap),
		[{"notice": truncation_notice}],
	))
}

capped_block(b) := truncate_block(b)

capped_block(b) := b if { not truncate_block(b) }

# -----------------------------------------------------------------------------
# Transform — truncation runs first, then redaction over the surviving rows.
# Emitted only when in scope, the caller is not exempt, and at least one block
# actually changed. Otherwise the rule is undefined and the aggregator skips this
# policy, returning the response byte-identical.
# -----------------------------------------------------------------------------

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

capped_blocks := [out |
	some block in text_blocks
	out := capped_block(block)
]

redacted_blocks := [out |
	some block in capped_blocks
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
```
