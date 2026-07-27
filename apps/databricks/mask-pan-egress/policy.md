---
name: "Databricks: Mask Cardholder PANs in Responses"
tags:
  - databricks
  - mask-pan-egress
  - egress
  - cardholder-data
  - dlp
  - soc2
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # databricks / mask-pan-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `databricks.egress.mask_pan`

  ## What it does

  Masks payment-card numbers (PANs) in Databricks tool responses before the
  agent receives them. Lakehouse tables routinely hold cardholder data, and a
  PAN surfaces in the *response* payload of the async SQL/Genie poll tools and
  the free-text AI Search index tools — not in the submit call. This egress
  policy Luhn-validates every 13-to-19-digit card-shaped candidate in the
  response and rewrites each confirmed PAN to **BIN-plus-last4**: the first six
  digits (the issuer BIN) and the last four are kept, and every digit between is
  replaced with `*`, e.g. `4111 1111 1111 1111` → `411111******1111`. BIN+last4
  is the maximum display format PCI DSS permits for personnel without a business
  need to see the full PAN.

  Luhn validation keeps the false-positive rate far below a bare digit-length
  regex: ordinary long numbers (order IDs, row counts, epoch timestamps, join
  keys) fail the checksum and are left intact, so only numbers that actually
  satisfy the card-number check digit are masked.

  The policy never blocks a call. When at least one PAN is found the response
  content blocks are rewritten via `transformed_payload`; when nothing matches,
  the `transform` rule is undefined and the response passes through
  byte-identical.

  Callers whose `input.subject.claims.groups` contains the documented
  placeholder group `pci-full-pan` receive unmasked responses. The exemption is
  fail-closed: a caller with no subject, no claims, no `groups` claim, or a
  malformed `groups` claim is never exempt and always gets masked output.

  ## Compliance alignment

  - **PCI DSS 3.4.1** — supports masking of PAN when displayed: the agent
    channel shows at most BIN+last4, with full-PAN visibility limited to a
    defined role (`pci-full-pan`).
  - **PCI DSS 3.4.2** — supports preventing PAN copy/relocation via
    remote-access technologies: an agent that only ever receives the masked
    form of a query result cannot re-post the full PAN into other tools,
    tickets, notebooks, or files.
  - **PCI DSS 12.10.7** — supports PAN-where-not-expected incident procedures:
    a PAN returned from an unexpected lakehouse column is a classic trigger, and
    the gateway's decision/transform audit events for this policy give the
    incident process a concrete signal to work from.
  - **CCPA/CPRA §1798.150** — supports reducing nonredacted-PI breach exposure:
    card numbers read out of the lakehouse are masked before they reach the
    agent by default.
  - **SOC 2 CC6.7** — supports restricting the transmission and movement of
    information: cardholder PANs read out of the lakehouse are masked to
    BIN+last4 on the agent channel before they can be moved into other tools,
    tickets, notebooks, or files.

  This family also aligns with **ISO/IEC 27001 A.8.11 (data masking)** on the
  MCP read path, and complements — rather than duplicates — SSN/email/phone
  redaction (see Composition).

  ## Tool name matching

  The policy scopes to the Databricks surfaces that return row/document data in
  their response, matched case-insensitively on the tool name after normalizing
  `_` to `-` so both underscore (as the servers publish them) and hyphenated (as
  some gateways deliver them) forms match. The tool name is resolved from
  `input.resource.name` (PARC), then `input.tool_metadata.name`, then
  `input.payload.name` — all three carry the same value on `tool_post_invoke`, and
  taking whichever is populated keeps the scope check from failing open on a
  gateway that omits `resource.name` on egress (the pre-PARC path). The surfaces:

  - **`poll_sql_result`** — the managed Databricks SQL server's async result
    tool. The `execute_sql` / `execute_sql_read_only` submit calls return only a
    statement handle; the row data egresses here, so this is the tool to mask
    (verified name — Databricks docs + community article).
  - **`genie_poll_response`** — the Genie One (Beta) async answer tool. Genie
    answers are grounded in Unity Catalog data, so this is the natural-language
    exfiltration path for the same tables (verified name — Databricks docs).
  - **`execute_sql_query`** — the community `RafaelCartenet/mcp-databricks-server`
    synchronous SQL passthrough, which returns rows directly in its own response
    (verified name — that server's source).
  - **AI Search index tools** — the managed AI Search server exposes one tool
    per index, named dynamically `{CATALOG}__{SCHEMA}__{INDEX_NAME}` with a
    **double underscore** between segments. These indexes frequently hold support
    tickets and documents with free-text card numbers. Because the exact names
    are per-deployment (the double-underscore scheme is documented but the
    concrete names are not), the policy matches any tool whose name contains
    `__` as an AI Search index tool.

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `databricks-sql-poll_sql_result`), and that prefix is not standardized —
  suffix matching on the fixed verbs and the `__` signature for AI Search keep
  the policy portable. Verify the exact names your gateway sends with the
  dump-input debug technique before relying on this in production.

  Deliberately **out of scope:** `execute_sql` / `execute_sql_read_only`
  (managed) return a handle, not data; `genie_ask` and the SQL submit tools are
  ingress-side; metadata tools (`describe_uc_table`, `list_uc_catalogs`,
  `list_clusters`, …) do not return card data.

  ## Patterns matched

  Conservative, anchored PAN shapes only — each is commented in the Rego, and
  every candidate must additionally pass the Luhn check before it is masked:

  - 16-digit PANs grouped 4-4-4-4 with space or dash separators
    (Visa/Mastercard/Discover print format).
  - 15-digit American Express PANs grouped 4-6-5, constrained to the 34/37 IIN
    range.
  - Unseparated 13-19-digit runs (the ISO/IEC 7812 PAN length range) — the
    dominant shape for a PAN stored in a lakehouse column and serialized into a
    SQL result. Runs of 20+ digits never match: there is no word boundary inside
    a digit run, so a longer identifier is never partially masked.

  ## Response shape

  Egress tool output arrives as content blocks in `input.payload.text` (an
  array; entries are typically strings of plain text, markdown, or serialized
  JSON — a `poll_sql_result` result set is a JSON string block). The policy scans
  each string block, replaces every Luhn-valid match with its own BIN+last4
  form, and emits `transform.transformed_payload` with the original payload's
  `text` replaced by the masked blocks. Non-string blocks pass through
  unmodified. Because matching is string-level, PANs are masked wherever they
  appear — result rows, Genie answer prose, AI Search snippets — without parsing
  each tool's specific JSON shape.

  ## Examples

  ### Transformed (masked)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "databricks-sql-poll_sql_result", "type": "tool" },
      "payload": {
        "name": "databricks-sql-poll_sql_result",
        "text": ["{\"rows\":[[\"acct-889\",\"4111 1111 1111 1111\"]]}"]
      },
      "subject": { "sub": "google-apps|casey@acme.com", "claims": { "groups": ["support"] } }
    }
  }
  ```

  `allow = true`; the agent sees the row with `411111******1111`.

  ### Allowed unmasked (exempt group)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "databricks-sql-poll_sql_result", "type": "tool" },
      "payload": {
        "name": "databricks-sql-poll_sql_result",
        "text": ["{\"rows\":[[\"acct-889\",\"4111111111111111\"]]}"]
      },
      "subject": { "sub": "google-apps|pci-analyst@acme.com", "claims": { "groups": ["pci-full-pan"] } }
    }
  }
  ```

  `allow = true`, no transform — the caller is in the `pci-full-pan` group.

  ### Passthrough (no PAN)

  A Luhn-invalid digit run (a row count, an epoch timestamp, an order number)
  produces no transform; the response is returned byte-identical.

  ## Composition

  One policy, one job. This policy masks **cardholder PANs only**; it is designed
  to run alongside — not merge with — the other Databricks egress family:

  - [`redact-pii-egress`](../redact-pii-egress/policy.md) (egress) handles SSN,
    email, and phone. Keeping PAN separate lets the two families use different
    exemption groups (PCI full-PAN role vs. a privacy role) and independent
    tuning. Attach both to the same egress direction for round-trip coverage.
  - [`guard-warehouse-sql`](../guard-warehouse-sql/policy.md) (ingress) blocks
    DML/DDL and forces read-only SQL; this policy masks card data in the results
    of the reads you do allow.
  - A `default-deny-unknown-tools` (PF-28) ingress policy is recommended
    alongside AI Search / UC-function deployments, since those tool names are
    dynamic.

  ## Known limitations

  - **Luhn-valid non-card numbers are masked too.** The Luhn check eliminates
    most row counts, timestamps, and IDs, but some non-card identifiers (certain
    IMEIs and other checksummed numbers) are Luhn-valid and will be masked. The
    masked form keeps first-six/last-four, so such false positives usually stay
    recognizable.
  - **Obfuscated PANs are missed.** Card numbers with separators other than
    space/dash (dots, unicode spaces), split across lines or content blocks,
    spelled out in words, or base64-encoded do not match. Card numbers typed
    with non-ASCII digits (e.g. Unicode fullwidth) also do not match: the RE2
    `\d` class is ASCII-only. Grouped formats other than 4-4-4-4 and Amex 4-6-5
    match only in their unseparated form.
  - **A PAN glued directly to a word character is missed.** Every pattern is
    `\b`-anchored, and the underscore counts as a word character in RE2, so a
    digit run immediately preceded or followed by a letter, digit, or underscore
    with no separator (e.g. `acct_4111111111111111`) has no word boundary and is
    not masked. This is the deliberate cost of the same `\b` anchoring that stops
    a 20+-digit identifier from being partially masked. The same applies to a
    **grouped** PAN with a stray digit glued to its first or last group (e.g.
    `4000 0000 0000 00021` or `94000 0000 0000 0002`): the grouped pattern's
    leading/trailing `\b` fails, and the single-space separators break the run
    below the 13-contiguous-digit floor of the unseparated pattern, so the whole
    PAN-shaped string passes through unmasked.
  - **The `__` AI-Search signature also matches non-index tools whose gateway
    server name contains `__`.** The AI Search branch puts any tool whose resolved
    name contains a double underscore in scope. If you name an MCP server with a
    `__` in it (e.g. `my__srv`), even its metadata/SQL tools (`list_clusters`,
    `execute_sql`, …) are pulled into scope and their responses are scanned and
    masked. This is over-masking, not a leak — the policy only ever masks
    Luhn-valid card shapes and never denies — but it can surprise. Avoid `__` in
    gateway server names, or pin the concrete AI Search tool names and drop the
    `__` heuristic if the collateral scanning is unwanted.
  - **Adjacent digit groups can shadow a grouped PAN.** In pathological
    sequences like `1234 5678 4111 1111 1111 1111`, the leftmost 4-4-4-4 window
    is consumed first (and fails Luhn), so the real PAN inside it is not matched.
    Unseparated PANs are unaffected.
  - **Substring collisions between two detected PANs.** Replacements are applied
    per distinct matched string in unspecified order; if one detected PAN is a
    literal substring of another in the same block (both Luhn-valid), more than
    BIN+last4 of the longer one can remain visible. Middle digits of every match
    still get masked.
  - **Structured (non-string) content blocks and non-array `text` are not
    masked — fail-open.** The policy scans and rewrites only string entries of
    `input.payload.text`, and only when `text` is a JSON array. A PAN carried
    inside a content block delivered as a JSON *object*, or a `payload.text`
    delivered as a bare string, passes through unmasked. In the DTwo egress shape
    observed to date tool output arrives as an array of *string* blocks, and
    serialized JSON inside a string block **is** scanned; only native object
    shapes and non-array `text` evade it. Confirm your gateway/server delivers
    string blocks with the dump-input technique before relying on this.
  - **The synchronous community `execute_sql` is not covered.** This policy
    matches `execute_sql_query` (RafaelCartenet) but not the `JustTryAI`
    server's synchronous `execute_sql`, to avoid colliding with the managed
    `execute_sql` submit tool (which returns only a handle). If you run the
    JustTryAI server, add its `execute_sql` suffix to `content_tool_suffixes`.
  - **The Genie Space (GA) single-invoke tool is not covered.** Only Genie
    *One* (Beta) is masked, via its async `genie_poll_response` egress tool. The
    GA-track Genie *Space* server (`/api/2.0/mcp/genie/{space_id}`) exposes a
    single synchronous invoke tool that returns the Unity-Catalog-grounded answer
    inline in its own response — but its name is **not published**, does not end
    in `poll-sql-result` / `genie-poll-response` / `execute-sql-query`, and
    carries no `__` signature, so it is out of scope and its responses pass
    through **unmasked**. Because it is GA (Genie One is still Beta), it is the
    more likely production surface. Do not assume "Genie is covered": once you
    learn the concrete tool name for your space with the dump-input technique,
    add its suffix to `content_tool_suffixes`, and run the
    `default-deny-unknown-tools` (PF-28) companion (see Composition) so a new or
    unpinned Genie/AI-Search tool is denied rather than silently leaking.
  - **Egress masking only.** The full card number still exists in the lakehouse
    and in the Databricks UI; this policy controls what the *agent* sees on the
    MCP path.
  - **Tool names are partly unverified.** `poll_sql_result`,
    `genie_poll_response`, and `execute_sql_query` are verified from the
    landscape research; the AI Search per-index tool name is **not published**
    (the double-underscore scheme is documented but the concrete name is
    per-deployment), so the `__` match is a heuristic — verify with dump-input.
  - **Group names are placeholders** — replace `pci-full-pan` with your IdP's
    group name at import time. The exemption reads `input.subject.claims.groups`
    and requires it to be an **array** of strings; every other shape (string,
    object, number, null, or missing) fails closed to masked output. Confirm
    your IdP emits a `groups` claim as a string array for your tenant before
    relying on the exemption.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - databricks
industries: []
bundles:
  - soc2
  - pci-dss
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package databricks.egress.mask_pan

# Transform-only policy — never denies, only masks Luhn-valid card numbers in
# Databricks result/answer/search responses to BIN+last4.
default allow := true

# -----------------------------------------------------------------------------
# Tool matching — Databricks surfaces that return row/document data in their
# response. The gateway prefixes tool names with the configured server name, so
# we match on the suffix to stay portable. Suffixes are hyphenated; the incoming
# name is normalized `_` -> `-` first so both `poll_sql_result` and
# `poll-sql-result` deliveries match.
# -----------------------------------------------------------------------------

content_tool_suffixes := [
    # Managed Databricks SQL server: async result of execute_sql* (data egresses
    # here, not in the submit call).
    "poll-sql-result",
    # Genie One (Beta): async NL->SQL answer payload.
    "genie-poll-response",
    # Community RafaelCartenet/mcp-databricks-server: synchronous SQL passthrough
    # that returns rows directly in its own response.
    "execute-sql-query",
]

# The egress tool name can arrive under resource.name (PARC), tool_metadata.name
# (the legacy egress-only source), or payload.name — all three carry the same
# value. Collect every populated form (lowercased) so a gateway that does not
# populate resource.name on egress (the pre-PARC path) still scopes correctly
# instead of failing open and masking nothing.
tool_name_candidates := [lower(raw) |
    some raw in [
        object.get(object.get(input, "resource", {}), "name", ""),
        object.get(object.get(input, "tool_metadata", {}), "name", ""),
        object.get(object.get(input, "payload", {}), "name", ""),
    ]
    raw != ""
]

# Suffixes are hyphenated; each candidate is normalized `_` -> `-` before the
# suffix compare so both `poll_sql_result` and `poll-sql-result` deliveries match.
is_in_scope_tool if {
    some cand in tool_name_candidates
    some suffix in content_tool_suffixes
    endswith(replace(cand, "_", "-"), suffix)
}

# AI Search index tools are named dynamically `{CATALOG}__{SCHEMA}__{INDEX_NAME}`
# with a double underscore between segments. The concrete names are
# per-deployment, so we match any tool whose name carries that `__` signature.
is_in_scope_tool if {
    some cand in tool_name_candidates
    contains(cand, "__")
}

# -----------------------------------------------------------------------------
# PAN candidate shapes — anchored with \b word boundaries so digit runs inside
# longer identifiers are never partially matched. Every candidate must also pass
# the Luhn check below before it is masked.
# -----------------------------------------------------------------------------

pan_pattern := concat("|", [
    # 16-digit PANs grouped 4-4-4-4 with space or dash separators
    # (Visa / Mastercard / Discover print format, e.g. 4111 1111 1111 1111).
    `\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b`,
    # 15-digit American Express PANs grouped 4-6-5 with space or dash separators,
    # constrained to the 34/37 IIN range (e.g. 3782 822463 10005).
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

# -----------------------------------------------------------------------------
# Masking — each match is rewritten to BIN+last4: first six digits (issuer BIN)
# and last four kept, everything between masked with `*`. Separators are dropped
# in the masked form (e.g. `4111 1111 1111 1111` -> `411111******1111`).
# -----------------------------------------------------------------------------

mask_pan(c) := masked if {
    d := digits_only(c)
    n := count(d)
    masked := concat("", [
        substring(d, 0, 6),
        # Replace every middle digit with `*` (RE2 has no repeat builtin, so we
        # mask the middle substring char-by-char instead of building a `*` run).
        regex.replace(substring(d, 6, n - 10), `\d`, "*"),
        substring(d, n - 4, 4),
    ])
}

# Rewrite every Luhn-valid candidate in a string block to its masked form.
mask_block(b) := out if {
    is_string(b)
    replacements := {c: mask_pan(c) | some c in pan_candidates(b)}
    count(replacements) > 0
    out := strings.replace_n(replacements, b)
}

mask_block(b) := b if {
    is_string(b)
    count(pan_candidates(b)) == 0
}

# Non-string content blocks (structured/JSON object blocks) pass through
# unmodified.
mask_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Full-PAN exemption — callers in the placeholder group see unmasked content.
# Fail-closed: missing subject, missing claims, missing groups, or a malformed
# groups claim all leave this rule undefined, so masking applies. The is_array
# guard is load-bearing: without it a groups claim shaped as an object (e.g.
# {"role":"pci-full-pan"}) would iterate its *values* and match, granting the
# exemption to a caller who never held the group in an array. Requiring an array
# keeps every non-array shape (string, object, number, null) fail-closed.
# Replace "pci-full-pan" with your IdP's group name at import time.
# -----------------------------------------------------------------------------

caller_may_view_full_pan if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some group in groups
    group == "pci-full-pan"
}

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, the caller is not exempt, and at least
# one block actually changed. Otherwise the rule is undefined and the aggregator
# skips this policy, returning the response byte-identical.
# -----------------------------------------------------------------------------

text_blocks := object.get(input.payload, "text", [])

masked_blocks := [out |
    some block in text_blocks
    out := mask_block(block)
]

transform := {
    "transformed_payload": object.union(input.payload, {"text": masked_blocks}),
} if {
    input.mode == "output"
    is_in_scope_tool
    not caller_may_view_full_pan
    is_array(text_blocks)
    masked_blocks != text_blocks
}
```
