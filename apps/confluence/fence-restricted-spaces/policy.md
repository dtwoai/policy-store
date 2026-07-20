---
name: "Fence Confluence Reads & Search to Non-Restricted Spaces"
tags:
  - confluence
  - atlassian
  - fence-sensitive-scopes
  - access-control
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # confluence / fence-restricted-spaces

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny; explicit allows for non-fenced tools and cleared calls
  **Package:** `confluence.ingress.fence_restricted_spaces`

  ## What it does

  Fences a configurable set of restricted Confluence spaces (placeholder keys:
  `HR`, `LEGAL`, `SEC`) out of the agent's read and search paths unless the
  caller's IdP groups include the matching team. It guards three read surfaces:

  - **CQL search** (`searchConfluenceUsingCql`, community `confluence_search`):
    denied when the free-form `cql` argument contains a `space = KEY` or
    `space in (...)` clause naming a restricted key the caller is not cleared
    for. A CQL query with **no positive space clause at all is also denied**
    for callers who are not cleared for every restricted space, because an
    unscoped query fans out across all spaces the connected user can reach —
    including the restricted ones — and pulls back whatever was pasted into
    wiki pages. This closes the primary confidential-data exfiltration channel
    on the agent path.
  - **Page listing** (`getPagesInConfluenceSpace`): denied when the target
    space identifier resolves to a restricted key the caller is not cleared
    for.
  - **Space lookup** (`getConfluenceSpaces`): denied when the call is
    explicitly scoped to restricted keys the caller is not cleared for.
    Unscoped space listings (metadata only) pass through.

  Every other tool — Confluence writes, page fetches by id, all Jira tools —
  passes through untouched. Compose with companion policies for those
  surfaces (see Composition).

  ## Identity gating

  Access is granted per space via IdP group membership read from
  `input.subject.claims.groups` using `object.get(...)` chains, so a missing
  subject, missing claims, or missing/malformed `groups` claim **fails
  closed**: no matching group means no access to the restricted space. The
  shipped mapping is:

  | Space key (placeholder) | Required IdP group (placeholder) |
  |---|---|
  | `HR` | `hr` |
  | `LEGAL` | `legal` |
  | `SEC` | `infosec` |

  Group names are compared case-insensitively. An **unscoped** CQL search
  requires membership in *all* restricted-space groups, since it can reach
  every restricted space at once.

  ## Compliance alignment

  This policy instantiates sensitive-scope fencing (family PF-23) on
  Confluence's read/search path and supports alignment with:

  - **SOC 2 C1.1, P4.1** — identifies and protects confidential information
    and limits personal-information use by fencing designated spaces out of
    agent reads and CQL searches.
  - **HIPAA §164.502(b)/§164.514(d), §164.308(a)(4)** — minimum-necessary and
    information-access-management: agents cannot list or trawl restricted
    spaces over MCP unless the caller's role grants it; **§164.522(a)** —
    supports agreed-to restrictions expressed as space-level fences.
  - **GDPR Art. 9; CPRA §1798.121** — keeps special-category / sensitive
    personal information held in fenced spaces (HR records, legal matters)
    out of agent result sets; **Art. 5(1)(b)** — supports purpose limitation
    by keying access to the caller's team.

  ## Why ingress

  All three surfaces can be fully evaluated from the request alone (tool name,
  arguments, caller claims), so enforcement happens before the call reaches
  Confluence and restricted content is never fetched into the model context.
  For defense in depth, pair with an egress redaction policy as a backstop for
  content reached by paths this policy does not cover.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `atlassian-searchconfluenceusingcql`), and the prefix is not standardized,
  so the policy matches case-insensitively on suffixes:

  - `searchconfluenceusingcql` (official Rovo connector, verified) and
    `confluence_search` (sooperset community server, verified name)
  - `getpagesinconfluencespace` (official, verified)
  - `getconfluencespaces` (official, verified)

  Verify the exact names your gateway emits with the dump-input debug
  technique before relying on this in production.

  ## Argument shape

  - **CQL:** read from `input.payload.args.cql` (official connector,
    verified), falling back to `args.query` for the community
    `confluence_search` (community per-field schema **unverified** — adjust if
    your server differs). A missing or non-string CQL value is treated as an
    unscoped query and fails closed.
  - **Page listing:** the space identifier is read from `args.spaceId`
    (official), falling back to `args.spaceKey` / `args.space`
    (**unverified** variants for portability).
  - **Space lookup:** restricted-key scoping is detected in `args.keys` /
    `args.spaceKeys` (arrays or comma-separated strings) and
    `args.spaceKey` / `args.key` (**unverified** — the official tool's filter
    arguments are not documented; unscoped calls pass through regardless).

  ## Configuration

  Edit the `restricted_spaces` object at the top of the Rego. Space keys
  (`HR`, `LEGAL`, `SEC`) are placeholders — replace them with your restricted
  space keys (UPPERCASE). Group names (`hr`, `legal`, `infosec`) are
  placeholders — remap them to your IdP's group names at import time. If a
  restricted space is commonly addressed by its numeric v2 `spaceId` or a
  `space.id` CQL clause, add the numeric id as an extra entry mapped to the
  same group (e.g. `"1234567": "hr"`).

  ## Examples

  ### Allowed (search scoped to a non-restricted space)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-searchconfluenceusingcql", "type": "tool" },
      "payload": {
        "name": "atlassian-searchconfluenceusingcql",
        "args": { "cql": "space = ENG and text ~ \"deploy runbook\"" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (search reaching into a restricted space)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-searchconfluenceusingcql", "type": "tool" },
      "subject": { "sub": "auth0|dev", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "atlassian-searchconfluenceusingcql",
        "args": { "cql": "space in (ENG, HR) and text ~ \"salary\"" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "This CQL search reaches into restricted Confluence space(s) (HR) ..."`.

  ### Denied (unscoped search, caller not cleared for all restricted spaces)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-searchconfluenceusingcql", "type": "tool" },
      "payload": {
        "name": "atlassian-searchconfluenceusingcql",
        "args": { "cql": "text ~ \"password\"" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This CQL search has no space filter, ..."`.

  ## Composition

  This policy covers the space-fenced read/search surface. Useful companions:

  - [`cap-read-field-exposure`](../../jira/cap-read-field-exposure/policy.md) —
    keeps high-exposure field selections out of Jira-side reads.
  - [`redact-pii-egress`](../redact-pii-egress/policy.md) — egress backstop
    that masks PII in any page content that is returned.
  - A Jira-side PF-23 fence
    ([`deny-view-search-sensitive-projects`](../../jira/deny-view-search-sensitive-projects/policy.md))
    so JQL cannot reach the equivalent restricted projects.

  ## Known limitations

  - **CQL is inspected with regex, not a parser.** The detection covers the
    common `space = KEY`, `space in (...)`, and `space.key` / `space.id`
    shapes with optional quotes and any casing. Exotic CQL that reaches
    restricted content without a positive space clause (e.g. `ancestor = <id>`
    or `id = <pageId>` pointing into a restricted space) is treated as
    *unscoped* and therefore denied for non-privileged callers — fail-closed,
    but with a generic reason.
  - **Negative clauses do not count as scoping.** `space != HR` or
    `space not in (HR)` still fan out across all other spaces (including the
    other restricted ones), so they are treated as unscoped and denied for
    callers not cleared for every restricted space.
  - **Disjunctions broaden past the space filter.** A CQL `OR`
    (e.g. `space = ENG or text ~ "salary"`, `space = ENG or ancestor = <id>`)
    unions in results the space clause does not constrain, so such a query
    still reaches every space including restricted ones. Any CQL containing a
    word-bounded `or` token is therefore treated as *not confined* and
    requires clearance for every restricted space — fail-closed. Because the
    check is a regex, not a CQL parser, the literal word "or" inside a quoted
    `text ~ "..."` value (e.g. `text ~ "cats or dogs"`) trips the same rule and
    is denied for non-privileged callers; split such searches or scope them so
    they need no full clearance.
  - **CQL search is the primary trawling channel this policy covers, not the
    only read route.** It fences `searchConfluenceUsingCql` / page-listing /
    space-lookup; the id-based reads and cross-product search/fetch routes
    below remain open. Treat this as one layer, composed with the egress
    redaction backstop, not a complete boundary around restricted spaces.
  - **Numeric space ids are not mapped by default.** `getPagesInConfluenceSpace`
    takes a numeric v2 `spaceId`; a bare numeric id cannot equal a placeholder
    key like `HR`, so such calls pass unless you add the numeric id to
    `restricted_spaces` (see Configuration). The same applies to
    `space.id = <n>` CQL clauses.
  - **Direct, id-based reads are not fenced.** Tools that take a page or
    comment id rather than a space — `getConfluencePage`,
    `getConfluencePageDescendants`, `getConfluencePageFooterComments`,
    `getConfluencePageInlineComments`, `getConfluenceCommentChildren` (all
    official) — carry no space information at ingress, so a caller who already
    knows a page id in a restricted space can read it and its
    descendants/comments through these tools. Fencing them requires an egress
    policy or per-page rules; pair with the egress redaction backstop.
  - **Cross-product search/fetch is a parallel route.** The official beta
    tools `searchAtlassian` (`atlassian-search`) and `fetchAtlassian`
    (`atlassian-fetch`) — verified in the live connector — run a unified
    Jira+Confluence search / resource fetch that takes **no `cql` or space
    argument**, so this policy cannot fence them and they pass through. An
    agent denied a `space = HR` CQL search can still reach the same content
    with a free-text `atlassian-search` query. These are out of scope for a
    space-clause fence by construction; deny them with a separate blanket rule
    (or exclude the tools at the gateway) and back-stop with egress redaction
    if your deployment exposes them.
  - **Community server coverage is partial.** The community `confluence_search`
    tool name is verified, but its argument schema (`query`) is not; other
    community read paths (`confluence_get_space_page_tree`,
    `confluence_get_page_children`) are not matched by this policy — extend
    the suffix sets if you run that server.
  - **Identity placeholders.** Group names are placeholders — replace `hr`,
    `legal`, and `infosec` with your IdP's group names at import time. The
    `groups` claim must be an array of strings; any other shape fails closed.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - confluence
industries: []
bundles:
  - atlassian
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package confluence.ingress.fence_restricted_spaces

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# -----------------------------------------------------------------------------
# CONFIG: restricted Confluence space key -> IdP group cleared to access it.
# Space keys (HR, LEGAL, SEC) and group names (hr, legal, infosec) are
# PLACEHOLDERS — replace the keys with your restricted space keys (UPPERCASE)
# and remap the groups to your IdP's group names at import time. If a
# restricted space is commonly addressed by its numeric v2 id, add the id as
# an extra entry mapped to the same group (e.g. "1234567": "hr").
# -----------------------------------------------------------------------------
restricted_spaces := {
    "HR": "hr",
    "LEGAL": "legal",
    "SEC": "infosec",
}

# -----------------------------------------------------------------------------
# Tool matching. The gateway prefixes tool names with the configured MCP
# server name, so we match case-insensitively on suffixes: the official Rovo
# connector's lowercased names plus the community server's snake_case name.
# Verify exact names on your gateway with the dump-input debug technique.
# -----------------------------------------------------------------------------

tool_name := lower(input.resource.name)

cql_search_suffixes := {"searchconfluenceusingcql", "confluence_search"}

is_cql_search_tool if {
    some suffix in cql_search_suffixes
    endswith(tool_name, suffix)
}

is_space_pages_tool if endswith(tool_name, "getpagesinconfluencespace")

is_spaces_list_tool if endswith(tool_name, "getconfluencespaces")

is_fenced_tool if is_cql_search_tool

is_fenced_tool if is_space_pages_tool

is_fenced_tool if is_spaces_list_tool

# -----------------------------------------------------------------------------
# Identity — caller's IdP groups, read fail-closed: a missing subject, missing
# claims, or missing/malformed groups claim yields no memberships, so the
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

# Required to run an UNSCOPED CQL search: it can reach every restricted space
# at once, so the caller must be cleared for all of them.
caller_in_all_restricted_groups if {
    every _, group in restricted_spaces {
        member_of(group)
    }
}

# -----------------------------------------------------------------------------
# Arguments
# -----------------------------------------------------------------------------

req_args := object.get(object.get(input, "payload", {}), "args", {})

# CQL string: the official connector uses `cql`; the community
# confluence_search exposes `query` (community schema unverified — adjust if
# your server differs). A missing or non-string value leaves cql_text
# undefined, which the rules below treat as an unscoped query (fail-closed).
cql_text := text if {
    text := object.get(req_args, "cql", "")
    is_string(text)
    text != ""
}

cql_text := text if {
    object.get(req_args, "cql", "") == ""
    text := object.get(req_args, "query", "")
    is_string(text)
    text != ""
}

# -----------------------------------------------------------------------------
# CQL inspection.
#
# A "positive space scope" is `space = X` or `space in (...)` (plus the
# space.key / space.id field variants). Negative clauses (space != X,
# space not in (...)) do NOT scope the query down — they still fan out across
# other spaces — so they intentionally do not count as a scope.
# -----------------------------------------------------------------------------

has_space_scope if {
    regex.match(`(?i)\bspace(?:\.key|\.id)?\s*=\s*\S`, cql_text)
}

has_space_scope if {
    regex.match(`(?i)\bspace(?:\.key|\.id)?\s+in\s*\(`, cql_text)
}

# A CQL disjunction (`OR`) unions in results that a positive space clause does
# NOT constrain, so `space = ENG or text ~ "x"` still fans out across every
# space. Detected conservatively with a word-bounded, case-insensitive match.
# This can also fire on the literal word "or" inside a quoted `text ~ "..."`
# value — a fail-closed false positive (see Known limitations).
has_disjunction if regex.match(`(?i)\bor\b`, cql_text)

# A query is treated as "confined" to its named spaces only when it carries a
# positive space scope AND has no broadening disjunction.
confined if {
    has_space_scope
    not has_disjunction
}

# `space = KEY` (optionally quoted, any casing). The value is extracted and
# compared uppercase against the restricted set.
referenced_restricted_spaces contains key if {
    some m in regex.find_all_string_submatch_n(
        `(?i)\bspace(?:\.key|\.id)?\s*=\s*["']?([A-Za-z0-9_~.-]+)["']?`,
        cql_text,
        -1,
    )
    key := upper(m[1])
    object.get(restricted_spaces, key, "") != ""
}

# `space in (A, B, ...)`: the list is split on commas and each entry trimmed
# of quotes/whitespace before an exact uppercase comparison, so a key like
# CHROME can never substring-match HR.
referenced_restricted_spaces contains key if {
    some m in regex.find_all_string_submatch_n(
        `(?i)\bspace(?:\.key|\.id)?\s+in\s*\(([^)]*)\)`,
        cql_text,
        -1,
    )
    some raw in split(m[1], ",")
    key := upper(trim(trim_space(raw), `"'`))
    object.get(restricted_spaces, key, "") != ""
}

# Restricted spaces the CQL references that the caller is NOT cleared for.
denied_cql_spaces contains key if {
    some key in referenced_restricted_spaces
    not member_of(restricted_spaces[key])
}

# -----------------------------------------------------------------------------
# getPagesInConfluenceSpace — target space identifier. The official tool takes
# `spaceId`; `spaceKey` / `space` cover common variants (unverified). Values
# are normalized to an uppercase string so numeric ids configured as
# restricted keys still match.
# -----------------------------------------------------------------------------

pages_target := val if {
    val := object.get(req_args, "spaceId", "")
    val != ""
}

pages_target := val if {
    object.get(req_args, "spaceId", "") == ""
    val := object.get(req_args, "spaceKey", "")
    val != ""
}

pages_target := val if {
    object.get(req_args, "spaceId", "") == ""
    object.get(req_args, "spaceKey", "") == ""
    val := object.get(req_args, "space", "")
    val != ""
}

pages_target_key := upper(sprintf("%v", [pages_target]))

pages_violation if {
    is_space_pages_tool
    object.get(restricted_spaces, pages_target_key, "") != ""
    not member_of(restricted_spaces[pages_target_key])
}

# -----------------------------------------------------------------------------
# getConfluenceSpaces — restricted keys the call is explicitly scoped to.
# Filter argument names are unverified; both array and comma-separated string
# shapes are handled. Unscoped listings collect nothing and pass through.
# -----------------------------------------------------------------------------

spaces_filter_arg_names := {"keys", "spaceKeys", "spaceKey", "key"}

requested_space_keys contains key if {
    some name in spaces_filter_arg_names
    val := object.get(req_args, name, null)
    is_array(val)
    some k in val
    key := upper(sprintf("%v", [k]))
}

requested_space_keys contains key if {
    some name in spaces_filter_arg_names
    val := object.get(req_args, name, null)
    is_string(val)
    some part in split(val, ",")
    key := upper(trim(trim_space(part), `"'`))
    key != ""
}

denied_listed_spaces contains key if {
    some key in requested_space_keys
    object.get(restricted_spaces, key, "") != ""
    not member_of(restricted_spaces[key])
}

# -----------------------------------------------------------------------------
# Allow rules
# -----------------------------------------------------------------------------

# Any tool this policy does not fence passes through.
allow if {
    not is_fenced_tool
}

# CQL search confined to positive space scope(s): allowed unless it names a
# restricted space the caller is not cleared for.
allow if {
    is_cql_search_tool
    confined
    count(denied_cql_spaces) == 0
}

# A CQL search that is not confined — no space scope at all, OR an `OR` clause
# that broadens results past the space scope — fans out across every space, so
# only callers cleared for ALL restricted spaces may run one.
allow if {
    is_cql_search_tool
    not confined
    caller_in_all_restricted_groups
}

# Space page listing: allowed unless it targets a restricted space the caller
# is not cleared for.
allow if {
    is_space_pages_tool
    not pages_violation
}

# Space lookup: allowed unless explicitly scoped to a restricted space the
# caller is not cleared for.
allow if {
    is_spaces_list_tool
    count(denied_listed_spaces) == 0
}

# -----------------------------------------------------------------------------
# Reasons
# -----------------------------------------------------------------------------

reasons contains msg if {
    is_cql_search_tool
    confined
    count(denied_cql_spaces) > 0
    key_list := concat(", ", sort([k | some k in denied_cql_spaces]))
    msg := sprintf("This CQL search reaches into restricted Confluence space(s) (%s) that your account is not cleared for. Scope the query to spaces you work in, or contact your InfoSec team if you believe this is a false positive.", [key_list])
}

reasons contains "This CQL search has no space filter, so it would fan out across every Confluence space, including restricted ones. Add a space = KEY or space in (...) clause naming the spaces you need, or contact your InfoSec team if you need broader search access." if {
    is_cql_search_tool
    not has_space_scope
    not caller_in_all_restricted_groups
}

reasons contains "This CQL search uses an OR clause, which broadens results past any space filter to every Confluence space, including restricted ones. Split it into separate space-scoped searches, or contact your InfoSec team if you need broader search access." if {
    is_cql_search_tool
    has_space_scope
    has_disjunction
    not caller_in_all_restricted_groups
}

reasons contains msg if {
    pages_violation
    msg := sprintf("Listing pages in the restricted Confluence space '%s' is not permitted for your account. Contact your InfoSec team if your role requires access.", [pages_target_key])
}

reasons contains msg if {
    is_spaces_list_tool
    count(denied_listed_spaces) > 0
    key_list := concat(", ", sort([k | some k in denied_listed_spaces]))
    msg := sprintf("Looking up restricted Confluence space(s) (%s) is not permitted for your account. Contact your InfoSec team if your role requires access.", [key_list])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
