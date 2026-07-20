---
name: Default-Deny Unaudited BigQuery Tools
tags:
  - bigquery
  - default-deny-unknown-tools
  - allowlist
  - access-control
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # bigquery / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only allowlisted tool-name suffixes pass
  **Package:** `bigquery.ingress.default_deny_unknown_tools`

  ## What it does

  Maintains a per-tenant allowlist of audited BigQuery tool-name suffixes and
  denies any call whose tool name does not end with an allowlisted entry.
  Everything not explicitly reviewed is blocked before it reaches the BigQuery
  MCP server, and the deny is surfaced as a gateway event — the drift signal
  that flags a new, renamed, or newly enabled upstream tool the moment it first
  appears. A newly-published or renamed tool whose name does not end in an
  allowlisted suffix stops matching the allowlist and **fails closed** rather
  than passing unchecked. The one residual is a new tool whose name *ends in* an
  allowlisted suffix (e.g. a Toolbox `batch_execute_sql` glued onto
  `execute_sql`): because matching is `endswith` with no separator requirement,
  that shape is admitted and would *not* be caught as drift — see Known
  limitations, and use exact full gateway tool names if you need to close it.

  This is the **baseline companion** to the SQL-inspection policies in the
  BigQuery set, not a replacement for them: it decides *which* BigQuery tools
  exist for agents at all, while `guard-warehouse-sql` and `guard-warehouse-export`
  decide *how* the SQL-carrying tools it admits may be used.

  Default-deny matters specifically for BigQuery because the **MCP Toolbox
  prebuilt `bigquery` toolset is self-expanding**: alongside the verified
  read/query tools it also exposes AI-analytics tools — `ask_data_insights`
  (Conversational Analytics, which ships table data to another Google API),
  `forecast`, `analyze_contribution`, and `search_catalog` — that move table
  data to other Google APIs. Those are intentionally **not** on the default
  allowlist, so a tenant must consciously review and add them before an agent
  can reach them.

  A missing, empty, non-string, or non-ASCII tool name matches nothing and is
  denied (fail closed).

  ## Pin the allowlist to YOUR tenant at import time

  The shipped `allowed_tool_suffixes` array is a **starter set** built from the
  names verified in the app research: the official Google remote server and the
  MCP Toolbox prebuilt `bigquery` toolset (snake_case), plus the two community
  servers (`ergut/mcp-bigquery-server`, `LucasHild/mcp-server-bigquery`). It is
  not, and cannot be, the list of tools *your* deployment has reviewed — in
  particular it deliberately excludes the Toolbox AI-analytics tools.

  Because the DTwo gateway prepends the configured server name to each tool, the
  exact string the gateway sends is deployment-specific. **Verify the precise
  suffixes with the dump-input debug technique before pinning** — do not guess.
  Add only what you have reviewed; every unlisted tool is denied until you do,
  and the allowlist must be **re-pinned whenever the upstream server adds tools**.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    a warehouse full of regulated data (PII, financial, and in healthcare orgs
    PHI) is reachable only through the tool names that were explicitly reviewed
    and enumerated, not the whole surface an OAuth grant / IAM role exposes.
  - **SOC 2 CC6.6** — supports boundary protection against external threats: an
    upstream-added, renamed, or self-expanding tool (including the Toolbox
    AI-analytics tools that move data to other Google APIs) does not become
    reachable through the gateway boundary without an explicit allowlist change.
  - **SOC 2 CC6.8** — supports prevention of unauthorized software on the agent
    channel: any tool the tenant has not audited — including a self-expanding
    toolset's additions — is unauthorized-by-default on the MCP path (partial —
    covers the MCP path only).
  - **SOC 2 CC7.2 / CC7.3** — deny decisions from this policy surface tool drift
    (new/renamed upstream tools, newly enabled AI-analytics surfaces) as
    observable gateway events that feed anomaly monitoring and event evaluation
    (partial — the alerting/monitoring itself is a platform property, not this
    policy).
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default state of any new data-bearing BigQuery tool is
    "inaccessible until audited," and access requires a deliberate allowlist
    change.
  - **HIPAA §164.308(a)(4) / §164.312(a)(1)** — supports information access
    management and access control on the MCP path: a warehouse that in healthcare
    orgs holds PHI is reachable only through the explicitly audited tool names on
    the allowlist, not the whole surface an OAuth grant / IAM role exposes, so an
    unreviewed or self-expanding tool cannot access PHI-bearing datasets by
    default (partial — covers the MCP path only, and gates the tool surface, not
    per-dataset entitlement; pair with `fence-sensitive-datasets`).
  - **PCI DSS 7.2.1 / 7.2.6** — supports the least-privilege access model and the
    restriction of programmatic query access to stored cardholder data: only
    audited tool names can reach a warehouse that may hold CHD, and any
    unaudited, renamed, or self-expanding tool is denied by default until it is
    reviewed and added.

  ## Tool name matching

  BigQuery MCP tool names are **unprefixed by the vendor** (verified in the app
  research): both official servers use bare snake_case (`execute_sql`,
  `list_dataset_ids`) with no vendor prefix, and the community servers use bare
  snake_case / kebab-case. Behind the DTwo gateway each appears as
  `<configured-server-name>-<tool-name>`, and that prefix is not standardized
  across deployments.

  To cover the gateway prefix with a single allowlist entry, the policy matches
  case-insensitively on `lower(input.resource.name)` with **`endswith`** against
  each audited name:

  - `execute_sql` (bare) — matches,
  - `bigquery-mcp-execute_sql` (gateway-prefixed) — ends with `execute_sql`,
    matches,
  - `execute_sql_readonly` — a **separate** entry, because `execute_sql_readonly`
    does **not** end with `execute_sql`; both official names must be listed.

  Before matching, the **raw** (pre-lowercase) name must consist only of the
  ASCII set real tool names and gateway prefixes use — `[A-Za-z0-9._-]`. This is
  checked before `lower()` runs, which closes a Unicode case-folding evasion:
  `lower()` folds a handful of non-ASCII code points onto ASCII letters (e.g.
  the Kelvin sign `U+212A` → `k`), so an allowlisted suffix could otherwise be
  spoofed with a folded homoglyph. A name containing any character outside that
  ASCII set — including whitespace padding or a spliced newline — is denied.

  ## Allowlisted tools

  The starter allowlist covers the **verified** names:

  - **Official Google remote server + MCP Toolbox prebuilt toolset** (snake_case):
    `execute_sql`, `execute_sql_readonly`, `list_dataset_ids`, `list_table_ids`,
    `get_dataset_info`, `get_table_info`.
  - **`ergut/mcp-bigquery-server`** (community, single tool): `query`.
  - **`LucasHild/mcp-server-bigquery`** (community, kebab-case): `execute-query`,
    `list-tables`, `describe-table`.

  Everything else is deliberately **excluded** and must be audited before it is
  added, including the **MCP Toolbox self-expanding AI-analytics tools** —
  `ask_data_insights`, `forecast`, `analyze_contribution`, `search_catalog` —
  which move table data to other Google APIs and are the reason default-deny is
  the right posture for this toolset.

  ## Argument shape

  This policy inspects only the tool **name** (`input.resource.name`); it reads
  no arguments, so it is insensitive to argument-shape differences between the
  official, Toolbox, and community servers. A missing `resource` or
  `resource.name` resolves to `""` via `object.get` and matches nothing (deny).
  A **non-string** name (null, number, object, array — a malformed or hostile
  request) is coerced to `""` rather than passed to `lower()`; without that guard
  `lower()` would raise a built-in type error that leaves `allow` and `reason`
  undefined — a deny with no surfaced reason. With the guard it is a clean,
  reasoned deny.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "args": { "sql": "SELECT id FROM ds.orders LIMIT 10" }
      }
    }
  }
  ```

  `allow = true`, no reason. (The SQL text itself is governed by the companion
  `guard-warehouse-sql` policy.)

  ### Denied — self-expanding AI-analytics tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-ask_data_insights", "type": "tool" },
      "payload": {
        "name": "bigquery-mcp-ask_data_insights",
        "args": { "table": "ds.customers", "question": "top spenders?" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This BigQuery tool is not on the audited BigQuery allowlist (...)"`.
  (`ask_data_insights` does not end with any allowlisted suffix, so the
  Conversational-Analytics data-movement tool stays denied until reviewed.)

  ## Composition

  This policy is the outer gate — it decides *which* BigQuery tools exist for
  agents. Pair it with policies that constrain *how* the allowlisted tools are
  used:

  - [`guard-warehouse-sql`](../guard-warehouse-sql/policy.md) — blocks
    DML/DDL/destructive statements in the `sql` argument of the allowlisted
    write-capable SQL tools.
  - [`guard-warehouse-export`](../guard-warehouse-export/policy.md) — blocks
    `EXPORT DATA` / `EXTERNAL_QUERY` exfiltration constructs inside SQL.
  - [`fence-sensitive-datasets`](../fence-sensitive-datasets/policy.md) — fences
    regulated datasets referenced by `sql` and by the metadata tools this gate
    admits.
  - [`redact-pii-egress`](../redact-pii-egress/policy.md) — egress backstop that
    masks PII/PAN in query results, since a permitted `SELECT *` can still return
    regulated data in bulk.

  ## Known limitations

  - **The starter allowlist is not your tool list.** Pinning it to the suffixes
    your tenant has actually reviewed is a required deployment step, not a
    tuning step, and it must be **re-pinned whenever the upstream server adds
    tools** — the MCP Toolbox toolset in particular self-expands. If you swap in
    or add a community server, every tool it adds is denied until you introspect
    and add it.
  - **`endswith` matching trusts the suffix, not a separator.** To absorb any
    gateway server-name prefix with one entry, matching does not require a
    separator before the suffix — this relies on the documented BigQuery tool
    names being **unprefixed by the vendor** (verified in the app research), so
    the only prefix on the wire is the gateway's `<server-name>-`. As a result a
    tool literally named `<anything>execute_sql` (any prefix glued directly onto
    an allowlisted suffix) would also match, and the short community suffix
    `query` is the loosest — it matches any name ending in `query`, so an
    unaudited or foreign tool such as `run_arbitrary_query` (for example a
    different server's tool on a shared pipeline) is admitted rather than flagged
    as drift (note too that the common server-name stem `bigquery` itself ends in
    `query`). No tool in the
    current BigQuery inventory collides this way — notably the excluded
    AI-analytics tools `ask_data_insights`, `forecast`, `analyze_contribution`,
    and `search_catalog` do **not** end with any allowlisted suffix and are
    denied — but if your deployment needs stricter matching, replace the suffix
    entries with the exact full gateway tool names.
  - **Attach to the BigQuery server's pipeline.** Because the gate denies every
    name that does not end in an allowlisted BigQuery suffix, attaching it to a
    shared multi-server pipeline would deny tools on other servers too. Attach it
    to the BigQuery server's pipeline (where denying everything unaudited is the
    intent), or add those other servers' audited suffixes to the allowlist.
  - **ASCII-only tool names.** Matching requires the raw name to be
    `[A-Za-z0-9._-]`. This is deliberate (it blocks Unicode case-fold and
    homoglyph spoofing, whitespace smuggling, and spliced newlines), but a
    deployment whose configured MCP server name contains other characters
    (spaces, `@`, `/`, non-ASCII) would see even its legitimate tools denied;
    rename the server to an ASCII slug, or relax the character class, if so.
  - **Name-based trust only.** The policy audits tool *names*, not behavior. A
    tool that keeps an allowlisted name but changes behavior upstream bypasses
    the intent while matching the letter. Re-audit when upstream servers change.
  - **Exact upstream suffixes unverified for your gateway.** The official,
    Toolbox, and community names are verified from their docs, but the string
    your gateway actually sends depends on the configured server name. Confirm
    with dump-input before pinning.
  - **No identity-based exemptions.** All callers face the same allowlist. If you
    need a platform-admin break-glass group that can call unaudited tools, add a
    separate `allow if` branch gated on `input.subject.claims` groups. (Group
    names would be placeholders — replace them with your IdP's group name at
    import time.)

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - bigquery
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package bigquery.ingress.default_deny_unknown_tools

# Deny-by-default: a tool call is allowed only if its name ends with an audited
# allowlist suffix below. A missing, empty, non-string, or non-ASCII tool name
# matches nothing and is therefore denied (fail closed).
default allow := false

# Audited BigQuery tool-name suffixes — STARTER SET. Pin to the suffixes YOUR
# tenant has actually reviewed at import time (see the policy description), and
# RE-PIN whenever the upstream server adds tools. Matched with endswith so one
# entry also absorbs any gateway server-name prefix
# (bigquery-mcp-execute_sql -> ends with execute_sql). This works because
# BigQuery MCP tool names are UNPREFIXED by the vendor (verified in the app
# research) — the only prefix on the wire is the gateway's <server-name>-.
#
# Verified names (do NOT shorten into overlapping stems — keep each specific
# enough to preserve drift detection; execute_sql and execute_sql_readonly are
# separate because neither is a suffix of the other):
#   - Official Google remote server + MCP Toolbox prebuilt toolset (snake_case):
#       execute_sql, execute_sql_readonly, list_dataset_ids, list_table_ids,
#       get_dataset_info, get_table_info
#   - ergut/mcp-bigquery-server (community, single tool): query
#   - LucasHild/mcp-server-bigquery (community, kebab-case):
#       execute-query, list-tables, describe-table
#
# Deliberately EXCLUDED — default-deny by design, audit before adding any. The
# MCP Toolbox prebuilt toolset self-expands with AI-analytics tools that move
# table data to OTHER Google APIs; a tenant must consciously review/add them:
#       ask_data_insights (Conversational Analytics API — ships table data out),
#       forecast, analyze_contribution, search_catalog
allowed_tool_suffixes := [
	# --- Official Google remote server + MCP Toolbox prebuilt toolset ---
	"execute_sql",
	"execute_sql_readonly",
	"list_dataset_ids",
	"list_table_ids",
	"get_dataset_info",
	"get_table_info",
	# --- ergut/mcp-bigquery-server (community) ---
	"query",
	# --- LucasHild/mcp-server-bigquery (community) ---
	"execute-query",
	"list-tables",
	"describe-table",
]

# Raw tool name straight from the request. Missing resource/name resolves to ""
# via object.get and matches nothing (fail closed).
raw_tool_name := object.get(object.get(input, "resource", {}), "name", "")

# Tool name, lowercased. A non-string name (null, number, object, array — a
# malformed or hostile request) is coerced to "" instead of being handed to
# lower(), which would raise a built-in type error and leave allow/reason
# undefined. Coercing keeps the decision a clean, reasoned deny (fail closed).
tool_name := lower(raw_tool_name) if is_string(raw_tool_name)

tool_name := "" if not is_string(raw_tool_name)

# Character-class guard on the RAW (pre-lowercase) name. Real BigQuery tool names
# (snake_case and kebab-case) and gateway <server-name>- prefixes use only ASCII
# letters, digits, underscore, dot, and hyphen. Checking the raw name BEFORE
# lower() closes a Unicode case-folding evasion: lower() folds some non-ASCII
# code points onto ASCII letters (e.g. the Kelvin sign U+212A -> "k"), so an
# allowlisted suffix could be spoofed with a folded homoglyph and slip past the
# default-deny gate despite being a visibly different, un-audited name. The regex
# is NOT multiline in OPA/Go, so whitespace padding or a spliced newline breaks
# the whole-string match. Guarded by is_string so a non-string name still yields
# a clean, reasoned deny.
raw_name_is_plain_ascii if {
	is_string(raw_tool_name)
	regex.match(`^[A-Za-z0-9._-]+$`, raw_tool_name)
}

# Allow only when the name ends with an audited suffix. endswith (no separator
# requirement) is intentional: it matches the bare vendor name (execute_sql) and
# any gateway server-name prefix (bigquery-mcp-execute_sql) with a single
# allowlist entry. See Known limitations for the residual this trades for.
allow if {
	raw_name_is_plain_ascii
	some suffix in allowed_tool_suffixes
	endswith(tool_name, suffix)
}

reason := "This BigQuery tool is not on the audited BigQuery allowlist, so the gateway denies it by default and surfaces the call as tool drift. The allowlist pins the verified official Google / MCP Toolbox tools (execute_sql, execute_sql_readonly, list_dataset_ids, list_table_ids, get_dataset_info, get_table_info) and the community server tools (query, execute-query, list-tables, describe-table); a newly added, renamed, or self-expanding upstream tool — including the MCP Toolbox AI-analytics tools (ask_data_insights, forecast, analyze_contribution, search_catalog) that move table data to other Google APIs — is not on it and must fail closed until it is reviewed. If this tool is legitimate, contact your gateway admin to introspect it live and add its verified name to the per-tenant allowlist in this policy after review." if not allow
```
