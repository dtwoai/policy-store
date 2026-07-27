---
name: Glean Default-Deny Unknown Tools
tags:
  - glean
  - default-deny-unknown-tools
  - allowlist
  - access-control
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # glean / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny unknown Glean tools, allow allowlisted built-in Glean tools and all other servers
  **Package:** `glean.ingress.default_deny_unknown_tools`

  ## What it does

  Pins a per-tenant allowlist of the **verified built-in read tools** on the
  Glean managed remote MCP server and denies **every other tool suffix** on the
  Glean server by default. Matching is anchored to the configured Glean
  server prefix so Glean's generic tool names (`search`, `chat`) are never
  confused with a same-named tool on a different server. Tools on other MCP
  servers behind the same gateway pass through unchanged.

  This closes Glean's two **self-expanding** surfaces:

  - **Org-built agents-as-tools** — Glean agents surface as extra tools with
    arbitrary, org-specific snake_case names (e.g. `qbr_summarizer`) that appear
    without warning.
  - **MCP-Gateway-proxied tools** — Glean's own MCP Gateway proxies third-party
    MCP servers (Asana, GitHub, Linear, Notion, Atlassian Rovo, HubSpot, ...)
    and data-source **write** actions (Jira/Salesforce/GitHub writes). Their
    tool names are **admin-mutable and undocumented**.

  Because the tool inventory can grow without warning, a tool that was newly
  added, proxied in, or renamed after your review is **denied by default until
  it is reviewed and explicitly added** to the allowlist — never silently
  reachable.

  ## Why a reviewed per-tenant allowlist (pin at import time)

  Unlike apps with a fixed vendor tool set, Glean is an aggregation layer whose
  surface is composed by admins from a tool menu (Glean recommends ≤40 tools per
  server) and extended at runtime by agents-as-tools and gateway-proxied
  connectors. The built-in **read** tools have canonical, upstream-verified
  snake_case names, so this policy **ships those names pre-populated**. But the
  live inventory on any given tenant is whatever the admin configured plus
  whatever agents/proxies were added — which the landscape note documents as
  having **no stable naming pattern**.

  So two constants must be reviewed and pinned at import time:

  - `glean_server_names` — the MCP server name(s) your gateway admin gave the
    Glean server(s); the gateway prefixes every tool with this name
    (`<server-name>-<tool-name>`). The shipped values are **illustrative
    starter examples** — replace them with your deployment's real names.
  - `allowed_tool_suffixes` — the exact tool-name suffixes you reviewed. The
    shipped list is the set of **verified built-in read tools plus the memory
    surface**. After you inventory the actual configured server, remove any
    built-in your admin did not enable and add any additional built-in you
    reviewed. Do **not** add agents-as-tools or proxied write tools here without
    a deliberate review — that is exactly the drift this policy exists to catch.

  This policy's default-deny applies **only within the scope of a pinned server
  name**. Deny-by-default is *scoped*, not global: a tool is subjected to the
  allowlist only if its name carries one of the pinned prefixes. If none of the
  pinned names match the prefix your gateway actually sends, the Glean server is
  treated as an unrecognized "other server" and **its entire surface — verified
  read tools, agents-as-tools, and proxied writes alike — passes through the
  out-of-scope branch ALLOWED (fail open)**. Pinning the correct server name is
  therefore not optional hardening; it is what makes this gate exist at all.
  Confirm the exact prefix the gateway sends with the dump-input debug technique
  **before** relying on this policy — see the "Server-name pinning is load-bearing"
  entry under Known limitations.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    Glean can reach everything the user has indexed (Drive, mail, HR, finance,
    Gong, source code), so the agent channel is confined to the tool names that
    were explicitly reviewed and pinned.
  - **SOC 2 CC6.6** — supports boundary protection against external threats: an
    agent-as-tool or a gateway-proxied third-party/write tool added upstream
    cannot extend the agent channel's reach past the reviewed inventory.
  - **SOC 2 CC6.8** — supports preventing unauthorized/unreviewed software on
    the agent channel: a newly proxied or agent-generated tool is new executable
    capability, denied by default until reviewed (partial — MCP path only).
  - **SOC 2 CC7.2 / CC7.3** — deny events on unknown names surface tool-set
    drift as reviewable alerts in the gateway's audit pipeline (partial —
    alerting/monitoring itself is a platform property, not this policy).
  - **HIPAA §164.308(a)(4) / §164.312(a)(1)** — supports information access
    management and technical access control on a PHI-capable aggregation layer:
    Glean can reach PHI-bearing indexed sources (mail, HR, support tickets,
    clinical documents in Drive/Confluence), so confining the agent channel to
    the reviewed built-in tool inventory limits which access paths exist over
    MCP and denies unreviewed self-expanding surfaces by default.
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default posture for any new Glean data-access path is
    deny, and access requires a deliberate allowlist change after review.

  ## Tool name matching

  Matching is case-insensitive (`lower(input.resource.name)`).

  **Scoping** ("is this the Glean server?") is decided on a whitespace-trimmed
  view of the name: a name is in scope when — after trimming leading/trailing
  whitespace — it starts with a pinned Glean server name followed by `-` (the
  gateway's `<server-name>-<tool-name>` convention), or equals a pinned server
  name outright. The trim is deliberate: without it, a padded name like
  `" glean-mcp-search"` would fail the prefix test, be mistaken for a different
  server, and pass through the out-of-scope allow branch — a fail-open bypass.

  **Allowlisting** is a suffix match anchored to the prefix: for an in-scope
  name, the policy strips a pinned server prefix off the **untrimmed** lower-cased
  name and requires the remaining tool suffix to **exactly equal** an entry in
  `allowed_tool_suffixes`. Anchoring on the prefix and requiring an exact suffix
  is what closes two bypasses at once:

  - a **different server's** generic tool (a GitHub server's `search`) is out of
    scope and governed by its own policy, not accidentally allowed here;
  - a **look-alike Glean tool** whose name merely ends in an allowlisted token
    (`evil_search`, which ends in `search`) is **not** an exact suffix match, so
    it is denied.

  Because scoping trims but the allowlist match runs on the untrimmed name, a
  whitespace-padded variant (leading or trailing) lands **in scope but is never
  an exact suffix match, so it is denied** (fail closed). Everything in scope
  that does not match exactly — agents-as-tools, proxied writes, renamed or
  new built-ins, near-misses — is denied.

  The gateway's server-name prefix is deployment-specific; verify the exact
  names your gateway sends with the dump-input debug technique before relying on
  this in production, and pin **every** Glean server name if the gateway fronts
  more than one Glean server path.

  ## Argument shape

  None. The decision is made entirely from the tool name — the point of this
  gate is that an unknown tool's semantics cannot be inspected from its
  arguments. A scoped unknown tool is denied even when its arguments or the whole
  payload are missing. If `input.resource.name` is missing entirely, empty,
  **whitespace-only** (e.g. `" "`, a tab, a newline), or a non-string (JSON
  `null`, a number, an object), the request **fails closed** (denied): a
  nameless call cannot be matched against the reviewed allowlist. The
  whitespace-only case matters specifically because a trimmed-empty name is not
  a Glean tool and must not be waved through the out-of-scope pass-through
  branch.

  ## Examples

  ### Allowed

  ```jsonc
  // A verified built-in read tool on the pinned Glean server.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-mcp-search", "type": "tool" },
      "payload": {
        "name": "glean-mcp-search",
        "args": { "query": "q3 roadmap", "app": "confluence" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  // An org-built agent-as-tool that appeared after the review — unknown suffix.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-mcp-qbr_summarizer", "type": "tool" },
      "payload": {
        "name": "glean-mcp-qbr_summarizer",
        "args": { "quarter": "Q3" }
      }
    }
  }
  ```

  `allow = false`, `reason = "The Glean tool 'glean-mcp-qbr_summarizer' is not on the reviewed allowlist (...)"`.

  ## Composition

  This policy is the ingress gate the rest of the Glean set assumes: companion
  policies (a memory-write guard on `memory`/`read_memory`, a transcript guard on
  `meeting_lookup`, a datasource fence and bulk-export cap on `search`, an
  external-URL guard on `read_document`, and an egress PII-redaction backstop)
  only ever see a request that already passed this gate, so their per-tool logic
  can assume the tool inventory is the one that was reviewed. Keep those attached
  alongside this policy — allowlisting the memory surface here does **not**
  permit memory writes; the action-level guard does that.

  ## Known limitations

  - **Server-name pinning is load-bearing — a wrong/unpinned prefix fails OPEN.**
    Scoping is decided entirely by the pinned `glean_server_names` prefixes.
    Because the policy cannot tell a *mis-prefixed Glean tool* from a legitimate
    *different server's* tool by name alone, any name that does **not** carry a
    pinned prefix is treated as another server and passes through the
    out-of-scope branch **allowed**. Two configurations therefore silently defeat
    the whole gate: (1) the gateway prefixes Glean tools with a name you have not
    pinned (e.g. the shipped defaults `glean-mcp`/`glean` left in place while your
    gateway actually sends `acme-glean-…`), and (2) the gateway sends **bare,
    unprefixed** tool names (`search`, `qbr_summarizer`, `create_jira_issue`). In
    both cases every Glean tool — including agents-as-tools and proxied writes —
    is allowed, not denied. This is the inverse of the fail-closed guarantee that
    holds *inside* the pinned scope, and it cannot be closed in Rego without also
    blocking every genuinely-different server behind the gateway. Confirm the
    exact prefix your gateway emits with the dump-input debug technique before
    relying on this policy, pin **every** Glean server name, and treat a
    pass-through allow on a Glean tool as a misconfiguration signal.
  - **Proxied-tool naming is undocumented.** The landscape note records that the
    naming pattern for Glean-MCP-Gateway-proxied third-party and data-source
    write tools is **not documented** and is org-specific. The reviewed
    allowlist is therefore the **only reliable defense** against inventory
    drift — there is no name shape to match proxied writes by. Re-inventory the
    configured server whenever the Glean MCP server composition, its agents, or
    its gateway connectors change.
  - **The allowlist is only as good as the review.** This policy pins *names*,
    not semantics. If an admin re-points an allowlisted built-in name at
    different behavior, or an agent is given the exact name of a retired
    built-in, the gate cannot see the change. Re-review on any config change.
  - **Legacy local-server names differ.** The archived `gleanwork/mcp-server`
    (stdio, deprecated June 2026) exposed different names for the same functions
    (`company_search`, `people_profile_search`). This allowlist ships the
    **remote managed-server** names only. If a tenant still runs the archived
    package, add those legacy aliases after reviewing them.
  - **Naming divergence within the official surface.** Glean's admin docs list
    the memory tool as `memory`; Glean's own client guide surfaces it as
    `read_memory`. Both suffixes are on the allowlist so either wire name is
    accepted; the action-level memory-write guard is what restricts what the
    tool may do.
  - **Embedded server-name mimicry.** Matching strips the pinned prefix and
    compares the exact remaining suffix, so a scoped name whose *tool portion*
    embeds the server name again (e.g. `glean-mcp-x-glean-mcp-search`) yields the
    suffix `x-glean-mcp-search`, which is not on the allowlist and is denied.
    There is no known way for such a name to pass; it is called out only so
    reviewers know the exact-suffix comparison is intentional.
  - **A request with no usable tool name is denied (fail closed).** Unlike apps
    that pass nameless calls through, this policy denies a call whose
    `input.resource.name` is missing, empty, **whitespace-only** (`" "`, tab,
    newline), or a **non-string** (JSON `null`, number, object). The decision is
    made on a whitespace-trimmed view, and a non-string name is coerced to `""`,
    so all of these land on the same fail-closed deny with the missing-name
    reason — none of them slip through the out-of-scope pass-through branch. The
    gateway does not normally route a nameless tool call; if you see this
    denial, verify the gateway is populating `resource.name` with the dump-input
    technique rather than relaxing the policy.
  - **No identity-based exemptions — intentionally.** Exempting a group from the
    anchor gate would bypass every downstream Glean policy at once. For
    unreviewed tooling needs, use the Glean web UI or a native client outside the
    agent channel, where the user's own permissions and audit trail apply.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - glean
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package glean.ingress.default_deny_unknown_tools

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Per-tenant pinned constants (EDIT AT IMPORT TIME) ---
# The gateway prefixes every tool with the MCP server name it was configured
# under (`<server-name>-<tool-name>`). Pin the name(s) your admin gave the Glean
# server(s) here — every name starting with one of these prefixes is treated as
# a Glean tool and subjected to the allowlist. These are ILLUSTRATIVE STARTER
# EXAMPLES; replace them with your deployment's real names. Lower-case only.
glean_server_names := [
    "glean-mcp",
    "glean",
]

# The exact built-in tool-name suffixes you reviewed for this deployment. Glean's
# built-in READ tools have canonical upstream-verified snake_case names, shipped
# here pre-populated, plus the memory surface (allowed at the tool level here;
# memory WRITES are governed by the companion action-level guard). Matching is
# an EXACT suffix match after the pinned server prefix is stripped — anchoring on
# the prefix keeps Glean's generic names (`search`, `chat`) from colliding with a
# same-named tool on another server, and the exact match denies look-alikes such
# as `evil_search`. Agents-as-tools and gateway-proxied write tools are
# deliberately NOT listed: they are the drift this policy exists to deny. After
# inventorying the configured server, prune built-ins your admin did not enable
# and add any additional reviewed tool. Lower-case only.
allowed_tool_suffixes := [
    "search",
    "chat",
    "read_document",
    "code_search",
    "employee_search",
    "gmail_search",
    "outlook_search",
    "meeting_lookup",
    "user_activity",
    "memory_schema",
    "knowledge_graph_query",
    "knowledge_graph_schema",
    "memory",
    "read_memory",
]

# The raw name field, defaulting to "" when resource or name is absent.
raw_name := object.get(object.get(input, "resource", {}), "name", "")

# Case-insensitive; always defined. A missing name yields "". A NON-STRING name
# (JSON null, number, object) is coerced to "" so the request fails closed WITH
# the missing-name reason, rather than leaving `normalized_name` undefined —
# which would still deny (default false) but emit no reason, hiding the event
# from the drift-alert audit pipeline.
normalized_name := lower(raw_name) if is_string(raw_name)

normalized_name := "" if not is_string(raw_name)

# Scoping ("is this the Glean server?") is decided on a whitespace-trimmed view
# of the name so that leading/trailing padding cannot push a Glean tool OUT of
# scope into the pass-through allow branch (a fail-open bypass). Trimming here
# keeps padded names in scope; the exact suffix match below runs on the untrimmed
# `normalized_name`, so a padded name is in scope but never an exact match =>
# denied (fail closed). trim_space trims Unicode whitespace on both ends.
scoping_name := trim_space(normalized_name)

# A tool is in scope when it carries a pinned Glean server-name prefix followed
# by the gateway's `-` separator...
is_glean_tool if {
    some server in glean_server_names
    startswith(scoping_name, concat("", [server, "-"]))
}

# ...or is exactly a pinned server name (degenerate prefix-only name: still
# Glean-scoped, never on the allowlist, so it is denied).
is_glean_tool if {
    some server in glean_server_names
    scoping_name == server
}

# Allowlist = exact suffix match anchored to the prefix: strip a pinned server
# prefix off the UNTRIMMED lower-cased name and require the remainder to equal a
# reviewed built-in suffix exactly. Runs on `normalized_name` so whitespace
# variants fail (fail closed).
is_allowed_glean_tool if {
    some server in glean_server_names
    prefix := concat("", [server, "-"])
    startswith(normalized_name, prefix)
    suffix := substring(normalized_name, count(prefix), -1)
    some tool in allowed_tool_suffixes
    suffix == tool
}

# Tools on other MCP servers are out of scope — pass through unchanged. Gated on
# the TRIMMED `scoping_name` being non-empty so that a missing, empty, OR
# whitespace-only `resource.name` does NOT fall through here: such a call trims
# to "" and is denied by default (fail closed). Using the untrimmed
# `normalized_name` here would let a whitespace-only name (" ", "\t", "\n") —
# non-empty yet not a Glean tool — slip through this branch and be ALLOWED,
# defeating the fail-closed guarantee.
allow if {
    scoping_name != ""
    not is_glean_tool
}

# Glean tools are allowed only on an exact reviewed-suffix match.
allow if {
    is_glean_tool
    is_allowed_glean_tool
}

# Scoped Glean tool that is not on the reviewed allowlist — denied with the
# drift-alert reason.
reasons contains msg if {
    is_glean_tool
    not is_allowed_glean_tool
    msg := sprintf("The Glean tool '%s' is not on the reviewed allowlist of verified built-in Glean tools, so it is denied by default. Glean's tool inventory is admin-mutable and self-expanding: org-built agents-as-tools and MCP-Gateway-proxied third-party and write tools appear under arbitrary, undocumented names. If this tool is legitimate, ask your gateway operator to inventory the configured Glean server, review this tool, and add its exact name suffix to the allowlist in this policy after review.", [normalized_name])
}

# Missing, empty, whitespace-only, or non-string tool name — cannot be verified,
# denied (fail closed). Keyed on the TRIMMED name so a whitespace-only name is
# treated as nameless too (a non-string name is coerced to "" upstream).
reasons contains "This request carries no tool name, so it cannot be matched against the reviewed Glean allowlist and is denied by default (fail closed). Verify the gateway is populating input.resource.name with the dump-input debug technique; if tool names are missing systemically, fix the gateway configuration rather than relaxing this policy." if {
    scoping_name == ""
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
