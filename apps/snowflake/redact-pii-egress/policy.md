---
name: "Snowflake: Redact PII from Query Result Sets"
tags:
  - snowflake
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
  # snowflake / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `snowflake.egress.redact_pii`

  ## What it does

  Scans the row content returned by the result-returning Snowflake MCP tools
  and rewrites personally identifiable information to fixed redaction tokens
  before the response reaches the agent:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | canonical hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Email address | RFC-shaped `local@domain.tld`, word-boundary anchored | `[REDACTED-EMAIL]` |
  | US phone number | separator-formatted (e.g. `206-555-0100`, `(206) 555-0100`, `+1 206.555.0100`) | `[REDACTED-PHONE]` |

  Matches are replaced in place, leaving the surrounding row/column structure
  intact so the agent still gets a usable result set with only the sensitive
  fields masked. The policy is transform-only: it never denies a call, so a
  legitimate query still succeeds — it just comes back with SSN, email, and
  phone values masked. Responses with no matches (and all out-of-scope tools)
  pass through byte-identical. Every response field is read via `object.get`,
  so a missing or oddly-shaped payload is never an error — it simply passes
  through.

  This is a **backstop for tables that lack Snowflake dynamic data masking
  policies**. A warehouse routinely holds regulated data (PII, PHI-eligible
  columns, financial records), and a `SELECT *` over a customer table can
  exfiltrate it wholesale; when a column has no column-level masking policy
  attached in Snowflake, this egress redaction is the last line of defence on
  the agent channel. It is intentionally narrow (three high-signal identifier
  classes) to limit false positives on free-text columns.

  ### Group exemption

  Redaction is gated by IdP group. Callers whose `groups` claim contains
  `pii-cleared` (a placeholder name — see Known limitations) receive
  **unredacted** responses. The check reads `input.subject.claims.groups` via
  `object.get` chains: a missing subject, missing claims, or missing `groups`
  claim means the caller is *not* cleared and redaction applies — the grant
  fails closed. This failure mode is safe: a caller whose claims fail to arrive
  gets over-redaction, never disclosure.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in query results as
    they leave the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the warehouse read path; **P4.1** — supports limiting
    personal-information use to identified purposes; **P6.1** — supports
    controls over personal-information disclosure by keeping raw identifiers
    out of agent context that doesn't need them.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based limits: only placeholder `pii-cleared` group members see raw
    identifiers; everyone else gets a working result set with identifiers
    masked.
  - **HIPAA §164.514(a)–(b)** — supports de-identification practice by
    stripping Safe-Harbor identifier classes (SSN, email, phone) from
    responses; **§164.530(c)** — supports privacy safeguards on the agent
    channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR columns; **Art. 5(1)(f) / Art. 32** —
    supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN) on the agent channel;
    **§1798.150** — reduces nonredacted-PI breach exposure.

  ## Why egress

  The PII already lives in the warehouse — there is nothing to block at
  ingress, and denying the query outright would make the agent useless for
  everyday analytics work. The leak happens when the result set is returned to
  the MCP client, so the response path is the only place to catch it while
  keeping the query result useful. Ingress SQL guarding (DML/DDL/export denial,
  schema fencing) is a separate concern handled by companion policies.

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to the
  result-returning Snowflake tools, matched case-insensitively **by suffix**
  from `input.resource.name` with `input.tool_metadata.name` as a fallback.
  Suffix matching keeps the policy portable across the gateway server-name
  prefix (which is not standardised — different deployments name the Snowflake
  MCP server differently).

  The suffix set combines **verified wire names** from the two open-source
  servers with the **tool-type constants** for the managed server:

  - **Community server (isaacwasserman) — verified wire name:** `read_query`
  - **Snowflake-Labs server — verified wire names:** `run_snowflake_query`,
    `query_semantic_views`
  - **Managed Snowflake MCP server — tool *type* identifiers, matched
    opportunistically:** `system_execute_sql`, `cortex_search_service_query`,
    `cortex_analyst_message`

  > **Important — managed-server names are not guaranteed to match.** On the
  > Snowflake-managed MCP server each tool has an **admin-chosen name** and a
  > fixed **type**; the type (`SYSTEM_EXECUTE_SQL`, `CORTEX_SEARCH_SERVICE_QUERY`,
  > `CORTEX_ANALYST_MESSAGE`) is **not visible on the wire at call time**. The
  > type constants are included in the suffix set so the policy fires for
  > deployments that happen to name tools after their type, but a managed
  > deployment that names its SQL tool `sales-sql` (or anything else) will
  > **not** be matched until you add that name. Pin your configured names in
  > `pii_result_suffixes` per the landscape guidance. See Known limitations.

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

  ### Redacted (in-scope tool, non-cleared caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "snowflake-read_query", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["analysts"] } },
      "payload": {
        "name": "snowflake-read_query",
        "text": ["cust 42 | ssn 123-45-6789 | jane@acme.com | 206-555-0100"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["cust 42 | ssn [REDACTED-SSN] | [REDACTED-EMAIL] | [REDACTED-PHONE]"]`.

  ### Passed through (cleared caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "snowflake-read_query", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["pii-cleared"] } },
      "payload": {
        "name": "snowflake-read_query",
        "text": ["cust 42 | ssn 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `pii-cleared` group receives raw
  content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes
  cleanly with deny/transform policies on the same egress pipeline. Recommended
  companions for `apps/snowflake`:

  - **`mask-pan-egress` (PF-01)** — cardholder PAN masking (Luhn-validated,
    mask to BIN+last4) is intentionally **left to that companion policy** and
    is not handled here. Attach both for cardholder-data environments.
  - A **`guard-warehouse-sql`-style ingress deny** (PF-07) that blocks DML/DDL,
    `GRANT`/`REVOKE`, and export constructs (`COPY INTO @`, external stages) in
    the SQL argument — so data redacted on read cannot be bulk-exported around
    the gateway instead.
  - A **`default-deny-unknown-tools`-style ingress allowlist** (PF-28) — on the
    managed server, tool names are admin-defined and drift; a default-deny
    allowlist stops a newly-added (unredacted) result tool from silently
    reaching the agent.
  - A **`cap-bulk-export`-style ingress guard** (PF-08) that clamps result
    `limit`, bounding the blast radius of any redaction miss.

  ## Known limitations

  - **Managed-server tool names are admin-chosen — the type constants are a
    best-effort, not a guarantee.** The Snowflake-managed MCP server names each
    tool arbitrarily; the tool *type* (`SYSTEM_EXECUTE_SQL`,
    `CORTEX_SEARCH_SERVICE_QUERY`, `CORTEX_ANALYST_MESSAGE`) is not on the wire
    at call time. This policy matches those type constants opportunistically,
    but a managed deployment that names its SQL/Cortex tools anything else
    (e.g. `sales-sql`, `product-search`) is **not** covered until you add the
    configured names to `pii_result_suffixes`. Pair this with a
    `default-deny-unknown-tools` allowlist so an unmatched result tool cannot
    silently leak.
  - **`CORTEX_AGENT_RUN` and `GENERIC` tools are not matched.** Cortex Agent
    invocations run opaque multi-step plans server-side and `GENERIC` tools
    wrap arbitrary UDFs/procedures; their response shapes are not
    predictable. Deny those tools at ingress rather than relying on egress
    redaction (see the landscape note).
  - **Cardholder PAN is out of scope.** PAN detection/masking is deliberately
    delegated to the companion `mask-pan-egress` (PF-01) policy; this policy
    does not attempt Luhn validation or card masking.
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
    detection: `123-45-67890` (SSN with a trailing digit), `id00123-45-6789`
    (leading digits), `nameX123-45-6789` (letter-prefixed), and `206-555-01000`
    (phone with a trailing digit) all pass through **unredacted**. This is a
    deliberate trade-off — dropping the boundary anchors would emit partial
    redactions such as `[REDACTED-SSN]0` (which still leaks the extra digit) and
    fire false positives on longer numeric IDs. Where result columns concatenate
    identifiers without delimiters, rely on column-level masking in Snowflake or
    a stricter companion policy rather than this egress backstop.
  - **The email pattern can over-match inside connection strings.** A
    `user:password@host.example.com` substring in a returned DSN/connection
    string matches the email shape and is redacted. On egress this is
    over-redaction (safe), not disclosure, but it can obscure legitimate
    non-email content — tune `email_pattern` if your result sets routinely
    contain such strings.
  - **Non-string content blocks pass through unmodified.** Redaction applies to
    string entries of `input.payload.text` (including serialized-JSON strings).
    If your gateway emits structured non-string blocks for Snowflake results,
    verify their shape with the dump-input technique.
  - **Group names are placeholders — replace `pii-cleared` with your IdP's
    group name at import time.** The exemption expects the `groups` claim as an
    array of strings (a single bare string is also handled); if your IdP emits
    roles under a namespaced claim, adjust `caller_groups`. Missing claims
    always mean redaction applies — the failure mode is over-redaction, not
    disclosure. Never rely on stripped ContextForge-internal claims
    (`is_admin`, `teams`, `user`) for the exemption.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms (e.g. `mask-pan-egress`) run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - snowflake
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package snowflake.egress.redact_pii

# Transform-only egress policy: rewrites SSN, email, and phone patterns in the
# result sets returned by Snowflake's result-returning MCP tools to fixed
# redaction tokens before the response reaches the agent. Never denies — a
# legitimate query still succeeds, just with sensitive fields masked. A backstop
# for tables that lack Snowflake dynamic data masking policies. Callers in the
# placeholder `pii-cleared` IdP group receive unredacted responses; the group
# check fails closed, so a caller with missing claims gets over-redaction, never
# disclosure. Cardholder PAN masking is left to the companion mask-pan-egress
# (PF-01) policy.
default allow := true

# -----------------------------------------------------------------------------
# Scope: the result-returning Snowflake tools. The gateway prefixes tool names
# with the configured MCP server name (not standardised), so we match by
# suffix, case-insensitively.
#
# The first three are VERIFIED wire names from the two open-source servers. The
# last three are the managed server's tool-TYPE identifiers, which are NOT
# guaranteed to be the wire name (managed-server tools are admin-named and the
# type is not visible at call time) — they are matched opportunistically. Pin
# your managed/Cortex deployment's actual tool names here. See the policy's
# Known limitations.
# -----------------------------------------------------------------------------

pii_result_suffixes := {
    # Community server (isaacwasserman) — verified: SELECT-only query tool
    "read_query",
    # Snowflake-Labs server — verified: SQL passthrough + semantic-view read
    "run_snowflake_query",
    "query_semantic_views",
    # Managed server — tool-TYPE constants (see note above), not guaranteed names
    "system_execute_sql",
    "cortex_search_service_query",
    "cortex_analyst_message",
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
# responses. Replace "pii-cleared" with your IdP's group name at import time.
# object.get chains mean a missing subject/claims/groups claim is never
# cleared: the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"pii-cleared"}

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
# free-text warehouse columns.
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
# Transform — emitted only when in scope, the caller is not cleared, and at
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
    is_pii_result_tool
    not is_exempt
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
