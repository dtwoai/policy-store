---
name: "Fence Glean Search by Datasource"
tags:
  - glean
  - fence-sensitive-scopes
  - access-control
  - datasource
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # glean / fence-datasource-scope

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny; explicit allows for non-fenced tools and cleared calls
  **Package:** `glean.ingress.fence_datasource_scope`

  ## What it does

  Glean's `search` tool fans out across every system the tenant has indexed
  (Drive, Confluence, Slack, Jira, Gmail/Outlook, GitHub, Salesforce, Gong,
  HR systems…). This policy restricts **which indexed datasource a `search`
  call may target** by inspecting the call's `app` argument — the datasource
  enum (`gong`, `salescloud`, `confluence`, `gdrive`, `slack`, `jira`,
  `github`, `gmail`, `o365sharepoint`, …).

  Calls targeting a **restricted datasource** are denied unless the caller's
  IdP groups include the group cleared for that source. The shipped
  (placeholder) mapping is:

  | Datasource (`app` value) | What it holds | Required IdP group |
  |---|---|---|
  | `gong` | Call recordings / conversation intelligence | `sales` |
  | `salescloud` | Salesforce CRM | `revops` |
  | `workday`, `bamboohr` (HR datasources) | HR / people records | `hr` |

  When the `app` argument is **absent**, the search fans out across every
  indexed system at once, so an unscoped query is treated like a query that
  can reach all restricted sources: it is allowed only for a caller cleared
  for **every** restricted datasource, and otherwise denied with a reason
  directing the caller to pass an explicit `app`.

  Every other tool — `chat`, `read_document`, `code_search`,
  `employee_search`, `gmail_search`, `meeting_lookup`, `memory`, and all
  non-Glean tools — passes through this policy untouched. Because `chat`
  accepts only free text with no filterable datasource field, this ingress
  fence covers `search` only and must be paired with the egress redaction
  policy to cover `chat` (see Composition).

  ## Identity gating

  Clearance is granted per datasource via IdP group membership read from
  `input.subject.claims.groups` through `object.get(...)` chains, so a missing
  subject, missing claims, or a missing/malformed `groups` claim **fails
  closed**: no matching group means no access to the restricted datasource.
  The `groups` claim must be an array of strings; any other shape yields no
  memberships. Group names are compared case-insensitively.

  ## Compliance alignment

  This policy instantiates sensitive-scope fencing (family PF-23) on Glean's
  cross-source search path and supports alignment with:

  - **SOC 2 C1.1, P4.1** — identifies and protects confidential information
    and limits personal-information use by fencing designated datasources
    (Gong call data, Salesforce CRM, HR systems) out of agent search unless
    the caller's role grants it.
  - **HIPAA §164.502(b)/§164.514(d), §164.308(a)(4)** — minimum-necessary and
    information-access-management: an agent cannot trawl HR datasources over
    MCP unless the caller's role clears it; **§164.522(a)** — supports
    agreed-to restrictions expressed as datasource-level fences.
  - **PCI DSS 7.2.6** — supports restricting programmatic (agent) query access
    to stored data that may include account data (e.g. the Salesforce CRM
    datasource) by IdP role.
  - **GDPR Art. 9; CPRA §1798.121** — keeps special-category / sensitive
    personal information held in HR and CRM datasources out of agent result
    sets; **Art. 5(1)(b)** — supports purpose limitation by keying datasource
    access to the caller's team.

  ## Why ingress

  The target datasource is fully determined by the request alone (tool name,
  the `app` argument, caller claims), so enforcement happens before the call
  reaches Glean and restricted content is never fetched into the model
  context. For defense in depth, pair with an egress redaction policy as a
  backstop for content reached by paths this policy does not cover (notably
  `chat`).

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `glean-search`), and the prefix is not standardized, so the policy matches
  case-insensitively. Glean's remote server names its search tool the bare
  word `search`, which collides with other servers' `search` tools and with
  Glean's own `code_search` / `employee_search` / `gmail_search` /
  `outlook_search`. To avoid mis-matching those, the policy matches **only**:

  - the exact tool name `search`, or
  - any name ending in `-search` (e.g. `glean-search`, `glean-mcp-search`).

  This deliberately excludes the `_search` sibling tools (they take no `app`
  argument and are governed by companion policies). It also means the policy
  should be attached to the **Glean gateway/pipeline only** — on a Glean-only
  pipeline the sole `-search`/`search` tool is Glean's. Verify the exact name
  your gateway emits with the dump-input debug technique before relying on
  this in production. The deprecated local server exposed search as
  `company_search` (a `_search` name, so **not** matched); add it only if a
  tenant still runs the archived package.

  ## Argument shape

  The datasource is read from `input.payload.args.app` (verified from Glean's
  `search` parameter list). The value is normalized with `lower`/`trim_space`
  and compared against the restricted set. Both shapes are handled
  defensively:

  - a single string (`"app": "gong"`), and
  - an array of strings (`"app": ["gdrive", "gong"]`) — a call is denied if
    **any** entry names a restricted datasource the caller is not cleared for.

  An empty, missing, or non-string `app` (and an array of only empty strings)
  is treated as an **unscoped** query and fails closed as described above.

  ## Configuration

  Edit the `restricted_sources` object at the top of the Rego. The datasource
  keys (`gong`, `salescloud`, `workday`, `bamboohr`) map to the required IdP
  group. `gong` and `salescloud` are Glean's documented enum values; the HR
  entries (`workday`, `bamboohr`) are **placeholders** — replace them with the
  exact `app` enum values your tenant's HR systems are indexed under, and
  remap the groups (`sales`, `revops`, `hr`) to your IdP's group names at
  import time.

  ## Examples

  ### Allowed (search scoped to a non-restricted datasource)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-search", "type": "tool" },
      "payload": {
        "name": "glean-search",
        "args": { "query": "deploy runbook", "app": "confluence" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed (restricted datasource, caller cleared)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-search", "type": "tool" },
      "subject": { "sub": "auth0|rep", "claims": { "groups": ["sales"] } },
      "payload": {
        "name": "glean-search",
        "args": { "query": "acme renewal", "app": "gong" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (restricted datasource, caller not cleared)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-search", "type": "tool" },
      "subject": { "sub": "auth0|eng", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "glean-search",
        "args": { "query": "pipeline", "app": "salescloud" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "This Glean search targets restricted datasource(s) (salescloud) …"`.

  ### Denied (unscoped search, caller not cleared for all restricted sources)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-search", "type": "tool" },
      "payload": {
        "name": "glean-search",
        "args": { "query": "compensation" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Glean search has no `app` datasource filter, …"`.

  ## Composition

  This policy covers the datasource-scoped `search` surface. Useful companions:

  - An **egress redaction** policy on `search` / `chat` / `read_document`
    responses so PII/CHD that is reached by paths this fence does not cover
    (notably free-text `chat`) is masked before it reaches the agent context.
  - A `meeting_lookup` transcript-extraction fence and a mailbox-search
    restriction for the other sensitive Glean read tools.
  - A default-deny-unknown-tools policy (PF-28) for Glean's admin-mutable tool
    inventory (agents-as-tools, gateway-proxied writes).

  ## Known limitations

  - **`chat` is not fenceable here.** `chat` takes only free text with no
    datasource argument, so it can reach any indexed system regardless of this
    policy. It is intentionally passed through and must be covered by the
    egress redaction backstop.
  - **Sibling read tools are out of scope by design.** `code_search`,
    `employee_search`, `gmail_search`, `outlook_search`, `meeting_lookup`,
    `read_document`, and `user_activity` reach sensitive data but do not take
    the `app` datasource argument, so this policy does not fence them (the
    tool-name match excludes `_search` names). Govern them with the companion
    policies listed above.
  - **`dynamic_search_result_filters` is a bypass residual.** Glean's `search`
    also accepts a structured result-filter argument that can re-scope results
    by datasource. A caller could in principle set a benign `app` (or none)
    and steer results toward a restricted source through that filter. Its
    per-tenant schema is not documented, so this policy does not parse it; rely
    on the egress redaction backstop and cap/strip that argument with a
    separate transform if your tenant exposes it.
  - **Denylist, not allowlist — an unrecognized `app` value is not fenced.**
    A scoped call is denied only when `app` names a *restricted* source the
    caller lacks; any other non-empty string (a real but non-restricted
    datasource, **or a value the enum does not define**) is treated as a
    benign scoped query and allowed. Glean's behavior on an unrecognized `app`
    value is **unverified**: if Glean validates the enum and errors, there is
    no exposure; but if it silently ignores the value and fans out across all
    sources, a non-privileged caller could pass a junk `app` (e.g. `app:
    "everything"`) to reach restricted datasources while still setting
    `app_present`, sidestepping the unscoped-search guard. The same gap covers
    **obfuscated look-alikes**: a homoglyph or otherwise-encoded value (e.g.
    `gong` spelled with a Greek omicron) is a distinct, unrecognized string
    that `lower`/`trim_space` do not fold to the restricted key, so it is
    treated as a benign scoped query — though Glean's own enum will not resolve
    it either, so this yields no exposure beyond the fan-out case above. Do not
    rely on this
    fence alone against that case: keep the egress redaction backstop, and if
    you can enumerate your tenant's datasource enum, convert
    `restricted_sources` handling to an allowlist (treat any `app` outside the
    known set as unscoped/fail-closed) at import time.
  - **Bulk-export flags are not capped here.** `exhaustive` and
    `num_results` (up to 500) enable bulk pulls; this policy fences *which*
    datasource, not *how much*. Pair with a transform policy that caps
    `num_results` and strips `exhaustive` if bulk export is a concern.
  - **HR datasource names are placeholders.** Only the configured `app` enum
    values (`workday`, `bamboohr` by default) are treated as HR; a restricted
    HR system indexed under a different `app` value is not caught until you add
    it to `restricted_sources`.
  - **Tool-name portability.** Bare `search` and any `-search` suffix match, so
    attach this to the Glean pipeline only — a non-Glean server whose tool is
    named `…-search` would otherwise be fenced too. Confirm the exact gateway
    tool name with the dump-input technique. The match also depends on the
    gateway joining the server prefix to the tool with a **hyphen**
    (`glean-search`, the DTwo convention). If a deployment instead joins with an
    underscore, the search tool is emitted as `glean_search`, which ends in
    `_search` and is deliberately excluded (that suffix is how the sibling
    `code_search`/`gmail_search`/`employee_search` tools are skipped) — so the
    fence would silently pass the search tool through. Broadening the match to
    `_search` is not an option (it would blanket-deny every no-`app` sibling
    search); verify your gateway emits a hyphen-joined name before relying on
    this fence.
  - **Identity placeholders.** Group names are placeholders — replace `sales`,
    `revops`, and `hr` with your IdP's group names at import time. The `groups`
    claim must be an array of strings; any other shape fails closed.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - glean
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package glean.ingress.fence_datasource_scope

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# -----------------------------------------------------------------------------
# CONFIG: restricted Glean datasource (`app` enum value) -> IdP group cleared
# to search it. `gong` and `salescloud` are Glean's documented enum values;
# the HR entries are PLACEHOLDERS — replace them with the exact `app` values
# your HR systems are indexed under, and remap the groups (sales, revops, hr)
# to your IdP's group names at import time. Keys must be lowercase.
# -----------------------------------------------------------------------------
restricted_sources := {
    "gong": "sales",
    "salescloud": "revops",
    "workday": "hr",
    "bamboohr": "hr",
}

# -----------------------------------------------------------------------------
# Tool matching. The gateway prefixes tool names with the configured MCP
# server name. Glean's search tool is the bare word `search`, which collides
# with other `search` tools and with Glean's own `code_search` /
# `employee_search` / `gmail_search` (all `_search`). We match ONLY the exact
# name `search` or a `-search` suffix so those `_search` siblings are excluded.
# Attach to the Glean pipeline only. Verify with the dump-input technique.
# -----------------------------------------------------------------------------

tool_name := lower(input.resource.name)

is_glean_search_tool if tool_name == "search"

is_glean_search_tool if endswith(tool_name, "-search")

# -----------------------------------------------------------------------------
# Identity — caller's IdP groups, read fail-closed: a missing subject, missing
# claims, or a missing/malformed groups claim yields no memberships, so the
# caller is never treated as cleared by accident.
# -----------------------------------------------------------------------------

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

# Required to run an UNSCOPED search (no `app`): it fans out across every
# indexed system, so the caller must be cleared for ALL restricted sources.
caller_in_all_restricted_groups if {
    every _, group in restricted_sources {
        member_of(group)
    }
}

# -----------------------------------------------------------------------------
# Arguments — the datasource(s) the search targets. Handles both a single
# string (`"app": "gong"`) and an array (`"app": ["gdrive", "gong"]`). Empty
# or non-string values contribute nothing, so a missing/blank `app` leaves
# requested_apps empty and is treated as an unscoped query (fail-closed).
# -----------------------------------------------------------------------------

req_args := object.get(object.get(input, "payload", {}), "args", {})

app_raw := object.get(req_args, "app", "")

requested_apps contains a if {
    is_string(app_raw)
    a := lower(trim_space(app_raw))
    a != ""
}

requested_apps contains a if {
    is_array(app_raw)
    some x in app_raw
    is_string(x)
    a := lower(trim_space(x))
    a != ""
}

app_present if count(requested_apps) > 0

# Restricted datasources the call targets that the caller is NOT cleared for.
denied_apps contains a if {
    some a in requested_apps
    group := object.get(restricted_sources, a, "")
    group != ""
    not member_of(group)
}

# -----------------------------------------------------------------------------
# Allow rules
# -----------------------------------------------------------------------------

# Any tool this policy does not fence passes through (chat, read_document,
# the *_search siblings, memory, all non-Glean tools).
allow if {
    not is_glean_search_tool
}

# Search scoped to an explicit datasource: allowed unless it names a restricted
# source the caller is not cleared for.
allow if {
    is_glean_search_tool
    app_present
    count(denied_apps) == 0
}

# Unscoped search (no `app`): fans out across every source, so only a caller
# cleared for ALL restricted datasources may run one.
allow if {
    is_glean_search_tool
    not app_present
    caller_in_all_restricted_groups
}

# -----------------------------------------------------------------------------
# Reasons
# -----------------------------------------------------------------------------

reasons contains msg if {
    is_glean_search_tool
    app_present
    count(denied_apps) > 0
    src_list := concat(", ", sort([a | some a in denied_apps]))
    msg := sprintf("This Glean search targets restricted datasource(s) (%s) your account is not cleared for. Search a datasource you have access to, or contact your InfoSec team if your role requires that source.", [src_list])
}

reasons contains "This Glean search has no `app` datasource filter, so it fans out across every indexed system, including restricted ones (Gong call recordings, Salesforce CRM, HR). Pass an explicit `app` naming the datasource you need, or contact your InfoSec team if you need broader search access." if {
    is_glean_search_tool
    not app_present
    not caller_in_all_restricted_groups
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
