---
name: "Databricks: Redact PII in Tool Responses"
tags:
  - databricks
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
  # databricks / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `databricks.egress.redact_pii`

  ## What it does

  Scans the response payloads of the Databricks MCP tools that carry lakehouse
  data *back to the agent* and rewrites personally identifiable information to
  fixed redaction tokens before the response is delivered:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | canonical hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Email address | RFC-shaped `local@domain.tld`, word-boundary anchored | `[REDACTED-EMAIL]` |
  | US phone number | separator-formatted (e.g. `206-555-0100`, `(206) 555-0100`, `+1 206.555.0100`) | `[REDACTED-PHONE]` |

  Matches are replaced in place, leaving the surrounding row/column structure
  intact so the agent still gets a usable result set with only the sensitive
  values masked. The policy is transform-only: it never denies a call, so a
  legitimate query, Genie question, or index search still succeeds — it just
  comes back with SSN, email, and phone values masked. Responses with no matches
  (and all out-of-scope tools) pass through byte-identical. Every response field
  is read via `object.get`, so a missing or oddly-shaped payload is never an
  error — it simply passes through.

  ### Why these tools — the egress surface, not the submit call

  Databricks' SQL and Genie tools are **async pairs**: the submit call
  (`execute_sql`, `genie_ask`) returns only a statement/conversation handle, and
  the lakehouse rows arrive later through the **poll** response. So this policy
  deliberately targets the surfaces where data actually egresses:

  - **`poll_sql_result`** — the managed Databricks SQL server's async result
    tool (the rows land here, not in `execute_sql`).
  - **`genie_poll_response`** — the Genie One server's natural-language answer,
    grounded in Unity Catalog data.
  - **`execute_sql_query`** — the community `RafaelCartenet/mcp-databricks-server`
    **synchronous** SQL passthrough, which returns rows directly in one call.
  - **AI Search index tools** — the managed AI Search server's dynamic
    `{CATALOG}__{SCHEMA}__{INDEX}` (double-underscore) tools, whose vector
    indexes routinely hold support tickets and free-text documents laced with
    PII.

  This pairs with the ingress SQL/schema guards by design: **ingress limits what
  can be asked** (DML/DDL denial, schema fencing), **egress limits what actually
  leaks back** through the async poll and search surfaces. A read the ingress
  guard permits can still surface a regulated identifier in its rows — this is
  the layer that catches it.

  ### Group exemption

  Redaction is gated by IdP group. Callers whose `groups` claim contains
  `data-privacy` (a placeholder name — see Known limitations) receive
  **unredacted** responses. The check reads `input.subject.claims.groups` via
  `object.get` chains: a missing subject, missing claims, or missing `groups`
  claim means the caller is *not* exempt and redaction applies — the grant fails
  closed. This failure mode is safe: a caller whose claims fail to arrive gets
  over-redaction, never disclosure.

  ## Compliance alignment

  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based limits: only placeholder `data-privacy` group members see raw
    identifiers in lakehouse reads; everyone else gets a working result set with
    identifiers masked.
  - **HIPAA §164.514(a)–(b)** — supports de-identification practice by stripping
    Safe-Harbor identifier classes (SSN, email, phone) from responses;
    **§164.530(c)** — supports privacy safeguards on the agent channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data
    from the lakehouse; **Art. 9** — reduces special-category exposure on the
    MCP path where identifiers co-occur with health/HR columns or free-text
    support tickets; **Art. 5(1)(f) / Art. 32** — supports security of
    processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN) on the agent channel; **§1798.150** —
    reduces nonredacted-PI breach exposure.
  - **SOC 2 CC6.7** — supports restricting the transmission and movement of
    information: SSN, email, and phone values in lakehouse reads are redacted on
    the agent channel before they leave through the async poll and search
    responses.

  ## Why egress

  The PII already lives in the lakehouse — there is nothing to block at ingress
  on the read path, and denying the query or Genie question outright would make
  the agent useless for everyday analytics work. The leak happens when the rows
  or index hits are returned to the MCP client, so the response path is the only
  place to catch it while keeping the result useful. Ingress SQL guarding
  (DML/DDL/export denial, schema fencing) is a separate concern handled by
  companion policies (see Composition).

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to the data-returning
  Databricks tools, matched case-insensitively from `input.resource.name` with
  `input.tool_metadata.name` as a fallback (egress hooks may populate either).

  Two matching strategies are combined:

  - **Fixed snake_case verbs — matched by suffix** (the gateway prefixes tool
    names with the configured MCP server name, which is not standardised):
    - `poll_sql_result` — managed SQL async result (verified)
    - `genie_poll_response` — Genie One NL answer (verified)
    - `execute_sql_query` — community synchronous SQL passthrough (verified)
  - **Dynamic AI Search / UC-function tools — matched by shape.** Managed AI
    Search indexes (and UC function tools) are named
    `{CATALOG}__{SCHEMA}__{NAME}` with **double-underscore** delimiters. The
    policy matches any tool name that splits into **three or more** segments on
    `__` (i.e. contains at least two `__` delimiters). This is disjoint from the
    single-underscore fixed verbs above, so the two strategies never collide.

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each string block
  (including string blocks containing serialized JSON row data, since the
  regexes run over the serialized text). Non-string blocks pass through
  unmodified. When at least one block changes, the policy emits
  `transform.transformed_payload` containing the original payload with the
  rewritten `text` array (all other payload keys preserved). When nothing
  changes, no transform is emitted and the response passes through
  byte-identical.

  ## Examples

  ### Redacted (in-scope poll tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "databricks-poll_sql_result", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["analysts"] } },
      "payload": {
        "name": "databricks-poll_sql_result",
        "text": ["cust 42 | ssn 123-45-6789 | jane@acme.com | 206-555-0100"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["cust 42 | ssn [REDACTED-SSN] | [REDACTED-EMAIL] | [REDACTED-PHONE]"]`.

  ### Redacted (AI Search index — support ticket free-text)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "databricks-support__tickets__ticket_index", "type": "tool" },
      "payload": {
        "name": "databricks-support__tickets__ticket_index",
        "text": ["Ticket #88: reach the customer at jane@acme.com"]
      }
    }
  }
  ```

  `allow = true`, with the email rewritten to `[REDACTED-EMAIL]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "databricks-genie_poll_response", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["data-privacy"] } },
      "payload": {
        "name": "databricks-genie_poll_response",
        "text": ["The record lists SSN 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `data-privacy` group receives raw content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny/transform policies on the same egress pipeline. Recommended
  companions for `apps/databricks`:

  - **`mask-pan-egress` (PF-01)** — cardholder PAN masking (Luhn-validated, mask
    to BIN+last4) is intentionally **left to that companion policy** and is not
    handled here, so each policy stays single-purpose. Attach both for
    cardholder-data environments.
  - A **`guard-warehouse-sql`-style ingress deny** (PF-07) that blocks DML/DDL,
    `GRANT`/`REVOKE`, and export constructs in the SQL argument — so data
    redacted on read cannot be bulk-exported around the gateway instead.
  - A **sensitive-schema fence** (PF-23) on `execute_sql*` / `describe_uc_table`
    that limits *what can be asked* — the ingress half of this defense-in-depth
    pair.
  - A **`default-deny-unknown-tools`-style ingress allowlist** (PF-28) — the
    managed AI Search and UC-function tool names are dynamic and drift; a
    default-deny allowlist stops a newly-added result surface from silently
    reaching the agent unredacted.

  ## Known limitations

  - **Cardholder PAN is out of scope.** PAN detection/masking is deliberately
    delegated to the companion `mask-pan-egress` (PF-01) policy; this policy does
    not attempt Luhn validation or card masking. A Luhn-valid PAN in a result
    passes through untouched here.
  - **The single-space Genie server's tool name is unverified and not matched.**
    The landscape note records that the Genie Space (GA) server exposes a single
    Genie-invoke tool whose wire name **was not published in any verifiable
    doc**. Only Genie One's verified `genie_poll_response` is matched; if your
    deployment uses a Genie Space server, confirm its poll/answer tool name with
    the dump-input technique and add it to `fixed_result_suffixes`.
  - **The community `JustTryAI` synchronous `execute_sql` is not matched.** Its
    name shares the `execute_sql` stem with the managed *submit* tool (which
    egresses no data), so it is excluded to avoid firing on the submit surface.
    Only the community `execute_sql_query` (RafaelCartenet) synchronous
    passthrough is matched. If you run the `JustTryAI` server, pin its
    `execute_sql` in `fixed_result_suffixes`.
  - **Double-underscore matching also covers UC-function tools.** UC function
    tools share the `{CATALOG}__{SCHEMA}__{NAME}` shape with AI Search indexes,
    so their responses are redacted too. On egress this is safe over-application
    (redacting PII from a function's output never leaks), not a defect — but be
    aware the policy is not AI-Search-exclusive. A tool name with only a *single*
    `__` is not matched (it does not fit the three-segment dynamic shape).
  - **Managed AI Search / UC tool names are dynamic — pair with a default-deny
    allowlist.** Because these names are per-index/per-function and can change,
    a `default-deny-unknown-tools` allowlist (PF-28) is the right backstop so an
    unmatched result surface cannot silently leak.
  - **Pattern-based detection is best-effort and conservative by design.** SSNs
    are matched in the canonical hyphenated form only — bare 9-digit runs collide
    with row IDs and sequence values, and dot- or space-separated forms
    (`123.45.6789`, `123 45 6789`) are not matched; phones only in
    separator-formatted US shapes (`(206)555-0100` with no space after the
    parenthesis, tab-separated forms, and bare 10-digit runs are not matched);
    emails only when word-boundary anchored. Obfuscated, split-across-cells,
    spelled-out, full-width/unicode-digit, or non-US-formatted values are not
    caught. Treat this as a high-signal minimum-necessary layer, not a complete
    DLP solution.
  - **Characters glued directly to a value defeat the word-boundary anchors
    (red-team residual).** The SSN and phone patterns are `\b`-anchored, so a
    value with an extra digit or letter adjacent and no delimiter escapes
    detection: `123-45-67890` (SSN trailing digit), `id00123-45-6789` /
    `acct123-45-6789` (SSN leading digits/letters), `206-555-01000` (phone
    trailing digit), and — symmetrically — `1206-555-0100` / `id206-555-0100`
    (phone **leading** digit/letter glued to the area code) all pass through
    **unredacted**. This is a deliberate trade-off — dropping the anchors would
    emit partial redactions such as `[REDACTED-SSN]0` (which still leaks the
    extra digit) and fire false positives on longer numeric IDs. Where result
    columns concatenate identifiers without delimiters, rely on Unity Catalog
    column masking or a stricter companion policy rather than this egress
    backstop.
  - **The email pattern can over-match inside connection strings.** A
    `user:password@host.example.com` substring in a returned DSN/connection
    string matches the email shape and is redacted. On egress this is
    over-redaction (safe), not disclosure, but it can obscure legitimate
    non-email content — tune `email_pattern` if your result sets routinely
    contain such strings.
  - **Only `input.payload.text` is scanned — structured payload keys leak
    (red-team residual).** Redaction applies to string entries of
    `input.payload.text` (including serialized-JSON strings) and leaves non-string
    entries *within* that array unmodified — **including MCP object content blocks
    of the form `{"type":"text","text":"…"}`**: because such a block is an object,
    not a bare string, `redact_block` returns it as-is and any PII in its inner
    `text` field passes through **unredacted**. This policy assumes the gateway's
    documented egress shape — a flat array of plain strings (skill dump-input
    contract) — and does not descend into object blocks; if your gateway version
    delivers object content blocks instead of flattened strings, confirm the shape
    with the dump-input technique and treat this layer as inactive (pair with a
    PF-28 allowlist) until it emits a string array. It does **not** reach any other
    payload key: if your gateway delivers Databricks rows in a top-level
    `structuredContent` (or similar `structured_content` / `content` /
    `data`) object rather than as strings in `text`, the identifiers in that
    object pass through **unredacted** — an SSN in
    `payload.structuredContent.rows[…]` is not caught. The policy deliberately
    reads only the documented egress field (`payload.text`) rather than guessing
    at an undocumented structured shape and emitting a malformed rewrite. Verify
    where your gateway version actually places tabular Databricks results with the
    dump-input technique before relying on this layer, and pair it with a
    `default-deny-unknown-tools` allowlist (PF-28) so a result surface whose
    payload shape this policy cannot read is not silently reaching the agent.
  - **Group names are placeholders — replace `data-privacy` with your IdP's
    group name at import time.** The exemption expects the `groups` claim as an
    array of strings (a single bare string is also handled); if your IdP emits
    roles under a namespaced claim, adjust `caller_groups`. Missing claims always
    mean redaction applies — the failure mode is over-redaction, not disclosure.
    Never rely on stripped ContextForge-internal claims (`is_admin`, `teams`,
    `user`) for the exemption.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input technique
    before production, and mind attachment order if other egress transforms (e.g.
    `mask-pan-egress`) run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - databricks
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
package databricks.egress.redact_pii

# Transform-only egress policy: rewrites SSN, email, and phone patterns in the
# responses of the Databricks tools that carry lakehouse data back to the agent
# (managed SQL async result `poll_sql_result`, Genie One answer
# `genie_poll_response`, community synchronous `execute_sql_query`, and the
# dynamic AI Search `{CATALOG}__{SCHEMA}__{INDEX}` tools) to fixed redaction
# tokens before the response reaches the agent. Never denies — a legitimate
# query, Genie question, or search still succeeds, just with sensitive values
# masked. It pairs with the ingress SQL/schema guards: ingress limits what can be
# asked, egress limits what actually leaks back through the async poll and search
# surfaces. Callers in the placeholder `data-privacy` IdP group receive
# unredacted responses; the group check fails closed, so a caller with missing
# claims gets over-redaction, never disclosure. Cardholder PAN masking is left to
# the companion mask-pan-egress (PF-01) policy.
default allow := true

# -----------------------------------------------------------------------------
# Scope: the data-returning Databricks tools. The gateway prefixes tool names
# with the configured MCP server name (not standardised), so we match by suffix,
# case-insensitively. Data egresses in the POLL / synchronous-result responses,
# NOT in the submit call (`execute_sql`, `genie_ask`), which return only a
# handle — so the managed submit tools are intentionally excluded.
# -----------------------------------------------------------------------------

fixed_result_suffixes := {
    # Managed Databricks SQL server — verified: async result poll
    "poll_sql_result",
    # Genie One server — verified: natural-language answer poll
    "genie_poll_response",
    # Community RafaelCartenet server — verified: synchronous SQL passthrough
    "execute_sql_query",
}

# Candidate tool names: resource.name (PARC) and tool_metadata.name (egress
# fallback). Empty strings are dropped so an absent surface never matches "".
candidate_names := {n |
    some src in [
        object.get(object.get(input, "resource", {}), "name", ""),
        object.get(object.get(input, "tool_metadata", {}), "name", ""),
    ]
    src != ""
    n := lower(src)
}

# Fixed snake_case verbs, matched by suffix.
is_pii_result_tool if {
    input.mode == "output"
    some n in candidate_names
    some suffix in fixed_result_suffixes
    endswith(n, suffix)
}

# Dynamic AI Search / UC-function tools: named {CATALOG}__{SCHEMA}__{NAME} with
# double-underscore delimiters. A name that splits into 3+ segments on "__" has
# at least two "__" delimiters — the dynamic shape. This is disjoint from the
# single-underscore fixed verbs above, so the two strategies never collide.
is_pii_result_tool if {
    input.mode == "output"
    some n in candidate_names
    count(split(n, "__")) >= 3
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP group whose members receive unredacted
# responses. Replace "data-privacy" with your IdP's group name at import time.
# object.get chains mean a missing subject/claims/groups claim is never exempt:
# the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"data-privacy"}

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
# Detection patterns — anchored and conservative to limit false positives on
# free-text lakehouse columns and index documents.
# -----------------------------------------------------------------------------

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# row IDs and sequence values, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Email addresses, word-boundary anchored: local part, "@", domain, TLD of at
# least two letters. Conservative TLD class keeps it from firing on stray "@".
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone numbers (e.g. 206-555-0100, (206) 555-0100,
# +1 206.555.0100). Bare 10-digit runs are deliberately not matched. The 3-3-4
# grouping is disjoint from the SSN 3-2-4 grouping, so the two never collide.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)|\b\d{3})[-. ]\d{3}[-. ]\d{4}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_phone(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

redact_email(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

# Order: SSN first (fixed 3-2-4 shape), then phones (3-3-4, disjoint from SSN),
# then emails (contain "@", disjoint from both digit patterns). The redaction
# tokens contain no digits-with-separators or "@", so no step can re-match a
# token emitted by an earlier step.
redact_block(b) := redact_email(redact_phone(redact_ssn(b))) if {
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
