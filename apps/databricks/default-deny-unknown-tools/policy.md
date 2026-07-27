---
name: Databricks Default-Deny Unknown Tools
tags:
  - databricks
  - default-deny-unknown-tools
  - allowlist
  - access-control
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # databricks / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny unknown Databricks tools, allow allowlisted Databricks tools and all other servers
  **Package:** `databricks.ingress.default_deny_unknown_tools`

  ## What it does

  Pins an **allowlist of the exact Databricks tool names your team audited** and
  denies every other tool name on the Databricks MCP server(s). A Unity Catalog
  function that was newly registered upstream, an AI Search index that was
  renamed, or a tool added to the workspace after your audit is
  **denied-and-alerted instead of silently reachable**. Tools on other MCP
  servers behind the same gateway pass through unchanged.

  It also **fences the Databricks `system.ai` prebuilt MCP-Services proxies**
  (Slack, GitHub, Google Drive) unconditionally — even if their names were
  mistakenly added to the allowlist. Routing those SaaS apps *through* Databricks
  would let the lakehouse act as a second-order gateway around the per-app DTwo
  policies that govern Slack, GitHub, and Google Drive directly.

  This is the **anchor policy for the whole Databricks set**: the companion SQL
  guard, bulk-export guard, and egress-redaction policies only ever see a request
  that already passed this gate, so their per-tool logic can assume the tool
  inventory is the one that was reviewed.

  ## Why a per-tenant allowlist (pin at import time)

  Databricks managed MCP servers mix **fixed, canonical verbs** with
  **dynamically-named, customer-specific tools**:

  - **Fixed verbs** (verified in Databricks docs) — Genie One exposes `genie_ask`
    and `genie_poll_response`; the SQL server exposes `execute_sql`,
    `execute_sql_read_only`, and `poll_sql_result`. These are stable across
    deployments, so the shipped allowlist seeds them for you.
  - **AI Search index tools** — one tool per vector-search index, named
    `{CATALOG}__{SCHEMA}__{INDEX}` (double underscore). These names are
    **customer-specific** and cannot be shipped as defaults.
  - **UC Function tools** — one tool per registered Unity Catalog function, named
    after the function. A function body can hide **arbitrary writes and side
    effects**, so an unaudited function reaching the lakehouse is exactly the
    drift this policy exists to stop. Also customer-specific.

  Because the dynamic double-underscore names are per-workspace, you **must pin
  them at import time**. Enumerate the current inventory from the workspace, then
  add each audited name to `allowed_dynamic_tools`:

  - **AI Search indexes:** list your vector-search indexes (Databricks CLI
    `databricks vector-search-indexes list`, or the AI Search managed-server URL
    `/api/2.0/mcp/ai-search/{cat}/{schema}/{index}`). The tool name is the
    `{cat}__{schema}__{index}` triple with double underscores.
  - **UC functions:** `SHOW FUNCTIONS IN {catalog}.{schema};` in a SQL editor, or
    the UC Functions managed-server URL
    `/api/2.0/mcp/functions/{cat}/{schema}/{fn}`. The tool name is the function
    name as registered.

  The shipped dynamic entries are **illustrative placeholders**, not real names.
  Until you replace them with your deployment's audited names, legitimate dynamic
  tools will be denied — the fail-closed direction — and nothing unaudited is
  allowed.

  You must also pin `databricks_server_names` to the MCP server name(s) your
  gateway admin gave the Databricks managed server(s). Because the managed
  offering is **one workspace URL per capability** (Genie / SQL / AI Search / UC
  Functions), a gateway commonly fronts several — pin **every** server name it
  exposes.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets: a
    lakehouse full of regulated data is reachable only through the tool names
    that were explicitly audited and pinned.
  - **SOC 2 CC6.6** — supports boundary protection against external threats: an
    upstream party adding or renaming a tool cannot extend the agent channel's
    reach past the reviewed inventory, and the `system.ai` proxy fence stops
    Databricks from becoming a second-order boundary around the per-app policies
    for Slack, GitHub, and Google Drive.
  - **SOC 2 CC6.8** — supports preventing unauthorized/unreviewed software on the
    agent channel: a new UC-function or search-index tool is new executable
    capability, denied by default until reviewed (partial — covers the MCP path
    only).
  - **SOC 2 CC7.2 / CC7.3** — deny events on unknown names surface tool-set drift
    as reviewable alerts in the gateway's audit pipeline (partial — the
    alerting/monitoring itself is a platform property, not this policy).
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default posture for any new data-access path is deny, and
    access requires a deliberate allowlist change.

  ## Tool name matching

  Matching is case-insensitive (`lower(input.resource.name)`). The **allowlist
  match is strictly exact** — no `endswith`, no trimming: an in-scope name is
  allowed only when it equals `<server-name>-<tool-name>` for some pinned server
  name and some entry in `allowed_fixed_tools` or `allowed_dynamic_tools`. Exact
  matching is deliberate: a suffix match on a canonical verb like `execute_sql`
  would also admit a renamed UC function crafted to end in `_execute_sql`, which
  would defeat the whole default-deny posture.

  **Scoping** ("is this the Databricks server?") is decided on a normalized view
  of the name with **invisible characters stripped and whitespace trimmed**. A
  name is in scope when — after removing zero-width / BOM / bidi-control
  characters and trimming leading/trailing whitespace — it starts with a pinned
  server name followed by `-` (the gateway's `<server-name>-<tool-name>`
  convention), or equals a pinned server name outright. The normalization is
  deliberate: without it, a padded name like `" databricks-sql-execute_sql"`
  (leading space/tab/newline) — or one prefixed with an invisible zero-width space
  (U+200B) or BOM (U+FEFF) — would fail the prefix test, be mistaken for a
  different server, and pass through the out-of-scope allow branch — a fail-open
  bypass. Because scoping normalizes but the allowlist match does not, a padded or
  obfuscated name lands **in scope but is never an exact allowlist match, so it is
  denied** (fail closed). The invisible-character set covers the well-known
  smuggling classes — soft-hyphen, the zero-width block (U+200B–U+200F), legacy
  bidi embed/override (U+202A–U+202E) **and their modern isolate replacements
  (U+2066–U+2069)**, the Arabic Letter Mark (U+061C), word-joiner / invisible-math
  (U+2060–U+2064), variation selectors (U+FE00–U+FE0F), the BOM, and the **Unicode
  Tags block (U+E0000–U+E007F)** — best-effort, not an exhaustive enumeration of
  every invisible Unicode codepoint.

  Everything in scope that does not match exactly is denied — including
  near-misses like `genie_ask_v2` and whitespace-padded variants — which are
  treated as unknown tools. The `system.ai` proxy fence overrides the allowlist:
  a name matching a `system_ai_proxy_markers` substring is denied even if it was
  added to the allowlist.

  The gateway's server-name prefix is deployment-specific; verify the exact names
  your gateway sends with the dump-input debug technique before relying on this
  in production.

  ## Argument shape

  None. The decision is made entirely from the tool name — the point of this gate
  is that an unknown name's semantics cannot be inspected from its arguments (a UC
  function's body is opaque on the wire). A matched unknown tool is denied even
  when its arguments or the whole payload are missing.

  ## Examples

  ### Allowed

  ```jsonc
  // A verified fixed verb on the managed SQL server.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-sql-execute_sql_read_only", "type": "tool" },
      "payload": {
        "name": "databricks-sql-execute_sql_read_only",
        "args": { "statement": "SELECT id FROM sales.orders LIMIT 100" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ```jsonc
  // An audited AI Search index tool pinned into allowed_dynamic_tools.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-ai-search-support__tickets__kb_index", "type": "tool" },
      "payload": {
        "name": "databricks-ai-search-support__tickets__kb_index",
        "args": { "query": "reset password", "num_results": 5 }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  // A UC function registered after the audit — name not on the pinned allowlist.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-functions-payments__ops__wire_transfer", "type": "tool" },
      "payload": {
        "name": "databricks-functions-payments__ops__wire_transfer",
        "args": { "amount": 5000 }
      }
    }
  }
  ```

  `allow = false`, `reason = "The Databricks tool 'databricks-functions-payments__ops__wire_transfer' is not on the pinned allowlist ..."`.

  ```jsonc
  // A system.ai prebuilt Slack proxy — fenced off unconditionally.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-functions-system__ai__slack_send_message", "type": "tool" },
      "payload": { "name": "databricks-functions-system__ai__slack_send_message", "args": {} }
    }
  }
  ```

  `allow = false`, `reason = "The Databricks tool 'databricks-functions-system__ai__slack_send_message' is a Databricks system.ai prebuilt MCP-Services proxy ..."`.

  ## Composition

  This policy is the ingress gate the rest of the Databricks set assumes.
  Companions in this catalog:

  - A destructive-SQL guard on the allowlisted `execute_sql` / `execute_sql_read_only`
    tools (PF-07 `guard-warehouse-sql` style) — this gate lets `execute_sql`
    through as a *known* verb; its write danger (`INSERT`/`UPDATE`/`DELETE`/`DROP`/
    `GRANT`) is governed downstream.
  - An egress PII/PAN redaction backstop on `poll_sql_result`, `genie_poll_response`,
    and AI Search index responses (the data egresses in the poll/search response,
    not the submit call).

  ## Known limitations

  - **The allowlist pins names, not semantics.** If an admin re-points an
    allowlisted name at a different UC function, or a function body is edited to
    add a write, the gate cannot see the change. Re-audit and re-enumerate
    whenever the workspace's function/index inventory changes.
  - **`system.ai` proxy names are unverified.** The landscape note confirms
    Databricks ships prebuilt `system.ai` MCP-Services proxies for Slack, GitHub,
    and Google Drive, but their exact tool names were not published. The fence
    matches the `system.ai` / `system__ai__` catalog-schema markers
    conservatively; verify the actual names your workspace exposes with the
    dump-input technique and extend `system_ai_proxy_markers` if they differ.
  - **The `execute_sql` name collides across servers.** Two community Databricks
    MCP servers also expose an `execute_sql`-shaped tool with different auth
    (PAT-scoped, no read-only guard). If you pin a community server name, its
    `execute_sql` is allowlisted the same as the managed verb — audit which
    server you are actually pinning, and rely on the companion SQL guard for the
    write semantics.
  - **Cross-product over-allowance with multiple servers.** Every allowlist entry
    is accepted under every pinned server name, so pinning several managed servers
    allows e.g. `databricks-sql-genie_ask` even though `genie_ask` only exists on
    the Genie server. Harmless when the name doesn't exist upstream, but split the
    policy per server if you need strict per-server inventories.
  - **Genie Space (single-space) tool name is unverified.** The GA Genie Space
    server exposes one invoke tool whose name Databricks has not published. If you
    use Genie Space, discover its name with dump-input and add it to
    `allowed_fixed_tools`.
  - **Scope-evasion via invisible characters is closed for the well-known set, not
    provably every codepoint.** Leading/embedded whitespace, soft-hyphen, the
    zero-width block, legacy bidi embed/override **and their modern isolate
    replacements (U+2066–U+2069)**, the Arabic Letter Mark (U+061C), word-joiner /
    invisible-math, variation selectors (U+FE00–U+FE0F), the BOM, and the **Unicode
    Tags block (U+E0000–U+E007F)** are stripped before scoping, so a name like
    `"​databricks-functions-…"` — or one prefixed with an invisible Tag character —
    still lands in scope and is denied (fail closed). This is best-effort: an exotic
    invisible/ignorable codepoint outside the stripped set (e.g. a Hangul filler
    such as U+3164, or a musical-notation combining mark) could still push a name
    out of scope into the pass-through allow branch. This is only reachable if the
    gateway itself normalizes that codepoint away when routing (otherwise the
    crafted name matches no real tool and is never routed). Verify with dump-input
    if your gateway performs aggressive name normalization.
  - **A request with no tool name at all — or a non-string tool name — is
    allowed.** A missing/`null` name normalizes to `""`, and a present but
    non-string name (number, array, object) makes `lower()` yield an undefined
    `normalized_name`; either way the request matches no pinned server prefix, so
    `not is_databricks_tool` holds and it falls through the out-of-scope
    pass-through branch (fail open, no reason). The gateway only ever routes a
    tool call with a string `resource.name` (MCP tool names are strings by
    protocol), so neither shape is a reachable bypass, but the policy asserts
    nothing over nameless or malformed-name input — it is scoped only to
    correctly-named Databricks tools.
  - **No identity-based exemptions — intentionally.** Exempting a group from the
    anchor gate would bypass every downstream Databricks policy at once. For
    unaudited tooling needs, use the Databricks workspace UI or a native client
    outside the agent channel, where the user's own Unity Catalog identity and
    audit trail apply.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - databricks
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package databricks.ingress.default_deny_unknown_tools

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Per-tenant pinned constants (EDIT AT IMPORT TIME) ---
# The gateway prefixes every tool with the MCP server name it was configured
# under (`<server-name>-<tool-name>`). Databricks managed MCP is one workspace
# URL per capability (Genie / SQL / AI Search / UC Functions), so a gateway
# commonly fronts several servers — pin EVERY name your admin gave them here.
# Lower-case only.
databricks_server_names := [
    "databricks-mcp",
    "databricks-genie",
    "databricks-sql",
    "databricks-ai-search",
    "databricks-functions",
]

# The fixed, canonical Databricks managed-server verbs, verified in Databricks
# docs. These are stable across deployments, so they are seeded for you.
# `execute_sql` is read+write — it is a KNOWN verb here (this gate only decides
# known/unknown); govern its write semantics with the companion SQL guard.
# Matching is EXACT against <server-name>-<entry>. Lower-case only.
allowed_fixed_tools := [
    "genie_ask",
    "genie_poll_response",
    "execute_sql",
    "execute_sql_read_only",
    "poll_sql_result",
]

# Dynamically-named, CUSTOMER-SPECIFIC tools you must enumerate from the
# workspace and pin at import time (see "Why a per-tenant allowlist"):
#   - AI Search index tools: {CATALOG}__{SCHEMA}__{INDEX} (double underscore)
#   - UC Function tools: one per registered function, named after the function
# These are ILLUSTRATIVE PLACEHOLDERS — replace them with your deployment's
# audited names. Matching is EXACT against <server-name>-<entry>. Lower-case.
allowed_dynamic_tools := [
    "support__tickets__kb_index",       # AI Search index (placeholder)
    "sales__crm__accounts_index",       # AI Search index (placeholder)
    "sales__analytics__forecast_revenue", # UC function (placeholder)
]

# system.ai prebuilt MCP-Services proxies (Slack / GitHub / Google Drive) are
# fenced off UNCONDITIONALLY — even if a name below were added to the allowlist.
# Routing those SaaS apps through Databricks would make the lakehouse a
# second-order gateway around the per-app DTwo policies. Names are UNVERIFIED;
# match the catalog.schema markers conservatively and extend if your workspace
# exposes different names (verify with dump-input). Lower-case substrings.
system_ai_proxy_markers := [
    "system.ai",
    "system__ai__",
]

# Case-insensitive; the allowlist match below is otherwise strictly exact (no
# suffix matching). Always defined — a missing name yields "".
normalized_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Invisible / zero-width / bidi-control characters that carry no visible glyph
# and are NOT caught by trim_space (which strips only Unicode WHITESPACE). A
# leading zero-width space (U+200B) or BOM (U+FEFF) would otherwise defeat the
# `startswith` scope test the same way leading whitespace does — pushing a
# Databricks tool into the pass-through allow branch (fail open). We strip these
# for SCOPING before trimming. Stripping only ever pulls names further INTO scope
# (the fail-closed direction); the exact allowlist match below still runs on the
# untrimmed `normalized_name`, so a padded/obfuscated name is in scope but never
# an exact allowlist match => denied. The set covers the well-known invisible /
# formatting classes attackers use to smuggle text: soft-hyphen (U+00AD),
# Mongolian vowel separator (U+180E), the zero-width block (U+200B–U+200F),
# legacy bidi embed/override (U+202A–U+202E) AND their modern isolate replacements
# (U+2066–U+2069) plus the Arabic Letter Mark (U+061C), the word-joiner / invisible-
# math block (U+2060–U+2064), variation selectors (U+FE00–U+FE0F), the BOM/ZWNBSP
# (U+FEFF), and the Unicode Tags block (U+E0000–U+E007F). It is best-effort, not an
# exhaustive enumeration of every invisible Unicode codepoint (e.g. Hangul fillers
# such as U+3164 are not stripped — see Known limitations).
invisible_chars := `[\x{00AD}\x{061C}\x{180E}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{2066}-\x{2069}\x{FE00}-\x{FE0F}\x{FEFF}\x{E0000}-\x{E007F}]`

# Scoping ("is this the Databricks server?") is decided on a view of the name that
# has invisible characters stripped and whitespace trimmed, so leading/trailing
# padding — visible or invisible — cannot push a Databricks tool OUT of scope into
# the pass-through allow branch. Without this, a name like
# " databricks-sql-execute_sql" (leading space/tab/newline) or
# "​databricks-sql-execute_sql" (leading zero-width space) would fail the
# `startswith` prefix test, be treated as a non-Databricks server, and be allowed
# — a fail-open bypass. Normalizing here keeps padded names in scope; the exact
# allowlist match below still runs on the untrimmed `normalized_name`, so a padded
# name is in scope but never an exact allowlist match => denied (fail closed).
scoping_name := trim_space(regex.replace(normalized_name, invisible_chars, ""))

# A tool is in scope when it carries a pinned Databricks server-name prefix
# followed by the gateway's `-` separator...
is_databricks_tool if {
    some server in databricks_server_names
    startswith(scoping_name, concat("", [server, "-"]))
}

# ...or is exactly a pinned server name (degenerate prefix-only name: still
# Databricks-scoped, and never allowlisted, so it is denied).
is_databricks_tool if {
    some server in databricks_server_names
    scoping_name == server
}

# The name exactly equals <server-name>-<audited-tool> for some pinned pair,
# across both the fixed-verb and dynamic allowlists.
is_allowed_databricks_tool if {
    some server in databricks_server_names
    some tool in allowed_fixed_tools
    normalized_name == concat("-", [server, tool])
}

is_allowed_databricks_tool if {
    some server in databricks_server_names
    some tool in allowed_dynamic_tools
    normalized_name == concat("-", [server, tool])
}

# The system.ai proxy fence: a Databricks-scoped tool whose name carries a
# system.ai proxy marker. This overrides the allowlist (see allow rule below).
is_system_ai_proxy if {
    is_databricks_tool
    some marker in system_ai_proxy_markers
    contains(normalized_name, marker)
}

# Tools on other MCP servers are out of scope — pass through unchanged.
allow if {
    not is_databricks_tool
}

# Databricks tools are allowed only on an exact allowlist match AND when they are
# not a fenced system.ai proxy.
allow if {
    is_databricks_tool
    is_allowed_databricks_tool
    not is_system_ai_proxy
}

# Unconditional fence reason for system.ai proxies (fires even if allowlisted).
reasons contains msg if {
    is_system_ai_proxy
    msg := sprintf("The Databricks tool '%s' is a Databricks system.ai prebuilt MCP-Services proxy (Slack, GitHub, or Google Drive) and is fenced off unconditionally. Routing those SaaS apps through Databricks would let the lakehouse act as a second-order gateway that bypasses the per-app DTwo policies governing Slack, GitHub, and Google Drive directly. Use the dedicated DTwo MCP server for that app instead. Adding the name to the allowlist does not lift this fence; remove the system.ai proxy from the Databricks MCP surface if you believe this is a false positive.", [normalized_name])
}

# Drift-alert reason for any other unknown in-scope tool (not a proxy).
reasons contains msg if {
    is_databricks_tool
    not is_allowed_databricks_tool
    not is_system_ai_proxy
    msg := sprintf("The Databricks tool '%s' is not on the pinned allowlist of audited tool names for this gateway, so it is denied by default. Databricks managed servers expose a fixed set of verbs (genie_ask, genie_poll_response, execute_sql, execute_sql_read_only, poll_sql_result) plus dynamically-named AI Search index tools ({catalog}__{schema}__{index}) and one tool per registered Unity Catalog function whose body can hide arbitrary writes, so an unknown name may be a newly published UC function or a renamed search index that has not been reviewed. If this tool is legitimate, enumerate the workspace's current tool inventory, audit it, and add its exact name to the pinned allowlist in this policy.", [normalized_name])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
