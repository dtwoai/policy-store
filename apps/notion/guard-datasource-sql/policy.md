---
name: Block Destructive and Export SQL on Notion Data Sources
tags:
  - notion
  - guard-warehouse-sql
  - ingress
  - sql
  - readonly
  - soc2
publishedAt: 2026-07-12
description: |
  # notion / guard-datasource-sql

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on a destructive/export SQL construct or an uninspectable payload, allow otherwise
  **Package:** `notion.ingress.guard_datasource_sql`

  ## What it does

  Inspects Notion data-source query tool calls (`notion-query-data-sources` on
  the hosted server, `query-data-source` on the official local server) and
  denies any whose raw SQL argument contains a data-manipulation, schema, or
  export construct — `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`,
  `GRANT`, `TRUNCATE`, a MySQL `REPLACE INTO` upsert — or a bulk-export idiom (`INTO OUTFILE`/`DUMPFILE`,
  `COPY INTO`, `COPY … TO`, `EXPORT DATA`, `UNLOAD`, `ATTACH DATABASE`,
  `SELECT … INTO`). The effect is that the agent can only run **read-only
  SELECT queries** against Notion databases — which in practice hold HR
  trackers, CRM tables, finance/deal pipelines, and incident logs.

  Calls that pass only an existing view ID (or other non-SQL arguments) with
  no free SQL string are allowed through untouched, and read-only SELECTs stay
  allowed, so ordinary reporting keeps working.

  The policy **fails closed** on anything it cannot inspect: if the SQL
  argument is present but not a plain string, or the tool is called with an
  unexpectedly-shaped arguments payload (an array or scalar where an object is
  expected), the call is denied with an explanatory reason rather than waved
  through.

  This is defense-in-depth: the hosted server nominally exposes SELECT-style
  querying only, so a blocked DML/DDL keyword guards against upstream server
  changes, plan/feature drift, or prompt-injected query bodies — not against a
  capability Notion documents today.

  ## Compliance alignment

  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary and
    information-access limits by confining agent SQL over Notion databases
    (which in practice hold HR trackers and other regulated records) to
    read-only SELECT and denying bulk-export idioms that would pull entire
    tables of personal/health data out through a single query; **§164.312(c)**
    — supports the integrity standard by blocking
    `DELETE`/`DROP`/`UPDATE`/`TRUNCATE` against those records.
  - **GDPR Art. 5(1)(c) / CCPA** — supports data minimisation by denying
    bulk-export idioms that would pull entire HR/CRM tables of personal data
    out through a single query.
  - **SOC 2 CC8.1** — supports change management by preventing the agent from
    making unreviewed schema changes (`CREATE`/`ALTER`/`DROP`) to data-source
    structures.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `notion-mcp-…`), which is not standardized, so the policy matches by
  **suffix**:

  - `*query-data-sources` — Notion hosted server (`notion-query-data-sources`,
    verified against Notion's supported-tools docs)
  - `*query-data-source` — official local server (`query-data-source`,
    verified against the `makenotion/notion-mcp-server` README; the v1 name
    was `post-database-query`)

  Neighbouring hosted read tools — `notion-query-database-view`,
  `notion-query-meeting-notes`, `notion-search`, `notion-fetch` — do not end
  with either suffix and pass through untouched. Verify the exact names your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  ## Argument shape

  Notion documents that `notion-query-data-sources` accepts **raw SQL or an
  existing view ID** with filters/grouping/summaries, but does not publish the
  exact wire argument key names. The policy therefore reads the SQL string
  defensively via `object.get` from three candidate keys — `sql`, `query`,
  `statement` — and matches the concatenation of whichever are present.

  - No candidate key present (e.g. a view-ID-only call): nothing to inspect,
    **allow**.
  - A candidate key holds a non-string value: uninspectable, **deny**
    (fail closed).
  - `input.payload.args` is not an object at all: uninspectable, **deny**
    (fail closed).

  ## Examples

  ### Allowed — read-only SELECT

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-mcp-notion-query-data-sources", "type": "tool" },
      "payload": {
        "name": "notion-mcp-notion-query-data-sources",
        "args": { "sql": "SELECT name, stage, close_date FROM crm_pipeline WHERE stage = 'won'" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — view-ID-only call, no free SQL

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-mcp-notion-query-data-sources", "type": "tool" },
      "payload": {
        "name": "notion-mcp-notion-query-data-sources",
        "args": { "view_id": "1f3a-collection-view-90d2" }
      }
    }
  }
  ```

  `allow = true` — nothing to inspect, passes untouched.

  ### Denied — destructive SQL

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-mcp-notion-query-data-sources", "type": "tool" },
      "payload": {
        "name": "notion-mcp-notion-query-data-sources",
        "args": { "sql": "DELETE FROM hr_tracker WHERE status = 'closed'" }
      }
    }
  }
  ```

  `allow = false` with the blocked-construct reason.

  ## Composition

  This policy blocks destructive/export SQL on the data-source query path.
  Useful companions:

  - **Egress PII redaction** on `-query-data-sources` results — a permitted
    `SELECT *` over an HR tracker still returns regulated data.
  - **PF-28 `default-deny-unknown-tools`** — pin the exact Notion tool names
    your gateway exposes so a renamed or newly added query tool cannot slip
    past the suffix match.
  - A **sensitive data-source denylist** policy (deny queries whose target
    data-source ID is on an HR/comp/pipeline list unless the caller's IdP
    claims include the owning team).
  - A **`-get-users` guard** — the hosted server's directory tool returns
    workspace member emails and deserves its own gate.

  ## Known limitations

  - **Regex over SQL text, not a parser.** A blocked keyword inside a string
    literal (e.g. `SELECT * FROM notes WHERE body = 'please DROP this'`) is a
    false positive, and the `SELECT … INTO` pattern can trip on the word
    "into" in a literal. Conversely, a mutating construct not in the list
    would pass. Treat this as a high-signal read-only guard, not a SQL
    firewall.
  - **Hosted argument key names are unverified.** Notion documents the raw-SQL
    capability but not the wire key; the policy inspects `sql`, `query`, and
    `statement`. If your deployment carries SQL under a different key it
    passes uninspected — confirm with the dump-input technique and add the key
    to `sql_arg_keys`.
  - **Community servers are out of scope.** suekou's
    `notion_query_data_source_by_values` sends structured filters (no free
    SQL) and does not match; awkoy's `notion_execute` meta-tool hides every
    operation behind one tool name — block that server in gateway config
    rather than relying on this policy.
  - **No identity-based exemption.** All callers are read-only on this path.
    If you need a break-glass data team, add an `allow if` branch gated on
    `input.subject.claims.groups` (group names are placeholders — replace them
    with your IdP's group names at import time).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - notion
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package notion.ingress.guard_datasource_sql

# Deny-by-default: a Notion data-source query is permitted only when it carries
# no free SQL at all (view-ID-only call) or its SQL is read-only, and its
# payload is inspectable. Anything uninspectable fails closed.
default allow := false

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match on the suffix to stay portable:
#   - `query-data-sources` — hosted server (`notion-query-data-sources`)
#   - `query-data-source`  — official local server (`query-data-source`)
# Neighbouring read tools (`notion-query-database-view`,
# `notion-query-meeting-notes`, `notion-search`, `notion-fetch`) do not end
# with either suffix and pass through untouched.
datasource_query_suffixes := [
	"query-data-sources",
	"query-data-source",
]

is_datasource_query_tool if {
	name := lower(input.resource.name)
	some suffix in datasource_query_suffixes
	endswith(name, suffix)
}

# --- SQL extraction ----------------------------------------------------------
# Notion documents "raw SQL or an existing view ID" but not the exact wire key,
# so we defensively inspect three candidate argument keys and match the
# concatenation of whichever are present. A call with none of these keys has no
# free SQL to inspect (view-ID-only) and is allowed through untouched.
sql_arg_keys := ["sql", "query", "statement"]

raw_args := object.get(object.get(input, "payload", {}), "args", {})

sql_values := [v |
	is_object(raw_args)
	some key in sql_arg_keys
	v := raw_args[key]
]

# Every present SQL value must be a plain string, otherwise the call is
# uninspectable and fails closed.
all_sql_strings if {
	every v in sql_values {
		is_string(v)
	}
}

sql_text := concat(" ", [v | some v in sql_values; is_string(v)])

# --- Blocked constructs ------------------------------------------------------
# Conservative, case-insensitive patterns anchored on word boundaries so
# identifiers like `created_at`/`updated_at` never trip UPDATE/CREATE.
blocked_constructs := [
	{
		# Data-manipulation, schema, and privilege keywords. \b keeps
		# `updated_at` from matching UPDATE and `created_at` from CREATE.
		"pattern": `(?i)\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|TRUNCATE)\b`,
		"label": "data-manipulation, schema, or privilege keyword (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, GRANT, or TRUNCATE)",
	},
	{
		# MySQL-style bulk export of a result set to a server-side file.
		"pattern": `(?i)\binto\s+(?:outfile|dumpfile)\b`,
		"label": "INTO OUTFILE / INTO DUMPFILE (bulk export to a file)",
	},
	{
		# MySQL REPLACE INTO — an insert-or-replace mutation (delete+insert)
		# that carries no INSERT/UPDATE/DELETE keyword, so the DML pattern
		# above misses it. Optional LOW_PRIORITY/DELAYED modifiers are allowed
		# between REPLACE and INTO. The required `into` keeps this from
		# colliding with the scalar `REPLACE(str, from, to)` function used in
		# read-only SELECTs.
		"pattern": `(?i)\breplace\s+(?:low_priority\s+|delayed\s+)?into\b`,
		"label": "REPLACE INTO (MySQL insert-or-replace mutation)",
	},
	{
		# Snowflake-style bulk unload of a table to a stage or location.
		"pattern": `(?i)\bcopy\s+into\b`,
		"label": "COPY INTO (bulk unload)",
	},
	{
		# Postgres-style COPY <table-or-query> TO 'file' / TO STDOUT. The
		# bounded gap and required quote/STDOUT keep prose from matching.
		"pattern": `(?i)\bcopy\b[\s\S]{0,160}\bto\s+(?:stdout\b|')`,
		"label": "COPY ... TO (bulk copy to a file or stdout)",
	},
	{
		# BigQuery-style bulk export statement.
		"pattern": `(?i)\bexport\s+data\b`,
		"label": "EXPORT DATA (bulk export)",
	},
	{
		# Redshift/Athena-style bulk unload statement.
		"pattern": `(?i)\bunload\b`,
		"label": "UNLOAD (bulk export)",
	},
	{
		# SQLite escape hatch that attaches an external database file.
		"pattern": `(?i)\battach\s+database\b`,
		"label": "ATTACH DATABASE (cross-database escape)",
	},
	{
		# SELECT ... INTO copies the result set into another table or file.
		"pattern": `(?i)\bselect\b[\s\S]+?\binto\b`,
		"label": "SELECT ... INTO (copies results into another table or file)",
	},
]

sql_is_blocked if {
	some entry in blocked_constructs
	regex.match(entry.pattern, sql_text)
}

# --- Allow rules -------------------------------------------------------------
# Any tool other than the data-source query tools passes through.
allow if {
	not is_datasource_query_tool
}

# View-ID-only (or otherwise SQL-free) calls pass through untouched.
allow if {
	is_datasource_query_tool
	is_object(raw_args)
	count(sql_values) == 0
}

# Read-only SQL is allowed: every SQL value is a plain string and none of the
# blocked constructs match.
allow if {
	is_datasource_query_tool
	is_object(raw_args)
	count(sql_values) > 0
	all_sql_strings
	not sql_is_blocked
}

# --- Deny reasons ------------------------------------------------------------
reasons contains msg if {
	is_datasource_query_tool
	is_object(raw_args)
	count(sql_values) > 0
	all_sql_strings
	some entry in blocked_constructs
	regex.match(entry.pattern, sql_text)
	msg := sprintf("This Notion data-source query contains a blocked SQL construct — %s. The agent path to Notion databases is read-only: rewrite the query as a plain SELECT or use a saved view. If this was a false positive, contact your data platform team.", [entry.label])
}

# Fail closed: SQL argument present but not a plain string.
reasons contains "The SQL argument on this Notion data-source query is not a plain string, so it cannot be inspected. Pass the query as a single SQL string or reference a saved view ID instead. If this looks wrong, contact your data platform team." if {
	is_datasource_query_tool
	is_object(raw_args)
	count(sql_values) > 0
	not all_sql_strings
}

# Fail closed: arguments payload is not an object at all.
reasons contains "This Notion data-source query call has an unexpected argument shape that cannot be inspected, so it is blocked. Retry with a standard arguments object, or contact your data platform team." if {
	is_datasource_query_tool
	not is_object(raw_args)
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
