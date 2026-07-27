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

  Blocks bulk PII extraction through Salesforce query tools by inspecting the
  free-text query arguments that are the real policy surface for these servers.
  A single generic query tool fronts every object, so this policy is
  **argument-shaped, not tool-shaped** — it reads the SOQL/SOSL string, not just
  the tool name.

  Two surfaces are governed:

  - **SOQL query tools** (`soql_query`, `executeQuery`, `querySobjects`,
    `run_soql_query`, `salesforce_query_records` — suffix-matched
    case-insensitively). The policy applies anchored, case-insensitive regexes to
    the `query` string argument (SOQL is case-insensitive, so the patterns are
    too). When the query reads from the PII-heavy `Contact`, `Lead`, or `Account`
    objects, it must carry a trailing `LIMIT` clause of **1000 or fewer** rows.
    A PII read with no `LIMIT`, or a `LIMIT` above 1000, is denied. Queries
    against other objects pass through — object pinning is
    [`query-allowlist`](../query-allowlist/policy.md)'s job, result volume is
    this policy's.
  - **Org-wide SOSL search tools** (`find`, `executeSearch`, `searchSobjects`,
    `run_sosl_search`, `salesforce_search_all` — suffix-matched). SOSL searches
    every field across every object, so it is a broad exfiltration surface even
    on a read-scoped server. These are denied unless the caller's IdP `groups`
    claim includes the placeholder group `sales` or `support`.

  **Fail closed:** a matched SOQL tool with a missing/empty `query` argument, and
  a matched SOSL tool with a missing/empty `search` argument, are denied — an
  unverifiable scope is treated as unbounded. All other Salesforce tools and all
  non-Salesforce tools pass through unchanged.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information by capping how many PII records a single agent call can pull
    and by gating org-wide search.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary standard:
    an agent querying Contact/Lead/Account (which carry PHI in health-cloud orgs)
    is bounded to ≤1000 rows per call, and cannot fan out an unscoped org-wide
    search without a gated group.
  - **PCI DSS 7.2.6 / 3.4.2** — supports restricting programmatic query access to
    stored account data by role (org-wide SOSL search is gated to the `sales` /
    `support` groups) and prevents bulk copy/relocation of card-adjacent data through
    the agent channel by capping per-call row volume on Contact/Lead/Account reads, so
    a single agent call cannot pull an unbounded PII set off the platform.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent read path by
    bounding bulk personal-data reads.
  - **CCPA 11 CCR §7002** — supports proportionality: the volume an agent can
    extract per call is constrained relative to purpose.
  - **CCPA/CPRA §1798.121** — supports limiting access to sensitive personal
    information by fencing org-wide field search behind `sales`/`support`.

  ## Why ingress

  A query's scope is fully determined by the request (the SOQL/SOSL string plus
  the caller's identity), so the cheapest and safest place to enforce a volume
  cap is before the call reaches Salesforce — an over-broad read never executes.
  Egress redaction ([`redact-pii`](../redact-pii/policy.md)) still masks the
  fields that a *permitted* read returns; the two compose (see Composition).

  ## Tool name matching

  Matches case-insensitively on the **suffix** of `input.resource.name`. The DTwo
  gateway prefixes tool names with the configured MCP server name (e.g.
  `salesforce-soql_query`), and that prefix is not standardized — suffix matching
  keeps the policy portable across the hosted and community dialects.

  - **SOQL suffixes:** `soql_query` (hosted `sobject-all`), `executequery`
    (`sobject-mutations`), `querysobjects` (`sobject-deletes`), `run_soql_query`
    (smn2gnt / beta-era), `salesforce_query_records` (tsmztech).
  - **SOSL suffixes:** `find` (hosted `sobject-all`), `executesearch`
    (`sobject-mutations`), `searchsobjects` (`sobject-deletes`), `run_sosl_search`
    (smn2gnt), `salesforce_search_all` (tsmztech).

  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  - **SOQL:** the query text is read from `input.payload.args.query` (the key the
    hosted `soql_query`, community `run_soql_query`, and `salesforce_query_records`
    tools use). Some community servers expose the string under `q` or `soql`;
    if yours does, add that key to `soql_query_text` in `policy.md`.
  - **SOSL:** the search text is read from `input.payload.args.search`.
  - The `sales`/`support` exemption reads `input.subject.claims.groups` via
    `object.get` chains with an empty-array default, and requires the claim to be an
    **array of strings** (`is_array` + `is_string` guards). A missing subject,
    missing claims, missing `groups` claim, a bare-string `groups`, an **object/map**
    `groups` (even one whose values happen to equal `"sales"`/`"support"`), or an
    array whose gated entry is a non-string all deterministically fail closed (no
    exemption). Without the `is_array` guard a `{"role":"sales"}`-shaped claim would
    have iterated to the value `"sales"` and spoofed the exemption.

  ## LIMIT parsing

  The `LIMIT` value is extracted with a regex anchored to the **end** of the query
  (allowing a trailing `OFFSET n` and a `FOR UPDATE|VIEW|REFERENCE` clause). This
  is deliberate:

  - A `LIMIT` inside a child-relationship subquery (`(SELECT … FROM Contacts LIMIT
    5000)`) sits before the outer `FROM`/`LIMIT`, so it is **not** mistaken for the
    outer row cap — a PII read whose only `LIMIT` is inside a subquery is treated as
    unbounded and denied.
  - A `LIMIT n` embedded in a `WHERE` string literal (`WHERE LastName = 'LIMIT 5'`)
    is not at the end of the query, so it cannot be used to fake a bound.

  ## Examples

  ### Allowed — bounded PII read

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soql_query", "type": "tool" },
      "payload": {
        "name": "salesforce-soql_query",
        "args": { "query": "SELECT Id, Name FROM Contact WHERE Title = 'CFO' LIMIT 100" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — unbounded PII read

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soql_query", "type": "tool" },
      "payload": {
        "name": "salesforce-soql_query",
        "args": { "query": "SELECT Id, Email, Phone FROM Lead" }
      }
    }
  }
  ```

  `allow = false`, reason asks for a trailing `LIMIT 1000` (or lower). Note a
  `WHERE` filter alone does **not** unblock the call — only a trailing `LIMIT`
  bounds row volume, so that is the only remediation the deny reason names.

  ### Denied — org-wide SOSL outside sales/support

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-find", "type": "tool" },
      "subject": { "sub": "auth0|eng@example.com", "claims": { "groups": ["engineering"] } },
      "payload": { "name": "salesforce-find", "args": { "search": "FIND {john} IN ALL FIELDS RETURNING Contact(Id, Email)" } }
    }
  }
  ```

  `allow = false`, reason points to a scoped SOQL query or a member of the gated
  groups.

  ## Composition

  Single-purpose: this policy only bounds read *volume* and org-wide search. It is
  designed to sit alongside:

  - [`salesforce/query-allowlist`](../query-allowlist/policy.md) — pins the SOQL
    `FROM` object to an approved set but does **not** cap result volume; this
    policy adds the row cap. Together they bound *what* and *how much* an injected
    agent can pull per call.
  - [`salesforce/redact-pii`](../redact-pii/policy.md) — egress masking of the
    contact fields a permitted read returns. Ingress volume cap + egress field
    masking is defense in depth.
  - `salesforce/read-only` / `salesforce/role-gate-writes` — orthogonal write
    governance.

  ## Known limitations

  - **Group names are placeholders — replace `sales`/`support` with your IdP's
    group names at import time.** The exemption reads
    `input.subject.claims.groups` (array of strings) and fails closed: no IdP, no
    claim, a bare-string `groups`, or an object/map `groups` means nobody is exempt
    from the SOSL deny (the rule requires `is_array` + `is_string`, so a
    `{"dept":"sales"}`-shaped claim cannot spoof the exemption).
  - **Regex, not a SOQL parser.** Object detection keys on the singular object name
    after `FROM` (`Contact`, `Lead`, `Account`). Child-relationship subqueries use
    the plural relationship name (`FROM Contacts`) and are intentionally **not**
    treated as PII reads — only the outer/primary object is evaluated. A PII object
    reached only through a parent-to-child subquery whose outer object is
    non-PII (e.g. `… FROM Opportunity`) is out of scope for this policy; pair with
    `query-allowlist` for object pinning. Custom objects holding account/contact
    data (`Account_Archive__c`) are not matched by name.
  - **Unparseable object = pass-through here.** A query with no recognizable `FROM`
    object is not caught by this policy (it is not a recognized PII read); rely on
    `query-allowlist`, which denies unparseable/non-allowlisted `FROM` objects, for
    that backstop.
  - **`query`/`search` argument keys assumed.** SOQL reads `args.query`, SOSL reads
    `args.search`. Servers that use `q`/`soql` or a different search key are not
    inspected until you add the key. A matched tool with the expected key *missing*
    fails closed (deny).
  - **`find` is a generic suffix.** The hosted SOSL tool is literally `find`, so the
    suffix match can also catch a `find`-suffixed tool on an unrelated MCP server on
    the same gateway. The failure mode is over-blocking (that search also needs
    `sales`/`support`), never under-blocking.
  - **Escape hatches bypass this entirely.** `apex_execute`, `tooling_execute`,
    `restful`, and `salesforce_execute_anonymous` can read records without issuing a
    matched SOQL/SOSL call; govern them with an escape-hatch deny.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - crm
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package salesforce.ingress.cap_bulk_export

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Maximum rows a PII read may return per call.
max_pii_rows := 1000

# SOQL query tools, matched by suffix (the gateway prefixes tool names with the
# configured MCP server name, which is not standardized). Verified against the
# Salesforce Hosted MCP GA references and the two community servers.
soql_suffixes := [
    "soql_query",               # hosted sobject-all
    "executequery",             # hosted sobject-mutations
    "querysobjects",            # hosted sobject-deletes
    "run_soql_query",           # community smn2gnt / beta-era hosted
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

# Placeholder IdP groups exempt from the org-wide SOSL deny. Replace `sales` /
# `support` with your IdP's group names at import time.
sosl_groups := {"sales", "support"}

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

# --- SOQL ---

# Trimmed query text; "" when missing (fails closed below).
soql_query_text := trim_space(object.get(args, "query", ""))

# The query's primary object is one of the PII-heavy standard objects. Keys on
# the singular object name after FROM (case-insensitive); the plural relationship
# names used by child subqueries (FROM Contacts) do not match.
from_pii if {
    regex.match(`(?i)\bfrom\s+(contact|lead|account)\b`, soql_query_text)
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
    soql_limit <= max_pii_rows
}

# --- SOSL ---

sosl_search_text := trim_space(object.get(args, "search", ""))

caller_in_sosl_group if {
    groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])
    is_array(groups)
    some group in groups
    is_string(group)
    sosl_groups[lower(group)]
}

# --- Allow rules ---

# Pass through anything that isn't a governed SOQL or SOSL tool.
allow if {
    not is_soql_tool
    not is_sosl_tool
}

# SOQL against a non-PII object passes through (volume is governed only for the
# PII-heavy objects; object pinning is query-allowlist's job).
allow if {
    is_soql_tool
    soql_query_text != ""
    not from_pii
}

# SOQL against a PII object is allowed only when it carries a trailing LIMIT of
# at most max_pii_rows.
allow if {
    is_soql_tool
    soql_query_text != ""
    from_pii
    soql_limit_ok
}

# SOSL is allowed only for callers in the sales/support groups, and only when a
# search term is actually present.
allow if {
    is_sosl_tool
    sosl_search_text != ""
    caller_in_sosl_group
}

# --- Deny reasons ---

reasons contains "This Salesforce query tool was called without a 'query' argument, so its scope cannot be verified and it is blocked. Provide the SOQL text you want to run. Contact your InfoSec team if this block is a false positive." if {
    is_soql_tool
    soql_query_text == ""
}

reasons contains "SOQL reads from the Contact, Lead, or Account objects must include a trailing 'LIMIT' clause of 1000 rows or fewer to prevent bulk PII extraction. Add 'LIMIT 1000' (or lower) to the end of your query. Contact your InfoSec team if this block is a false positive." if {
    is_soql_tool
    soql_query_text != ""
    from_pii
    not soql_limit_ok
}

# NOTE: this reason previously suggested "or narrow it with a WHERE filter" as an
# alternative. That was misleading — a WHERE filter without a trailing LIMIT is
# still denied (a filter does not bound row volume), so the remediation now names
# only the actually-unblocking fix: adding a trailing LIMIT.

reasons contains "Org-wide Salesforce search (SOSL) scans every field across every object and is restricted to callers in the 'sales' or 'support' groups. Use a scoped SOQL query against a specific object instead, or ask a member of those groups to run the search. Contact your InfoSec team if this block is a false positive." if {
    is_sosl_tool
    sosl_search_text != ""
    not caller_in_sosl_group
}

reasons contains "This Salesforce search tool was called without a 'search' argument, so it is blocked. Provide the SOSL search term you want to run. Contact your InfoSec team if this block is a false positive." if {
    is_sosl_tool
    sosl_search_text == ""
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
