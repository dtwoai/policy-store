---
name: Block Bulk Export & External Staging (Snowflake)
tags:
  - snowflake
  - guard-warehouse-sql
  - export
  - exfiltration
  - ingress
  - soc2
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # snowflake / guard-warehouse-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `snowflake.ingress.guard_warehouse_export`

  ## What it does

  Blocks Snowflake SQL-execution tool calls whose query text moves whole tables
  off the Snowflake perimeter — bulk export to cloud storage or a stage, and
  external data sharing. It inspects the SQL string carried by the SQL-passthrough
  tools (`SYSTEM_EXECUTE_SQL`, `run_snowflake_query`, `write_query`) and denies the
  request at ingress, before the SQL ever reaches Snowflake, when the query
  contains any of these constructs (matched case-insensitively):

  - **`COPY INTO @<stage>`** — bulk unload of a table to a named/internal stage.
  - **`COPY INTO '<scheme>://…'`** — bulk unload directly to a cloud-storage URL
    outside Snowflake. Any quoted URL literal after `COPY INTO` is treated as an
    external unload target regardless of scheme (`s3://`, `s3gov://` GovCloud,
    `gcs://`, `azure://`, `s3compat://`, …); the scheme list is not enumerated.
  - **`CREATE [OR REPLACE] STAGE`** — creates the staging object that unloads target.
  - **`CREATE SHARE`**, **`ALTER SHARE … ADD ACCOUNTS`**, and
    **`GRANT … TO SHARE`** — the three steps of external data sharing (create the
    share, add consumer accounts, and place regulated objects into it). All are
    denied so no single step of an off-perimeter share can be built by the agent.
  - **`PUT file://…`** and **`GET @<stage>`** — client-side file transfer to/from a
    stage.

  Everything else — reads, `SELECT`, ordinary DML, and `COPY INTO <table> FROM
  @<stage>` (a *load*, not an unload) — passes through unchanged. This is a
  distinct job from the destructive-mutation policy (`guard-warehouse-sql`):
  that policy governs `DROP`/`TRUNCATE`/`GRANT`-class governance changes, whereas
  this one governs data *leaving* the warehouse.

  ## Why no group is exempt

  Unlike the mutation policy — which exempts a `data-platform-admins` IdP group —
  bulk export of regulated data off-perimeter is **never** an agent-appropriate
  action, even for a data-platform admin. There is no `allow if` claims branch: a
  human should run these operations out of band, from a session that is directly
  attributable to them, not through an agent that can be prompt-injected. If your
  organization needs a break-glass path, run it outside the gateway rather than
  weakening this policy.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission, movement, and
    removal of information by blocking bulk unload of warehouse data to external
    storage and shares; **CC8.1** — treats stage/share creation (a governance
    change to how data can leave) as a change-managed operation the agent may not
    self-serve.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored
    cardholder data by role, by denying the constructs that copy that data out;
    **3.4.2** — supports preventing the copy/relocation of PAN via remote access
    by blocking `COPY INTO` to external targets over the agent channel.
  - **GDPR Art. 5(1)(c)** — supports data minimisation by preventing wholesale
    export of personal data; **Arts. 44/46** — supports the restriction on
    cross-border transfers by blocking agent-initiated unload to arbitrary cloud
    storage and external Snowflake accounts; **Art. 5(1)(f)/32** — security of
    processing on the agent's warehouse-egress path.
  - **HIPAA §164.502(e) / §164.514(d)** — supports the business-associate and
    minimum-necessary safeguards on a PHI-capable warehouse: blocking bulk
    unload (`COPY INTO` an external stage or cloud-storage URL) and external
    data shares stops an agent from copying PHI-bearing tables wholesale to
    storage or Snowflake accounts outside the covered entity's controlled,
    BAA-governed perimeter.

  ## Tool name matching

  Snowflake has **no stable canonical tool names** — the managed MCP server lets
  the admin name each tool freely (the SQL semantics live in the tool *type*,
  which is not visible on the wire), and the SQL surface is a string inside one
  argument. This policy matches the SQL-execution tools by suffix on
  `lower(input.resource.name)`:

  - `*execute_sql` (covers the managed server's `SYSTEM_EXECUTE_SQL` type when
    surfaced under that name)
  - `*run_snowflake_query` (Snowflake-Labs `run_snowflake_query`)
  - `*write_query` (community `mcp-snowflake-server` `write_query`)

  Because managed-server tool names are admin-chosen, **add the exact SQL-tool
  name your deployment configured** to `sql_tool_suffixes`, and pair this policy
  with a PF-28 `default-deny-unknown-tools` policy so a newly added or renamed SQL
  tool cannot slip past the suffix list. Verify names with the dump-input debug
  technique before relying on this in production.

  ## Argument shape

  For all three tools the SQL text is the entire policy surface. The landscape
  note verifies the argument key is `query`. To be robust against alternate key
  names on admin-configured tools, and to defeat "hide the SQL under a different
  key" bypasses, the policy scans **every top-level string-valued argument** (not
  just `query`) and matches the export patterns against their concatenation. Only
  SQL-execution tools are inspected, so scanning all string args cannot affect
  read tools.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-mcp-run_snowflake_query", "type": "tool" },
      "payload": {
        "name": "snowflake-mcp-run_snowflake_query",
        "args": { "query": "SELECT id, name FROM analytics.customers LIMIT 100" }
      }
    }
  }
  ```

  `allow = true`, no reason. (A `COPY INTO customers FROM @load_stage` load is
  likewise allowed — only unloads to a stage/URL are blocked.)

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-mcp-run_snowflake_query", "type": "tool" },
      "payload": {
        "name": "snowflake-mcp-run_snowflake_query",
        "args": { "query": "COPY INTO @my_ext_stage FROM prod.pii.customers" }
      }
    }
  }
  ```

  `allow = false`, `reason` names the construct ("COPY INTO @<stage> …").

  ## Composition

  - **`guard-warehouse-sql`** — the sibling ingress policy that blocks
    destructive/governance SQL (`DROP`/`TRUNCATE`/`DELETE`/`GRANT`,
    `CREATE USER/ROLE`) with a `data-platform-admins` exemption. Attach both:
    this one has no exemption by design.
  - **A PF-28 `default-deny-unknown-tools` policy** on the Snowflake server prefix,
    so admin-named SQL tools that are not on the suffix list are denied outright
    rather than passing uninspected.
  - **An egress redaction policy** on read tools (`read_query`,
    `run_snowflake_query`, Cortex Search/Analyst): that only masks what the agent
    *reads back*; this policy prevents the *write* that exports the data. They are
    complementary, not substitutes.

  ## Known limitations

  - **Regex over SQL text, not a parser.** The patterns are conservative and
    anchored per construct, but SQL is expressive: heavy comment injection
    (`COPY/*x*/INTO`), unusual quoting, or vendor syntax variants could evade a
    pattern. Treat this as a high-signal guardrail, not a complete anti-exfil
    control. Deeper coverage belongs in Snowflake-side network policies and
    storage-integration allowlists.
  - **Nested/structured arguments not inspected.** Only top-level *string* arguments
    are scanned. SQL nested inside an object (e.g. `args.options.query`) **or inside
    an array** (e.g. a batch `args.statements: ["COPY INTO @…"]`) is not matched —
    the comprehension takes only `is_string(v)` top-level values. None of the three
    verified tools use those shapes (each takes a single `query`/statement string);
    add a rule (or a recursive walk) if your admin-configured tool nests SQL. Pair
    with a PF-28 `default-deny-unknown-tools` policy so such a tool cannot be added
    silently.
  - **Composite tools are opaque.** A `CORTEX_AGENT_RUN`-type tool executes
    multi-step plans server-side; the gateway sees one opaque call and cannot reach
    the SQL inside it. Deny agent/composite tools separately (see the landscape
    note's PF-06/PF-14 candidates).
  - **Tool names are unverified for the managed server.** `SYSTEM_EXECUTE_SQL` is a
    tool *type*, not a wire name; the actual tool name is admin-chosen. The
    suffixes here match the two OSS servers' verified names plus a generic
    `*execute_sql`; confirm and extend `sql_tool_suffixes` for your deployment.
  - **No identity exemption.** This is intentional (see "Why no group is exempt").
    The policy does not read `input.subject.claims` at all.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - snowflake
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
package snowflake.ingress.guard_warehouse_export

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# SQL-execution tools whose `query`/statement argument carries arbitrary SQL.
# Snowflake has no canonical tool names, so we match by suffix on the tool name.
# `execute_sql` covers the managed server's SYSTEM_EXECUTE_SQL type when surfaced
# under that name; the other two are the verified OSS-server names. Add the exact
# SQL-tool name your managed-server deployment configured.
sql_tool_suffixes := [
    "execute_sql",
    "run_snowflake_query",
    "write_query",
]

is_sql_tool if {
    name := lower(input.resource.name)
    some suffix in sql_tool_suffixes
    endswith(name, suffix)
}

# Bulk-export / external-staging constructs. Each pattern is case-insensitive
# (`(?i)`) and anchored to a specific SQL construct to limit false positives.
export_constructs := [
    # Unload a table into a named or internal stage: COPY INTO @<stage> ...
    # (COPY INTO <table> FROM @stage is a *load* and does not match — the @ must
    # directly follow INTO).
    {
        "pattern": `(?i)\bcopy\s+into\s+@`,
        "label": "COPY INTO @<stage> (bulk unload to a stage)",
    },
    # Unload directly to a cloud-storage URL outside Snowflake. Any quoted URL
    # literal directly after COPY INTO is an external unload target — the scheme
    # is NOT enumerated (covers s3://, s3gov:// GovCloud, gcs://, azure://,
    # s3compat:// and any future scheme). A *load* names an unquoted table
    # (COPY INTO <table> FROM …), so requiring the leading quote avoids the load.
    {
        "pattern": `(?i)\bcopy\s+into\s+'[a-z0-9][a-z0-9+.\-]*://`,
        "label": "COPY INTO cloud-storage URL (external unload)",
    },
    # Create the staging object that COPY INTO unloads to.
    {
        "pattern": `(?i)\bcreate\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?stage\b`,
        "label": "CREATE STAGE",
    },
    # Create a data share (exposes data to other Snowflake accounts).
    {
        "pattern": `(?i)\bcreate\s+(?:or\s+replace\s+)?share\b`,
        "label": "CREATE SHARE",
    },
    # Add external accounts to an existing share. [\s\S]* crosses newlines
    # because ADD ACCOUNTS may sit on a later line of the statement.
    {
        "pattern": `(?i)\balter\s+share\b[\s\S]*\badd\s+accounts\b`,
        "label": "ALTER SHARE ... ADD ACCOUNTS",
    },
    # Grant object access into an existing share — the step that actually places
    # regulated tables into a share for external accounts to read (CREATE/ALTER
    # SHARE alone expose nothing without it). `\bto\s+share\b` requires the SHARE
    # keyword, so it does not match GRANT ... TO ROLE share_admin or a table whose
    # name merely contains "share".
    {
        "pattern": `(?i)\bgrant\b[\s\S]*\bto\s+share\b`,
        "label": "GRANT ... TO SHARE (expose objects to a data share)",
    },
    # Client-side upload of a local file to a stage.
    {
        "pattern": `(?i)\bput\s+'?file://`,
        "label": "PUT (upload to stage)",
    },
    # Client-side download of stage contents to the local filesystem.
    {
        "pattern": `(?i)\bget\s+@`,
        "label": "GET (download from stage)",
    },
]

# Concatenate every top-level string argument so SQL cannot hide under an
# alternate key. Missing `args` yields "" (fail-safe: nothing to match).
sql_text := concat("\n", [v |
    some _, v in object.get(input.payload, "args", {})
    is_string(v)
])

# Which export constructs the query text triggers.
matched_constructs contains label if {
    is_sql_tool
    some entry in export_constructs
    regex.match(entry.pattern, sql_text)
    label := entry.label
}

# Allow anything that is not a SQL-execution tool.
allow if {
    not is_sql_tool
}

# Allow SQL-execution tools only when no export construct matches.
allow if {
    is_sql_tool
    count(matched_constructs) == 0
}

reasons contains msg if {
    is_sql_tool
    some label in matched_constructs
    msg := sprintf("This Snowflake SQL performs a bulk export or external-sharing operation (%s), which the agent is not permitted to run. Bulk export of warehouse data off Snowflake's perimeter must be run by a human out of band — no IdP group is exempt. Contact your data-platform team if this was a false positive.", [label])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
