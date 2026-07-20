---
name: Guard DAX Whole-Table Dumps in Power BI
tags:
  - power-bi
  - guard-warehouse-sql
  - ingress
  - dax
  - exfiltration
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # power-bi / guard-warehouse-sql-dax

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on a bare full-table `EVALUATE` (fail **open** when no DAX text is present — nothing to dump), allow otherwise
  **Package:** `power_bi.ingress.guard_warehouse_sql_dax`

  ## What it does

  Power BI semantic models front the warehouse: a model imports or DirectQueries
  lakehouse/warehouse tables — finance, HR, customer PII. DAX is **read-only**, so
  the risk on the query path is not corruption but *wholesale exfiltration*: a bare
  `EVALUATE 'Customers'` returns the entire `Customers` table in one call.

  This ingress policy inspects the DAX expression argument on the query-capable
  Power BI tools and denies a **bare full-table evaluation** — `EVALUATE`
  immediately followed by a table reference with **no row-limiting or aggregating
  function** wrapping it. A query that bounds or aggregates the table — `TOPN`,
  `FILTER`, `SUMMARIZE`, `SUMMARIZECOLUMNS`, `SAMPLE`, `ROW`, or a filtered
  `CALCULATETABLE` — passes through, because every one of those constructs
  introduces a function call (`(`) after `EVALUATE`, and the guard's anchored
  pattern only fires when the table reference runs unbroken to the end of the
  statement.

  The check runs at ingress, before the DAX reaches the model, so a blocked
  full-table dump never executes and no rows are ever returned to the agent.

  ### Fail-open on missing DAX

  Unlike a write guard, this policy **fails open** when a matched tool carries no
  readable DAX string (missing or empty argument): with no query there is nothing
  to dump, so the call is allowed. This is the opposite posture from the SQL
  write-guard sibling (which fails *closed* on empty SQL) — here an empty argument
  is inert, not a bypass, because the tool cannot exfiltrate without a query.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission, movement, and removal
    of information: the most permissive form of programmatic read (an unfiltered
    whole-table pull) is blocked on the agent MCP path, so an agent cannot move an
    entire model table off the gateway in one call without a bounded, approved
    extract.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent channel by
    forcing DAX reads to bound or aggregate the result rather than returning an
    entire personal-data table in a single evaluation.

  ## Tool name matching

  The policy matches the query-capable Power BI tools by **suffix** (the gateway
  prefixes tool names with the configured MCP server name, which is not
  standardized), on `lower(input.resource.name)`:

  - `*executequery` — remote official server (`ExecuteQuery`, PascalCase on the
    wire; matched lowercased).
  - `*execute_dax` — community `sulaiman013/powerbi-mcp` server. This suffix also
    covers `desktop_execute_dax` (the Desktop variant), since that name ends with
    `execute_dax`.
  - `*dax_query_operations` — modeling server (`microsoft/powerbi-modeling-mcp`)
    DAX query multiplexer.

  Metadata/read tools that do not carry a DAX expression — `GetSemanticModelSchema`,
  `GetReportMetadata`, `ValueSearch`, `cloud_list_tables`, the `*_operations`
  metadata multiplexers — do not end with any of these suffixes and pass through
  untouched. (`ValueSearch` searches raw data values and is better paired with the
  egress PII redaction policy; it is out of scope for this DAX-text guard.)

  ## Argument shape

  The DAX text is read from `input.payload.args` across a set of candidate keys —
  `dax_query` (verified for the community server), plus `dax`, `query`,
  `expression`, and `daxQuery` as defensive fallbacks — and the policy inspects the
  concatenation of whichever **string** values are present. Only string values are
  considered; a non-string value (list/object) contributes nothing.

  **The exact DAX argument field name is unverified in the landscape note** for the
  remote and modeling servers (the preview docs describe "a DAX query expression
  (string)" without naming the wire field). If your deployment names the argument
  something outside the candidate set, the guard sees no DAX text and — per the
  fail-open posture — allows the call. Add the real key to `dax_arg_keys` in
  `policy.md` once you confirm it with the dump-input debug technique.

  ## Examples

  ### Denied — bare full-table dump

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-mcp-ExecuteQuery", "type": "tool" },
      "payload": {
        "name": "powerbi-mcp-ExecuteQuery",
        "args": { "expression": "EVALUATE 'Customers'" }
      }
    }
  }
  ```

  `allow = false` with the whole-table-dump reason.

  ### Allowed — row-bounded with TOPN

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-mcp-ExecuteQuery", "type": "tool" },
      "payload": {
        "name": "powerbi-mcp-ExecuteQuery",
        "args": { "expression": "EVALUATE TOPN(100, 'Customers')" }
      }
    }
  }
  ```

  `allow = true` — the `TOPN(` call breaks the bare-table pattern.

  ### Allowed — filtered

  `EVALUATE FILTER('Customers', 'Customers'[Region] = "EMEA")` and
  `EVALUATE SUMMARIZECOLUMNS('Customers'[Country], "n", COUNTROWS('Customers'))`
  both pass — an aggregating/filtering function follows `EVALUATE`.

  ### Allowed — no DAX present (fail open)

  A matched tool called with no DAX argument (or an empty string) is allowed:
  there is no query, so nothing can be dumped.

  ## Composition

  This guard is single-purpose and deliberately narrow. Pair it with:

  - **Egress PII redaction** on `ExecuteQuery` / `execute_dax` / `ValueSearch`
    results — a *filtered* query the pattern allows can still return regulated
    data, and DAX obfuscation (below) can slip a dump past this ingress guard. The
    egress policy is the backstop that masks email/SSN/PAN patterns in returned
    rows. **This ingress guard is not sufficient on its own.**
  - **PF-07 SQL write guard siblings** on the warehouse connectors behind the
    model (Snowflake/BigQuery/Databricks) for the write/DDL surface DAX cannot
    reach.
  - A **service-identity guard** — the remote server does not enforce row-level
    security under service-principal auth, so a shared-credential deployment
    widens every caller's scope. Blocking service-identity `ExecuteQuery` sessions
    is a separate, complementary policy.

  ## Known limitations

  - **Regex over DAX text, not a parser.** This is a high-signal guard for the
    common bare-dump shape, **not** a complete DAX parser. It matches `EVALUATE`
    followed by a table reference that runs unbroken to the end of the statement.
    Known evasions, all documented rather than caught:
    - **Variables / `DEFINE` blocks.** `DEFINE VAR t = FILTER('Customers', …)` then
      `EVALUATE t` — the trailing `EVALUATE t` matches the bare-table pattern and is
      denied even though it is filtered (false positive); conversely a variable that
      resolves to a whole table can be dumped through an aggregating-looking
      wrapper the regex misreads. Variable indirection is the primary evasion.
    - **Comments containing parentheses (unquoted tables only).** For an
      *unquoted* table, `EVALUATE Customers /* uses ( */` — the `(` inside the
      comment breaks the unquoted end-of-line pattern, so the dump is allowed
      (false negative). Note this evasion does **not** work for a quoted table
      name: `EVALUATE 'Customers' /* uses ( */` is still caught, because the
      quoted pattern matches the `'…'` table reference directly after `EVALUATE`
      and ignores any trailing comment.
    - **A comment *between* `EVALUATE` and the table (quoted or unquoted).**
      `EVALUATE /* x */ 'Customers'` and `EVALUATE // x⏎'Customers'` are full
      dumps that are **not** caught (false negative): the comment token sits
      where the pattern expects the table reference or an opening `(`, so neither
      the bare nor the parenthesised pattern fires. This defeats the quoted
      pattern too — a *leading* comment is stronger than the trailing-comment
      evasion above. Stripping DAX comments before matching is beyond a
      conservative regex; rely on the egress redaction companion.
    - **Parenthesised bare table — CAUGHT for single wrap, residual for nesting.**
      `EVALUATE ('Customers')` and `EVALUATE (Customers)` (a table wrapped in bare
      parentheses, still a whole-table dump) **are** now denied by the
      `paren_*_dump_pattern` rules. Deeper nesting — `EVALUATE (('Customers'))` —
      is **not** caught, because the inner content is no longer a lone table
      reference the pattern recognises. Multi-level parenthesisation is a
      documented residual in the same class as variable indirection.
    - **`CALCULATETABLE` without a filter.** Only a *filtered* `CALCULATETABLE` is
      an intended allow; an unfiltered `EVALUATE CALCULATETABLE('Customers')` is
      effectively a full dump but is **not** caught, because the `(` immediately
      follows a function name (`CALCULATETABLE`), not a lone table reference.
      Detecting filter-less `CALCULATETABLE` is beyond a conservative regex.
  - **Unverified argument field name.** The remote/modeling DAX argument key is not
    verified in the landscape note; a call whose DAX lands under a key outside
    `dax_arg_keys` is allowed (fail open). Confirm the key and add it.
  - **Fail-open by design.** Because a query-only tool cannot exfiltrate without a
    query, an empty/absent/misnamed DAX argument is allowed. Combined with the
    obfuscation residual above, treat this as a first line of defense and rely on
    the egress redaction companion for the data actually returned.
  - **No identity exemption.** All callers are subject to the same check. If a
    data-team break-glass path needs full exports, gate it with
    `input.subject.claims.groups` as a separate `allow if` branch; group names in
    such a branch are placeholders — replace them with your IdP's group name.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - power-bi
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package power_bi.ingress.guard_warehouse_sql_dax

# Deny-by-default: a query-capable Power BI DAX tool call is permitted unless it
# carries a bare full-table EVALUATE. The explicit allow rules below cover the
# passthrough, fail-open (no DAX), and bounded-query cases; anything left over
# (a matched tool + readable DAX + bare-dump pattern) falls to the default deny.
default allow := false

# --- Query-capable DAX tools (matched by suffix) -----------------------------
# The gateway prefixes tool names with the configured MCP server name (not
# standardized), so match on the lowercased suffix for portability:
#   - `executequery`         — remote official server (ExecuteQuery, PascalCase)
#   - `execute_dax`          — community sulaiman013 server; also covers
#                              `desktop_execute_dax` (ends with `execute_dax`)
#   - `dax_query_operations` — modeling server DAX query multiplexer
dax_tool_suffixes := [
	"executequery",
	"execute_dax",
	"dax_query_operations",
]

is_dax_tool if {
	name := lower(input.resource.name)
	some suffix in dax_tool_suffixes
	endswith(name, suffix)
}

# --- DAX extraction ----------------------------------------------------------
# The exact wire field name is unverified for the remote/modeling servers; read
# the DAX text from a set of candidate keys and inspect the concatenation of
# whichever STRING values are present. `dax_query` is verified for the community
# server; the rest are defensive fallbacks. A non-string value contributes
# nothing, so it cannot smuggle a query past the string-based pattern.
dax_arg_keys := ["dax_query", "dax", "query", "expression", "daxQuery"]

dax_text := concat(" ", [v |
	some key in dax_arg_keys
	v := object.get(input.payload.args, key, "")
	is_string(v)
	v != ""
])

# --- Bare full-table dump detection ------------------------------------------
# `(?i)` case-insensitive (DAX keywords are case-insensitive). `\b` avoids
# matching a longer identifier ending in EVALUATE. Two patterns, because relying
# on a single end-of-TEXT (`$`) anchor was bypassable: a DAX query may contain
# several EVALUATE statements, so appending a second statement that merely
# contains a `(` (e.g. `EVALUATE 'Customers'\nEVALUATE ROW("x",1)`) used to push
# the dump off the `$` anchor and slip through. The two patterns below anchor on
# statement/line boundaries and on the quote-directly-after-EVALUATE shape, so a
# trailing statement, comment, or decoy argument key can no longer hide a dump.
#
#   1. Quoted bare table — a single-quoted table name directly follows EVALUATE.
#      No DAX *function* is single-quoted, so `EVALUATE '<name>'` is unambiguously
#      a whole-table evaluation. This pattern deliberately does NOT anchor to end
#      of text, so it fires regardless of any trailing statement/comment/paren and
#      also catches table names that themselves contain `(` (e.g. 'Sales (2)').
#      A filtering/aggregating call puts its quote INSIDE parens after a function
#      name (`FILTER('Customers',…)`), so the quote does not directly follow
#      EVALUATE and this pattern does not fire.
#   2. Unquoted bare table — EVALUATE + an identifier whose run to end-of-LINE
#      (or end of text) contains no `(`. Terminating on the line break rather than
#      end-of-text means a following statement that contains a `(` no longer hides
#      a preceding unquoted dump. TOPN(/FILTER(/SUMMARIZE(/SUMMARIZECOLUMNS(/
#      SAMPLE(/ROW(/CALCULATETABLE( all introduce a `(` on the same line and so
#      break this pattern and are allowed.
bare_quoted_dump_pattern := `(?i)\bEVALUATE\s+'[^']*'`
bare_unquoted_dump_pattern := `(?i)\bEVALUATE\s+[A-Za-z_][^(\r\n]*(\r?\n|$)`

# 3+4. Parenthesised bare table — `EVALUATE ('Customers')` / `EVALUATE (Customers)`.
#      A table reference wrapped in nothing but parentheses is still a whole-table
#      dump; the outer `(` used to masquerade as a bounding/aggregating function
#      call and slip the dump straight through (patterns 1 and 2 both require the
#      table token to follow EVALUATE with no intervening `(`). These two patterns
#      fire ONLY when the parentheses contain a lone table reference (a quoted name
#      or a single bare identifier) and immediately close — so a real bounding call
#      inside the parens (`EVALUATE (FILTER('Customers',…))`, first token after `(`
#      is `FILTER` then another `(`, not a closing `)`) does NOT match and still
#      passes. Deeper nesting (`EVALUATE (('Customers'))`) is a documented residual.
paren_quoted_dump_pattern := `(?i)\bEVALUATE\s*\(\s*'[^']*'\s*\)`
paren_unquoted_dump_pattern := `(?i)\bEVALUATE\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)`

is_bare_table_dump if {
	regex.match(bare_quoted_dump_pattern, dax_text)
}

is_bare_table_dump if {
	regex.match(bare_unquoted_dump_pattern, dax_text)
}

is_bare_table_dump if {
	regex.match(paren_quoted_dump_pattern, dax_text)
}

is_bare_table_dump if {
	regex.match(paren_unquoted_dump_pattern, dax_text)
}

# --- Allow rules -------------------------------------------------------------
# Non-guarded tools (metadata/read helpers, anything not a DAX query tool) pass.
allow if {
	not is_dax_tool
}

# Fail OPEN: a query tool with no readable DAX text cannot dump anything.
allow if {
	is_dax_tool
	dax_text == ""
}

# A query tool with DAX that is NOT a bare full-table dump (bounded/aggregated).
allow if {
	is_dax_tool
	dax_text != ""
	not is_bare_table_dump
}

# --- Deny reason -------------------------------------------------------------
reasons contains "This DAX query is a bare full-table evaluation (EVALUATE over an entire table with no row-limiting or aggregating function), which returns the whole table in one call and is blocked on the agent MCP path. Add a FILTER predicate or wrap the table in TOPN to bound the result, or request an approved data extract from the data team if a full export is genuinely required. If this was a false positive (for example a filtered query the guard could not parse), contact your data platform team." if {
	is_dax_tool
	dax_text != ""
	is_bare_table_dump
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
