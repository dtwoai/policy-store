---
name: Fence Snowflake Sensitive Schemas by Data Domain
tags:
  - snowflake
  - fence-sensitive-scopes
  - ingress
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # snowflake / fence-sensitive-schemas

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny sensitive-domain references for callers outside the mapped group, allow otherwise
  **Package:** `snowflake.ingress.fence_sensitive_schemas`

  ## What it does

  Fences customer-designated sensitive data domains inside a Snowflake warehouse by
  inspecting the SQL text the agent is about to run — not by tool name, which on
  Snowflake carries no stable semantics (see Tool name matching). The policy carries one
  placeholder map, `sensitive_domains`, pairing a **schema/table name prefix** with the
  IdP group required to touch that domain:

  - `PII_` → `pii-cleared`
  - `PHI_` → `phi-cleared`
  - `HR_` → `hr`
  - `FINANCE_` → `finance`

  It reads two argument shapes and applies two independent controls at ingress:

  - **Domain fence (group-gated).** It scans the SQL `query` (and `statement`) argument and
    the natural-language `message` argument (`CORTEX_ANALYST_MESSAGE`, best-effort) for any
    identifier beginning with a fenced prefix (e.g. `PHI_LABRESULTS`,
    `ANALYTICS.FINANCE_LEDGER`). If a fenced prefix is referenced and the caller's
    `input.subject.claims.groups` does **not** include the mapped group, the call is denied.
  - **`SELECT *` fence (outright).** If the SQL text performs a star-select
    (`SELECT *`, `SELECT DISTINCT *`, `SELECT ALL *`, `SELECT TOP <n> *`, the no-space
    `SELECT*`, or a table-qualified `SELECT c.*`) **and** references any
    fenced prefix, the call is denied for **everyone** — including cleared callers — forcing an
    explicit column list. This makes the agent state its intent and stops it from sweeping every
    column of a regulated table in a single call.

  Group membership is read through `object.get` chains and fails closed: a missing, empty, or
  malformed `subject`/`claims`/`groups` never grants a fenced domain (no group → not exempt).
  Calls carrying no `query`/`statement`/`message` argument (e.g. `list_databases`,
  `describe_table`) are not inspected and pass through untouched.

  ## Compliance alignment

  - **HIPAA §164.502(b)/§164.514(d)** — supports the minimum-necessary and role-based-limits
    standard: agent access to a PHI-bearing domain is gated to its mapped group on the MCP path,
    and the `SELECT *` fence forces column-level intent so a call cannot pull more PHI than named;
    **§164.308(a)(4)** — supports information access management by authorizing sensitive-domain
    access via IdP group; **§164.522(a)** — the domain map can encode agreed-to restrictions on
    specific regulated schemas.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored cardholder data
    by role: fence the `FINANCE_`/CHD prefix so only the mapped group can query it through an agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential information by gating
    agent SQL against designated confidential domains; **P4.1** — supports limiting personal-
    information use to identified purposes by keeping PI-bearing schemas behind role fences.
  - **GDPR Art. 9** — supports special-category protection by fencing schemas holding health, HR,
    or other Art. 9 data; **CPRA §1798.121** — supports the right to limit use of sensitive
    personal information by fencing SPI schemas to a minimal group; **GDPR Art. 5(1)(b)** —
    supports purpose limitation on the agent channel.

  ## Why ingress and least-privilege

  This is the minimum-necessary / least-privilege control for the warehouse's data plane: it stops
  a regulated-schema read before it executes, rather than masking a response the query already
  produced. It pairs with an **egress redaction backstop** (see Composition) for defense in depth —
  because which specific tables hold regulated data is not knowable from the wire, egress redaction
  catches leaks from schemas an operator has not yet pinned here.

  ## Tool name matching

  **This policy does not match tool names.** Snowflake MCP servers expose the dangerous surface as a
  SQL string inside a single argument, and there are no stable canonical tool names: the managed
  server's tools are admin-named (semantics live in a `type` that is not visible on the wire), the
  Labs server derives Cortex tool names from config, and each community/Labs SQL tool takes the SQL
  as an argument. Matching tool names would therefore be neither portable nor sound. Instead the
  policy inspects the **arguments** every SQL/analyst tool uses:

  - SQL execution/read tools (`run_snowflake_query`, `read_query`, `write_query`, `create_table`,
    and the managed server's SQL-execution tool) take the SQL text under `query` (a `statement` key
    is also checked defensively).
  - Cortex Analyst tools (`CORTEX_ANALYST_MESSAGE`-typed) take a natural-language `message`.

  Any call carrying none of these arguments is not inspected. Verify your server's argument names
  with the dump-input debug technique before relying on this in production.

  ## Argument shape

  - `query` / `statement` — the SQL text (string). Scanned for fenced prefixes and for `SELECT *`.
  - `message` — the Cortex Analyst natural-language string. Scanned for fenced prefixes only
    (best-effort; a star-select has no meaning in NL).

  ## Examples

  ### Allowed — cleared caller, explicit columns

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-run_snowflake_query", "type": "tool" },
      "subject": { "sub": "google-apps|nurse@example.com", "claims": { "groups": ["phi-cleared"] } },
      "payload": {
        "name": "snowflake-run_snowflake_query",
        "args": { "query": "SELECT patient_id, visit_date FROM PHI_RECORDS WHERE patient_id = 42" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — uncleared caller references a fenced domain

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-run_snowflake_query", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "snowflake-run_snowflake_query",
        "args": { "query": "SELECT customer_id, email FROM PII_CUSTOMERS WHERE id = 5" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Access to the 'PII_' sensitive data domain requires the 'pii-cleared' IdP group. (...)"`.

  ### Denied — `SELECT *` on a fenced schema, even for a cleared caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-run_snowflake_query", "type": "tool" },
      "subject": { "sub": "google-apps|analyst@example.com", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "snowflake-run_snowflake_query",
        "args": { "query": "SELECT * FROM FINANCE_LEDGER" }
      }
    }
  }
  ```

  `allow = false`, `reason = "SELECT * against a fenced sensitive schema is not allowed (...)"`.

  ## Composition

  This policy is single-purpose. Curated companions for the Snowflake data plane:

  - **`guard-warehouse-sql` (ingress)** — deny DDL/DML/`GRANT` and bulk-export constructs
    (`COPY INTO @`, `CREATE STAGE`) so a fenced-out caller cannot pivot to exfiltration.
  - **`redact-pii-egress` (egress)** — redact SSN/PAN/email patterns from returned rows: the
    defense-in-depth backstop for regulated tables that have not yet been pinned into
    `sensitive_domains`, and for Cortex results this policy inspected only best-effort.
  - **`default-deny-unknown-tools` (ingress)** — allowlist the audited Snowflake tool names so an
    admin-renamed or newly-added tool cannot introduce an uninspected SQL path.

  ## Known limitations

  - **Placeholder configuration.** The prefixes (`PII_`, `PHI_`, `HR_`, `FINANCE_`) and group names
    (`pii-cleared`, `phi-cleared`, `hr`, `finance`) are placeholders — replace them with your real
    schema/table naming convention and your IdP's group-claim values at import time. Which tables
    hold regulated data is **not** knowable from the wire (per the Snowflake landscape note), so
    pinning the naming convention is mandatory for this policy to do anything.
  - **Convention-dependent, not ancestry-aware.** Detection keys on a prefix at an identifier
    boundary (`\bPREFIX`), so it fences a regulated domain only when its tables/schemas actually
    carry the pinned prefix. A regulated table that does not follow the naming convention
    (`CUSTOMERS_PII`, `patient_data`) is **not** fenced. Enforce the naming convention in Snowflake,
    and rely on the egress redaction backstop for the residual.
  - **`SELECT *` detection is regex-based.** It catches `SELECT *`, `SELECT DISTINCT *`,
    `SELECT ALL *`, `SELECT TOP <n> *` (and combinations of those leading set-quantifier /
    row-limit tokens), table-qualified `SELECT alias.*`, and the no-space `SELECT*` form.
    Exotic forms still evade it: a `*` produced by a view, a comment or hint between `SELECT`
    and `*` (`SELECT /*x*/ * FROM ...`), or every column enumerated by name (arithmetic
    `col * 2` is *not* flagged and is not a leak). The domain group-fence still applies to
    uncleared callers regardless; only a **cleared** caller could evade the star-select fence,
    and the egress backstop remains. A `*` reference inside a string literal may cause a
    conservative (fail-safe) denial.
  - **Prefix detection can be evaded by identifier obfuscation.** Detection matches the literal
    fenced prefix at an identifier boundary in the wire text. A caller who constructs the
    identifier dynamically — e.g. Snowflake `IDENTIFIER('PII' || '_CUSTOMERS')` with the prefix
    split across concatenated string literals, or a variable/session bind — references the fenced
    table without the contiguous prefix ever appearing, so the domain fence does **not** fire and
    the call is allowed. This is a fundamental limit of wire-level SQL inspection. Pair with
    `guard-warehouse-sql` (to deny/scope dynamic-SQL constructs) and keep the egress redaction
    backstop in place; treat the ingress fence as one layer, not the sole control.
  - **`message` inspection is best-effort.** Cortex Analyst turns natural language into SQL
    server-side; the gateway sees only the NL `message`. This policy fences an NL request that
    literally names a fenced prefix, but cannot see the SQL the semantic model ultimately generates.
    Deny or tightly scope Cortex Analyst/Agent tools (see `default-deny-unknown-tools`) if that
    residual is unacceptable, and keep the egress redaction backstop in place.
  - **Composite/opaque tools not reached.** `CORTEX_AGENT_RUN`-typed tools execute multi-step plans
    server-side; the gateway sees one opaque call and per-statement inspection cannot reach inside
    it. Deny agent tools and force the client to use granular, inspectable tools.
  - **`groups` claim must be an array of strings.** A string-valued or otherwise malformed claim
    fails closed (fenced domains deny). If your IdP emits groups under a different claim name (e.g. a
    namespaced custom claim), update `caller_groups` in the Rego.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - snowflake
industries: []
bundles:
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package snowflake.ingress.fence_sensitive_schemas

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# ---------------------------------------------------------------------------
# Fence configuration — PLACEHOLDERS, replace at import time.
#
# Snowflake exposes no stable tool names and which tables hold regulated data
# is not knowable from the wire, so this policy fences by a customer-pinned
# schema/table NAME PREFIX -> the IdP group required to query that domain.
# Prefixes are matched case-insensitively at an identifier boundary (\bPREFIX);
# groups are compared case-insensitively against `subject.claims.groups`.
sensitive_domains := {
    "PII_": "pii-cleared",   # e.g. PII_CUSTOMERS, ANALYTICS.PII_PROFILES
    "PHI_": "phi-cleared",   # e.g. PHI_RECORDS, PHI_LABRESULTS
    "HR_": "hr",             # e.g. HR_EMPLOYEES, HR_COMP
    "FINANCE_": "finance",   # e.g. FINANCE_LEDGER, FINANCE_PAYROLL
}

# ---------------------------------------------------------------------------
# Identity — read groups via object.get chains so a missing subject/claims/
# groups fails closed (no group -> no access to a fenced domain).
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# True when the caller's groups claim (an array of strings) contains `group`.
# A malformed (non-array) claim makes the iteration fail -> fail closed.
caller_has_group(group) if {
    some g in caller_groups
    lower(g) == lower(group)
}

# ---------------------------------------------------------------------------
# Argument extraction — object.get everywhere. SQL text arrives under `query`
# (and, defensively, `statement`); Cortex Analyst text under `message`.
args := object.get(object.get(input, "payload", {}), "args", {})

sql_candidates contains t if {
    t := object.get(args, "query", "")
    t != ""
}

sql_candidates contains t if {
    t := object.get(args, "statement", "")
    t != ""
}

nl_candidates contains t if {
    t := object.get(args, "message", "")
    t != ""
}

# Prefix references are checked across both SQL and NL text; SELECT * only
# meaningfully applies to SQL text.
all_text_candidates := sql_candidates | nl_candidates

# This policy only inspects calls that carry a SQL query/statement or an
# analyst message; everything else passes through.
is_inspected_call if {
    count(all_text_candidates) > 0
}

# ---------------------------------------------------------------------------
# Detection helpers.

# True when `text` references an identifier beginning with `prefix`. `\b`
# anchors the match to an identifier boundary (start of string, whitespace,
# `.`, `(`, quote, comma), so FINANCE_LEDGER and DB.PII_X match but a prefix
# buried mid-identifier (MY_PII_COL) does not.
domain_in_text(prefix, text) if {
    regex.match(sprintf(`(?i)\b%s`, [prefix]), text)
}

# A fenced domain the caller is NOT cleared for is referenced in the request.
denied_domains contains prefix if {
    some prefix, group in sensitive_domains
    some t in all_text_candidates
    domain_in_text(prefix, t)
    not caller_has_group(group)
}

# A star-select against a fenced schema, in a single SQL statement. Catches
# `SELECT *`, `SELECT DISTINCT *`, `SELECT ALL *`, `SELECT TOP <n> *` (and any
# combination of those leading set-quantifier / row-limit tokens, in any order),
# table-qualified `SELECT alias.*`, and the no-space form `SELECT*` (valid SQL)
# so a missing space or a leading modifier cannot evade the fence. Each modifier
# alternative requires a following `\s+`, so identifiers like `all_flags`,
# `distinct_id`, or `top_customer` are NOT mistaken for a set quantifier.
select_star_on_sensitive if {
    some t in sql_candidates
    regex.match(`(?i)select\s*(?:(?:all|distinct|top\s+\d+)\s+)*(?:\w+\.)?\*`, t)
    some prefix in object.keys(sensitive_domains)
    domain_in_text(prefix, t)
}

# ---------------------------------------------------------------------------
# Allow rules.

# Any call this policy does not inspect passes through untouched.
allow if {
    not is_inspected_call
}

# Inspected call with no fenced-domain violation and no star-select on a
# fenced schema.
allow if {
    is_inspected_call
    count(denied_domains) == 0
    not select_star_on_sensitive
}

# ---------------------------------------------------------------------------
# Deny reasons.

reasons contains msg if {
    some prefix in denied_domains
    group := sensitive_domains[prefix]
    msg := sprintf("Access to the '%s' sensitive data domain requires the '%s' IdP group. Ask your data platform admin for that entitlement, or contact InfoSec if this fence looks wrong.", [prefix, group])
}

reasons contains "SELECT * against a fenced sensitive schema is not allowed. List the specific columns you need so the access is minimum-necessary, then re-run. Contact your data platform admin if a fenced prefix is mislabeled." if {
    select_star_on_sensitive
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
