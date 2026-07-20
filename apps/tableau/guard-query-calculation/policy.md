---
name: Guard Calculation Expressions in Tableau VDS Queries
tags:
  - tableau
  - guard-warehouse-sql
  - ingress
  - calculation
  - vizql
  - soc2
publishedAt: 2026-07-12
description: |
  # tableau / guard-query-calculation

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny when a non-analyst query carries a calculation expression, allow otherwise
  **Package:** `tableau.ingress.guard_query_calculation`

  ## What it does

  Inspects the structured VizQL Data Service (VDS) query carried by Tableau's
  `query-datasource` tool and denies the call for callers **outside the
  `data-analysts` group** whenever any entry in `query.fields[]` or
  `query.filters[]` carries a `calculation`.

  The VDS query is normally highly policable: fields are named by `fieldCaption`,
  which gives column-level matching, and `datasourceLuid` gives a clean scope
  dimension (see the companion `fence-datasource-scope` LUID allowlist). The
  `calculation` field variant is the exception — it accepts an **arbitrary
  Tableau calc expression that can reference any column in the datasource**,
  regardless of which fields the rest of the query names. That defeats
  column-level (`fieldCaption`) allowlisting and any assumption about which
  columns are exposed. It is Tableau's analogue of a raw-SQL / DAX surface, so
  the mere presence of a calculation is treated as **elevated** and confined to
  the `data-analysts` group.

  Two properties matter for correctness:

  - **Fail safe on a missing or empty query.** Both arrays are read through
    `object.get` chains with `{}`/`[]` defaults, so a call with no `query`
    object, an empty `query`, or empty `fields`/`filters` arrays carries no
    calculation, `calc_present` is false, and the call is **allowed**. Absence of
    a calculation never denies.
  - **Calculations hide in nested field slots too.** In the VDS schema a
    `calculation` can appear directly on a `fields[]` entry, under a filter's
    `field` sub-object (`{ "field": { "calculation": … }, "filterType": … }`),
    and under a **TOP-N filter's `fieldToMeasure`** sub-object — `field` and
    `fieldToMeasure` are the *same* FilterField union, so either accepts an
    arbitrary calc. Rather than enumerate positions (which would leave a bypass
    open the moment Tableau adds another nested field slot), the policy `walk`s
    the whole `query` object and flags a `calculation` key at **any depth**, so a
    calc smuggled into a filter, a `fieldToMeasure`, or any future nesting is
    caught.

  Callers whose IdP-issued `groups` claim includes `data-analysts` are exempt and
  may use calculations freely. The exemption is read through an `object.get`
  chain that **fails closed** — a caller with no claims, or no `groups` claim, is
  treated as having no groups and is therefore subject to the deny.

  This runs at ingress, before the query reaches the VDS engine, so an
  arbitrary-expression query from a non-analyst never executes and never returns
  row-level data.

  ## Compliance alignment

  - **SOC 2 CC6.3** — supports role-based, least-privilege access on the agent
    channel: the arbitrary-expression (`calculation`) escape hatch that would let
    any caller read any column of a published datasource is confined to the
    `data-analysts` group, while ordinary callers are held to the declared
    `fieldCaption` columns a companion allowlist can police. **CC6.1** — supports
    logical access security over the datasource read path by keeping the
    raw-expression surface off the default agent path.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent channel:
    a `calculation` can pull or derive any personal-data column irrespective of
    the columns the query otherwise names, so blocking it for non-analysts keeps
    ordinary agent callers to the declared, minimal set of fields.

  ## Tool name matching

  The policy matches the VDS query tool by **suffix** (the gateway prefixes tool
  names with the configured MCP server name, which is not standardized):

  - `*-query-datasource` — the official `tableau/tableau-mcp` VizQL Data Service
    query tool (kebab-case, no vendor prefix). The landscape note flags the
    generic single-word suffixes (`list-users`, `search-content`) as collision
    risks, so this policy anchors on the distinctive `-query-datasource` suffix.

  Every other Tableau tool (`get-datasource-metadata`, `list-datasources`,
  `get-view-data`, the Pulse and admin-insights readers, the mutation tools,
  etc.) does not end with `-query-datasource` and passes through untouched — this
  policy is single-purpose. Verify the exact tool name your gateway sends with
  the dump-input debug technique before relying on this in production.

  ## Argument shape

  The query is read from `input.payload.args.query` (the verified VDS argument
  key for `query-datasource`; `datasourceLuid` and `limit` are siblings this
  policy does not inspect). Within it, `query.fields[]` entries have the shape
  `{fieldCaption, function?, calculation?, sortDirection?, …}` and `query.filters[]`
  entries carry a `field` sub-object (and, for the TOP-N variant, a
  `fieldToMeasure` sub-object) plus filter-variant keys. The policy treats the
  query as elevated when a `calculation` key with a non-null value appears
  **anywhere in the query object at any depth** — a full recursive walk, not a
  fixed set of positions — so it does not matter which field slot the calc rides
  in. A non-object array element (e.g. a bare string in `fields[]`) carries no
  `calculation` key and does not deny.

  ## Examples

  ### Allowed — fieldCaption-only query, non-analyst caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-mcp-query-datasource", "type": "tool" },
      "subject": { "claims": { "groups": ["marketing"] } },
      "payload": {
        "name": "tableau-mcp-query-datasource",
        "args": {
          "datasourceLuid": "abc-123",
          "query": {
            "fields": [{ "fieldCaption": "Region" }, { "fieldCaption": "Sales" }],
            "filters": [{ "field": { "fieldCaption": "Region" }, "filterType": "SET", "values": ["West"] }]
          }
        }
      }
    }
  }
  ```

  `allow = true` — no calculation anywhere in the query.

  ### Allowed — missing query object fails safe

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-mcp-query-datasource", "type": "tool" },
      "subject": { "claims": { "groups": ["marketing"] } },
      "payload": {
        "name": "tableau-mcp-query-datasource",
        "args": { "datasourceLuid": "abc-123" }
      }
    }
  }
  ```

  `allow = true` — no `query` means no calculation to detect.

  ### Denied — calculation in fields[], non-analyst caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-mcp-query-datasource", "type": "tool" },
      "subject": { "claims": { "groups": ["marketing"] } },
      "payload": {
        "name": "tableau-mcp-query-datasource",
        "args": {
          "datasourceLuid": "abc-123",
          "query": {
            "fields": [
              { "fieldCaption": "Region" },
              { "calculation": "SUM([Salary]) / SUM([Headcount])", "fieldAlias": "avg_salary" }
            ]
          }
        }
      }
    }
  }
  ```

  `allow = false` with the calculation reason.

  ### Allowed — same calculation query by a data-analysts caller

  The identical fields-with-calculation call succeeds when
  `input.subject.claims.groups` contains `data-analysts`.

  ## Composition

  This policy blocks the arbitrary-expression surface of VDS queries. Useful
  companions:

  - **PF-23 `fence-datasource-scope`** — deny `query-datasource` unless
    `datasourceLuid` is in the caller group's approved list. This policy and that
    one are complementary: the LUID allowlist controls *which datasource*, this
    controls *whether arbitrary expressions* may run against it.
  - **PF-02 egress PII/PAN redaction** on `query-datasource` /
    `get-view-data` results, since even a permitted `fieldCaption` query can
    return regulated row-level data.
  - **Admin-insights lockdown** and **token-management deny** for the other
    sensitive Tableau surfaces this policy does not touch.

  ## Known limitations

  - **Key match is case-sensitive (and exact).** The VDS API uses the lowercase
    key `calculation`; the policy matches that exact key (JSON keys are
    case-sensitive). A hand-crafted payload using a differently-cased key
    (`Calculation`) or a non-ASCII look-alike/homoglyph key would not be a valid
    VDS query — the server recognizes only the lowercase `calculation` field, so a
    field entry keyed otherwise carries no valid `fieldCaption`/`calculation` and
    the server rejects it before it executes. The guard would not flag such a
    payload (fail-open for the guard, not a data leak of a query the server would
    run) — rely on the server's schema validation as the backstop. See the
    "mis-cased Calculation key" test case, which pins this behavior.
  - **Query must be a JSON object, not a stringified blob.** The policy `walk`s
    `input.payload.args.query` as a structured object. If a client passed the
    query as *stringified* JSON
    (`"query": "{\"fields\":[{\"calculation\": …}]}"`), `walk` sees an opaque
    scalar with no `calculation` key, `calc_present` is false, and the call is
    **allowed** unguarded. The official VDS `query-datasource` schema declares
    `query` as an object (zod `.object`), so the Tableau server rejects a
    string-typed query before it executes — rely on that server-side schema
    validation as the backstop, exactly as with the case-sensitive-key limitation
    above (fail-open for the guard, not a data leak of a payload the server would
    run). See the "allowed — stringified query" test case.
  - **Presence, not semantics.** The policy denies on the *presence* of a
    calculation, not on what the expression does. A trivial constant calculation
    (`"1"`) is denied for non-analysts just like a cross-column one — this is
    intentional fail-safe elevation, since the policy cannot safely parse
    arbitrary Tableau calc syntax. Analysts are the intended escape valve.
  - **Single tool.** Only `-query-datasource` is guarded. `get-view-data` /
    `get-custom-view-data` return a view's underlying data as CSV keyed on an
    opaque `viewId` with no expression surface to inspect at ingress — govern
    those with datasource/view scoping and egress redaction instead. Tableau
    Next's `analyze_data` (a disjoint Salesforce-hosted server) is not covered by
    this policy.
  - **No batch surface.** The official Tableau server exposes no raw-API
    passthrough or batch tool, so there is no composite endpoint that could carry
    a hidden `query-datasource` call past this suffix match.
  - **Suffix match assumes a server prefix.** The guard fires only when the tool
    name *ends with* `-query-datasource` (with the leading hyphen). This relies on
    the gateway exposing the tool as `<server-name>-query-datasource`. If a
    deployment somehow surfaced the bare name `query-datasource` with no prefix,
    the suffix would not match and the query would pass **unguarded** (fail-open
    for the guarded tool, not a data leak of a blocked payload). This is the
    portability trade-off the whole suffix-match family accepts; confirm the exact
    tool name your gateway sends with the dump-input debug technique before
    relying on this policy. See the "allowed — bare tool name" test case, which
    documents this behavior.
  - **Group names are placeholders** — replace `data-analysts` with your IdP's
    group name at import time. The exemption reads `input.subject.claims.groups`;
    on Auth0 tenants without RBAC/permissions configured, no `groups` claim
    reaches the policy and the exemption never fires (fail-closed — every caller
    is barred from calculations until the claim is wired up).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - tableau
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package tableau.ingress.guard_query_calculation

# Deny-by-default: a `query-datasource` call from a non-analyst is permitted only
# when its VDS query carries no calculation expression. Every other tool, and
# every calculation-free query, is allowed.
default allow := false

# --- Guarded tool ------------------------------------------------------------
# Match the VizQL Data Service query tool by its distinctive suffix. The gateway
# prefixes tool names with the configured MCP server name (not standardized), so
# a suffix match keeps the policy portable. The landscape note warns that generic
# single-word suffixes collide across servers, so we anchor on `-query-datasource`.
# resource.name is read through an object.get chain so a missing resource object
# never makes the rule error — it just does not match.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

is_query_tool if {
	endswith(tool_name, "-query-datasource")
}

# --- Calculation detection ---------------------------------------------------
# Read the structured VDS query with fail-safe defaults: a missing
# `payload`/`args`/`query` yields an empty object, so `calc_present` never fires
# and the call is allowed (absence of a calculation never denies). Every hop uses
# object.get so a missing intermediate object cannot make a rule error out.
args := object.get(object.get(input, "payload", {}), "args", {})

query := object.get(args, "query", {})

# A `calculation` is Tableau's arbitrary-expression escape hatch, and the VDS
# schema admits it in several positions: directly on a `fields[]` entry
# (`{calculation: …}`), under a filter's `field` sub-object, and under a TOP-N
# filter's `fieldToMeasure` sub-object — both `field` and `fieldToMeasure` are the
# same FilterField union that accepts `{calculation: …}`. Enumerating positions
# invites a whack-a-mole bypass every time Tableau adds a nested field slot, so
# instead we `walk` the entire query object and treat the query as elevated when a
# `calculation` key with a non-null value appears anywhere at any depth. walk keys
# on the structural key *name*, so a column literally *named* "calculation"
# (a value carried under a `fieldCaption` key) is not matched — only a real
# `calculation:` key is. `count(path) > 0` skips the root node.
calc_present if {
	walk(query, [path, value])
	count(path) > 0
	path[count(path) - 1] == "calculation"
	value != null
}

# --- Identity exemption ------------------------------------------------------
# Callers in the `data-analysts` IdP group may use arbitrary calculations. The
# object.get chain fails closed — a missing `subject`, missing `claims`, or
# missing `groups` claim yields an empty list, so an unauthenticated/unclaimed
# caller is never exempt. The is_array guard means a `groups` claim that is a
# bare string (or any non-array shape) yields no memberships and also fails
# closed. Group name compared case-insensitively.
caller_groups := object.get(
	object.get(object.get(input, "subject", {}), "claims", {}),
	"groups",
	[],
)

is_analyst if {
	is_array(caller_groups)
	some g in caller_groups
	is_string(g)
	lower(g) == "data-analysts"
}

# --- Allow rules -------------------------------------------------------------
# Any tool that is not the VDS query tool passes through.
allow if {
	not is_query_tool
}

# Data analysts may run calculation queries.
allow if {
	is_query_tool
	is_analyst
}

# Ordinary callers may run the query only when it carries no calculation.
allow if {
	is_query_tool
	not is_analyst
	not calc_present
}

# --- Deny reason -------------------------------------------------------------
reasons contains "This Tableau VizQL Data Service query includes a calculation field, which accepts an arbitrary Tableau calc expression that can reference any column in the datasource and bypasses column-level (fieldCaption) allowlisting. Arbitrary calculations are restricted to the data-analysts group on the agent MCP path. Re-issue the query using only fieldCaption fields and standard filters, or ask a member of the data-analysts group to run it. If you need calculation access, contact your data platform team." if {
	is_query_tool
	not is_analyst
	calc_present
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
