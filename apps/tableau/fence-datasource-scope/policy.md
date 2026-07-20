---
name: Fence Tableau Datasource Scope
tags:
  - tableau
  - fence-sensitive-scopes
  - access-control
  - datasource
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # tableau / fence-datasource-scope

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny; explicit allows for non-fenced tools, approved-datasource queries, and cleared image renders
  **Package:** `tableau.ingress.fence_datasource_scope`

  ## What it does

  Tableau's MCP server is a warehouse proxy: `query-datasource` runs a VizQL
  Data Service (VDS) query and returns **raw row-level data** — PII, PHI,
  payroll, financials — from whatever the published datasource connects to, and
  the image-render tools return the same data drawn as pixels. This policy
  fences two of those surfaces at ingress, before the call reaches Tableau.

  It enforces two independent, group-scoped controls:

  1. **`query-datasource` — per-datasource allowlist.** The call is denied
     unless its `datasourceLuid` argument is a member of a per-tenant allowlist
     of approved datasource LUIDs (`approved_datasources`). `datasourceLuid` is
     the clean scope dimension the VDS schema exposes, so this confines the
     agent channel to datasources an operator has cleared (minimum-necessary /
     least-privilege). A missing, empty, or non-allowlisted `datasourceLuid`
     **fails closed** and is denied.

  2. **`get-view-image` / `get-custom-view-image` — analyst-only.** These tools
     return **PNG renders** of a view. Egress redaction cannot parse pixels, so
     masking is impossible and **deny is the only meaningful control**. The
     policy denies these two tools for any caller whose IdP groups do not
     include the analyst group (`data-analysts`, a placeholder). A missing
     subject, missing claims, or missing/malformed `groups` claim yields no
     memberships and **fails closed**.

  Every other Tableau tool — catalog/metadata reads (`list-datasources`,
  `get-datasource-metadata`, `get-view`, `list-workbooks`…), the CSV data reads
  (`get-view-data`, `get-custom-view-data`), Pulse, admin-insights, token, and
  mutation tools — and all non-Tableau tools pass through this policy untouched.
  Those surfaces are governed by companion policies (see Composition).

  ## Identity gating

  The image-render control reads the caller's IdP groups from
  `input.subject.claims.groups` through `object.get(...)` chains, so a missing
  subject, missing claims, or a missing/malformed `groups` claim resolves to an
  empty membership set: no matching group means no access to the image tools.
  The `groups` claim must be an array of strings; any other shape yields no
  memberships. Group names are compared case-insensitively.

  ## Compliance alignment

  This policy instantiates sensitive-scope fencing (family PF-23) on Tableau's
  data-query and image-render paths and supports alignment with:

  - **SOC 2 C1.1** — supports identification and protection of confidential
    information by confining agent queries to a governed set of datasources on
    the MCP path; **P4.1** — supports limiting personal-information use to
    identified purposes by keeping un-cleared datasources and un-redactable
    image renders off the agent path.
  - **HIPAA §164.502(b)/§164.514(d)** — supports the minimum-necessary /
    role-based-limit standard by scoping agent queries to approved datasources
    rather than every datasource the connected identity can reach;
    **§164.308(a)(4)** — supports information access management: which
    datasources the agent may query and who may pull image renders are operator
    decisions enforced at the gateway; **§164.522(a)** — the allowlist can
    encode agreed-to restrictions on specific datasources.
  - **GDPR Art. 9** — supports special-category protection by keeping
    datasources holding health, HR, or other Art. 9 data off the agent path
    until their LUID is allowlisted, and by denying image renders (which cannot
    be redacted) to non-analysts; **CPRA §1798.121** — supports the right to
    limit use of sensitive personal information by fencing SPI-bearing
    datasources to a minimal allowlist; **Art. 5(1)(b)** — supports purpose
    limitation by keying datasource and image-render access to the caller's
    approved scope.

  ## Why ingress

  Both violations are fully determined by the request alone — the tool name, the
  `datasourceLuid` argument, and the caller's claims — so enforcement happens
  before the call reaches Tableau and restricted rows or renders are never
  fetched into the model context. This matters most for image renders: once a
  PNG is returned there is no egress control that can clean it, so the leak must
  be prevented at ingress. For defense in depth, pair with the egress redaction
  companion for the CSV data-read surfaces this policy does not fence.

  ## Tool name matching

  The official Tableau server uses **kebab-case tool names with no vendor
  prefix** (`query-datasource`, `get-view-image`); the gateway prefixes them
  with the configured MCP server name joined by a hyphen (e.g.
  `tableau-query-datasource`), and that prefix is not standardized. The policy
  matches **case-insensitively by suffix** on the distinctive tails:

  - `query-datasource` — matches `query-datasource`, `tableau-query-datasource`,
    etc. This tail is distinctive; it does not collide with
    `get-datasource-metadata` or `list-datasources`.
  - `get-view-image` — the standard-view PNG render.
  - `get-custom-view-image` — the custom-view PNG render. (`get-custom-view-image`
    does **not** end in `get-view-image`, so both suffixes are matched
    explicitly.)

  Suffix matching keeps the policy portable across gateway prefixes. Verify the
  exact names your gateway sends with the dump-input debug technique before
  relying on this in production. **Tableau Next** (the Salesforce-hosted
  analytics product) uses disjoint snake_case names (`analyze_data`,
  `get_visualization`) and is **not** covered by this policy — author a separate
  policy for that server.

  ## Argument shape

  `query-datasource` carries the target datasource as a scalar string
  `datasourceLuid` (verified against the VDS query-tool schema). The policy
  reads it with `object.get(args, "datasourceLuid", "")` and compares it
  **verbatim** against `approved_datasources`. Tableau LUIDs are canonical
  lowercase UUIDs; store them in the allowlist exactly as Tableau emits them. A
  call that omits `datasourceLuid`, sends an empty value, or carries it under a
  different key resolves to `""`, which is not in the allowlist, and is denied
  (fail closed). The image-render tools take a `viewId`/`customViewId` (opaque
  LUID) plus optional filters; this policy does not inspect their arguments — it
  denies them wholesale for non-analysts.

  ## Examples

  ### Allowed — query against an approved datasource

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-query-datasource", "type": "tool" },
      "payload": {
        "name": "tableau-query-datasource",
        "args": { "datasourceLuid": "11111111-1111-1111-1111-111111111111" }  // on the allowlist
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — image render by a data analyst

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-get-view-image", "type": "tool" },
      "subject": { "sub": "auth0|amy", "claims": { "groups": ["data-analysts"] } },
      "payload": {
        "name": "tableau-get-view-image",
        "args": { "viewId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — query against a datasource that is not allowlisted

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-query-datasource", "type": "tool" },
      "payload": {
        "name": "tableau-query-datasource",
        "args": { "datasourceLuid": "99999999-9999-9999-9999-999999999999" }  // not on the allowlist
      }
    }
  }
  ```

  `allow = false`, `reason = "Tableau datasource 99999999-9999-9999-9999-999999999999 is not on the approved-datasource allowlist ..."`.

  ### Denied — image render by a non-analyst

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-get-custom-view-image", "type": "tool" },
      "subject": { "sub": "auth0|eng", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "tableau-get-custom-view-image",
        "args": { "customViewId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Tableau image renders (get-view-image / get-custom-view-image) return PNGs that cannot be redacted ..."`.

  ## Composition

  This policy fences the datasource-query and image-render surfaces. Useful
  companions:

  - An **egress PII/PHI/PAN redaction** policy on `query-datasource`,
    `get-view-data`, and `get-custom-view-data` responses — those return
    row-level data / CSV as text and *can* be redacted, unlike the PNG renders
    this policy denies outright. This is the mandatory backstop for the CSV
    data-read path, which this ingress fence does not cover.
  - A **`calculation`-field guard** on `query-datasource` for non-analyst
    groups: the VDS `calculation` field variant accepts an arbitrary Tableau
    calc expression that can reference any column in the (already-approved)
    datasource, so `fieldCaption`-level column fencing is bypassable — treat the
    presence of `calculation` as elevated.
  - A **token-management deny** (`get-embed-token`, `revoke-access-token`,
    `reset-consent`) and a **mutation gate** on the delete/update tools and
    their `confirm-` twins.
  - A **default-deny-unknown-tools** policy (PF-28): the hosted Tableau server
    ships new tools automatically, so the tool inventory drifts forward without
    any client change.

  ## Known limitations

  - **CSV data reads are not fenced here.** `get-view-data` and
    `get-custom-view-data` return the *same underlying data* as the image tools,
    but as CSV text. A non-analyst denied `get-view-image` can pull the same
    view's data through `get-view-data`. That is intentional: CSV *can* be
    egress-redacted, so it is governed by the egress redaction companion rather
    than an ingress deny. Attach that companion — this policy alone leaves the
    CSV path open.
  - **`calculation` escape hatch inside an approved datasource.** Once a
    datasource LUID is allowlisted, this policy does not restrict *which columns
    or rows* the query reads. The VDS `calculation` field can reference any
    column in that datasource, so column-level fencing is out of scope here.
    Pair with the `calculation`-field guard companion.
  - **Allowlist is literal LUIDs.** `datasourceLuid` is compared verbatim
    against `approved_datasources`; a datasource reached by any other LUID is
    denied (the intended default-deny), which also means the allowlist must
    contain each cleared datasource's exact canonical LUID. The shipped LUIDs
    are placeholders — replace them with your tenant's real datasource LUIDs at
    import time. A caller cannot gain access by re-casing an approved LUID: a
    case-altered value is a different string, is not in the set, and is denied.
  - **Off-schema `datasourceLuid` still fails closed, but its reason string is
    cosmetic.** The VDS schema types `datasourceLuid` as a scalar string. A call
    that sends it as a non-string (number, array, object) or under a different
    key is not on the allowlist and is **denied** — the security decision is
    correct. For a non-string scalar the denial *reason* interpolates the raw
    value with `%s`, which can render a formatting artifact (e.g.
    `%!s(int=123)`); the deny is unaffected. Send `datasourceLuid` as the
    canonical lowercase-UUID string.
  - **Image deny is all-or-nothing.** The image-render control is a pure
    group gate — an analyst may render *any* view (subject to Tableau's own
    permissions), and a non-analyst may render *none*. It does not scope image
    renders by datasource, because the render tools take an opaque `viewId`, not
    a `datasourceLuid`.
  - **Only the official kebab-case server is fenced; snake_case servers pass
    through.** Suffix matching is hyphen-specific (`query-datasource`,
    `get-view-image`), so any Tableau server that exposes the *same data
    surfaces under snake_case names is not matched and passes through
    un-fenced*. This covers the Salesforce-hosted **Tableau Next** product
    (`analyze_data`, `get_visualization`) *and* the community FastMCP servers
    the landscape note flags (e.g. `query_datasource`, `get_view_image`,
    `get_view_data` — tool names there are unverified). A non-allowlisted
    datasource query or a non-analyst image render issued against such a server
    would be allowed. This is by design — the policy is pinned to the official
    server's verified names and must not guess at unverified underscore names —
    but it means you must author a separate policy (and/or a PF-28
    default-deny-unknown gate) for any non-kebab Tableau server your gateway
    exposes. Confirm the exact `tools/list` names with the dump-input debug
    technique before trusting this fence.
  - **Suffix matching anchors on the *tail*, so a name with extra characters
    after the distinctive suffix is not matched.** The match is
    `endswith(name, "query-datasource")` / `endswith(name, "get-view-image")` /
    `endswith(name, "get-custom-view-image")`, which fires only when the
    distinctive tail is the *end* of the name. A drifted or versioned variant on
    the official server whose name carries a further suffix — e.g.
    `tableau-query-datasource-v2`, `…-query-datasource-async`, or
    `…-get-view-image-hd` — does **not** end in the anchored tail, so it is
    treated as an unfenced tool and passes through: a non-allowlisted datasource
    query or a non-analyst image render issued under such a name would be
    **allowed**. This is the flip side of anchoring on the tail rather than
    substring-matching (a `contains` match would false-positive on names like
    `get-query-datasource-metadata`), and it is why the policy must be paired
    with a **PF-28 default-deny-unknown-tools** gate: the hosted Tableau server
    ships new/renamed tools automatically, so re-verify `tools/list` with the
    dump-input debug technique whenever the server version changes and pin any
    new query/image variant names into this policy's suffix list.
  - **Identity placeholders.** The analyst group name (`data-analysts`) and
    every entry in `approved_datasources` are placeholders — replace them with
    your IdP's group name and your tenant's real datasource LUIDs at import
    time. The `groups` claim must be an array of strings; any other shape fails
    closed.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - tableau
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package tableau.ingress.fence_datasource_scope

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# ---------------------------------------------------------------------------
# CONFIG — PLACEHOLDERS, replace at import time.
#
# Approved datasource LUIDs the agent channel may query via `query-datasource`.
# Tableau LUIDs are canonical lowercase UUIDs; compare verbatim (not lowered).
# Pin the exact LUIDs an operator has cleared for the agent.
approved_datasources := {
    "11111111-1111-1111-1111-111111111111", # e.g. the governed sales-metrics datasource
    "22222222-2222-2222-2222-222222222222", # e.g. the governed ops datasource
}

# IdP group cleared to pull image renders (PNGs that cannot be redacted).
# PLACEHOLDER — remap to your IdP's group name at import time. Compared
# case-insensitively.
image_render_group := "data-analysts"

# ---------------------------------------------------------------------------
# Tool matching. Official server uses kebab-case, no vendor prefix; the gateway
# prefixes with the configured server name joined by a hyphen. Match
# case-insensitively by distinctive suffix so any prefix is covered. Verify
# exact names with the dump-input debug technique. Tableau Next (snake_case) is
# NOT matched by design.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# The VDS row-level query surface. `query-datasource` is distinctive and does
# not collide with `get-datasource-metadata` / `list-datasources`.
is_query_datasource_tool if endswith(tool_name, "query-datasource")

# The two PNG image-render surfaces. `get-custom-view-image` does not end in
# `get-view-image`, so both tails are matched explicitly.
is_image_render_tool if endswith(tool_name, "get-view-image")

is_image_render_tool if endswith(tool_name, "get-custom-view-image")

# ---------------------------------------------------------------------------
# Identity — caller's IdP groups, read fail-closed: a missing subject, missing
# claims, or a missing/malformed groups claim yields no memberships, so the
# caller is never treated as cleared by accident.
caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

member_of(group) if {
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    lower(g) == group
}

# ---------------------------------------------------------------------------
# Arguments — object.get everywhere so a missing field fails closed.
args := object.get(object.get(input, "payload", {}), "args", {})

requested_luid := object.get(args, "datasourceLuid", "")

# ---------------------------------------------------------------------------
# Allow rules.

# Any tool this policy does not fence passes through untouched (catalog reads,
# CSV data reads, Pulse, admin-insights, mutations, and all non-Tableau tools).
allow if {
    not is_query_datasource_tool
    not is_image_render_tool
}

# query-datasource: allowed only when the datasourceLuid is on the allowlist.
# A missing/empty LUID resolves to "" which is not in the set -> deny.
allow if {
    is_query_datasource_tool
    approved_datasources[requested_luid]
}

# Image renders: allowed only for callers in the analyst group.
allow if {
    is_image_render_tool
    member_of(image_render_group)
}

# ---------------------------------------------------------------------------
# Deny reasons.

# query-datasource naming a datasource that is not on the allowlist.
reasons contains msg if {
    is_query_datasource_tool
    requested_luid != ""
    not approved_datasources[requested_luid]
    msg := sprintf("Tableau datasource %s is not on the approved-datasource allowlist, so the agent may not query it. Query an approved datasource, or request datasource onboarding through your data-governance owner if you believe this one should be cleared.", [requested_luid])
}

# query-datasource with no datasourceLuid at all — fail closed.
reasons contains msg if {
    is_query_datasource_tool
    requested_luid == ""
    msg := "This Tableau query supplied no datasourceLuid, so it cannot be matched against the approved-datasource allowlist. Re-issue the call naming an approved datasource, and request datasource onboarding through your data-governance owner if the one you need is not yet approved."
}

# Image render by a caller outside the analyst group.
reasons contains msg if {
    is_image_render_tool
    not member_of(image_render_group)
    msg := "Tableau image renders (get-view-image / get-custom-view-image) return PNGs that cannot be redacted, so they are restricted to the data-analyst group. Use a CSV data read (get-view-data) or contact your data-governance owner if your role requires image exports."
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
