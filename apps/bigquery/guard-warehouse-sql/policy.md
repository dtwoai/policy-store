---
name: Block Destructive SQL in BigQuery Queries
tags:
  - bigquery
  - guard-warehouse-sql
  - ingress
  - sql
  - readonly
  - soc2
  - pci-dss
  - sox
publishedAt: 2026-07-12
description: |
  # bigquery / guard-warehouse-sql

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on a mutating/destructive statement (and fail closed on unreadable SQL), allow otherwise
  **Package:** `bigquery.ingress.guard_warehouse_sql`

  ## What it does

  Inspects the raw GoogleSQL string carried by BigQuery **write-capable** query
  tools and denies any statement in a state-changing class — DML
  (`INSERT`/`UPDATE`/`DELETE`/`MERGE`), destructive DDL
  (`TRUNCATE TABLE`, `DROP TABLE`/`DATASET`/`SCHEMA` and the data-bearing
  `DROP SNAPSHOT TABLE`/`EXTERNAL TABLE`/`MATERIALIZED VIEW`, `ALTER`,
  non-temporary `CREATE`), privilege change (`GRANT`), procedure invocation
  (`CALL`), bulk
  ingest (`LOAD DATA`), and dynamic SQL (`EXECUTE IMMEDIATE`). Read-only
  statements — `SELECT` and anything matching none of those constructs — pass
  through.

  The check makes a BigQuery connection **effectively read-only for ordinary
  agent callers** on the MCP path, independent of the server's `writeMode`
  setting (the DTwo policy cannot see whether the MCP Toolbox server runs
  `allowed`, `blocked`, or `protected`) or the caller's IAM role: the guard is on
  the SQL text itself, so it holds even when the server-side gate is
  misconfigured or absent.

  Two properties matter for correctness:

  - **The read-only tool always passes.** The official Google server exposes a
    dedicated `execute_sql_readonly` tool ("no DML, DDL, or Python UDFs"). Because
    the guarded write tool `execute_sql` is matched by suffix, `execute_sql`
    would also be a suffix of `execute_sql_readonly` under a naive
    `contains`-style match. This policy matches `_readonly` **first** and excludes
    it, so a read-only call can never be caught by the write-SQL guard — even if
    its SQL contains a mutating keyword.
  - **Fail closed on unreadable SQL.** If a matched write-capable tool is called
    with no `sql` string (missing or empty), the guard cannot confirm the
    statement is read-only, so it **denies** rather than allowing an inert call
    through. This prevents a malformed or renamed-argument payload from slipping a
    write past the regex.

  Callers whose IdP-issued `groups` claim includes `data-engineering` are exempt,
  so the data-engineering team can still run writes and DDL. The exemption is read
  through an `object.get` chain that **fails closed** — a caller with no claims,
  or no `groups` claim, is treated as having no groups and is therefore subject to
  the deny.

  This runs at ingress, before the statement reaches BigQuery, so a blocked
  `DROP`/`DELETE`/`GRANT` never executes — BigQuery's 7-day time-travel window is
  not needed because the change never happens.

  ## Compliance alignment

  - **SOC 2 CC8.1** — supports change management by preventing the agent from
    making unreviewed schema/DDL changes (non-temporary `CREATE`/`ALTER`/`DROP`)
    to production data structures outside a controlled data-engineering path.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored
    cardholder data by role: mutating access to warehouse data over the MCP path
    is confined to the `data-engineering` group; everyone else is read-only.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent channel by
    keeping the agent to `SELECT` reads and blocking bulk-mutating constructs
    (`MERGE`, `LOAD DATA`, `TRUNCATE`) that rewrite personal-data tables wholesale.
  - **SOX §802 / 18 U.S.C. §1519** — supports the anti-destruction/alteration of
    records control by blocking `DROP`/`TRUNCATE`/`DELETE`/`UPDATE` against
    financially relevant warehouse tables on the agent channel.

  ## Tool name matching

  The policy matches BigQuery tools that pass a raw SQL statement, by **suffix**
  (the gateway prefixes tool names with the configured MCP server name, which is
  not standardized). Write-capable SQL tools:

  - `*execute_sql` — Google official remote server + MCP Toolbox `bigquery`
    toolset (both snake_case, no vendor prefix). Treated as **write-capable** (see
    Known limitations).
  - `*query` — ergut/mcp-bigquery-server community server (single `query` tool).
  - `*execute-query` — LucasHild/mcp-server-bigquery community server (kebab-case).

  The read-only tool is matched first and **excluded**:

  - `*_readonly` (covers `execute_sql_readonly`) — always passes, so read-only
    calls are never blocked even when their SQL text contains a keyword the write
    guard would otherwise flag.

  Metadata/read tools that carry no write-capable SQL — `list_dataset_ids`,
  `list_table_ids`, `get_dataset_info`, `get_table_info`, `list-tables`,
  `describe-table` — do not end with any write suffix and pass through untouched.

  ## Argument shape

  The SQL string is read from `input.payload.args.sql` (the verified key for the
  official Google/Toolbox servers and for ergut). As a defensive fallback the
  policy also inspects a `query` key, matching the concatenation of whichever
  string values are present. LucasHild's `execute-query` passes the SQL
  **positionally** and its exact argument key is unverified in the landscape
  note — so on a `*execute-query` tool, when neither `sql` nor `query` is present,
  the policy reads the positional SQL by treating any non-empty string argument as
  the query (LucasHild's `execute-query` takes only the SQL string). That
  positional fallback is scoped to `*execute-query` on purpose: an official
  `execute_sql` call with an empty `sql` but a present `project_id` still fails
  closed, because `project_id` is never mistaken for the query. Only string values
  are inspected everywhere — a crafted non-string value (list/object) is treated
  as carrying no SQL and, on a write-capable tool, is denied fail closed.

  ## Examples

  ### Allowed — read-only SELECT

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "args": { "sql": "SELECT id, created_at, updated_at FROM ds.orders LIMIT 10" }
      }
    }
  }
  ```

  `allow = true` — `created_at`/`updated_at` do not trip `CREATE`/`UPDATE` because
  the patterns are anchored on word boundaries.

  ### Allowed — read-only tool passes even with a scary-looking string

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql_readonly", "type": "tool" },
      "payload": {
        "name": "bigquery-mcp-execute_sql_readonly",
        "args": { "sql": "SELECT 'we should DROP TABLE later' AS note" }
      }
    }
  }
  ```

  `allow = true` — `_readonly` is matched first and excluded from the write guard.

  ### Denied — destructive SQL

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "args": { "sql": "DROP TABLE ds.customers" }
      }
    }
  }
  ```

  `allow = false` with the mutating-SQL reason.

  ### Denied — fail closed on empty SQL

  A call to `bigquery-mcp-execute_sql` with `args: { "sql": "" }` (or no `sql` at
  all) is denied with the unreadable-SQL reason.

  ### Allowed — break-glass data-engineering

  The same `DROP TABLE ds.customers` call succeeds when
  `input.subject.claims.groups` contains `data-engineering`.

  ## Composition

  This policy blocks statement-class mutation on the SQL-carrying tools. Useful
  companions:

  - **PF-07 export sibling** — deny `EXPORT DATA OPTIONS(uri='gs://…')` and
    `EXTERNAL_QUERY` exfiltration constructs, which move data out without looking
    like a "write tool" and are not in this policy's destructive keyword set.
  - **PF-23 `fence-sensitive-schemas`** — deny `sql` (and `dataset_id`/`table_id`
    on metadata tools) referencing regulated datasets (`pii_*`, `finance_*`,
    `phi_*`) outside the matching data-domain group.
  - **PF-14 `constrain-aggregator`** — gate the Toolbox AI-analytics tools
    (`ask_data_insights`, `forecast`, `analyze_contribution`) whose data movement
    this SQL guard does not see.
  - **Egress PII/PAN redaction** on `execute_sql`/`query`/`execute_sql_readonly`
    results, since a permitted `SELECT *` can still return regulated data in bulk.

  ## Known limitations

  - **Regex over SQL text, not a parser.** Statement-typing by regex is
    approximate. A mutating keyword inside a string literal or `--`/`/* */` comment
    (e.g. `SELECT '… we will DELETE this later'`) is a false positive; multi-
    statement scripts and `EXECUTE IMMEDIATE` DDL assembled from string fragments
    can evade naive patterns and are false negatives. Because of this, the policy
    belongs **paired with a server-side control** — MCP Toolbox `writeMode:
    blocked` or a read-only IAM role — not relied on alone. Treat it as a
    high-signal read-only guard, not a SQL firewall.
  - **Comment/whitespace injection between construct tokens is a false negative.**
    The multi-word destructive constructs (`TRUNCATE TABLE`, `DROP
    TABLE/DATASET/SCHEMA`, `LOAD DATA`, `EXECUTE IMMEDIATE`) require the two
    keywords adjacent across a run of whitespace (`\s+`). A comment placed between
    them — `DROP /* x */ TABLE ds.t`, `TRUNCATE --c\nTABLE ds.t`, `LOAD /* */
    DATA …` — is still valid GoogleSQL and executes destructively, but the `\s+`
    does not span the comment, so the construct is **not** detected and the call is
    allowed. (Single-word keywords — `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`ALTER`/
    `CALL`/`GRANT` — are atomic and cannot be split this way, so they remain caught
    regardless of surrounding comments.) A comment-tolerant regex would still miss
    line-comment, nested-comment, and encoding variants, giving false confidence;
    the honest posture is the server-side companion control above. Do not rely on
    this guard alone to block obfuscated DDL.
  - **`execute_sql` is treated as write-capable.** Google's docs have described
    `execute_sql` inconsistently across revisions (an earlier revision called it
    SELECT-only); the existence of a separate `execute_sql_readonly` tool means
    this policy treats `execute_sql` as write-capable per the landscape note.
    Verify against your live deployment.
  - **`CREATE` lookahead is emulated by object-keyword adjacency.** The intended
    rule is `CREATE` unless it is `CREATE TEMP`/`CREATE TEMPORARY`. OPA's regex
    engine (RE2) has no negative lookahead, so a persistent create is detected as
    `CREATE [OR REPLACE] <object-keyword>` where the object keyword (`TABLE`,
    `VIEW`, `FUNCTION`, `PROCEDURE`, `SCHEMA`, `MATERIALIZED`, `EXTERNAL`,
    `SNAPSHOT`, `MODEL`, `RESERVATION`, `ASSIGNMENT`, `CAPACITY`, `ROW`, `SEARCH`,
    `VECTOR`, `AGGREGATE`) must sit **directly after** `CREATE`. A temporary
    create always puts `TEMP`/`TEMPORARY` between `CREATE` and the object keyword,
    so it never matches. Requiring adjacency also means an injected `CREATE TEMP`
    in a comment or string literal cannot suppress the verdict on a real
    persistent create (an earlier global `CREATE` + `CREATE TEMP` emulation
    allowed exactly that), and a multi-statement script pairing a temp create with
    a persistent one is now caught by the persistent create. Residual: a `CREATE`
    of an object type outside that enumerated list (non-standard GoogleSQL) would
    be missed, and `CREATE` DDL assembled dynamically inside `EXECUTE IMMEDIATE`
    string fragments is still a documented multi-statement/string false negative.
  - **DROP scope is conservative.** The guard matches the data-bearing drops:
    `DROP TABLE`/`DATASET`/`SCHEMA` plus `DROP SNAPSHOT TABLE`, `DROP EXTERNAL
    TABLE`, and `DROP MATERIALIZED VIEW` (each destroys stored or materialised
    data, and the matching `CREATE` of the same object is already blocked, so
    catching the `DROP` restores that symmetry — a red-team pass found these three
    slipping past the earlier `DROP\s+(?:TABLE|DATASET|SCHEMA)` pattern because the
    object keyword is not adjacent to `DROP`). Deliberately **still out of scope**
    and passing through: `DROP FUNCTION`/`DROP PROCEDURE`/`DROP VIEW` (definitional
    objects, no row data), and `DROP ROW ACCESS POLICY`/`DROP SEARCH INDEX`/`DROP
    VECTOR INDEX`/`DROP MODEL`/`DROP RESERVATION`/`DROP ASSIGNMENT` (security,
    index, and capacity objects). Dropping a row-access policy in particular is a
    security-weakening act rather than data destruction; gate it with a
    server-side control or a dedicated policy if it matters in your environment.
  - **LucasHild argument key unverified.** The `execute-query` SQL argument key is
    not verified in the landscape note. On a `*execute-query` tool the policy
    therefore reads the SQL positionally — any non-empty string arg is inspected
    when no `sql`/`query` key is present — so a legitimate read-only query is not
    spuriously denied and a destructive one is still caught. If that server ever
    ships additional string arguments alongside the SQL, the guard errs toward
    inspecting them all (conservative). Confirm the real key with the dump-input
    debug technique before relying on this in production. The positional fallback
    is scoped to `*execute-query`; on `execute_sql`/`query` the SQL must be under
    `sql`/`query` or the call fails closed.
  - **Group names are placeholders** — replace `data-engineering` with your IdP's
    group name at import time. The exemption reads `input.subject.claims.groups`;
    on Auth0 tenants without RBAC/permissions configured, no `groups` claim reaches
    the policy and the exemption never fires (fail-closed — everyone is read-only
    until the claim is wired up).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - bigquery
industries: []
bundles:
  - soc2
  - pci-dss
  - sox
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package bigquery.ingress.guard_warehouse_sql

# Deny-by-default: a BigQuery write-capable SQL tool call is permitted only when
# it carries readable, read-only SQL, or the caller is an exempt data engineer.
default allow := false

# --- Read-only tool (matched FIRST and excluded) -----------------------------
# The official Google server exposes `execute_sql_readonly` ("no DML, DDL, or
# Python UDFs"). Its name ends with `_readonly`, which we detect before the
# write-tool suffix match so a read-only call is NEVER caught by the write guard
# — even if the SQL string happens to contain a mutating keyword. This is the
# anchor that keeps `execute_sql` (write) from also matching
# `execute_sql_readonly` (read).
is_readonly_tool if {
	name := lower(input.resource.name)
	endswith(name, "_readonly")
}

# --- Write-capable SQL tools -------------------------------------------------
# Matched by suffix (the gateway prefixes tool names with the configured server
# name, which is not standardized):
#   - `execute_sql`   — Google official remote server + MCP Toolbox (write-capable)
#   - `query`         — ergut/mcp-bigquery-server
#   - `execute-query` — LucasHild/mcp-server-bigquery
# `execute-query` also ends with `query`; listing both is harmless and explicit.
write_sql_tool_suffixes := [
	"execute_sql",
	"execute-query",
	"query",
]

is_write_sql_tool if {
	not is_readonly_tool
	name := lower(input.resource.name)
	some suffix in write_sql_tool_suffixes
	endswith(name, suffix)
}

# --- SQL extraction ----------------------------------------------------------
# Read the statement from `sql` (verified for official/Toolbox/ergut); inspect
# `query` as a defensive fallback and match the concatenation of whichever string
# values are present. Only string values are considered — a non-string arg yields
# no SQL, which on a write-capable tool is denied fail closed below.
sql_arg_keys := ["sql", "query"]

# Named SQL args — verified for the official/Toolbox `execute_sql` and ergut
# `query`. `query` is inspected as a defensive fallback alongside `sql`.
sql_values contains v if {
	some key in sql_arg_keys
	v := object.get(input.payload.args, key, "")
	is_string(v)
	v != ""
}

# True when a named sql/query arg carries text. Defined independently of
# `sql_values` (not derived from it) to avoid rule recursion; it scopes the
# positional fallback below.
has_named_sql if {
	some key in sql_arg_keys
	v := object.get(input.payload.args, key, "")
	is_string(v)
	v != ""
}

# LucasHild's `execute-query` passes the SQL positionally; its exact argument key
# is unverified in the landscape note. Scoped to a `*execute-query` tool, and only
# when no named sql/query arg is present, treat any non-empty string arg as the
# SQL — LucasHild's execute-query takes only the SQL string, so this reads it
# regardless of the key name. The scope is deliberate: an official `execute_sql`
# call with an empty `sql` but a present `project_id` still fails closed here
# (project_id is never mistaken for the query, because the fallback only fires for
# `*execute-query`).
sql_values contains v if {
	endswith(lower(input.resource.name), "execute-query")
	not has_named_sql
	some val in input.payload.args
	is_string(val)
	val != ""
	v := val
}

# Concatenate every SQL string found (order-independent — the mutating patterns
# below are unanchored searches). Empty when nothing readable was found, so a
# write-capable tool then fails closed.
sql_text := concat(" ", sort([v | some v in sql_values]))

# --- Mutating / destructive statement detection ------------------------------
# Case-insensitive `(?i)` and anchored on word boundaries `\b` so identifiers
# like `created_at`, `updated_at`, or `merge_log` do not trip the keywords.
# Multi-word constructs (TRUNCATE TABLE; DROP TABLE/DATASET/SCHEMA and the
# data-bearing DROP SNAPSHOT TABLE/EXTERNAL TABLE/MATERIALIZED VIEW; LOAD DATA;
# EXECUTE IMMEDIATE) require the keywords adjacent (any run of whitespace).
# Plain DROP FUNCTION/PROCEDURE/VIEW and DROP ROW ACCESS POLICY/SEARCH INDEX are
# deliberately out of scope (see Known limitations, "DROP scope is conservative").
# `CREATE` is handled separately below to emulate the `CREATE (?!TEMP|TEMPORARY)`
# lookahead, which RE2 cannot express.
base_mutating_pattern := `(?i)(\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|CALL|GRANT)\b|\bTRUNCATE\s+TABLE\b|\bDROP\s+(?:SNAPSHOT\s+TABLE|EXTERNAL\s+TABLE|MATERIALIZED\s+VIEW|TABLE|DATASET|SCHEMA)\b|\bLOAD\s+DATA\b|\bEXECUTE\s+IMMEDIATE\b)`

is_mutating_sql if {
	regex.match(base_mutating_pattern, sql_text)
}

# Emulated `CREATE (?!TEMP|TEMPORARY)` without RE2 negative lookahead: match a
# persistent create as `CREATE [OR REPLACE] <object-keyword>` where the object
# keyword (TABLE, VIEW, FUNCTION, …) sits DIRECTLY after CREATE. A temporary
# create always places TEMP/TEMPORARY between CREATE and the object keyword, so it
# never matches this adjacency. Requiring adjacency is what makes the guard robust
# against a `CREATE TEMP` injected into a comment or string literal elsewhere in
# the statement (which the earlier global `CREATE`/`CREATE TEMP` emulation let
# suppress the verdict on a real persistent create), and it also catches a
# multi-statement script that pairs a temp create with a persistent one.
mutating_create_pattern := `(?i)\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED|EXTERNAL|FUNCTION|PROCEDURE|SCHEMA|SNAPSHOT|MODEL|RESERVATION|ASSIGNMENT|CAPACITY|ROW|SEARCH|VECTOR|AGGREGATE)\b`

is_mutating_sql if {
	regex.match(mutating_create_pattern, sql_text)
}

# --- Identity exemption ------------------------------------------------------
# Break-glass: callers in the `data-engineering` IdP group may run writes/DDL.
# The object.get chain fails closed — a missing `subject.claims` object or missing
# `groups` claim yields an empty list, so an unauthenticated/unclaimed caller is
# never exempt. A `groups` claim that is a bare string (not a list) also fails to
# match, since `some g in <string>` iterates characters.
caller_groups := object.get(object.get(input.subject, "claims", {}), "groups", [])

is_exempt if {
	some g in caller_groups
	g == "data-engineering"
}

# --- Allow rules -------------------------------------------------------------
# Non-guarded tools pass through: the read-only tool, metadata/read helpers, and
# anything else that is not a write-capable SQL tool.
allow if {
	not is_write_sql_tool
}

# Break-glass data engineers may run any statement on the write-capable tools.
allow if {
	is_write_sql_tool
	is_exempt
}

# Ordinary callers may run readable, read-only SQL on a write-capable tool.
# Requires the SQL to be present (fail closed on empty) AND non-mutating.
allow if {
	is_write_sql_tool
	not is_exempt
	sql_text != ""
	not is_mutating_sql
}

# --- Deny reasons ------------------------------------------------------------
reasons contains "This BigQuery statement performs a write, DDL, or otherwise state-changing operation (INSERT, UPDATE, DELETE, MERGE, TRUNCATE TABLE, DROP TABLE/DATASET/SCHEMA, ALTER, non-temporary CREATE, CALL, GRANT, LOAD DATA, or EXECUTE IMMEDIATE) and is blocked on the agent MCP path, which is read-only. Re-issue the query through the read-only tool execute_sql_readonly, or route the write through an approved data-engineering pipeline. If this was a false positive, contact your data platform team." if {
	is_write_sql_tool
	not is_exempt
	sql_text != ""
	is_mutating_sql
}

reasons contains "This BigQuery write-capable tool was called with no readable SQL statement, so the guard cannot confirm the call is read-only and blocks it fail-closed. Supply the statement in the `sql` argument and re-issue read-only queries through execute_sql_readonly, or route writes through an approved data-engineering pipeline. If this was a false positive, contact your data platform team." if {
	is_write_sql_tool
	not is_exempt
	sql_text == ""
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
