---
name: Block Destructive and Mutating Snowflake SQL
tags:
  - snowflake
  - guard-warehouse-sql
  - ingress
  - sql
  - readonly
  - soc2
  - pci-dss
  - sox
publishedAt: 2026-07-12
description: |
  # snowflake / guard-warehouse-sql

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on a mutating/destructive statement, allow otherwise
  **Package:** `snowflake.ingress.guard_warehouse_sql`

  ## What it does

  Inspects the SQL text that Snowflake MCP tools carry in their `query` argument
  and denies any statement in a mutating or destructive class — `DROP`,
  `TRUNCATE`, `DELETE`, `UPDATE`, `INSERT`, `MERGE`, `ALTER`, `CREATE`, `GRANT`,
  and `REVOKE` (the `CREATE` class also covers `CREATE USER` / `CREATE ROLE`
  governance DDL). Read-only statements — `SELECT` and other queries that match
  none of those keywords — pass through.

  The Snowflake-Labs server also exposes DDL tools that carry **no SQL string**
  — `create_object`, `create_or_alter_object`, and `drop_object` take structured
  args (`object_type`, `target_object`) instead. `drop_object` alone can drop a
  Database, Schema, Table, View, Warehouse, Role, or User. Because the SQL-text
  check can never see inside these, the policy denies them **by tool name**, so
  the read-only guarantee does not leak through them.

  The effect is to make any Snowflake connection **effectively read-only for
  ordinary agent callers**, independent of the managed server's `read_only`
  flag or the Labs server's `sql_statement_permissions` allowlist: the check is
  on the SQL text (and, for the structured DDL tools, the tool name) itself, so
  it holds even when the server-side gate is misconfigured or absent.

  Callers whose IdP-issued `groups` claim includes `data-platform-admins` are
  exempt, so break-glass DDL still works for the platform team. The exemption is
  read through an `object.get` chain that **fails closed** — a caller with no
  claims, or no `groups` claim, is treated as having no groups and is therefore
  subject to the deny.

  This runs at ingress, before the statement reaches Snowflake, so a blocked
  `DROP`/`DELETE`/`GRANT` never executes — Time Travel and undrop are not needed
  because the change never happens.

  ## Compliance alignment

  - **SOC 2 CC8.1** — supports change management by preventing the agent from
    making unreviewed schema/DDL changes (`CREATE`/`ALTER`/`DROP`) to production
    data structures outside a controlled break-glass path.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored
    cardholder data by role: mutating access to warehouse data over the MCP path
    is confined to the `data-platform-admins` group, and everyone else is
    read-only.
  - **SOX §802 / 18 U.S.C. §1519** — supports the anti-destruction/alteration of
    records control by blocking `DROP`/`TRUNCATE`/`DELETE`/`UPDATE` against
    financially relevant warehouse tables on the agent channel.
  - **HIPAA §164.312(c)(1) / §164.308(a)(4)** — supports the integrity standard
    and information-access management on a PHI-capable warehouse: blocking
    `DROP`/`TRUNCATE`/`DELETE`/`UPDATE` (and the structured
    `create_object`/`drop_object` DDL tools) for non-admin callers protects
    ePHI from improper alteration or destruction on the agent channel and
    confines mutating access to the `data-platform-admins` group.

  ## Tool name matching

  The policy matches the Snowflake tools that pass a raw SQL statement in a
  `query` argument, by **suffix** (the gateway prefixes tool names with the
  configured MCP server name, which is not standardized):

  - `*system_execute_sql` — Snowflake-managed server (`SYSTEM_EXECUTE_SQL` type)
  - `*run_snowflake_query` — Snowflake-Labs server (`snowflake-labs-mcp`)
  - `*read_query`, `*write_query`, `*create_table` — isaacwasserman community
    server

  A second set of Snowflake-Labs tools is matched by name (not by SQL text)
  because they carry no `query` argument and are mutating/destructive by design:

  - `*create_object`, `*create_or_alter_object`, `*drop_object` — Snowflake-Labs
    structured DDL tools (denied outright for non-exempt callers)

  Cortex read tools that emit natural language rather than raw SQL —
  `CORTEX_ANALYST_MESSAGE` (arg `message`) and `CORTEX_SEARCH_SERVICE_QUERY`
  (arg `query`) — do **not** end with any of these suffixes and pass through
  untouched, as do the read/list/describe helpers (`list_objects`,
  `list_databases`, `describe_table`, …).

  **Managed-server caveat:** the Snowflake-managed server lets the admin choose
  each tool's name (the dangerous semantics live in the tool `type`, which is not
  on the wire at call time). If your managed server exposes its SQL tool under a
  custom name (e.g. `sales-sql`), add that suffix to `sql_tool_suffixes` in
  `policy.md`, and pair this policy with a PF-28 `default-deny-unknown-tools`
  policy so an unrecognized SQL tool cannot slip past. See Known limitations.

  ## Argument shape

  All matched tools carry the statement in `input.payload.args.query`. As a
  defensive fallback the policy also inspects `statement` and `sql` keys and
  matches the concatenation, so a deployment that renamed the argument is still
  covered. If none of those keys is present the call has no inspectable SQL and
  is allowed through (the tool call is inert without a statement).

  ## Examples

  ### Allowed — read-only SELECT

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-mcp-run_snowflake_query", "type": "tool" },
      "payload": {
        "name": "snowflake-mcp-run_snowflake_query",
        "args": { "query": "SELECT id, created_at, updated_at FROM orders LIMIT 10" }
      }
    }
  }
  ```

  `allow = true` — `created_at`/`updated_at` do not trip `CREATE`/`UPDATE`
  because the pattern is anchored on word boundaries.

  ### Allowed — Cortex natural-language tool passes through

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-mcp-CORTEX_ANALYST_MESSAGE", "type": "tool" },
      "payload": {
        "name": "snowflake-mcp-CORTEX_ANALYST_MESSAGE",
        "args": { "message": "update me on this quarter's revenue" }
      }
    }
  }
  ```

  `allow = true` — not a SQL tool; the word "update" in prose is irrelevant.

  ### Denied — destructive SQL

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-mcp-run_snowflake_query", "type": "tool" },
      "payload": {
        "name": "snowflake-mcp-run_snowflake_query",
        "args": { "query": "DROP TABLE customers" }
      }
    }
  }
  ```

  `allow = false` with the mutating-SQL reason.

  ### Allowed — break-glass admin

  The same `DROP TABLE customers` call succeeds when
  `input.subject.claims.groups` contains `data-platform-admins`.

  ## Composition

  This policy blocks statement-class mutation. Useful companions:

  - **PF-07 bulk-export sibling** — deny `COPY INTO @<stage>` /
    `COPY INTO 's3://…'` and bare `CREATE STAGE` to stop exfiltration to external
    storage (this policy blocks `CREATE STAGE` via the `CREATE` class but not a
    `COPY INTO` that reuses an existing stage).
  - **PF-28 `default-deny-unknown-tools`** — allowlist the exact Snowflake tool
    names the gateway exposes so an admin-named managed SQL tool cannot bypass
    the suffix match here.
  - **PF-22 `deny-escape-hatches`** — deny opaque composite tools
    (`CORTEX_AGENT_RUN`, `GENERIC` UDF/stored-proc wrappers) whose SQL the
    gateway cannot see.
  - **Egress PII/PAN redaction** on `read_query`/`run_snowflake_query` results,
    since a permitted `SELECT *` can still return regulated data.

  ## Known limitations

  - **Regex over SQL text, not a parser.** The keyword match runs on the raw
    string. A mutating keyword inside a string literal or comment (e.g.
    `SELECT 'we will DROP this later'`) is a false positive; conversely, SQL that
    mutates without one of the listed keywords (a `CALL` to a stored procedure
    that deletes, an `EXECUTE IMMEDIATE` assembled from fragments) is a false
    negative. Treat this as a high-signal read-only guard, not a SQL firewall.
  - **Stored procedures / composite tools.** `CALL proc()` and Cortex Agent /
    `GENERIC` tools can have arbitrary side effects the gateway cannot inspect —
    deny those with the PF-22 companion.
  - **Non-string SQL arguments.** The SQL inspection only reads `query`/
    `statement`/`sql` when they are strings (the verified schema for every
    matched tool). A crafted non-string value (a list or object) is treated as
    carrying no inspectable SQL and passes through as inert rather than erroring
    the rule open — but if a future/forked server actually executed SQL from a
    non-string argument, that statement would not be inspected. Pair with the
    PF-28 companion, which pins the exact tool set and argument contract.
  - **Managed-server admin naming.** Tools on the Snowflake-managed server have
    admin-chosen names; only the `system_execute_sql` suffix is matched by
    default. Add your configured name to `sql_tool_suffixes` and pair with
    PF-28. Verified tool names for the Labs and community servers come from the
    Snowflake landscape note; the managed-server tool *name* is unverified by
    design (semantics are carried in the non-wire `type`).
  - **Bulk export not covered.** `COPY INTO` against an existing external stage
    is not a listed keyword — use the PF-07 bulk-export companion.
  - **Group names are placeholders** — replace `data-platform-admins` with your
    IdP's group name at import time. The exemption reads
    `input.subject.claims.groups`; on Auth0 tenants without RBAC/permissions
    configured, no `groups` claim reaches the policy and the exemption never
    fires (fail-closed — everyone is read-only until the claim is wired up).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - snowflake
industries: []
bundles:
  - soc2
  - pci-dss
  - sox
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package snowflake.ingress.guard_warehouse_sql

# Deny-by-default: a Snowflake SQL tool call is permitted only when it carries no
# mutating/destructive statement, or the caller is an exempt data-platform admin.
default allow := false

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match on the suffix to stay portable. These are the Snowflake tools that pass a
# raw SQL statement in a `query` argument:
#   - `system_execute_sql`  — Snowflake-managed server (SYSTEM_EXECUTE_SQL type)
#   - `run_snowflake_query` — Snowflake-Labs server
#   - `read_query`/`write_query`/`create_table` — isaacwasserman community server
# Cortex tools (`CORTEX_ANALYST_MESSAGE`, `CORTEX_SEARCH_SERVICE_QUERY`) and
# list/describe helpers do NOT end with any of these suffixes, so they pass
# through untouched.
sql_tool_suffixes := [
	"system_execute_sql",
	"run_snowflake_query",
	"read_query",
	"write_query",
	"create_table",
]

is_sql_tool if {
	name := lower(input.resource.name)
	some suffix in sql_tool_suffixes
	endswith(name, suffix)
}

# --- Structured mutating tools ----------------------------------------------
# The Snowflake-Labs server also exposes DDL tools that carry NO SQL string —
# they take structured args (`object_type`, `target_object`) — so the SQL-text
# check below can never see them. They are mutating/destructive by definition
# (`drop_object` can drop a Database, Schema, Table, View, Warehouse, Role, or
# User), so we deny them by tool name outright, subject to the same break-glass
# exemption. Without this, the "effectively read-only" guarantee would leak.
structured_mutating_suffixes := [
	"create_object",
	"create_or_alter_object",
	"drop_object",
]

is_structured_mutating_tool if {
	name := lower(input.resource.name)
	some suffix in structured_mutating_suffixes
	endswith(name, suffix)
}

# --- SQL extraction ----------------------------------------------------------
# All matched tools pass the statement in `query`; we also inspect `statement`
# and `sql` defensively in case a deployment renamed the argument, and match the
# concatenation of whichever are present. Only string values are inspected — a
# crafted non-string arg (list/number/object) is treated as carrying no SQL
# rather than erroring the rule into fail-open (see Known limitations).
sql_text := concat(" ", [v |
	some key in ["query", "statement", "sql"]
	v := object.get(input.payload.args, key, "")
	is_string(v)
	v != ""
])

# Mutating/destructive statement classes. Case-insensitive `(?i)` and anchored on
# word boundaries `\b` so identifiers like `created_at`, `updated_at`, or
# `merge_log` do not trip CREATE/UPDATE/MERGE. The CREATE class also covers
# CREATE USER / CREATE ROLE governance DDL.
mutating_pattern := `(?i)\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT|MERGE|ALTER|CREATE|GRANT|REVOKE)\b`

is_mutating_sql if {
	regex.match(mutating_pattern, sql_text)
}

# --- Identity exemption ------------------------------------------------------
# Break-glass: callers in the `data-platform-admins` IdP group may run DDL. The
# object.get chain fails closed — a missing `subject.claims` object or missing
# `groups` claim yields an empty list, so an unauthenticated/unclaimed caller is
# never exempt.
caller_groups := object.get(object.get(input.subject, "claims", {}), "groups", [])

is_exempt if {
	some g in caller_groups
	g == "data-platform-admins"
}

# --- Allow rules -------------------------------------------------------------
# Non-guarded tools (Cortex Analyst/Search, list/describe helpers, anything
# else) pass through. Both the SQL-carrying tools and the structured DDL tools
# are guarded, so neither slips through this branch.
allow if {
	not is_sql_tool
	not is_structured_mutating_tool
}

# Break-glass admins may run any statement on the SQL tools.
allow if {
	is_sql_tool
	is_exempt
}

# Ordinary callers may run read-only SQL (SELECT and other non-mutating reads).
allow if {
	is_sql_tool
	not is_exempt
	not is_mutating_sql
}

# Break-glass admins may also run the structured DDL tools.
allow if {
	is_structured_mutating_tool
	is_exempt
}

# --- Deny reason -------------------------------------------------------------
reasons contains "This Snowflake statement performs a mutating or destructive operation (DROP, TRUNCATE, DELETE, UPDATE, INSERT, MERGE, ALTER, CREATE, GRANT, or REVOKE — including CREATE USER / CREATE ROLE) and is blocked on the agent MCP path, which is read-only. Rewrite it as a SELECT, or have a member of the data-platform-admins group run break-glass DDL. If this was a false positive, contact your data platform team." if {
	is_sql_tool
	not is_exempt
	is_mutating_sql
}

reasons contains "This Snowflake tool performs a structured schema/object mutation (create/alter/drop of a database, schema, table, view, warehouse, role, or user) and is blocked on the agent MCP path, which is read-only. Route the change through your change-management process, or have a member of the data-platform-admins group run it as break-glass DDL. If this was a false positive, contact your data platform team." if {
	is_structured_mutating_tool
	not is_exempt
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
