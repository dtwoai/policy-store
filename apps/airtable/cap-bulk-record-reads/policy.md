---
name: Clamp Bulk Airtable Record Reads
tags:
  - airtable
  - cap-bulk-export
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # airtable / cap-bulk-record-reads

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — this policy never blocks, it only narrows)
  **Package:** `airtable.ingress.cap_bulk_record_reads`

  ## What it does

  Airtable bases routinely hold CRM contacts, applicant-tracking pipelines, customer/financial
  trackers, and — on HIPAA-eligible Enterprise plans — health-ops rows. Bulk record-list tools are
  the primary PII-egress surface: Airtable's list endpoints return pages of up to **100** rows, and
  an agent that is handed an unbounded (or high) page size can paginate to drain an entire table in
  a handful of calls.

  This is an **ingress transform** that enforces minimum-necessary / data-minimisation on the agent
  channel. It never denies a request — it only narrows the arguments before they reach the Airtable
  MCP server:

  1. **Row-count clamp.** On the bulk record-list tools, it rewrites `maxRecords` down to a ceiling
     of **50**, and **injects `maxRecords: 50` when the argument is absent** (or is not a number, or
     is non-positive, or is above the ceiling). A non-positive `maxRecords` (`0` or negative) is
     treated as invalid rather than "a very small read": a server that reads it as unset would fall
     back to its default page (up to 100 rows), so it is forced to the ceiling. Leaving a bulk read
     unclamped is never the default — the clamp is unconditional and applies to every caller,
     including analysts.
  2. **Formula strip.** For callers **outside** the placeholder `analyst` group, it strips the raw
     `filterByFormula` argument. `filterByFormula` is an arbitrary Airtable formula string — a
     high-selectivity query/exfil surface that enables targeted extraction (e.g. pulling every row
     matching a sensitive predicate). Analysts keep it; everyone else loses it and gets an
     unfiltered (but clamped) list.

  Tools that are **not** bulk list surfaces are left completely unchanged: `search_records` (scoped
  by an explicit `searchTerm`) and `get_record*` (single-record fetch by `recordId`) pass through
  untouched.

  ## Why ingress-transform and not deny/egress

  A bulk read has no permanent side effect, so denying it outright would be needlessly disruptive —
  the goal is data-minimisation, not access denial. Rewriting the arguments **before** the call
  reaches Airtable means the oversized page is never fetched in the first place (an egress policy
  would only mask an already-materialised 100-row response to the caller, after Airtable had already
  assembled and transmitted it). The clamp is therefore the cheapest and least-leaky place to
  enforce minimum-necessary.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal of information by
    bounding how many records leave the base per agent call.
  - **GDPR Art. 5(1)(c)** — supports data minimisation (adequate, relevant, limited to what is
    necessary); **CCPA 11 CCR §7002** — supports the proportionality/minimisation requirement on
    collection and use.

  ## Tool name matching

  The policy matches the bulk record-list tools by **suffix**, so it works across both the official
  server's verbose names and the community servers' terse names (the gateway prefixes tool names
  with the configured MCP server name, e.g. `airtable-list_records_for_table`, which is not
  standardised):

  - `*list_records` (domdomegg community server)
  - `*list_records_for_table` (official Airtable MCP server)
  - `*list_records_for_page` (official Airtable MCP server, page reads)

  The match is evaluated against **both** the PARC `resource.name` and the legacy `payload.name`
  alias (they carry the same value on tool hooks), so a call that arrived with one of the two absent
  is still recognised and still clamped — a bulk read is never left unclamped just because only the
  legacy name field was populated.

  `search_records` and `get_record*` are deliberately not matched. Verify the exact tool names your
  gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  Argument keys are taken from the landscape note:

  - `maxRecords` — integer page/row ceiling. Verified for the domdomegg server
    (`{ baseId, tableId, maxRecords?, filterByFormula? }`); the official server's `*_for_table` /
    `*_for_page` variants are documented as taking equivalent fields, so the same key is assumed
    there (see Known limitations).
  - `filterByFormula` — a raw Airtable formula string.

  Any value of `maxRecords` that is absent, non-numeric, non-positive (`0` or negative), or greater
  than 50 is replaced with `50`; a numeric value already in the range `1`–`50` is left untouched.

  ## Identity

  Group membership is read from the caller's JWT-derived claims via
  `object.get(input.subject, "claims", {})` → `groups`. The `analyst` exemption is a **grant**, so it
  **fails closed**: a caller with no `subject`, no `claims`, no `groups`, or a `groups` claim that is
  not an array of strings is treated as *not* an analyst, and `filterByFormula` is stripped. The
  row-count clamp does not depend on identity at all.

  ## Examples

  ### Clamped (non-analyst, oversized page + raw formula)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-list_records_for_table", "type": "tool" },
      "subject": { "claims": { "groups": ["support"] } },
      "payload": {
        "name": "airtable-list_records_for_table",
        "args": { "baseId": "appABC", "tableId": "tblXYZ", "maxRecords": 100, "filterByFormula": "{SSN}!=''" }
      }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload = { "baseId": "appABC", "tableId": "tblXYZ", "maxRecords": 50 }`
  (`maxRecords` clamped to 50, `filterByFormula` stripped).

  ### Injected (no maxRecords supplied)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-list_records", "type": "tool" },
      "payload": { "name": "airtable-list_records", "args": { "baseId": "appABC", "tableId": "tblXYZ" } }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload` adds `"maxRecords": 50`.

  ### Analyst keeps the formula (still clamped)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-list_records", "type": "tool" },
      "subject": { "claims": { "groups": ["analyst"] } },
      "payload": {
        "name": "airtable-list_records",
        "args": { "baseId": "appABC", "tableId": "tblXYZ", "maxRecords": 100, "filterByFormula": "{Stage}='Won'" }
      }
    }
  }
  ```

  `allow = true`; `maxRecords` clamped to 50, `filterByFormula` preserved.

  ### Untouched (single-record and search tools)

  A `get_record` or `search_records` call passes through with no transform.

  ## Composition

  This policy is single-purpose. Useful companions on the same Airtable gateway:

  - [`apps/airtable/fence-base-allowlist`](../fence-base-allowlist/policy.md) — confines the agent to
    sanctioned `baseId`s, so the clamp only ever applies inside approved bases.
  - [`apps/airtable/redact-pii-egress`](../redact-pii-egress/policy.md) — masks PII in whatever rows
    do come back, catching leakage that a bounded read still surfaces.
  - A companion clamp on `search_records` if your environment needs its `maxRecords` bounded too
    (this policy deliberately leaves `search_records` alone).

  ## Known limitations

  - **Pagination is not bounded across calls.** The clamp limits rows *per call*; it does not stop an
    agent from paginating (via `offset`/repeated calls) to traverse a table over many requests. It
    reduces per-call blast radius, not cumulative reads — pair it with egress PII redaction and
    platform-level rate limiting for defence in depth.
  - **`search_records` is out of scope by design.** Per the spec it is left unchanged (it is scoped
    by an explicit `searchTerm`), so its own `maxRecords` is not clamped. Add a companion policy if
    you need it bounded.
  - **`filterByFormula` is the only extraction key stripped.** A saved-`view` argument can also
    pre-filter a list server-side; this policy does not touch `view`. It also strips only the exact
    key `filterByFormula` — the argument key is fixed by the server schema, so casing variants are
    not a real vector, but a server exposing the formula under a different key would need that key
    added.
  - **Official-server argument shape is assumed, not source-verified.** The landscape note verifies
    `maxRecords`/`filterByFormula` for the domdomegg community server and states the official
    `*_for_table`/`*_for_page` variants "take equivalent fields"; confirm the official server's
    exact argument keys with live introspection before relying on this against the official server.
  - **Only the three `list_records*` suffixes are clamped.** Other record-returning surfaces are out
    of matching range and pass through unclamped: the official server's `display_records_for_table`
    (an interactive-widget bulk read, disabled by default — its argument shape is undocumented, so
    it is not clamped rather than clamped blindly) and any list-style tools exposed by the
    unverified `rashidazarang` community server (42 tools, names not source-verified in the landscape
    note). If your gateway enables `display_records_for_table` or fronts a server whose bulk-read tool
    is not named `*list_records[_for_table|_for_page]`, add its suffix to `is_bulk_list_tool` after
    verifying its `maxRecords` key with live introspection.
  - **Malformed (non-object) `args` are not narrowed.** The clamp injects/rewrites `maxRecords` only
    when `payload.args` is an object (the normal MCP shape). If a caller sends `args` as a scalar or
    array, the transform does not fire and no clamp is applied — but such a call carries no usable
    `maxRecords`/`filterByFormula` and is rejected by the Airtable MCP server before any records are
    returned, so this is not a data-egress path. Args that are simply *absent* still fail safe: an
    empty object is assumed and `maxRecords: 50` is injected.
  - **Group names are placeholders — replace `analyst` with your IdP's group name at import time.**
    Identity uses only IdP-supplied claims (`subject.claims.groups`); it never reads the stripped
    ContextForge-internal claims (`is_admin`, `teams`, `user`).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - airtable
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package airtable.ingress.cap_bulk_record_reads

# Transform-only: this policy never denies. It narrows bulk record-read arguments
# (minimum-necessary / data-minimisation) on the agent channel and passes every
# other request through unchanged.
default allow := true

# Row-count ceiling for a bulk record-list call. Airtable list endpoints return
# pages of up to 100 rows; without a cap an agent can paginate to drain a table.
# 50 is a deliberately conservative minimum-necessary default — tune it for your
# environment.
max_records_ceiling := 50

# IdP groups permitted to pass a raw `filterByFormula`. `filterByFormula` is an
# arbitrary Airtable formula string — a high-selectivity query/exfil surface — so
# it is stripped for everyone outside this group. Placeholder: replace `analyst`
# with your IdP's analyst group name at import time.
formula_privileged_groups := {"analyst"}

# --- Tool matching (suffix; official verbose names + community terse name) ------

# Bulk record-LIST tool suffixes. `search_records` (scoped by searchTerm) and
# `get_record*` (single record) are intentionally excluded: they do not end with
# any of these suffixes (`get_record_for_page` ends `record_for_page`, not the
# plural `records_for_page`; `search_records` ends `search_records`).
bulk_list_suffixes := {"list_records", "list_records_for_table", "list_records_for_page"}

# Candidate tool names, lower-cased. Both the PARC `resource.name` and the legacy
# `payload.name` alias are considered: they carry the same value on tool hooks, so
# a call that arrived with one of them absent still matches and is still clamped.
# Leaving a bulk read unclamped because only the legacy name was populated is
# exactly the fail-open this policy must avoid. Missing objects default to "" via
# object.get, and "" never matches a suffix.
candidate_tool_names := {lower(name) |
    some name in [
        object.get(object.get(input, "resource", {}), "name", ""),
        object.get(object.get(input, "payload", {}), "name", ""),
    ]
}

is_bulk_list_tool if {
    some name in candidate_tool_names
    some suffix in bulk_list_suffixes
    endswith(name, suffix)
}

# --- Identity -------------------------------------------------------------------

# Read groups via object.get(input.subject, "claims", {}) with a safe chain so a
# fully-missing subject does not error the rule body.
caller_claims := object.get(object.get(input, "subject", {}), "claims", {})

caller_groups := object.get(caller_claims, "groups", [])

# The analyst grant fails closed: `groups` must be an array of strings. A map- or
# scalar-shaped claim (a spoofing surface) is not an array and grants nothing, so
# filterByFormula is stripped. Missing claims => not analyst => stripped.
is_formula_privileged if {
    is_array(caller_groups)
    some group in caller_groups
    is_string(group)
    formula_privileged_groups[lower(group)]
}

# --- Transform (row-count clamp + conditional formula strip) --------------------

call_args := object.get(object.get(input, "payload", {}), "args", {})

# Fire only when narrowing actually changes the args, so a request that is already
# minimal produces no transform (the aggregator then skips this policy for it).
transform := {"transformed_payload": narrowed} if {
    is_bulk_list_tool
    narrowed := narrow_args(call_args)
    narrowed != call_args
}

# Apply both narrowings in sequence: clamp maxRecords, then strip filterByFormula.
narrow_args(args) := strip_formula(clamp_max_records(args))

# Leave maxRecords alone only when it is already a positive number in [1, ceiling];
# otherwise (absent, non-numeric, non-positive, or above the ceiling) set it to
# the ceiling. This both clamps oversized values and injects the cap when it is
# missing, closes the "pass maxRecords as a string" bypass, AND closes the
# non-positive bypass: a maxRecords of 0 or a negative number is not a smaller
# read — an Airtable server that treats a non-positive/invalid maxRecords as unset
# would fall back to its default page (up to 100 rows), so a bare `<= ceiling`
# lower-open guard would let `maxRecords: 0` defeat the clamp. Requiring value >= 1
# forces those to the ceiling.
clamp_max_records(args) := args if {
    max_records_within_ceiling(object.get(args, "maxRecords", null))
}

clamp_max_records(args) := object.union(args, {"maxRecords": max_records_ceiling}) if {
    not max_records_within_ceiling(object.get(args, "maxRecords", null))
}

max_records_within_ceiling(value) if {
    is_number(value)
    value >= 1
    value <= max_records_ceiling
}

# Non-analysts lose the raw formula; analysts keep it. object.remove is a no-op
# when the key is absent, so this never adds churn on formula-free calls.
strip_formula(args) := args if {
    is_formula_privileged
}

strip_formula(args) := object.remove(args, ["filterByFormula"]) if {
    not is_formula_privileged
}
```
