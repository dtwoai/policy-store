---
name: Snowflake Deny Composite & Generic Tools
tags:
  - snowflake
  - deny-escape-hatches
  - access-control
  - cortex
  - ingress
  - soc2
  - iso27001-nist
publishedAt: 2026-07-12
description: |
  # snowflake / deny-composite-cortex-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `snowflake.ingress.deny_composite_cortex_tools`

  ## What it does

  Denies the **opaque composite and generic passthrough tools** on the
  Snowflake-managed MCP server whose execution the gateway cannot inspect one
  SQL statement at a time:

  - **`CORTEX_AGENT_RUN`-typed tools** — invoke a Cortex Agent that runs a
    multi-step plan **server-side**, and that plan can itself issue SQL. The
    gateway sees one opaque call, so a per-statement SQL guard, export block,
    or schema fence can never reach inside it.
  - **`GENERIC`-typed tools** — wrap an arbitrary user-defined function (UDF)
    or stored procedure with side effects. What the UDF/procedure does is not
    visible on the wire, so argument-level policy has nothing to inspect.
  - **Snowflake-Labs `agent_services` tools** — the Labs server exposes Cortex
    Agent tools defined under its `agent_services:` config section; same opaque
    composite risk as `CORTEX_AGENT_RUN` on the managed server.

  Denying these forces all agent access through the **granular, inspectable**
  Search (`CORTEX_SEARCH_SERVICE_QUERY`), Analyst (`CORTEX_ANALYST_MESSAGE`),
  and SQL (`SYSTEM_EXECUTE_SQL`) tools — the tools that the companion SQL,
  bulk-export, and schema-fencing policies can actually reason about. Every
  other tool passes through unchanged.

  ## Why a per-tenant denylist (pin at import time)

  On the managed Snowflake MCP server, each tool is an admin-defined object
  with a **user-chosen `name`** and a fixed **`type`** (`CORTEX_AGENT_RUN`,
  `GENERIC`, `SYSTEM_EXECUTE_SQL`, …). **The `type` is not visible on the wire**
  at call time — the gateway sees only the name, and names are arbitrary
  (`sales-agent`, `run-plan`, `invoke-refund-udf`, anything the admin chose).
  There is therefore **no stable suffix to match** the way other apps' escape
  hatches match a fixed vendor tool name.

  So the denylist is a **per-tenant array** (`denied_composite_tool_names`) of
  the exact tool names your Snowflake admin configured for the composite
  (`CORTEX_AGENT_RUN`) and generic (`GENERIC`) tools you want denied — plus any
  Labs agent-service names. It ships with an illustrative **starter set** that
  you **must** replace with your deployment's real names at import time; the
  names below are examples, not canonical tool names. Until you pin your own
  names, this branch denies only the example names and nothing else.

  This is primarily a **security-value** policy: the coverage matrix files
  "Snowflake generic SQL tools" under the PF-22 `deny-escape-hatches` family and
  cites ISO 27001 A.8.2 / NIST AC-6 for it. Denying an uninspectable escape
  hatch on the agent channel also supports the SOC 2 boundary-protection (CC6.6)
  and least-privilege (CC6.3) criteria (see Compliance alignment), so it carries
  the `soc2` bundle.

  ## Compliance alignment

  - **SOC 2 CC6.6** — supports boundary protection on the agent channel: an
    opaque composite plan or generic UDF/procedure wrapper is an uninspectable
    path that bypasses every downstream SQL, export, and schema control; denying
    it keeps the channel's reach inside the granular, inspectable tools the
    boundary was drawn around. **SOC 2 CC6.3** — supports least-privilege by
    forcing access through the granular tools instead of a privileged composite
    runner.
  - **ISO 27001 A.8.2 / NIST 800-53 AC-6(9), AC-6(10)** — privileged access
    restriction: an opaque composite plan or a generic UDF/procedure wrapper is
    a privileged, uninspectable function on the agent channel; denying it
    supports restricting privileged functions to authorized, auditable paths
    and forcing access through granular tools that the gateway can govern.

  The ISO/NIST controls sit outside the soc2 / hipaa / pci-dss / gdpr-ccpa / sox
  bundle set; the SOC 2 criteria above place this policy in the `soc2` bundle.

  ## Why ingress

  A Cortex Agent plan or a generic UDF/procedure executes the moment the call
  reaches Snowflake — its internal SQL runs, side effects commit, and the
  gateway never saw the individual statements. Egress inspection would see only
  the aggregated result, far too late to stop what the plan already did.
  Denying at ingress is the only point where the opaque call can be prevented.

  ## Tool name matching

  Matching is case-insensitive after surrounding whitespace is stripped
  (`lower(trim_space(input.resource.name))`) so a trailing space, newline, or
  CRLF cannot slip a name past the check. Two independent branches deny:

  1. **Pinned per-tenant names** (`denied_composite_tool_names`). Each entry
     matches when it is the whole tool name **or** appears as a suffix preceded
     by a non-alphanumeric separator (`-`, `_`, `.`, `/`, …). This keeps a
     pinned name portable across the gateway's server-name prefix (e.g. a
     configured `run-cortex-agent` matches `snowflake-mcp-run-cortex-agent`)
     without over-matching a name where a letter or digit immediately precedes
     it (e.g. `sales-agent` does **not** match `wholesales-agent`).
  2. **Labs `agent_services` token** — a name containing the token
     `agent_services` bounded by non-alphanumerics (`(^|[^a-z0-9])agent_services([^a-z0-9]|$)`),
     a heuristic for the Snowflake-Labs agent-service surface. This is a
     defense-in-depth backstop; the Labs agent tools are named after the
     `service_name` entries in the admin's YAML config and are **not** verified
     to carry the literal token, so pin their real names in
     `denied_composite_tool_names` as well.

  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  None. The decision is made entirely from the tool name — the whole point is
  that these tools' behavior is *not* inspectable from their arguments. A
  matched tool is denied even when its arguments are empty or missing.

  ## Examples

  ### Allowed

  ```jsonc
  // A granular Cortex Search tool — inspectable, not on the denylist.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-mcp-product-search", "type": "tool" },
      "payload": {
        "name": "snowflake-mcp-product-search",
        "args": { "query": "wireless headphones", "limit": 10 }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  // A pinned CORTEX_AGENT_RUN tool (admin-chosen name), with the gateway prefix.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-mcp-run-cortex-agent", "type": "tool" },
      "payload": {
        "name": "snowflake-mcp-run-cortex-agent",
        "args": { "message": "reconcile Q2 revenue and email finance" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Snowflake tool is a composite or generic passthrough (...)"`.

  ## Composition

  This policy closes the opaque-composite path so the inspectable-tool policies
  can do their job. Useful companions (author per your deployment):

  - **Deny destructive / export SQL (ingress)** on the SQL execution tool
    (`SYSTEM_EXECUTE_SQL` / `run_snowflake_query`) — the `guard-warehouse-sql`
    (PF-07) family.
  - **Schema fencing (ingress)** — deny queries referencing regulated schemas
    (`fence-sensitive-scopes`, PF-23).
  - **`default-deny-unknown-tools` (ingress, PF-28)** — an allowlist of the
    audited granular tool names, so a newly published composite/generic tool is
    denied by default even before you add it here.
  - **Egress PII redaction** on the Search / Analyst / SQL result sets.

  ## Known limitations

  - **Denylist, not allowlist — and empty by default for your tenant.** The
    shipped names are illustrative examples. A composite or generic tool you
    have **not** pinned is allowed through. Pin the array to your deployment's
    real tool names at import time, and pair with a `default-deny-unknown-tools`
    allowlist (PF-28) for a fail-closed posture against newly added tools.
  - **`type` is invisible on the wire — names only.** The policy trusts that
    the names you pinned really are the `CORTEX_AGENT_RUN` / `GENERIC` tools. If
    an admin renames a composite tool, or publishes a new one under an
    unpinned name, it is not caught until you update the array. Re-audit when
    the Snowflake MCP server object changes.
  - **`agent_services` token is a heuristic, not a verified tool name.** The
    Snowflake-Labs agent tools are named after `service_name` entries in the
    admin's YAML config; the landscape research could not verify that the
    literal token `agent_services` appears in the wire name. Treat branch 2 as
    a backstop and pin the real Labs agent-service names in
    `denied_composite_tool_names`.
  - **No server-prefix scoping on the token branch.** A tool on an unrelated
    MCP server whose name embeds the `agent_services` token would also be
    denied. Collisions are unlikely, but if one occurs, remove the token branch
    and rely solely on the pinned array.
  - **No identity-based exemptions — intentionally.** There is no break-glass
    group: exempting an identity would hand it a bypass of every downstream
    SQL, export, and schema policy, which is exactly what this policy exists to
    prevent. For genuine Cortex Agent work, use the Snowflake web UI or a native
    client outside the agent channel, where the user's own role and audit trail
    apply.
  - **Suffix matching trusts the `<server-name>-` prefix convention.** A tool
    literally named `<anything><separator><pinned-name>` matches the pinned
    entry even if it is a different tool. Replace suffix entries with full
    gateway names (exact match still fires) if your deployment needs strict
    exact-name pinning. A request that carries **no tool name at all** (or a
    non-string `resource.name`) matches nothing and is allowed — the gateway
    never routes a nameless or non-string tool call, so this is not a reachable
    bypass, but the policy asserts nothing over nameless/non-string input.
  - **Appended-token / separator-variant renames evade branch 1.** A pinned
    composite name with a version or environment token appended
    (`run-cortex-agent-v2`) is no longer a suffix of the pinned entry, and an
    all-underscore rename (`run_cortex_agent`) is a different string — both are
    allowed until you re-pin. This is the direct consequence of the names-only,
    per-tenant denylist; the fail-closed answer is `default-deny-unknown-tools`
    (PF-28), not a fuzzy name match (which would over-match legitimate tools).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - snowflake
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package snowflake.ingress.deny_composite_cortex_tools

# Deny-by-default: only the explicit allow rule below permits the request.
default allow := false

# --- Per-tenant denylist (PIN AT IMPORT TIME) ---
# The managed Snowflake MCP server carries each tool's semantics in its `type`
# (CORTEX_AGENT_RUN, GENERIC, SYSTEM_EXECUTE_SQL, ...), which is NOT visible on
# the wire — the gateway sees only the admin-chosen `name`. So there is no
# stable suffix to match. Populate this array with the EXACT names your
# Snowflake admin configured for the composite (CORTEX_AGENT_RUN) and generic
# (GENERIC) tools you want denied, plus any Labs agent-service names.
#
# These are ILLUSTRATIVE EXAMPLES — replace them with your deployment's real
# tool names. Entries are compared lower-cased; keep them lower-case here.
denied_composite_tool_names := [
    # CORTEX_AGENT_RUN-typed tools (composite; run server-side multi-step plans)
    "run-cortex-agent",
    "sales-agent",
    # GENERIC-typed tools (wrap an arbitrary UDF / stored procedure)
    "invoke-refund-udf",
    "run-stored-proc",
    # Snowflake-Labs agent-service name (named after a service_name entry)
    "support_agent",
]

# Normalize the tool name once: strip surrounding whitespace (so a trailing
# newline / space / CRLF cannot slip a match past the checks below), then
# lower-case for case-insensitive matching. If no name is present this is
# undefined, both deny branches fail, and the request is allowed — nameless
# input is not a reachable tool call (see Known limitations).
normalized_name := lower(trim_space(input.resource.name))

# Branch 1: the tool name matches a pinned per-tenant denylist entry.
is_denied_composite if {
    some entry in denied_composite_tool_names
    name_matches_entry(normalized_name, entry)
}

# Branch 2: Snowflake-Labs `agent_services` token, bounded by non-alphanumerics
# so it fires on `...-agent_services` / `agent_services-...` but not on an
# embedded run like `agent_serviceship`. Heuristic backstop — see Known
# limitations; pin the real Labs agent-service names above as well.
is_denied_composite if {
    regex.match(`(^|[^a-z0-9])agent_services([^a-z0-9]|$)`, normalized_name)
}

# A pinned entry matches when it is the whole tool name...
name_matches_entry(name, entry) if {
    name == entry
}

# ...or when it is a suffix preceded by a non-alphanumeric separator (`-`, `_`,
# `.`, `/`, ...), so a configured `run-cortex-agent` still matches the
# gateway-prefixed `snowflake-mcp-run-cortex-agent`, while `sales-agent` does
# NOT match `wholesales-agent` (a letter immediately precedes the suffix).
name_matches_entry(name, entry) if {
    endswith(name, entry)
    prefix_len := count(name) - count(entry)
    prefix_len > 0
    sep := substring(name, prefix_len - 1, 1)
    not regex.match(`[a-z0-9]`, sep)
}

# Allow everything that is not a denied composite / generic tool.
allow if {
    not is_denied_composite
}

reasons contains "This Snowflake tool is a composite or generic passthrough (a Cortex Agent / CORTEX_AGENT_RUN plan, a GENERIC UDF or stored-procedure wrapper, or a Labs agent-service) whose steps the gateway cannot inspect one SQL statement at a time, so it is disabled on this path. Route the agent through the granular Search, Analyst, and SQL tools instead, which the gateway's SQL, export, and schema-fencing policies can enforce. If a tool was misclassified, ask your Snowflake admin to review the composite/generic denylist pinned for this gateway." if {
    is_denied_composite
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
