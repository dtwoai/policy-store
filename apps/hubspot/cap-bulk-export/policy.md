---
name: HubSpot Cap Bulk Export
tags:
  - hubspot
  - cap-bulk-export
  - pii
  - data-minimisation
  - ingress
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # hubspot / cap-bulk-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `hubspot.ingress.cap_bulk_export`

  ## What it does

  Caps how many records a single agent call can pull out of HubSpot, so an agent
  (or a prompt injection steering one) can't bulk-export the CRM. Instead of
  blocking an over-broad read, it **rewrites the request** down to the cap and
  lets it run, so reads keep working — just in bounded pages.

  | Read | Cap per call |
  |---|---|
  | Free-text search (`search_crm_objects` etc. with a `query` term) | **50** |
  | Filtered search / list (no `query` term) | **200** |
  | Batch read by ID (`get_crm_objects`, `hubspot-batch-read-objects`) | **200** IDs |
  | SQL over CRM data (`query_crm_data`) | **200** rows |

  - **Search / list** — a missing `limit`, a `limit` above the cap, a
    non-positive `limit`, or a non-numeric `limit` is rewritten to the cap. The
    remote server otherwise defaults to 100 and allows up to 200 per page; a
    free-text `query` matches broadly across name/email/phone/company fields, so
    it gets the tighter 50.
  - **Batch read** — an `ids` / `objectIds` / `inputs` array longer than 200 is
    truncated to its first 200 entries. (The remote server already caps
    `get_crm_objects` at 100 IDs; the clamp matters on the local beta.)
  - **SQL** — a query with no trailing `LIMIT` gets `LIMIT 200` appended on its
    own line; a trailing `LIMIT` above 200 is lowered to 200 (any `OFFSET` is
    kept). A query that already asks for 200 or fewer is untouched.

  The caps match [`salesforce/cap-bulk-export`](../../salesforce/cap-bulk-export/policy.md)
  (200 per query, 50 per search) and are sized for how reps actually use an
  assistant: call prep and account research return a handful of records,
  pipeline reviews a few dozen to a couple hundred.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information by bounding how much CRM data any single agent call can move
    out of HubSpot.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard: agents retrieve pages sized to the task, not the maximum the API
    permits.
  - **PCI DSS 7.2.6** — supports restricting programmatic/agent access to
    repositories of stored cardholder data: bounding the record count a single
    query can retrieve keeps an over-broad agent read from mass-extracting
    card-adjacent CRM data.
  - **GDPR Art. 5(1)(c)** — data minimisation on the agent channel: the query is
    minimised *before* it reaches HubSpot.
  - **CCPA 11 CCR §7002** — supports proportionality: collection and use of
    personal information stays proportionate to the disclosed purpose rather
    than defaulting to bulk retrieval.

  ## Why ingress

  The over-broad request itself is the problem: once HubSpot has returned the
  records, an egress policy can only mask fields — the volume has already been
  fetched. Rewriting the request at ingress enforces minimisation before the
  query executes, which is the only place the record *count* can be controlled.

  ## Tool name matching

  The tool name is lowercased and `-` is normalised to `_`, then matched by
  suffix. That covers the remote server's two spellings — kebab-case on the
  gateway (`hubspot-search-crm-objects`) and snake_case in HubSpot's docs
  (`search_crm_objects`) — and any server-name prefix the gateway adds.

  - **Search / list:** `search_crm_objects` (remote), `hubspot-search-objects`,
    `hubspot-list-objects` (local beta), `crm_list_objects`,
    `crm_search_objects`, `crm_search_contacts`, `crm_search_companies` (shinzo).
  - **Batch read:** `get_crm_objects` (remote), `hubspot-batch-read-objects`
    (local beta).
  - **SQL:** `query_crm_data` (remote).

  ## Argument shape

  - **Search / list:** page size in `limit`; free-text term in `query`
    (verified on the remote server).
  - **Batch read:** ID array in `objectIds` (remote, verified), `inputs` (local
    beta), or `ids`.
  - **SQL:** statement in `sql` (remote, verified). HubSpot's SQL dialect
    supports a trailing `LIMIT n [OFFSET n]`.

  ## Examples

  ### Free-text search clamped to 50

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-search-crm-objects", "type": "tool" },
      "payload": { "args": { "objectType": "CONTACT", "query": "acme", "limit": 200 } }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload.limit = 50`.

  ### Filtered list with no limit set to 200

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-search-crm-objects", "type": "tool" },
      "payload": { "args": { "objectType": "DEAL", "filterGroups": [ { "filters": [ { "propertyName": "dealstage", "operator": "EQ", "value": "qualifiedtobuy" } ] } ] } }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload.limit = 200`.

  ### SQL gets a LIMIT

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-query-crm-data", "type": "tool" },
      "payload": { "args": { "sql": "SELECT firstname, email FROM CONTACT WHERE lifecyclestage = 'lead'" } }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload.sql` ends with `LIMIT 200`.

  ## Composition

  This policy bounds record *volume*; it does not mask record *content*. Pair it
  with:

  - [`apps/hubspot/redact-pii`](../redact-pii/policy.md) — egress masking of
    contact identifiers in whatever records are returned.
  - [`apps/hubspot/read-only`](../read-only/policy.md) or
    [`apps/hubspot/read-only-except-call-notes`](../read-only-except-call-notes/policy.md)
    — write governance.

  ## Known limitations

  - **Per call, not per session.** An agent that walks the paging cursor (or
    `OFFSET` in SQL) can still enumerate the full dataset — it just takes more
    calls. Use gateway audit logs to spot high-frequency paging, or add a
    per-session record counter on egress.
  - **SQL is matched by regex, not parsed.** Only a `LIMIT` at the very end of
    the statement counts. Aggregate queries (`COUNT`, `GROUP BY`) also get
    `LIMIT 200` appended, which caps the number of result rows, not the records
    counted — harmless for typical reporting.
  - **shinzo per-engagement read tools are not clamped.** The shinzo server's
    `calls_/emails_/meetings_/notes_/tasks_` `list` / `search` / `batch_read`
    tools have unverified argument shapes and are not covered. Add their
    suffixes once you have confirmed the live shape from `tools/list`.
  - **The baryhuang community server is not covered.** Its bulk reads
    (`hubspot_get_active_contacts`, `hubspot_get_active_companies`,
    `hubspot_search_data`) use a distinct name family.
  - **Other page-size keys are not covered.** `search_owners` (`limit`, max 100)
    and `search_intent_signals` (`pageLength`, max 100) are already bounded below
    200 by HubSpot and are left alone.
  - **No identity-based exemptions.** All callers are clamped equally.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - hubspot
industries: []
bundles:
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
  - gtm-stack-hubspot
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package hubspot.ingress.cap_bulk_export

# Transform-only policy — never denies, only clamps how many records a single
# read can return.
default allow := true

# Maximum records per call for lists, filtered searches, batch reads, and SQL.
max_records := 200

# Maximum records per call for free-text search (a `query` term), which matches
# broadly across fields and is the closest thing to an org-wide search.
max_search_records := 50

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, and the
# remote server's tools surface kebab-case (`hubspot-search-crm-objects`) while
# its own docs use snake_case (`search_crm_objects`). Normalise `-` to `_` and
# match by suffix so both spellings, and any server-name prefix, match.
tool := replace(lower(object.get(object.get(input, "resource", {}), "name", "")), "-", "_")

args := object.get(object.get(input, "payload", {}), "args", {})

# Search/list tools that take a numeric `limit` argument.
limit_tool_suffixes := [
    "search_crm_objects",     # remote server (Claude connector)
    "hubspot_search_objects", # @hubspot/mcp-server local beta
    "hubspot_list_objects",   # local beta
    "crm_list_objects",       # shinzo
    "crm_search_objects",     # shinzo
    "crm_search_contacts",    # shinzo
    "crm_search_companies",   # shinzo
]

is_limit_tool if {
    some suffix in limit_tool_suffixes
    endswith(tool, suffix)
}

# ID-list batch reads.
is_batch_tool if endswith(tool, "get_crm_objects")

is_batch_tool if endswith(tool, "hubspot_batch_read_objects")

# SQL reads over CRM data (remote server).
is_sql_tool if endswith(tool, "query_crm_data")

# --- Search / list: clamp `limit` -----------------------------------------------

# A free-text `query` term makes it a search; filters alone make it a list.
is_text_search if {
    q := object.get(args, "query", "")
    is_string(q)
    trim_space(q) != ""
}

limit_cap := max_search_records if is_text_search

limit_cap := max_records if not is_text_search

limit_value := object.get(args, "limit", null)

# Missing: the remote server otherwise defaults to 100 per page.
needs_limit_clamp if limit_value == null

needs_limit_clamp if {
    is_number(limit_value)
    limit_value > limit_cap
}

# 0 or negative: some servers treat a non-positive limit as "unbounded".
needs_limit_clamp if {
    is_number(limit_value)
    limit_value < 1
}

# Present but not a number: replace rather than let the server default win.
needs_limit_clamp if {
    limit_value != null
    not is_number(limit_value)
}

# --- Batch reads: truncate ID arrays ------------------------------------------

batch_array_keys := ["ids", "objectIds", "inputs"]

oversized_batch_keys contains key if {
    some key in batch_array_keys
    value := object.get(args, key, [])
    is_array(value)
    count(value) > max_records
}

truncated_batch_args := {key: truncated |
    some key in oversized_batch_keys
    truncated := array.slice(object.get(args, key, []), 0, max_records)
}

# --- SQL: append or lower the trailing LIMIT -----------------------------------

sql_raw := object.get(args, "sql", "")

# Statement without trailing whitespace or semicolons.
sql_body := trim_right(trim_space(sql_raw), "; \t\r\n") if is_string(sql_raw)

# Trailing `LIMIT n` (optionally followed by `OFFSET n`). Anchored to the end so
# a LIMIT inside a string literal or comment is not mistaken for the cap.
sql_limit_re := `(?i)\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$`

sql_limit := n if {
    m := regex.find_all_string_submatch_n(sql_limit_re, sql_body, 1)
    count(m) == 1
    n := to_number(m[0][1])
}

# No trailing LIMIT: append one on its own line (a newline also ends any
# trailing `--` comment, so the LIMIT is never swallowed by it).
new_sql := concat("\n", [sql_body, sprintf("LIMIT %d", [max_records])]) if {
    sql_body != ""
    not sql_limit
}

# Trailing LIMIT above the cap: lower it, keeping any OFFSET.
new_sql := regex.replace(sql_body, sql_limit_re, sprintf("LIMIT %d${2}", [max_records])) if {
    sql_limit > max_records
}

# --- Transforms ---------------------------------------------------------------
# The three tool families are disjoint, so at most one transform fires.

transform := {"transformed_payload": object.union(args, {"limit": limit_cap})} if {
    input.action == "tool_pre_invoke"
    is_limit_tool
    needs_limit_clamp
}

transform := {"transformed_payload": object.union(args, truncated_batch_args)} if {
    input.action == "tool_pre_invoke"
    is_batch_tool
    count(oversized_batch_keys) > 0
}

transform := {"transformed_payload": object.union(args, {"sql": new_sql})} if {
    input.action == "tool_pre_invoke"
    is_sql_tool
    new_sql
}
```
