---
name: Snowflake Default-Deny Unknown Tools
tags:
  - snowflake
  - default-deny-unknown-tools
  - allowlist
  - access-control
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # snowflake / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny unknown Snowflake tools, allow allowlisted Snowflake tools and all other servers
  **Package:** `snowflake.ingress.default_deny_unknown_tools`

  ## What it does

  Pins an **allowlist of the exact Snowflake tool names your team audited** and
  denies every other tool name on the Snowflake MCP server(s). A tool that was
  newly published upstream, renamed by an admin, or added to the Labs server's
  YAML config after your audit is **denied-and-alerted instead of silently
  reachable**. Tools on other MCP servers behind the same gateway pass through
  unchanged.

  This is the **anchor policy for the whole Snowflake set**: the companion SQL
  guard, bulk-export guard, schema-fencing, and egress-redaction policies only
  ever see a request that already passed this gate, so their per-tool logic can
  assume the tool inventory is the one that was reviewed.

  ## Why an exact per-tenant allowlist (pin at import time)

  On the Snowflake-managed MCP server, every tool is an admin-defined object
  with a **user-chosen `name`** (docs use kebab-case examples such as
  `product-search`) and a fixed **`type`** (`SYSTEM_EXECUTE_SQL`,
  `CORTEX_AGENT_RUN`, `GENERIC`, `CORTEX_SEARCH_SERVICE_QUERY`,
  `CORTEX_ANALYST_MESSAGE`) that carries the tool's actual semantics — and the
  `type` is **not visible on the wire** at call time. The Snowflake-Labs server
  (`snowflake-labs-mcp`) adds dynamically-named Cortex Search/Analyst tools
  drawn from the `service_name` entries in the admin's YAML. There are **no
  canonical, suffix-stable names** to match the way other apps' policies match
  fixed vendor tool names.

  So this policy matches **exactly** (never `endswith`) against two pinned
  per-tenant constants that **you must edit at import time**:

  - `snowflake_server_names` — the MCP server name(s) your gateway admin gave
    the Snowflake server(s); the gateway prefixes every tool with this name.
  - `allowed_tool_names` — the exact tool names (as configured in the Snowflake
    MCP server spec / Labs YAML) that your team audited for this deployment.

  The shipped values are **illustrative starter examples**, not canonical
  names (only the Labs entries `list_objects` and `run_snowflake_query` are
  verified upstream names; the managed-server entries are admin-chosen). Until
  you replace them with your deployment's real names, legitimate tools will be
  denied — the fail-closed direction — and nothing unaudited is allowed.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    a warehouse full of regulated data is reachable only through the tool
    names that were explicitly audited and pinned.
  - **SOC 2 CC6.6** — supports boundary protection: an upstream party adding
    or renaming a tool cannot extend the agent channel's reach past the
    reviewed inventory.
  - **SOC 2 CC6.8** — supports preventing unauthorized/unreviewed software on
    the agent channel: a new MCP tool is new executable capability, denied by
    default until reviewed (partial — covers the MCP path only).
  - **SOC 2 CC7.2 / CC7.3** — deny events on unknown names surface tool-set
    drift as reviewable alerts in the gateway's audit pipeline (partial —
    alerting/monitoring itself is a platform property, not this policy).
  - **GDPR Art. 25** — supports data protection by design and by default on
    the agent channel: the default posture for any new data-access path is
    deny, and access requires a deliberate allowlist change.

  ## Tool name matching

  Matching is case-insensitive (`lower(input.resource.name)`). The **allowlist
  match is strictly exact** — no `endswith`, no trimming: an in-scope name is
  allowed only when it equals `<server-name>-<tool-name>` for some pinned server
  name and some entry in `allowed_tool_names`.

  **Scoping** ("is this the Snowflake server?") is decided on a
  whitespace-trimmed view of the name. A name is in scope when — after trimming
  leading/trailing whitespace — it starts with a pinned server name from
  `snowflake_server_names` followed by `-` (the gateway's
  `<server-name>-<tool-name>` convention), or equals a pinned server name
  outright. The trim is deliberate: without it, a padded name like
  `" snowflake-mcp-execute-sql"` (leading space/tab/newline) would fail the
  prefix test, be mistaken for a different server, and pass through the
  out-of-scope allow branch — a fail-open bypass. Because scoping trims but the
  allowlist match does not, a padded name lands **in scope but is never an exact
  allowlist match, so it is denied** (fail closed).

  Everything in scope that does not match exactly is denied — including
  near-misses like `product-search-v2` and whitespace-padded variants (leading
  or trailing), which are treated as unknown tools.

  The gateway's server-name prefix is deployment-specific; verify the exact
  names your gateway sends with the dump-input debug technique before relying
  on this in production, and pin **every** Snowflake server name if the
  gateway fronts more than one (e.g. managed and Labs side by side).

  ## Argument shape

  None. The decision is made entirely from the tool name — the point of this
  gate is that an unknown name's semantics cannot be inspected from its
  arguments. A matched unknown tool is denied even when its arguments or the
  whole payload are missing.

  ## Examples

  ### Allowed

  ```jsonc
  // An audited, pinned Cortex Search tool on the managed server.
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
  // A tool added upstream after the audit — name not on the pinned allowlist.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "snowflake-mcp-refund-runner", "type": "tool" },
      "payload": {
        "name": "snowflake-mcp-refund-runner",
        "args": { "message": "process all pending refunds" }
      }
    }
  }
  ```

  `allow = false`, `reason = "The Snowflake tool 'snowflake-mcp-refund-runner' is not on the pinned allowlist (...)"`.

  ## Composition

  This policy is the ingress gate the rest of the Snowflake set assumes.
  Companions in this catalog:

  - [`guard-warehouse-sql`](../guard-warehouse-sql/policy.md) — destructive-SQL
    guard on the allowlisted SQL tool.
  - [`guard-warehouse-export`](../guard-warehouse-export/policy.md) — blocks
    bulk export (`COPY INTO` external stages) through allowlisted SQL tools.
  - [`fence-sensitive-schemas`](../fence-sensitive-schemas/policy.md) — schema
    fencing on allowlisted query tools.
  - [`deny-composite-cortex-tools`](../deny-composite-cortex-tools/policy.md) —
    explicit denylist of known composite/`GENERIC` tools; keep it attached even
    with this gate so an accidentally-allowlisted composite name is still
    caught.
  - [`redact-pii-egress`](../redact-pii-egress/policy.md) — egress backstop on
    result sets.

  ## Known limitations

  - **The allowlist is only as good as the audit.** This policy pins *names*,
    not semantics: if an admin re-points an allowlisted name at a different
    tool `type` (e.g. renames a `GENERIC` UDF wrapper to a previously audited
    name), the gate cannot see the change. Re-audit whenever the Snowflake MCP
    server object or the Labs YAML changes.
  - **Starter values are illustrative.** Only `list_objects` and
    `run_snowflake_query` are verified upstream (Labs) names; the managed
    server has no canonical names to verify. Replace both constants with your
    deployment's real names at import time.
  - **Scoping relies on the `<server-name>-` prefix convention.** A Snowflake
    server exposed to the gateway *without* a name prefix cannot be
    distinguished from other servers by this policy — pin the exact bare names
    into `snowflake_server_names` only if you accept that scoping caveat, and
    verify with dump-input. Conversely, tools on non-Snowflake servers are out
    of scope by design and pass through (govern them with their own apps'
    policies).
  - **Cross-product over-allowance with multiple servers.** Every
    `allowed_tool_names` entry is accepted under every pinned server name, so
    pinning both managed and Labs servers allows e.g.
    `snowflake-mcp-list_objects` even if that tool only exists on the Labs
    server. Harmless when the name doesn't exist upstream, but split the
    policy per server if you need strict per-server inventories.
  - **A request with no tool name at all is allowed** — it cannot be scoped to
    the Snowflake server. The gateway never routes a nameless tool call, so
    this is not a reachable bypass, but the policy asserts nothing over
    nameless input.
  - **No identity-based exemptions — intentionally.** Exempting a group from
    the anchor gate would bypass every downstream Snowflake policy at once.
    For unaudited tooling needs, use the Snowflake web UI or a native client
    outside the agent channel, where the user's own role and audit trail
    apply.

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
package snowflake.ingress.default_deny_unknown_tools

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Per-tenant pinned constants (EDIT AT IMPORT TIME) ---
# The gateway prefixes every tool with the MCP server name it was configured
# under (`<server-name>-<tool-name>`). Pin the name(s) your admin gave the
# Snowflake server(s) here — every name starting with one of these prefixes is
# treated as a Snowflake tool and subjected to the allowlist. Lower-case only.
snowflake_server_names := [
    "snowflake-mcp",
    "snowflake-labs-mcp",
]

# The exact tool names your team audited for this deployment, as configured in
# the Snowflake MCP server spec (managed) or the Labs YAML (`service_name`
# entries). Snowflake tool names are admin-chosen and their `type` (which
# carries the real semantics) is invisible on the wire, so there is no stable
# suffix to match — matching is EXACT against <server-name>-<entry>.
#
# These are ILLUSTRATIVE STARTER EXAMPLES — replace them with your
# deployment's audited names at import time. Only `list_objects` and
# `run_snowflake_query` are verified upstream (Labs) names; the rest are
# admin-chosen placeholders. Lower-case only.
allowed_tool_names := [
    # Managed server (admin-chosen names; types shown for the audit record)
    "product-search",   # CORTEX_SEARCH_SERVICE_QUERY (read)
    "sales-analyst",    # CORTEX_ANALYST_MESSAGE (read)
    "execute-sql",      # SYSTEM_EXECUTE_SQL (governed by guard-warehouse-sql)
    # Snowflake-Labs server (verified upstream names)
    "list_objects",
    "run_snowflake_query",
]

# Case-insensitive; the allowlist match below is otherwise strictly exact (no
# suffix matching). Always defined — a missing name yields "".
normalized_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Scoping ("is this the Snowflake server?") is decided on a whitespace-trimmed
# view of the name so that leading/trailing padding cannot push a Snowflake tool
# OUT of scope into the pass-through allow branch. Without this, a name like
# " snowflake-mcp-execute-sql" (leading space/tab/newline) would fail the
# `startswith` prefix test, be treated as a non-Snowflake server, and be allowed
# — a fail-open bypass. Trimming here keeps padded names in scope; the exact
# allowlist match below still runs on the untrimmed `normalized_name`, so a
# padded name is in scope but never an exact allowlist match => denied (fail
# closed). trim_space trims Unicode whitespace on both ends.
scoping_name := trim_space(normalized_name)

# A tool is in scope when it carries a pinned Snowflake server-name prefix
# followed by the gateway's `-` separator...
is_snowflake_tool if {
    some server in snowflake_server_names
    startswith(scoping_name, concat("", [server, "-"]))
}

# ...or is exactly a pinned server name (degenerate prefix-only name: still
# Snowflake-scoped, and never allowlisted, so it is denied).
is_snowflake_tool if {
    some server in snowflake_server_names
    scoping_name == server
}

# The name exactly equals <server-name>-<audited-tool> for some pinned pair.
is_allowed_snowflake_tool if {
    some server in snowflake_server_names
    some tool in allowed_tool_names
    normalized_name == concat("-", [server, tool])
}

# Tools on other MCP servers are out of scope — pass through unchanged.
allow if {
    not is_snowflake_tool
}

# Snowflake tools are allowed only on an exact allowlist match.
allow if {
    is_snowflake_tool
    is_allowed_snowflake_tool
}

reasons contains msg if {
    is_snowflake_tool
    not is_allowed_snowflake_tool
    msg := sprintf("The Snowflake tool '%s' is not on the pinned allowlist of audited tool names for this gateway, so it is denied by default. Snowflake tool names are admin-chosen and the type that carries their real semantics (SQL execution, Cortex agent, generic UDF) is not visible on the wire, so an unknown name may be a newly added or renamed tool that has not been reviewed. If this tool is legitimate, ask your gateway operator to audit it against the Snowflake MCP server spec and add its exact name to the pinned allowlist in this policy.", [normalized_name])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
