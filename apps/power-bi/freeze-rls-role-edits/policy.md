---
name: Freeze Power BI RLS Role Edits
tags:
  - power-bi
  - freeze-identity-plane
  - ingress
  - rls
  - identity
  - groups
  - soc2
  - iso27001-nist
publishedAt: 2026-07-12
description: |
  # power-bi / freeze-rls-role-edits

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny RLS-role tools, allow everything else
  **Package:** `power_bi.ingress.freeze_rls_role_edits`

  ## What it does

  Freezes edits to row-level-security (RLS) roles on the Power BI MCP surface. RLS
  role filter expressions are editable through MCP: the Power BI **modeling** server's
  `security_role_operations` tool (and the community server's RLS-role-management
  tools) can rewrite a role's DAX filter expression to `TRUE()` and silently disable
  row security for everyone. That is a **governance change, not a data change** — a
  one-line filter rewrite widens every user's data scope across the model.

  This ingress policy denies the RLS-role tools for every caller **except** those
  whose IdP `groups` claim contains the placeholder governance group `bi-governance`.
  Row-security definitions therefore never change from a Cowork agent session **through
  these RLS-role tools** (see Known limitations for the sibling-tool residual — a
  full-model write can reach the same objects by another name). All other tools pass
  through unchanged.

  The modeling server's tools are coarse `<object>_operations` multiplexers: a single
  tool name multiplexes many sub-operations (list/create/update/delete-style) selected
  by an operation argument, and that operation enum is **undocumented** (landscape-noted
  as unverified). The tool name alone does not distinguish a read from a rewrite. This
  policy therefore denies the **whole tool** regardless of the operation argument — so
  even a read-only role listing through `security_role_operations` is blocked for
  non-governance callers. Denying the whole multiplexer is the only safe choice when a
  "list" and a "set filter to TRUE()" arrive under the same tool name; the deny reason
  directs analysts to request RLS changes through their governance workflow.

  ## Compliance alignment

  - **ISO 27001:2022 A.8.2 / NIST 800-53 AC-6(9), AC-6(10)** — supports privileged
    access restriction: editing an RLS role's filter expression is a privileged
    security-configuration function, and this policy prevents non-privileged callers
    (and injected agents acting as them) from exercising it on the agent channel. It
    keeps the RLS-role surface reserved to an explicit IdP-asserted governance group.
  - **SOC 2 CC6.1 / CC6.3** — supports logical access security and role-based least
    privilege by reserving the RLS-role edit surface to an explicit IdP-asserted
    governance group, so a non-privileged caller (or an injected agent acting as one)
    cannot rewrite a row-security filter on the agent channel.

  ## Tool name matching

  The policy matches case-insensitively on the lowercased, whitespace-trimmed
  `input.resource.name`, by **suffix**, because the DTwo gateway prefixes tool names
  with the configured MCP server name and that prefix is not standardized:

  - `security_role_operations` — the modeling server's RLS-role CRUD multiplexer
    (**verified** from `microsoft/powerbi-modeling-mcp`)
  - `create_rls_role`, `update_rls_role`, `delete_rls_role` — the community server's
    RLS-role-management tools. The landscape note records that three such tools exist
    but their exact names are **unverified**; these three suffixes are **placeholders
    to confirm and replace at import time**.

  These suffixes are snake_case and carry no leading separator, so a bare, unprefixed
  tool name (`security_role_operations`) and a prefixed one
  (`powerbi-modeling-security_role_operations`) both match. Verify the exact names your
  gateway sends with the dump-input debug technique before relying on this in
  production, and confirm the community tool names against your deployment.

  ## Argument shape

  The decision uses only the tool name (`input.resource.name`) and the caller's
  identity (`input.subject.claims.groups`). **Tool arguments are not inspected** — by
  design, because the operation enum on the `<object>_operations` multiplexer is
  undocumented and a permissive "this is only a list" argument cannot be trusted to
  distinguish a read from a filter rewrite. No argument-shape drift can bypass the
  deny.

  ## Identity claims

  Identity is read from `object.get(input.subject, "claims", {})`, then the placeholder
  governance group is checked against the `groups` claim:

  - `groups` — the caller's IdP-asserted group memberships (an array of strings).
    Membership of the placeholder `bi-governance` group is the only exemption.

  The lookup **fails closed (deny)**: a missing `subject`, missing `claims`, a
  missing/empty `groups` claim, or a `groups` claim that is not an array all yield "not
  a governance member", and the RLS-role tool is denied. No group means no exemption.

  ## Examples

  ### Allowed — a non-RLS modeling tool passes through

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-modeling-measure_operations", "type": "tool" },
      "payload": { "name": "powerbi-modeling-measure_operations", "args": { "operation": "list" } }
    }
  }
  ```

  `allow = true`, no reason — this policy governs only the RLS-role surface.

  ### Denied — RLS-role edit by a non-governance caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-modeling-security_role_operations", "type": "tool" },
      "subject": { "sub": "auth0|analyst", "claims": { "groups": ["analysts"] } },
      "payload": {
        "name": "powerbi-modeling-security_role_operations",
        "args": { "operation": "update", "role": "RegionFilter", "filter": "TRUE()" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Power BI row-level-security (RLS) role definitions are frozen on the agent path (...)"`.

  ### Denied — even a read-only role listing is blocked

  The same `security_role_operations` tool with `"args": { "operation": "list" }` and a
  non-governance caller still returns `allow = false` — the whole multiplexer is denied
  because the operation argument cannot be trusted to distinguish a read from a rewrite.

  ### Allowed — same edit by a `bi-governance` member

  The first denied call above, but with `"groups": ["bi-governance"]` in
  `input.subject.claims`, returns `allow = true`.

  ## Composition

  This policy is single-purpose. Curated companions on the Power BI surface:

  - **`default-deny-unknown-modeling-ops`** (PF-28) — allowlist the audited
    `*_operations` tools and deny on drift. **Pair this with it**: a renamed or newly
    added RLS-role tool would not match the suffixes here, but the default-deny policy
    catches it, so a renamed RLS tool does not slip past.
  - **`block-rls-bypass-service-principal`** — denies RLS-sensitive *reads/queries*
    under a service-principal identity (the read side of the RLS story).
  - **A PF-22 escape-hatch deny** on any raw-XMLA / generic passthrough tool that could
    reach the same model metadata without matching a named suffix.

  ## Known limitations

  - **Community RLS-role tool names are unverified.** The community server exposes
    three RLS-role-management tools whose names the landscape note records as
    unverified. The `create_rls_role` / `update_rls_role` / `delete_rls_role` suffixes
    are **placeholders** — confirm the real names against your community server and
    replace them at import time. Because the enforcement backstop is the companion
    `default-deny-unknown-modeling-ops` allowlist, an un-updated placeholder does not
    open a silent hole: an unknown RLS tool is caught there rather than allowed here.
  - **Group names are placeholders** — replace `bi-governance` with your IdP's group
    name at import time. The match is an exact, case-sensitive string comparison
    against entries of the `groups` claim; `BI-Governance` does not match
    `bi-governance`.
  - **The `groups` claim must be an array of strings.** If your IdP emits a single
    string or a namespaced custom claim (e.g. `https://acme.com/groups`), adjust
    `caller_groups` in the Rego. The exemption is guarded by `is_array`, so every
    non-array shape fails closed (deny) — including an object-shaped claim such as
    `{"role": "bi-governance"}`, whose *values* would otherwise have been iterated by
    `some group in caller_groups` and spoofed the governance exemption.
  - **Whole-tool deny is coarse by necessity.** Because the modeling server's operation
    enum is undocumented, this policy blocks even read-only role listings for
    non-governance callers. That is the safe choice given the multiplexer design; if
    your deployment documents the operation argument and you want to allow read
    operations, narrow the deny to write operations only — but do so knowing a
    permissive argument value cannot be trusted against an injected agent.
  - **Sibling modeling tools can redefine RLS roles without the named RLS tools
    (residual bypass — red-team finding).** RLS roles are objects inside the Tabular
    model definition, so a full-model or table-level metadata write through a
    *different* verified modeling tool — notably `model_operations` (and potentially
    `table_operations`) via a TMSL/TMDL `createOrReplace` that carries a `Roles`
    collection — can create or rewrite a security role's filter expression without ever
    invoking `security_role_operations`. Those tools are **not** renames of the RLS
    tool, so the companion `default-deny-unknown-modeling-ops` (PF-28) allowlist does
    **not** catch them: they are audited, expected tools PF-28 is meant to *allow*, and
    the "constrain modeling writes" candidate (deny `*_operations` except
    `dax_query_operations`/`model_operations`) explicitly *exempts* `model_operations`.
    This policy alone therefore does not guarantee row-security definitions never change
    from a Cowork session against a caller who holds `model_operations` (or
    `table_operations`) access. Mitigate by gating `model_operations`/`table_operations`
    behind the same `bi-governance` group (or a broader modeling-write role-gate) for any
    tenant where model-definition writes are in scope. (Red-team-verified:
    `model_operations` passes through this policy in isolation — see tests.yaml.)
  - **Suffix matching assumes the gateway joins the server-name prefix with a
    separator that leaves the snake_case tool name as a suffix.** DTwo's gateway does.
    A non-standard gateway that mangled the tool name could slip through; verify with
    the dump-input debug technique.
  - **Base-name rename / version drift slips past the exact-suffix match.** The
    match is `endswith(tool_name, suffix)` against the *exact* base names, so a
    renamed or versioned variant — e.g. `security_role_operations_v2`, or a
    community RLS tool named `manage_rls_role` / `set_rls_filter` rather than the
    `*_rls_role` placeholders — does **not** match here and this policy alone would
    allow it. This is by design for a single-purpose freeze: the enforcement
    backstop is the companion `default-deny-unknown-modeling-ops` (PF-28) allowlist,
    which denies any tool not on the audited list, so a renamed/added RLS tool is
    caught there rather than allowed. Deploy this policy paired with that PF-28
    allowlist, and re-confirm suffixes with the dump-input debug technique whenever
    the upstream server version changes. (Red-team-verified: `security_role_operations_v2`
    and `manage_rls_role` pass through this policy in isolation — see tests.yaml.)

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - power-bi
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package power_bi.ingress.freeze_rls_role_edits

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group permitted to edit RLS role definitions.
# Replace "bi-governance" with your IdP's group name at import time.
governance_group := "bi-governance"

# Lowercased, whitespace-trimmed tool name. The gateway prefixes tool names with
# the configured MCP server name, so matching is case-insensitive and suffix-based
# to stay portable across server names. trim_space so a trailing space/newline in
# the tool name cannot defeat the endswith suffix match.
tool_name := trim_space(lower(object.get(object.get(input, "resource", {}), "name", "")))

# RLS-role tools. These are coarse multiplexers / management tools whose operation
# argument cannot be trusted to distinguish a read from a filter rewrite, so the
# whole tool is matched regardless of arguments.
rls_role_suffixes := [
    # Modeling server RLS-role CRUD multiplexer (VERIFIED, microsoft/powerbi-modeling-mcp).
    "security_role_operations",
    # Community server RLS-role-management tools — names UNVERIFIED placeholders.
    # The landscape note records that three such tools exist but not their names.
    # Confirm against your community server and replace before import.
    "create_rls_role",
    "update_rls_role",
    "delete_rls_role",
]

# Suffix match. These suffixes carry no leading separator, so a bare unprefixed
# tool name (`security_role_operations`) and a prefixed one both match.
is_rls_role_tool if {
    some suffix in rls_role_suffixes
    endswith(tool_name, suffix)
}

# --- Identity (fail closed) ---
# Read groups via object.get(input.subject, "claims", {}). A missing subject,
# missing claims, missing groups claim, or a non-array groups claim all yield
# "not a governance member", so the RLS-role tool is denied.
claims := object.get(input.subject, "claims", {})

caller_groups := object.get(claims, "groups", [])

# Guard on is_array: without it, `some group in caller_groups` would iterate the
# *values* of an object-shaped groups claim, so a claim like {"role": "bi-governance"}
# would spoof the exemption and fail OPEN. Requiring an array makes every non-array
# shape (string, object, number) fail closed.
caller_is_governance if {
    is_array(caller_groups)
    some group in caller_groups
    group == governance_group
}

# Allow any tool that is not an RLS-role tool (all other Power BI tools pass through).
allow if {
    not is_rls_role_tool
}

# Allow RLS-role tools only for members of the governance group.
allow if {
    is_rls_role_tool
    caller_is_governance
}

reasons contains msg if {
    is_rls_role_tool
    not caller_is_governance
    msg := sprintf("Power BI row-level-security (RLS) role definitions are frozen on the agent path — an RLS filter expression controls who sees which rows, so changing it is a governance action, not a data change. This tool is blocked for every operation (including read-only role listings) because its operation argument cannot be trusted to distinguish a read from a filter rewrite. Request RLS role changes through your data-governance workflow. If your role requires editing RLS through the gateway, ask your data-governance team to add you to the '%s' IdP group, or contact your InfoSec team if this looks like a false positive.", [governance_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
