---
name: "JIRA: Cap Field and Result Exposure on Reads"
tags:
  - jira
  - atlassian
  - cap-bulk-export
  - data-minimisation
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # jira / cap-read-field-exposure

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `jira.ingress.cap_read_field_exposure`

  ## What it does

  Narrows the breadth of JIRA read requests *before* they run, on the two read
  surfaces that can pull large amounts of issue data into model context:

  - **Strips over-broad field tokens.** When a search or issue-view call's
    `fields` argument contains a broad wildcard — `"*all"` or `"*navigable"`,
    which expand to every / every navigable field (including custom fields —
    salary bands, customer identifiers — that the default field set
    deliberately omits) — or `"comment"` (which pulls full comment threads),
    those tokens are removed and the remaining fields pass through. If
    stripping leaves nothing, the request falls back to a conservative
    approximation of Jira's default safe field subset (`default_safe_fields`
    in `policy.md` — a documented tuning knob). Matching is case-insensitive
    and whitespace-tolerant (`"*ALL"`, `" *all "` are stripped too), both the
    official array form and the community comma-separated string form of
    `fields` are handled, and — because Jira comma-splits a `fields` value
    server-side — a *single array element* that packs a banned token behind a
    comma (`"summary,*all"`) is dropped whole rather than slipping through.
  - **Clamps search page size.** On the search tools, `maxResults` is
    rewritten down to **50** whenever it is higher than 50, absent,
    non-positive, or non-numeric — bounding bulk trawling well inside the
    server's own 100-row hard limit. A numeric value already in `[1, 50]`
    passes through unchanged. Note the *absent* case is deliberately
    clamped: a search that names no page size would otherwise run at the
    server's default, so the ceiling is injected.

  All other arguments (`jql`, `cloudId`, `issueIdOrKey`, …) are preserved via
  `object.union`. Calls are **never denied** — the request always proceeds,
  just narrower. Any tool outside the matched read set, any egress hook, and
  any call by an exempt power user passes through untouched. An issue-view
  call with no `fields` argument at all is left untouched (issue-view tools
  take no `maxResults`, so nothing is injected there).

  **Identity exemption:** callers whose `input.subject.claims.groups` include
  the placeholder group `jira-power-users` bypass the policy entirely. The
  exemption fails closed — missing subject, claims, or groups means the caps
  apply.

  ## Compliance alignment

  This policy instantiates field-level minimum-necessary / data-minimisation
  (family PF-08, cap-bulk-export) and supports alignment with:

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information by bounding how many fields and rows a single agent read
    can move out of Jira.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard: issue trackers routinely accumulate PHI in custom fields and
    comment threads; reads stay scoped to the default field subset unless a
    designated role needs more.
  - **GDPR Art. 5(1)(c)** — data minimisation on the agent channel: the
    query's breadth is minimised *before* it reaches Jira, so personal data
    in custom fields and comments is never pulled into model context.
  - **CCPA 11 CCR §7002** — supports proportionality: collection and use of
    personal information stays proportionate to the task rather than
    defaulting to every-field, maximum-row retrieval.

  ## Why ingress

  Once a `fields: ["*all"], maxResults: 100` search has executed, the data is
  already in the response, the model context, and the gateway logs — an
  egress policy can only mask patterns in text that has already been fetched.
  Rewriting the request at ingress is the only place the *breadth* of the
  read can be controlled. The companion egress policy
  (`redact-sensitive-info`) then masks sensitive values in whatever the
  narrowed query still returns.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `atlassian-searchjiraissuesusingjql`), so matching is by
  case-insensitive suffix to stay portable across deployments:

  - **Search tools** (fields stripped + `maxResults` clamped):
    `*searchjiraissuesusingjql` (official Rovo / Claude connector, verified)
    and `*jira_search` (sooperset community server).
  - **Issue-view tools** (fields stripped only): `*getjiraissue` (official,
    verified — same `fields`/`"*all"` semantics as search) and
    `*jira_get_issue` (community).

  Verify the exact names your gateway sends with the dump-input debug
  technique before relying on this in production.

  ## Argument shape

  - `searchJiraIssuesUsingJql` takes `jql`, `fields[]` (array of strings;
    default is a safe subset; `"*all"` pulls every field and `"comment"`
    pulls full comment threads), and `maxResults` ≤ 100 — verified from the
    live official-connector schemas. `getJiraIssue` has the same
    `fields`/`"*all"` semantics.
  - The community server's `fields` parameter is conventionally a
    comma-separated **string**; the policy handles that form with the same
    strip-and-fallback logic (rejoining with commas). Community per-field
    schemas are **not independently verified** — see Known limitations.
  - Every argument is read with `object.get` — no direct indexing — so
    malformed or missing args never crash the policy; they simply pass
    through (a non-array, non-string `fields` value is not rewritten).

  ## Examples

  ### Untouched

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-getjiraissue", "type": "tool" },
      "payload": {
        "name": "atlassian-getjiraissue",
        "args": { "issueIdOrKey": "ENG-42" }
      }
    }
  }
  ```

  `allow = true`, no transform — no `fields` argument, and issue-view tools
  take no `maxResults`.

  ### Transformed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-searchjiraissuesusingjql", "type": "tool" },
      "payload": {
        "name": "atlassian-searchjiraissuesusingjql",
        "args": { "jql": "project = ENG", "fields": ["summary", "*all", "status"], "maxResults": 100 }
      }
    }
  }
  ```

  `allow = true`, transform rewrites the args to
  `{ "jql": "project = ENG", "fields": ["summary", "status"], "maxResults": 50 }`.
  Had `fields` been `["*all"]` alone, the rewrite would fall back to the
  default safe subset instead.

  ### Exempt

  The same search issued by a caller whose `input.subject.claims.groups`
  include `jira-power-users` passes through completely unchanged.

  ## Composition

  This policy narrows the *query*; it does not inspect returned *values* or
  fence which projects are reachable. Useful companions:

  - [`apps/jira/redact-sensitive-info`](../redact-sensitive-info/policy.md) —
    egress redaction that masks PII/credentials in whatever the narrowed read
    still returns (defense in depth).
  - [`apps/jira/deny-view-search-sensitive-projects`](../deny-view-search-sensitive-projects/policy.md) —
    the project-level fence; this policy bounds breadth *within* the projects
    that fence still allows.
  - [`apps/jira/freeze-destructive-ops`](../freeze-destructive-ops/policy.md) —
    guards the destructive surface of community-server deployments.

  ## Known limitations

  - **Group names are placeholders** — replace `jira-power-users` with your
    IdP's group name at import time. The exemption expects `groups` to be an
    array of strings; a single-string `groups` claim is not matched (the
    caps then apply — fail closed for the grant).
  - **Community argument shapes are unverified.** The sooperset server's
    `jira_search` / `jira_get_issue` field parameter (comma-separated string)
    and its page-size parameter name were not independently verified in the
    landscape research. Notably, if the community server reads its page size
    from a key other than `maxResults` (e.g. `limit`), that key is **not**
    clamped by this policy — confirm from your server's `tools/list` and
    extend the clamp before relying on it.
  - **Per-call caps do not stop patient pagination.** Stateless Rego cannot
    track cumulative volume: an agent can still page through results 50 rows
    at a time, and named non-sensitive fields are never stripped. Use
    gateway audit logs to spot high-frequency crawls, and pair with the
    project fence and egress redaction listed above.
  - **Only the `"*all"`, `"*navigable"`, and `"comment"` tokens are stripped.**
    A caller who explicitly enumerates individual custom field IDs (e.g.
    `customfield_10042`) still receives them; blocking specific fields by
    name is a separate allowlist policy. `"*navigable"` is a documented Jira
    wildcard, not independently verified in the landscape note — it is
    stripped as defense in depth. If Jira adds a further broad-expansion
    token, add it to `banned_field_tokens`.
  - **Absent `maxResults` is injected, not left alone.** A bare search gains
    `maxResults: 50`. If your server's default page size is already lower,
    this is a no-op in practice but the argument will appear in the call.
  - **Other bulk-read tools are out of scope.** Community tools like
    `jira_get_project_issues` or `jira_batch_get_changelogs` have their own
    shapes; cover them with additional policies if your deployment exposes
    them.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are
  > outside the gateway's reach by design. Validate against your own compliance
  > program before relying on it.
direction: ingress
apps:
  - jira
industries: []
bundles:
  - soc2
  - gdpr-ccpa
  - atlassian
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package jira.ingress.cap_read_field_exposure

# Transform-only policy — never denies, only narrows the read before it runs.
default allow := true

# --- Tuning knobs ---------------------------------------------------------------

# Ceiling for search page size. Jira's own hard limit is 100; 50 keeps a single
# call from pulling the maximum the API allows.
max_results_ceiling := 50

# Field tokens stripped from `fields`: "*all" and "*navigable" are Jira wildcards
# that expand to every / every navigable field (including custom fields the
# default subset deliberately omits — salary bands, customer identifiers) and
# "comment" pulls full comment threads. "*navigable" is a documented Jira
# wildcard, not verified in the landscape note — stripped as defense in depth.
banned_field_tokens := {"*all", "*navigable", "comment"}

# Fallback when stripping leaves no fields: a conservative approximation of
# Jira's default safe field subset. Tune to your environment.
default_safe_fields := [
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "reporter",
    "created",
    "updated",
    "labels",
]

# Callers in this IdP group bypass the policy entirely. Placeholder name —
# replace with your IdP's group name at import time.
power_user_group := "jira-power-users"

# --- Tool matching ----------------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match case-insensitively by suffix to stay portable. Official Rovo/Claude
# connector names are verified; community (sooperset) names per its docs.

# Search tools: fields stripped AND maxResults clamped.
search_tool_suffixes := ["searchjiraissuesusingjql", "jira_search"]

# Issue-view tools: fields stripped only (they take no maxResults).
get_tool_suffixes := ["getjiraissue", "jira_get_issue"]

is_search_tool if {
    some suffix in search_tool_suffixes
    endswith(lower(input.resource.name), suffix)
}

is_get_tool if {
    some suffix in get_tool_suffixes
    endswith(lower(input.resource.name), suffix)
}

is_read_tool if is_search_tool

is_read_tool if is_get_tool

# The caps apply to the ingress hook only — egress hooks on the same tool
# names pass through.
is_capped_read_call if {
    input.action == "tool_pre_invoke"
    is_read_tool
}

# --- Identity exemption -----------------------------------------------------------
# Fail closed for the grant: a missing subject, claims, or groups claim means
# the caller is NOT exempt and the caps apply.

caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

is_power_user if {
    some g in caller_groups
    is_string(g)
    lower(g) == power_user_group
}

# --- Argument access (object.get everywhere — fields may be missing) ---------------

args := object.get(object.get(input, "payload", {}), "args", {})

fields_value := object.get(args, "fields", null)

# --- fields rewrite: array form (official Rovo/Claude connector, verified) ---------

# A token is banned when — lowercased and whitespace-trimmed — it matches a
# banned wildcard/token. Each array element is *also* comma-split first, because
# Jira splits a comma-joined `fields` value server-side: an element such as
# "*all,comment" or "summary,*all" would otherwise pass through atomically and
# still expand to every field. If any comma-part is banned the whole element is
# dropped (fail-safe: over-stripping falls back to the default safe subset).
# Non-string entries are never banned (and are preserved as-is).
is_banned_token(f) if {
    is_string(f)
    some part in split(f, ",")
    banned_field_tokens[lower(trim_space(part))]
}

banned_in_array if {
    is_array(fields_value)
    some f in fields_value
    is_banned_token(f)
}

# Original order preserved; only banned tokens are dropped.
sanitized_array := [f |
    is_array(fields_value)
    some f in fields_value
    not is_banned_token(f)
]

# --- fields rewrite: comma-separated string form (community servers; shape ---------
# --- not independently verified — see Known limitations) ---------------------------

banned_in_string if {
    is_string(fields_value)
    some t in split(fields_value, ",")
    banned_field_tokens[lower(trim_space(t))]
}

sanitized_string_tokens := [trimmed |
    is_string(fields_value)
    some t in split(fields_value, ",")
    trimmed := trim_space(t)
    not banned_field_tokens[lower(trimmed)]
    trimmed != ""
]

# --- Patches ------------------------------------------------------------------------
# Each patch defaults to {} so `patch` below is always defined; the transform
# fires only when at least one patch has content.

default fields_patch := {}

fields_patch := {"fields": sanitized_array} if {
    banned_in_array
    count(sanitized_array) > 0
}

fields_patch := {"fields": default_safe_fields} if {
    banned_in_array
    count(sanitized_array) == 0
}

fields_patch := {"fields": concat(",", sanitized_string_tokens)} if {
    banned_in_string
    count(sanitized_string_tokens) > 0
}

fields_patch := {"fields": concat(",", default_safe_fields)} if {
    banned_in_string
    count(sanitized_string_tokens) == 0
}

max_results_value := object.get(args, "maxResults", null)

# Clamp when maxResults is absent — a bare search would otherwise run at the
# server's own default page size.
needs_max_results_clamp if {
    max_results_value == null
}

# Clamp a numeric maxResults above the ceiling.
needs_max_results_clamp if {
    is_number(max_results_value)
    max_results_value > max_results_ceiling
}

# Clamp non-positive page sizes: several servers read 0/negative as "use the
# default" or "unbounded", so anything outside [1, ceiling] is rewritten.
needs_max_results_clamp if {
    is_number(max_results_value)
    max_results_value < 1
}

# Fail safe: a non-numeric maxResults is replaced with the ceiling rather than
# letting the server's parsing decide.
needs_max_results_clamp if {
    max_results_value != null
    not is_number(max_results_value)
}

default max_results_patch := {}

# The page-size clamp applies to search tools only — issue-view tools take no
# maxResults, so nothing is ever injected into them.
max_results_patch := {"maxResults": max_results_ceiling} if {
    is_search_tool
    needs_max_results_clamp
}

patch := object.union(fields_patch, max_results_patch)

# --- Transform ------------------------------------------------------------------------
# Rewrites only the offending keys; every other argument is preserved.
transform := {"transformed_payload": object.union(args, patch)} if {
    is_capped_read_call
    not is_power_user
    count(patch) > 0
}
```
