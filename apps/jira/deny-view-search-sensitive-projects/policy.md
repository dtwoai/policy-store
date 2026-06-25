---
name: "JIRA: Deny Sensitive Project Search and View"
tags:
  - jira
  - atlassian
  - access-control
  - data-protection
  - ingress
publishedAt: 2026-06-16
description: |
  # jira / deny-view-search-sensitive-projects

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow, with targeted denies and a silent search filter
  **Package:** `jira.ingress.deny_sensitive_search_and_view`

  ## What it does

  Keeps issues that belong to a configurable set of "sensitive" JIRA projects out
  of read access through the JIRA MCP server. It guards the two read paths a
  caller can use to reach an issue — fetching an issue directly by key, and
  searching with JQL — and leaves every other JIRA tool and every other project
  untouched.

  The set of sensitive projects is configured once at the top of the Rego
  (`sensitive_projects`) and all comparisons are case-insensitive.

  ## Behavior

  The policy is `default allow := true` and enforces three behaviors against the
  two read tools:

  - **Deny direct views.** A `*-getjiraissue` call whose `issueIdOrKey` resolves
    to a sensitive project is denied, and the caller receives a reason naming the
    affected project.
  - **Deny explicit searches.** A `*-searchjiraissuesusingjql` call whose JQL
    explicitly references a sensitive project — via `project = X`,
    `project in (... X ...)`, or any `X-NNN` issue key — is denied with a reason
    naming the matched project(s).
  - **Silently filter generic searches.** Any other
    `*-searchjiraissuesusingjql` call (generic filter, `ORDER BY` only, empty
    JQL, etc.) is rewritten to prepend a `project NOT IN (...)` clause so
    sensitive-project issues never appear in the result set. The caller gets
    results back, just without the protected issues.

  ## Why ingress

  Both read paths can be fully evaluated from the request alone (tool name +
  arguments), so enforcement happens before the call reaches JIRA. Direct views
  and explicit searches are denied outright; generic searches are rewritten in
  place. Doing this at ingress means sensitive issues are never fetched from JIRA
  in the first place. For defense in depth, pair this with the egress
  redaction policy in the same bundle as a backstop for any issue reached by a
  path this policy doesn't cover.

  ## Tool name matching

  Tool names on the gateway are prefixed with the configured MCP server name
  (e.g. `atlassian-jira-mcp-getjiraissue`), and that prefix is not standardized.
  The policy matches on the tool-name **suffix** (`-getjiraissue`,
  `-searchjiraissuesusingjql`) so it stays portable across naming conventions.
  Confirm the exact tool names your gateway emits with the dump-input debug
  technique before relying on this in production.

  ## Argument shape

  - Direct view: reads the issue key from `input.payload.args.issueIdOrKey`.
  - Search: reads the query from `input.payload.args.jql`.

  If your JIRA MCP server exposes these under different argument keys, adjust the
  `object.get(...)` lookups accordingly.

  ## Configuration

  Edit the `sensitive_projects` set at the top of the policy. The shipped keys
  (`PROJA`, `PROJB`) are **placeholders** — replace them with your own project
  keys (uppercase). If you also run a companion writes-protection policy for the
  same projects, mirror this set there so view/search and write restrictions stay
  aligned.

  ## Examples

  ### Allowed (generic search — silently filtered)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-jira-mcp-searchjiraissuesusingjql", "type": "tool" },
      "payload": {
        "name": "atlassian-jira-mcp-searchjiraissuesusingjql",
        "args": { "jql": "assignee = currentUser() ORDER BY created DESC" }
      }
    }
  }
  ```

  `allow = true`. The JQL is rewritten to
  `project NOT IN (PROJA, PROJB) AND (assignee = currentUser()) ORDER BY created DESC`.

  ### Denied (explicit sensitive-project search)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-jira-mcp-searchjiraissuesusingjql", "type": "tool" },
      "payload": {
        "name": "atlassian-jira-mcp-searchjiraissuesusingjql",
        "args": { "jql": "project = PROJA ORDER BY created DESC" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Searching for issues in protected project(s) (PROJA) is not permitted. ..."`.

  ### Denied (direct view of a sensitive issue)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-jira-mcp-getjiraissue", "type": "tool" },
      "payload": {
        "name": "atlassian-jira-mcp-getjiraissue",
        "args": { "issueIdOrKey": "PROJA-42" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Viewing issues in the 'PROJA' project is not permitted. ..."`.

  ## Composition

  This policy covers the read surface. Useful companions:

  - The [`redact-sensitive-info`](../redact-sensitive-info/policy.md) egress
    policy in the same bundle, as a backstop that masks PII/secrets in any issue
    content that is returned.
  - A separate ingress write-protection policy that denies
    create/edit/comment/transition on the same sensitive projects.

  ## Known limitations

  - **JQL is inspected with regex, not a parser.** The explicit-reference
    detection covers the common `project = X`, `project in (...)`, and `X-NNN`
    shapes. Exotic JQL (functions, deeply nested boolean logic, fields that
    indirectly imply a project) may not be detected as an *explicit* reference —
    in that case the call falls through to the silent `project NOT IN (...)`
    rewrite, which still excludes sensitive projects from results.
  - **Read paths only.** This policy does not restrict writes. Pair it with a
    write-protection policy if callers can create or edit issues.
  - **No identity-based exemptions.** All callers are treated the same. To add an
    InfoSec break-glass user, gate a separate `allow if` branch on
    `input.subject.claims`.
direction: ingress
apps:
  - jira
industries: []
bundles:
  - atlassian
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package jira.ingress.deny_sensitive_search_and_view

# Default-allow: only deny when a sensitive-project view or explicit search is
# detected. For generic searches, a transform rewrites the JQL to silently
# exclude sensitive projects (see Transform section below).
default allow := true

# -----------------------------------------------------------------------------
# CONFIG: Sensitive project keys. Edit this set to add or remove projects.
# The keys below (PROJA, PROJB) are PLACEHOLDERS — replace them with your own
# project keys. Stored UPPERCASE; all comparisons normalize input to upper case.
# If you also run a companion writes-protection policy, mirror this set there to
# keep view/search restrictions and write restrictions aligned.
# -----------------------------------------------------------------------------
sensitive_projects := {
    "PROJA",
    "PROJB",
}

# Suffix matching works regardless of the MCP server name on the gateway
# (atlassian-, atlassian-jira-mcp-, etc.).
view_tool_suffixes := {"-getjiraissue"}
search_tool_suffixes := {"-searchjiraissuesusingjql"}

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

tool_name := lower(input.resource.name)

is_search_tool if {
    some suffix in search_tool_suffixes
    endswith(tool_name, suffix)
}

# JQL clause used to exclude every configured sensitive project from a search.
# Sorted for stable, deterministic output (eases debugging).
exclusion_clause := sprintf(
    "project NOT IN (%s)",
    [concat(", ", sort([p | some p in sensitive_projects]))],
)

# Extract the project key from a JIRA issue key like "PROJA-123" -> "PROJA".
project_from_issue_key(key) := project if {
    parts := split(key, "-")
    count(parts) >= 2
    project := upper(parts[0])
    project != ""
}

# True when the request is fetching an issue in a sensitive project.
view_targets_sensitive_project if {
    key := object.get(input.payload.args, "issueIdOrKey", "")
    project := project_from_issue_key(key)
    sensitive_projects[project]
}

# -----------------------------------------------------------------------------
# JQL inspection — collect the specific sensitive projects the JQL references.
# Three regex shapes per project; any match adds the project to the set.
#
# Pattern A: project = <PROJ>     (with optional quotes/whitespace)
# Pattern B: project in (... <PROJ> ...)
# Pattern C: <PROJ>-NNN           (any specific issue key reference)
# -----------------------------------------------------------------------------

referenced_sensitive_projects contains proj if {
    jql := object.get(input.payload.args, "jql", "")
    is_string(jql)
    some proj in sensitive_projects
    pattern := sprintf(`(?i)\bproject\s*=\s*['"]?%s['"]?(\s|$|[^A-Z0-9_])`, [proj])
    regex.match(pattern, jql)
}

referenced_sensitive_projects contains proj if {
    jql := object.get(input.payload.args, "jql", "")
    is_string(jql)
    some proj in sensitive_projects
    pattern := sprintf(`(?i)\bproject\s+in\s*\([^)]*['"]?%s['"]?[^)]*\)`, [proj])
    regex.match(pattern, jql)
}

referenced_sensitive_projects contains proj if {
    jql := object.get(input.payload.args, "jql", "")
    is_string(jql)
    some proj in sensitive_projects
    pattern := sprintf(`\b%s-\d+\b`, [proj])
    regex.match(pattern, jql)
}

jql_references_sensitive_project if {
    count(referenced_sensitive_projects) > 0
}

# -----------------------------------------------------------------------------
# JQL rewriting helpers — find ORDER BY position and build the new JQL.
# Handles four shapes: filter+ORDER BY, ORDER BY only, filter only, empty.
# -----------------------------------------------------------------------------

# Index of "order by" in JQL. Returns the index of " order by " (with leading
# space) if present mid-string, or 0 if JQL starts with "order by ". Otherwise
# undefined — callers can use `not order_by_idx(...)` to mean "no ORDER BY".
order_by_idx(jql) := idx if {
    lower_jql := lower(jql)
    idx := indexof(lower_jql, " order by ")
    idx >= 0
}

order_by_idx(jql) := 0 if {
    lower_jql := lower(jql)
    indexof(lower_jql, " order by ") == -1
    startswith(lower_jql, "order by ")
}

# Case 1: JQL has both a filter and an ORDER BY clause.
build_jql(original_jql) := new_jql if {
    idx := order_by_idx(original_jql)
    filter_part := trim_space(substring(original_jql, 0, idx))
    order_part := trim_space(substring(original_jql, idx, count(original_jql) - idx))
    filter_part != ""
    new_jql := sprintf("%s AND (%s) %s", [exclusion_clause, filter_part, order_part])
}

# Case 2: JQL has ONLY an ORDER BY clause, no filter.
build_jql(original_jql) := new_jql if {
    idx := order_by_idx(original_jql)
    filter_part := trim_space(substring(original_jql, 0, idx))
    order_part := trim_space(substring(original_jql, idx, count(original_jql) - idx))
    filter_part == ""
    new_jql := sprintf("%s %s", [exclusion_clause, order_part])
}

# Case 3: JQL has ONLY a filter, no ORDER BY.
build_jql(original_jql) := new_jql if {
    not order_by_idx(original_jql)
    filter_part := trim_space(original_jql)
    filter_part != ""
    new_jql := sprintf("%s AND (%s)", [exclusion_clause, filter_part])
}

# Case 4: JQL is empty.
build_jql(original_jql) := exclusion_clause if {
    not order_by_idx(original_jql)
    trim_space(original_jql) == ""
}

# -----------------------------------------------------------------------------
# Deny rules
# -----------------------------------------------------------------------------

allow := false if {
    some suffix in view_tool_suffixes
    endswith(tool_name, suffix)
    view_targets_sensitive_project
}

allow := false if {
    is_search_tool
    jql_references_sensitive_project
}

# -----------------------------------------------------------------------------
# Transform — silently exclude sensitive projects from generic JQL searches.
# Only fires when the JQL does NOT already explicitly reference a sensitive
# project; those calls are denied above with a clear reason. Generic searches
# (no project filter, ORDER BY only, empty JQL, etc.) get the silent filter so
# sensitive-project issues never appear in the result set.
# -----------------------------------------------------------------------------

transform := {
    "transformed_payload": object.union(
        input.payload.args,
        {"jql": new_jql},
    )
} if {
    input.action == "tool_pre_invoke"
    is_search_tool
    not jql_references_sensitive_project
    original_jql := object.get(input.payload.args, "jql", "")
    is_string(original_jql)
    new_jql := build_jql(original_jql)
}

# -----------------------------------------------------------------------------
# Reasons
# -----------------------------------------------------------------------------

reasons contains msg if {
    some suffix in view_tool_suffixes
    endswith(tool_name, suffix)
    view_targets_sensitive_project
    key := object.get(input.payload.args, "issueIdOrKey", "")
    project := project_from_issue_key(key)
    msg := sprintf("Viewing issues in the '%s' project is not permitted. Contact your InfoSec team if this needs to change.", [project])
}

reasons contains msg if {
    is_search_tool
    jql_references_sensitive_project
    project_list := concat(", ", sort([p | some p in referenced_sensitive_projects]))
    msg := sprintf("Searching for issues in protected project(s) (%s) is not permitted. Contact your InfoSec team if this needs to change.", [project_list])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
