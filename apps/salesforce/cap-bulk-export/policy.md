---
name: Salesforce Cap Bulk Data Export
tags:
  - salesforce
  - cap-bulk-export
  - data-minimization
  - dlp
  - ingress
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # salesforce / cap-bulk-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `salesforce.ingress.cap_bulk_export`

  ## What it does

  Caps how many records a single agent call can pull out of Salesforce, so an
  agent (or a prompt injection steering one) can't bulk-export the CRM. It reads
  the SOQL/SOSL text itself — one generic query tool fronts every object, so the
  policy is **argument-shaped, not tool-shaped**.

  Two surfaces are governed, and everyone is treated the same (no IdP groups needed):

  - **SOQL query tools** (`soqlQuery`, `soql_query`, `executeQuery`,
    `querySobjects`, `run_soql_query`, `salesforce_query_records` —
    suffix-matched case-insensitively). Every query, on any object, must end
    with a `LIMIT` of **200 or fewer** rows. The one exception is a bare
    `SELECT COUNT() FROM …`, which returns a single number rather than records.
  - **Org-wide SOSL search tools** (`find`, `executeSearch`, `searchSobjects`,
    `run_sosl_search`, `salesforce_search_all` — suffix-matched). SOSL searches
    every field across every object, so it is the broadest read surface. Every
    search must end with an overall `LIMIT` of **50 or fewer** results.

  The caps are sized for how reps actually use an assistant: call prep and
  account research return a handful of records, pipeline reviews a few dozen to
  a couple hundred. Anything bigger is a bulk export and belongs in Salesforce
  reports or Data Loader, not an agent's context window.

  **Fail closed:** a matched tool called with no query/search text is denied —
  an unverifiable scope is treated as unbounded. All other Salesforce tools and
  all non-Salesforce tools pass through unchanged.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information by capping how many PII records a single agent call can pull.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary standard:
    an agent is bounded to ≤200 rows per query and ≤50 results per org-wide
    search, including on Contact/Lead/Account (which carry PHI in health-cloud orgs).
  - **PCI DSS 3.4.2** — prevents bulk copy/relocation of card-adjacent data
    through the agent channel by capping per-call record volume, so a single
    agent call cannot pull an unbounded set off the platform.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent read path by
    bounding bulk personal-data reads.
  - **CCPA 11 CCR §7002** — supports proportionality: the volume an agent can
    extract per call is constrained relative to purpose.

  ## Why ingress

  A read's scope is fully determined by the request (the SOQL/SOSL string), so
  the cheapest and safest place to enforce a volume cap is before the call
  reaches Salesforce — an over-broad read never executes. Egress redaction
  ([`redact-pii`](../redact-pii/policy.md)) still masks the fields that a
  *permitted* read returns; the two compose (see Composition).

  ## Tool name matching

  Matches case-insensitively on the **suffix** of `input.resource.name`. The
  gateway prefixes tool names with the configured MCP server name (e.g.
  `salesforce-soqlquery`), and that prefix is not standardized — suffix matching
  keeps the policy portable across the hosted and community dialects.

  - **SOQL suffixes:** `soqlquery` (hosted `sobject-all`, GA), `soql_query`
    (beta-era hosted), `executequery` (`sobject-mutations`), `querysobjects`
    (`sobject-deletes`), `run_soql_query` (smn2gnt), `salesforce_query_records`
    (tsmztech).
  - **SOSL suffixes:** `find` (hosted `sobject-all`), `executesearch`
    (`sobject-mutations`), `searchsobjects` (`sobject-deletes`),
    `run_sosl_search` (smn2gnt), `salesforce_search_all` (tsmztech).

  ## Argument shape

  - **SOQL:** query text is the first non-empty string among `args.q` (hosted
    `sobject-all` `soqlQuery`, verified), `args.query`, and `args.soql`.
  - **SOSL:** search text is the first non-empty string among `args.q` (hosted
    `sobject-all` `find`, verified), `args.search`, and `args.sosl`.

  ## LIMIT parsing

  Both caps are read with a regex anchored to the **end** of the text:

  - **SOQL** — `LIMIT n`, optionally followed by `OFFSET n` and a
    `FOR UPDATE|VIEW|REFERENCE` clause. A `LIMIT` inside a child subquery
    (`(SELECT … FROM Contacts LIMIT 5000)`) or a `WHERE` string literal
    (`WHERE LastName = 'LIMIT 5'`) is not at the end, so it can't fake a bound.
  - **SOSL** — the overall `LIMIT n`, optionally followed by
    `UPDATE TRACKING|VIEWSTAT`. Per-object limits inside `RETURNING`
    (`Contact(Name LIMIT 10)`) sit inside parentheses and do **not** count — the
    overall `LIMIT` is the one cap that covers every object in the result, so it
    is always required.

  ## Examples

  ### Allowed — bounded contact lookup

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soqlquery", "type": "tool" },
      "payload": { "args": { "q": "SELECT Id, Name, Email FROM Contact WHERE AccountId = '001Ak00000Ab1CdIAJ' LIMIT 50" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — unbounded PII read

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soqlquery", "type": "tool" },
      "payload": { "args": { "q": "SELECT Id, Email, Phone FROM Lead" } }
    }
  }
  ```

  `allow = false`, reason asks for a trailing `LIMIT 200` (or lower). A `WHERE`
  filter alone does **not** unblock the call — only a trailing `LIMIT` bounds
  row volume. The same applies to every object (`Opportunity`, `Case`, custom
  objects): object pinning is [`query-allowlist`](../query-allowlist/policy.md)'s
  job, row volume is this policy's.

  ### Allowed — bounded search

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-find", "type": "tool" },
      "payload": { "args": { "q": "FIND {Acme*} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Name) LIMIT 50" } }
    }
  }
  ```

  `allow = true`, no reason. The same search without `LIMIT`, or with
  `LIMIT 200`, is denied with a reason asking for `LIMIT 50` or lower.

  ## Composition

  Single-purpose: this policy only bounds read *volume*. It is designed to sit
  alongside:

  - [`salesforce/query-allowlist`](../query-allowlist/policy.md) — pins the SOQL
    `FROM` object to an approved set but does **not** cap result volume; this
    policy adds the row cap.
  - [`salesforce/redact-pii`](../redact-pii/policy.md) — egress masking of the
    contact fields a permitted read returns.
  - `salesforce/read-only` / `salesforce/read-only-except-call-notes` /
    `salesforce/role-gate-writes` — orthogonal write governance.

  ## Known limitations

  - **Per call, not per session.** An agent can page with `OFFSET` (SOQL allows
    up to 2,000) or run many narrow searches. The caps make bulk pulls slow and
    noisy rather than impossible; for a hard ceiling, add a per-session record
    counter on egress.
  - **Regex, not a SOQL/SOSL parser.** Only the outer `LIMIT` at the end of the
    text counts. Child subqueries are not capped separately — a parent row can
    carry its own child records — so keep subquery `LIMIT`s small or use
    `query-allowlist` to pin objects.
  - **Aggregates need a LIMIT.** Only a bare `SELECT COUNT() FROM …` is exempt.
    `GROUP BY` aggregates are treated like any other query and need a trailing
    `LIMIT`; add one (e.g. `LIMIT 200`) and the call goes through.
  - **`find` is a generic suffix.** The hosted SOSL tool is literally `find`, so
    the suffix match can also catch a `find`-suffixed tool on an unrelated MCP
    server on the same gateway. The failure mode is over-blocking (that call also
    needs a trailing `LIMIT`), never under-blocking.
  - **Escape hatches bypass this entirely.** `apex_execute`, `tooling_execute`,
    `restful`, and `salesforce_execute_anonymous` can read records without a
    matched SOQL/SOSL call; govern them with an escape-hatch deny.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
  - gtm-stack-salesforce
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package salesforce.ingress.cap_bulk_export

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Maximum rows any SOQL query may return per call.
max_query_rows := 200

# Maximum records an org-wide SOSL search may return per call.
max_search_rows := 50

# SOQL query tools, matched by suffix (the gateway prefixes tool names with the
# configured MCP server name, which is not standardized).
soql_suffixes := [
    "soqlquery",                # hosted sobject-all (GA name)
    "soql_query",               # hosted beta-era name
    "executequery",             # hosted sobject-mutations
    "querysobjects",            # hosted sobject-deletes
    "run_soql_query",           # community smn2gnt
    "salesforce_query_records", # community tsmztech
]

# Org-wide SOSL search tools — search every field across every object.
sosl_suffixes := [
    "find",                  # hosted sobject-all
    "executesearch",         # hosted sobject-mutations
    "searchsobjects",        # hosted sobject-deletes
    "run_sosl_search",       # community smn2gnt
    "salesforce_search_all", # community tsmztech
]

# Argument keys that carry the query / search text, in priority order. The
# hosted GA servers use `q`; community servers use `query` / `search`.
soql_text_keys := ["q", "query", "soql"]

sosl_text_keys := ["q", "search", "sosl"]

# Case-insensitive tool name; missing fields resolve to "" (never matches).
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Tool arguments; {} when payload/args are absent so lookups fail closed.
args := object.get(object.get(input, "payload", {}), "args", {})

is_soql_tool if {
    some suffix in soql_suffixes
    endswith(tool_name, suffix)
}

is_sosl_tool if {
    some suffix in sosl_suffixes
    endswith(tool_name, suffix)
}

# First non-empty string argument among `keys`, trimmed; "" when none.
first_text(keys) := t if {
    texts := [trim_space(v) |
        some k in keys
        v := object.get(args, k, "")
        is_string(v)
        trim_space(v) != ""
    ]
    count(texts) > 0
    t := texts[0]
} else := ""

# --- SOQL ---

soql_query_text := first_text(soql_text_keys)

# A bare `SELECT COUNT() FROM ...` returns a single number, not records, so it
# needs no row cap.
is_count_only if {
    regex.match(`(?i)^select\s+count\(\s*\)\s+from\b`, soql_query_text)
}

# Outer row cap: LIMIT anchored to the end of the query (optionally followed by
# OFFSET and a FOR UPDATE|VIEW|REFERENCE clause). Anchoring to the end means a
# LIMIT inside a subquery, or inside a WHERE string literal, is not mistaken for
# the outer cap.
soql_limit := n if {
    m := regex.find_all_string_submatch_n(`(?i)\blimit\s+(\d+)(?:\s+offset\s+\d+)?(?:\s+for\s+(?:update|view|reference))?\s*$`, soql_query_text, 1)
    count(m) == 1
    n := to_number(m[0][1])
}

soql_limit_ok if {
    soql_limit <= max_query_rows
}

# --- SOSL ---

sosl_search_text := first_text(sosl_text_keys)

# Overall result cap: LIMIT anchored to the end of the search (optionally
# followed by UPDATE TRACKING|VIEWSTAT). A per-object LIMIT inside a RETURNING
# clause sits inside parentheses, so it is not mistaken for the overall cap.
sosl_limit := n if {
    m := regex.find_all_string_submatch_n(`(?i)\blimit\s+(\d+)(?:\s+update\s+(?:tracking|viewstat))?\s*$`, sosl_search_text, 1)
    count(m) == 1
    n := to_number(m[0][1])
}

sosl_limit_ok if {
    sosl_limit <= max_search_rows
}

# --- Allow rules ---

# Pass through anything that isn't a governed SOQL or SOSL tool.
allow if {
    not is_soql_tool
    not is_sosl_tool
}

# A bare COUNT() query returns one number — allowed without a LIMIT.
allow if {
    is_soql_tool
    is_count_only
}

# Any other SOQL query is allowed only with a trailing LIMIT of at most
# max_query_rows.
allow if {
    is_soql_tool
    soql_query_text != ""
    soql_limit_ok
}

# SOSL is allowed only with a trailing LIMIT of at most max_search_rows.
allow if {
    is_sosl_tool
    sosl_search_text != ""
    sosl_limit_ok
}

# --- Deny reasons ---

reasons contains "This Salesforce query tool was called without query text, so its scope cannot be verified and it is blocked. Provide the SOQL you want to run." if {
    is_soql_tool
    soql_query_text == ""
}

reasons contains "Salesforce queries (SOQL) must end with a 'LIMIT' clause of 200 rows or fewer. Add 'LIMIT 200' (or lower) to the end of your query, and page or narrow the query if you need more." if {
    is_soql_tool
    soql_query_text != ""
    not is_count_only
    not soql_limit_ok
}

reasons contains "Salesforce searches (SOSL) must end with a 'LIMIT' clause of 50 results or fewer. Add 'LIMIT 50' (or lower) to the end of your search, and narrow the search term if what you need isn't in the first 50." if {
    is_sosl_tool
    sosl_search_text != ""
    not sosl_limit_ok
}

reasons contains "This Salesforce search tool was called without search text, so it is blocked. Provide the SOSL search you want to run." if {
    is_sosl_tool
    sosl_search_text == ""
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
