---
name: Guard Databricks SQL Against Writes and DDL
tags:
  - databricks
  - guard-warehouse-sql
  - ingress
  - sql
  - readonly
  - pci-dss
  - sox
  - soc2
publishedAt: 2026-07-12
description: |
  # databricks / guard-warehouse-sql

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on a write/DDL/permission/export statement (and fail closed on a missing SQL argument), allow otherwise
  **Package:** `databricks.ingress.guard_warehouse_sql`

  ## What it does

  Inspects the SQL statement string that Databricks SQL-executing tools carry in
  their argument and denies any statement that performs a write, schema change,
  permission change, or bulk export — `INSERT`, `UPDATE`, `DELETE`, `MERGE`,
  `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`, `DENY` (the legacy
  table-ACL permission statement), a `COPY INTO` or `LOAD DATA` export/ingest
  construct, the Delta-specific `VACUUM` (permanent file purge),
  `RESTORE` (revert-to-version), and `REORG` (whose `APPLY (PURGE)` form
  permanently purges data files, defeating time-travel recovery just as `VACUUM`
  does) statements, or an `EXECUTE IMMEDIATE`
  dynamic-SQL construct (which can reassemble a hidden write from string
  fragments). Read-only statements — `SELECT`,
  `SHOW`, `DESCRIBE`,
  `EXPLAIN`, and anything matching none of those keywords — pass through.

  This matters because the managed Databricks SQL server's `execute_sql` tool is
  explicitly **read AND write**: a single agent call can run `INSERT`/`UPDATE`/
  `DELETE`/`DROP`/`GRANT` and make irreversible data-plane or permission changes.
  The community servers (`RafaelCartenet`'s `execute_sql_query`, `JustTryAI`'s
  `execute_sql`) ship **no server-side read-only guard** at all — a PAT with write
  grants turns either into a write tool. This policy puts the read-only guarantee
  on the SQL text itself, so it holds regardless of which server is behind the
  gateway or how its credentials are scoped.

  The effect is to make any guarded Databricks SQL tool **effectively read-only
  for ordinary agent callers**. When a caller needs to write, the denial reason
  directs the agent to re-issue the query through the managed
  `execute_sql_read_only` tool (which the SQL server exposes for exactly this
  purpose), or to route the change through the `data-engineering` team.

  Callers whose IdP-issued `groups` claim includes `data-engineering` are exempt,
  so the data-engineering team can still run writes and DDL over the agent path.
  The exemption is read through an `object.get` chain that **fails closed** — a
  caller with no claims, or no `groups` claim, is treated as having no groups and
  is therefore subject to the deny.

  **Fail closed on a missing SQL argument.** If a guarded SQL tool is called with
  no readable statement string (the argument is absent, empty, or a non-string),
  the guard cannot confirm the call is read-only, so it **denies** rather than
  letting a malformed call slip past the verb check.

  This runs at ingress, before the statement reaches Databricks, so a blocked
  `DROP`/`DELETE`/`GRANT` never executes.

  ## Compliance alignment

  - **PCI DSS 7.2.6** — supports restricting *programmatic query access to stored
    cardholder data by role*: mutating access to lakehouse data over the MCP path
    is confined to the `data-engineering` group, and every other caller is
    read-only.
  - **GDPR Art. 5(1)(c)** — supports *data minimisation* on the agent channel by
    preventing the agent from writing, restructuring, or bulk-exporting personal
    data held in the lakehouse; only read-only access remains for ordinary
    callers.
  - **SOX §802 / 18 U.S.C. §1519** — supports the *anti-destruction/alteration of
    records* control by blocking `DROP`/`TRUNCATE`/`DELETE`/`UPDATE` against
    financially relevant lakehouse tables on the agent channel.
  - **SOC 2 CC8.1** — supports *change management* by preventing the agent from
    making unreviewed schema/DDL changes (`CREATE`/`ALTER`/`DROP`) to production
    data structures outside a controlled `data-engineering` path.

  ## Tool name matching

  The policy matches every SQL-executing tool across the Databricks MCP servers by
  **suffix** (the gateway prefixes tool names with the configured MCP server name,
  which is not standardized), sharing the `execute_sql` / `execute_sql_query`
  stem the landscape note recommends matching on:

  - `*execute_sql` — Databricks managed SQL server (read + write) **and** the
    `JustTryAI/databricks-mcp-server` community tool of the same name (a name
    collision the shared suffix intentionally catches)
  - `*execute_sql_read_only` — Databricks managed SQL server's read-only tool
    (guarded too, for defense in depth; a read-only SELECT still passes)
  - `*execute_sql_query` — `RafaelCartenet/mcp-databricks-server` community tool
    (`execute_sql_query(sql)`), which has no server-side read-only guard

  **Genie is out of scope.** The Genie tools (`genie_ask`, `genie_poll_response`)
  take a natural-language question, not raw SQL — the agent never hands them a SQL
  string — so they do not match any suffix here and pass through untouched. The
  `poll_sql_result` egress tool (which carries the returned rows, not the
  statement) is likewise not this policy's concern.

  ## Argument shape

  The managed SQL tools and the community servers all carry the statement as a
  string. The policy reads it from `statement`, `sql`, and `query` (in that set)
  and inspects the concatenation of whichever string values are present —
  `execute_sql_query` uses `sql`; the managed tools' exact key is not published in
  the landscape note, so `statement`/`query` are inspected defensively. Only
  string values are considered; a non-string value yields no readable SQL, which
  on a guarded tool is denied fail-closed (see What it does).

  ## Examples

  ### Allowed — read-only SELECT

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-sql-execute_sql", "type": "tool" },
      "payload": {
        "name": "databricks-sql-execute_sql",
        "args": { "statement": "SELECT id, created_at, updated_at FROM orders LIMIT 10" }
      }
    }
  }
  ```

  `allow = true` — `created_at`/`updated_at` do not trip `CREATE`/`UPDATE` because
  the pattern is anchored on word boundaries.

  ### Allowed — SHOW/DESCRIBE metadata read

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-sql-execute_sql_read_only", "type": "tool" },
      "payload": {
        "name": "databricks-sql-execute_sql_read_only",
        "args": { "statement": "DESCRIBE TABLE main.sales.orders" }
      }
    }
  }
  ```

  `allow = true`.

  ### Denied — destructive DDL

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-sql-execute_sql", "type": "tool" },
      "payload": {
        "name": "databricks-sql-execute_sql",
        "args": { "statement": "DROP TABLE main.sales.customers" }
      }
    }
  }
  ```

  `allow = false` with the write/DDL reason.

  ### Allowed — break-glass data engineer

  The same `DROP TABLE` call succeeds when `input.subject.claims.groups` contains
  `data-engineering`.

  ## Composition

  This policy blocks statement-class mutation. Useful companions:

  - **PF-28 `default-deny-unknown-tools`** — allowlist the exact Databricks tool
    names the gateway exposes so a renamed or dynamically-named SQL tool
    (the managed servers also mint dynamic `{CATALOG}__{SCHEMA}__{NAME}` tools for
    AI Search / UC functions) cannot bypass the suffix match here.
  - **PF-14 `constrain-aggregator`** — Databricks ships `system.ai` MCP Services
    that proxy other SaaS apps; constrain that fan-out separately so it cannot
    become a side channel around per-app policy.
  - **PF-06 compute/ops lockdown** — deny `create_cluster`/`terminate_cluster`/
    `run_job`/`export_notebook` (the community servers' compute surface) for
    non-platform callers.
  - **Egress PII/PAN redaction** on `poll_sql_result` / `genie_poll_response`,
    since a permitted `SELECT *` can still return regulated data — the rows
    egress in the poll response, not the submit call.

  ## Known limitations

  - **Regex over SQL text, not a parser.** The keyword match runs on the raw
    string. A mutating keyword inside a string literal or comment (e.g.
    `SELECT 'we will DROP this later'`) is a false positive; conversely, SQL that
    mutates without one of the listed keywords (a `CALL` to a UDF that writes) is
    a false negative. Treat this as a high-signal read-only guard, not a SQL
    firewall.
  - **Comment-injection splits the two-word constructs.** The multi-word matches
    (`COPY INTO`, `LOAD DATA`, `EXECUTE IMMEDIATE`) join their words with `\s+`, so
    a block comment wedged between them — `COPY /*x*/ INTO`, `LOAD /*x*/ DATA` —
    is not recognized and passes, since a comment is not whitespace. The
    single-word DML/DDL verbs are unaffected (a keyword token cannot contain a
    comment). This is the same "not a SQL parser" residual above; pin the tool
    with PF-28 if you need parser-grade coverage of the ingest constructs.
  - **`DENY`/`LOAD DATA` word false positives.** Because the scan is keyword-based,
    a read-only statement that uses `deny` or `reorg` as a bare column name
    (`SELECT deny FROM flags`, `SELECT reorg FROM t`) or the two identifiers
    `load data` back-to-back (`SELECT load data FROM
    t`, an implicit alias) is a false-positive deny — the same conservative
    trade-off already accepted for `GRANT`/`REVOKE`. `COMMENT` is deliberately
    excluded from this trade-off (see below) because `comment` columns are far more
    common. Escalate a false positive to your data platform team.
  - **Dynamic SQL is denied, not parsed.** `EXECUTE IMMEDIATE` runs a string
    expression, so `EXECUTE IMMEDIATE 'DR'||'OP TABLE x'` would reassemble a
    `DROP` that the keyword scan cannot see in the fragments. Because the
    construct cannot be proven read-only from the argument, the literal phrase
    `EXECUTE IMMEDIATE` is itself treated as mutating and denied fail-closed —
    including a legitimately read-only `EXECUTE IMMEDIATE 'SELECT …'`. Run dynamic
    SQL through the `data-engineering` group. A caller could still hide a write
    behind a non-`EXECUTE IMMEDIATE` executor (a UDF/`CALL` whose body writes);
    those carry no inspectable SQL and are out of scope — pin them with PF-28.
  - **Metadata-only and layout statements are not blocked.** `COMMENT ON` (which
    edits catalog metadata) and `OPTIMIZE`/`ZORDER` (which rewrite file
    layout without changing logical rows) pass through. `REORG` is *not* in this
    set — it is blocked, because its `APPLY (PURGE)` form permanently destroys
    data files; `ANALYZE ... COMPUTE STATISTICS` and `MSCK REPAIR` (stats/
    partition metadata) do pass. `COMMENT` in particular is
    deliberately *not* a keyword: a `comment` column is extremely common
    (`SELECT comment FROM tickets`), so matching the bare word would be a heavy
    false-positive source. If your change-management scope requires blocking
    metadata edits, pin the tool with the PF-28 companion instead.
  - **Whitespace/non-executable statements pass.** A statement that is only
    whitespace or punctuation contains no mutating keyword and is allowed; it is
    also not executable SQL, so this is not an exploitable write path.
  - **UC function tools can hide writes.** Unity Catalog function tools (named
    after the function, not `execute_sql*`) run arbitrary function bodies that may
    write, and carry no inspectable SQL. They are out of scope here — pin them
    with the PF-28 companion.
  - **Managed SQL argument key is unverified.** The landscape note documents the
    managed `execute_sql`/`execute_sql_read_only` tools as taking "the SQL
    statement string" but does not publish the argument's name. The policy
    inspects `statement`/`sql`/`query`; if your managed server uses a different
    key, the call is denied fail-closed (missing-SQL branch) — add the real key to
    `sql_arg_keys`.
  - **Non-string SQL arguments.** Only string values under the inspected keys are
    read. A crafted non-string value (list/object) yields no readable SQL and is
    denied fail-closed rather than erroring the rule open.
  - **Group names are placeholders** — replace `data-engineering` with your IdP's
    group name at import time. The exemption reads `input.subject.claims.groups`;
    on Auth0 tenants without RBAC/permissions configured, no `groups` claim
    reaches the policy and the exemption never fires (fail-closed — everyone is
    read-only until the claim is wired up).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - databricks
industries: []
bundles:
  - soc2
  - pci-dss
  - sox
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package databricks.ingress.guard_warehouse_sql

# Deny-by-default: a Databricks SQL tool call is permitted only when it carries
# readable, read-only SQL, or the caller is an exempt data engineer.
default allow := false

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match on the suffix to stay portable. These are every SQL-executing tool across
# the Databricks servers, sharing the `execute_sql` / `execute_sql_query` stem:
#   - `execute_sql`            — managed SQL server (read + write) AND the
#                                JustTryAI community tool (name collision — both
#                                caught by the shared suffix, by design)
#   - `execute_sql_read_only`  — managed SQL server's read-only tool (guarded too;
#                                a read-only SELECT still passes)
#   - `execute_sql_query`      — RafaelCartenet community tool (no server-side
#                                read-only guard)
# Genie tools (`genie_ask`, `genie_poll_response`) take natural language, not raw
# SQL, so they do NOT end with any of these suffixes and pass through untouched.
sql_tool_suffixes := [
	"execute_sql",
	"execute_sql_read_only",
	"execute_sql_query",
]

is_sql_tool if {
	name := lower(input.resource.name)
	some suffix in sql_tool_suffixes
	endswith(name, suffix)
}

# --- SQL extraction ----------------------------------------------------------
# `execute_sql_query` uses `sql`; the managed tools' exact key is not published,
# so we inspect `statement`/`sql`/`query` and match the concatenation of whichever
# string values are present. Only string values are considered — a crafted
# non-string arg (list/object) yields no SQL, which on a guarded tool is denied
# fail-closed below (see Known limitations).
sql_arg_keys := ["statement", "sql", "query"]

sql_text := concat(" ", [v |
	some key in sql_arg_keys
	v := object.get(input.payload.args, key, "")
	is_string(v)
	v != ""
])

# --- Mutating / destructive / export statement detection ---------------------
# Case-insensitive `(?i)` and anchored on word boundaries `\b` so identifiers
# like `created_at`, `updated_at`, or `merge_log` do not trip the keywords.
# Covers DML/DDL/permission verbs plus the `COPY INTO` bulk export/ingest
# construct (`\s+` allows any run of whitespace between the two words). An
# `INSERT OVERWRITE DIRECTORY` exfil is already caught by the INSERT verb.
# `VACUUM` (permanent Delta file purge — irreversible destruction that defeats
# time-travel recovery), `RESTORE` (reverts a table to a prior version,
# altering current data), and `REORG` (whose `APPLY (PURGE)` form permanently
# purges underlying data files, the same time-travel-defeating destruction as
# `VACUUM`) are Delta-specific mutation/destruction statements that
# carry none of the DML/DDL verbs above, so they are matched explicitly. `REORG`
# is matched as a bare verb (not just its `APPLY (PURGE)` clause) so a comment or
# whitespace trick inside the clause cannot hide the purge — the same parser-free
# stance taken for `VACUUM`; a benign non-purge `REORG` compaction is denied too
# (route it through data-engineering).
# `DENY` is the legacy Hive-metastore table-ACL permission statement (a
# permission-plane change that GRANT/REVOKE don't cover), and `LOAD\s+DATA` is the
# Spark/Hive data-ingest statement (a write parallel to `COPY INTO` — loads files
# into a table) — both are matched so the permission/ingest surface has no gap.
# `EXECUTE IMMEDIATE` is Databricks' dynamic-SQL executor: it runs a string
# expression, so `EXECUTE IMMEDIATE 'DR'||'OP TABLE x'` reassembles a `DROP` the
# keyword scan can't see in the fragments. The construct itself cannot be shown
# read-only from the argument, so the literal phrase is matched and denied
# fail-closed (a read-only `EXECUTE IMMEDIATE 'SELECT …'` is denied too — route it
# through the data-engineering group; see Known limitations).
mutating_pattern := `(?i)(\b(?:INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|DENY|VACUUM|RESTORE|REORG)\b|\bCOPY\s+INTO\b|\bLOAD\s+DATA\b|\bEXECUTE\s+IMMEDIATE\b)`

is_mutating_sql if {
	regex.match(mutating_pattern, sql_text)
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
# Non-guarded tools (Genie, poll/list/describe helpers, anything not a SQL tool)
# pass through untouched.
allow if {
	not is_sql_tool
}

# Break-glass data engineers may run any statement on the SQL tools.
allow if {
	is_sql_tool
	is_exempt
}

# Ordinary callers may run readable, read-only SQL. Requires the statement to be
# present (fail closed on missing/empty) AND non-mutating.
allow if {
	is_sql_tool
	not is_exempt
	sql_text != ""
	not is_mutating_sql
}

# --- Deny reasons ------------------------------------------------------------
reasons contains "This Databricks SQL statement performs a write, DDL, permission, or export operation (INSERT, UPDATE, DELETE, MERGE, DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE, or COPY INTO) and is blocked on the agent MCP path, which is read-only. Re-issue it as a read-only statement (SELECT, SHOW, DESCRIBE, or EXPLAIN) through the execute_sql_read_only tool, or have a member of the data-engineering group run the change. If this was a false positive, contact your data platform team." if {
	is_sql_tool
	not is_exempt
	sql_text != ""
	is_mutating_sql
}

reasons contains "This Databricks SQL tool was called with no readable SQL statement, so the guard cannot confirm the call is read-only and blocks it fail-closed. Supply the statement as a string argument and re-issue read-only queries through the execute_sql_read_only tool, or route writes through the data-engineering group. If this was a false positive, contact your data platform team." if {
	is_sql_tool
	not is_exempt
	sql_text == ""
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
