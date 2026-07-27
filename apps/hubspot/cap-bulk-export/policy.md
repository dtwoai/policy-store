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

  Clamps the page size of HubSpot bulk-read tool calls before they reach the
  HubSpot MCP server, so a single agent request to a **covered** bulk-read tool
  can never pull more than 50 CRM records. (Coverage is by tool-name suffix —
  see Tool name matching and Known limitations for what is and isn't clamped.)
  Contact, company, deal, and ticket records carry names, emails,
  phones, and addresses — search/list pagination is the mass-PII export channel
  in every HubSpot MCP implementation.

  Two clamps are applied:

  - **Page-size clamp** — on search/list tools, any numeric `limit` outside the
    range 1–50 is rewritten to 50: values above the cap, and non-positive values
    (`limit: 0` / negatives, which some servers treat as "unbounded"). `limit: 50`
    is also injected when the field is absent or non-numeric (the remote server
    otherwise defaults up to 200 records per page). Calls that already request
    between 1 and 50 pass through untouched.
  - **Batch-read truncation** — on ids-style batch reads (`get_crm_objects`
    accepts up to 100 IDs; `hubspot-batch-read-objects` takes an `inputs`
    array), any `ids` / `objectIds` / `inputs` array longer than 50 entries is
    truncated to its first 50.

  The policy never denies, so read workflows keep functioning — just at bounded
  page sizes. Every possibly-missing field is read with `object.get`, so
  malformed or minimal calls pass through rather than erroring.

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
    minimised *before* it reaches HubSpot; **Art. 5(1)(d)** — smaller read/write
    surfaces reduce mass-corruption blast radius on downstream batch workflows.
  - **CCPA 11 CCR §7002** — supports proportionality: collection and use of
    personal information stays proportionate to the disclosed purpose rather
    than defaulting to bulk retrieval.

  ## Why ingress

  The over-broad request itself is the problem: once HubSpot has returned 200
  records, an egress policy can only mask fields — the volume has already been
  fetched, logged, and counted against rate limits. Rewriting `limit` at ingress
  enforces minimisation before the query executes, which is the only place the
  record *count* can be controlled.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `hubspot-mcp-hubspot-list-objects`), so matching is by case-insensitive
  suffix to stay portable across deployments. Covered names, per server family:

  - **Remote server / Claude connector** (verified): `search_crm_objects`,
    `get_crm_objects`
  - **`@hubspot/mcp-server` local beta** (verified): `hubspot-search-objects`,
    `hubspot-list-objects`, `hubspot-batch-read-objects`
  - **shinzo-labs community server** (verified names): `crm_list_objects`,
    `crm_search_objects`, `crm_search_contacts`, `crm_search_companies`

  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production, and extend the suffix lists if your
  server exposes additional list/search tools.

  ## Argument shape

  - Search/list tools take a top-level numeric `limit` (verified for
    `search_crm_objects` / `hubspot-search-objects`, alongside `objectType`,
    `query`, `filterGroups`, `properties`, `after`). All other arguments are
    preserved unchanged by the rewrite.
  - `hubspot-batch-read-objects` takes `objectType` + an `inputs` array
    (verified pattern for the local-beta batch tools).
  - `get_crm_objects` accepts up to 100 IDs, but HubSpot does not fully publish
    the parameter name — the policy truncates both common shapes (`ids` and
    `objectIds`) when present as arrays. Confirm the live shape from
    `tools/list` before relying on this clamp.

  ## Examples

  ### Passed through unchanged

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-remote-search_crm_objects", "type": "tool" },
      "payload": {
        "name": "hubspot-remote-search_crm_objects",
        "args": { "objectType": "contacts", "query": "smith", "limit": 25 }
      }
    }
  }
  ```

  `allow = true`, no transform — the requested page size is already within the cap.

  ### Transformed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-remote-search_crm_objects", "type": "tool" },
      "payload": {
        "name": "hubspot-remote-search_crm_objects",
        "args": { "objectType": "contacts", "query": "smith", "limit": 200 }
      }
    }
  }
  ```

  `allow = true`, transform rewrites the args to
  `{ "objectType": "contacts", "query": "smith", "limit": 50 }`. A call with no
  `limit` at all gets `limit: 50` injected the same way.

  ## Composition

  This policy bounds record *volume*; it does not mask record *content*. Pair it
  with:

  - [`apps/hubspot/redact-pii`](../redact-pii/policy.md) — egress masking of
    contact identifiers in whatever records are returned. Together they enforce
    minimisation on both the query and the response.
  - [`apps/hubspot/read-only`](../read-only/policy.md) — if agents should not
    write to the CRM at all.

  ## Known limitations

  - **Per-request caps do not stop patient pagination.** An agent that walks the
    `after` cursor page by page can still enumerate the full dataset — it just
    takes 4× as many calls at `limit: 50`. Detecting cursor-driven crawls
    requires cross-request state the policy engine does not have; use gateway
    audit logs / alerting to spot high-frequency paging.
  - **shinzo per-engagement read tools are not clamped.** The shinzo server
    exposes `calls_/emails_/meetings_/notes_/tasks_` `list` / `search` /
    `batch_read` tools — bulk-read channels for engagement bodies, which
    frequently carry customer PII/PHI verbatim — but their argument shapes (the
    `limit` key and the batch array key) are not verified, so this policy does
    **not** clamp them. An agent that calls `emails_search`, `calls_list`, etc.
    can still request large pages. Add their suffixes to `limit_tool_suffixes` /
    `batch_array_keys` once you have confirmed the live shape from `tools/list`.
  - **The baryhuang community server is not covered.** Its bulk reads
    (`hubspot_get_active_contacts`, `hubspot_get_active_companies`,
    `hubspot_search_data`) use a distinct name family and are not clamped;
    `hubspot_search_data` additionally vectorises CRM data into a local store
    *outside* HubSpot. The 50-record bound holds for the remote and local-beta
    families plus the four shinzo CRM search/list names listed above — not for
    every conceivable HubSpot MCP server. Extend the suffix lists per server.
  - **`get_crm_objects` ID parameter name is partially verified.** The 100-ID
    capacity is documented, the exact key is not; the policy covers `ids` and
    `objectIds`. An implementation using a different key passes through
    unclamped until you add it.
  - **Only the listed argument keys are clamped.** A server that spells the page
    size differently (`pageSize`, `maxResults`, `count`) is not covered — extend
    the policy if your `tools/list` shows other shapes.
  - **No identity-based exemptions.** All callers are clamped equally. If a
    data-ops group legitimately needs full-page reads, add an
    `input.subject.claims`-gated bypass as a separate rule.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are
  > outside the gateway's reach by design. Validate against your own compliance
  > program before relying on it.
direction: ingress
apps:
  - hubspot
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
package hubspot.ingress.cap_bulk_export

# Transform-only policy — never denies, only clamps bulk-read page sizes.
default allow := true

# Maximum records a single agent call may request.
max_records := 50

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match case-insensitively by suffix to stay portable. Verify the exact names
# your gateway sends with the dump-input debug technique before production use.

# Search/list tools that take a numeric `limit` argument.
# Remote server family: search_crm_objects
# Local beta family:    hubspot-search-objects, hubspot-list-objects
# shinzo family:        crm_list_objects, crm_search_objects,
#                       crm_search_contacts, crm_search_companies
limit_tool_suffixes := [
    "search_crm_objects",
    "hubspot-search-objects",
    "hubspot-list-objects",
    "crm_list_objects",
    "crm_search_objects",
    "crm_search_contacts",
    "crm_search_companies",
]

is_limit_tool if {
    some suffix in limit_tool_suffixes
    endswith(lower(input.resource.name), suffix)
}

# Ids-style batch reads: get_crm_objects (remote, <=100 IDs) and
# hubspot-batch-read-objects (local beta, `inputs` array).
is_batch_tool if {
    endswith(lower(input.resource.name), "get_crm_objects")
}

is_batch_tool if {
    endswith(lower(input.resource.name), "hubspot-batch-read-objects")
}

# --- Argument access (object.get everywhere — fields may be missing) ---------

args := object.get(input.payload, "args", {})

limit_value := object.get(args, "limit", null)

# Clamp when `limit` is absent (the remote server otherwise defaults up to
# 200 records per page).
needs_limit_clamp if {
    limit_value == null
}

# Clamp when a numeric `limit` exceeds the cap.
needs_limit_clamp if {
    is_number(limit_value)
    limit_value > max_records
}

# Clamp when a numeric `limit` is below 1 (0 or negative). Some servers treat a
# non-positive `limit` as "unbounded" or silently fall back to their large
# default page, so `limit: 0` / `limit: -1` would otherwise be a fail-open
# bypass of the cap. Any numeric limit outside [1, max_records] is normalised.
needs_limit_clamp if {
    is_number(limit_value)
    limit_value < 1
}

# Clamp when `limit` is present but not a number (fail safe: replace an
# unparseable value with the cap rather than letting the server default win).
needs_limit_clamp if {
    limit_value != null
    not is_number(limit_value)
}

# --- Batch truncation --------------------------------------------------------
# `inputs` is the verified key for hubspot-batch-read-objects; `ids` and
# `objectIds` cover the common shapes for get_crm_objects (exact key not
# fully published by HubSpot — see Known limitations).
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

# --- Transforms ---------------------------------------------------------------
# Only one of these can fire per call: the limit-tool and batch-tool suffix
# sets are disjoint, so the complete `transform` rule never conflicts.

# Rewrite (or inject) `limit` on search/list tools.
transform := {"transformed_payload": object.union(args, {"limit": max_records})} if {
    input.action == "tool_pre_invoke"
    is_limit_tool
    needs_limit_clamp
}

# Truncate oversized ID/inputs arrays on batch-read tools.
transform := {"transformed_payload": object.union(args, truncated_batch_args)} if {
    input.action == "tool_pre_invoke"
    is_batch_tool
    count(oversized_batch_keys) > 0
}
```
