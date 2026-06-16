---
name: "JIRA: Protect Sensitive Projects from Writes"
tags:
  - jira
  - atlassian
  - access-control
  - data-protection
  - ingress
publishedAt: 2026-06-16
description: |
  # jira / deny-write-sensitive-projects

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow, with targeted denies on writes to sensitive projects
  **Package:** `jira.ingress.protect_sensitive_projects`

  ## What it does

  Blocks write operations against issues that belong to a configurable set of
  "sensitive" JIRA projects. It is the write-side companion to the read/search
  restriction policy: where that one keeps sensitive issues out of view, this one
  keeps callers from modifying, creating, moving, or linking them. Any tool that
  is not a write, and any project not in the sensitive set, passes through
  untouched.

  The set of sensitive projects is configured once at the top of the Rego
  (`sensitive_projects`) and all comparisons are case-insensitive.

  ## Behavior

  The policy is `default allow := true` and denies a call only when a write
  targets a sensitive project, across four families of operations:

  - **Direct writes** — edit, update, transition, assign, delete,
    archive/unarchive, set priority/labels, comment, worklog, attachment,
    watcher, and vote operations on an issue whose key resolves to a sensitive
    project (read from `issueIdOrKey`).
  - **Links** — link/unlink operations where either the inward or outward issue
    belongs to a sensitive project.
  - **Create** — creating an issue whose target project is sensitive.
  - **Move** — moving an issue into a sensitive project.

  ## Why ingress

  Writes have permanent side effects, so the only place to stop them is *before*
  the call reaches JIRA. Each violation is fully determined by the request (tool
  name + arguments), so ingress denial prevents the modification from ever
  executing. Pair this with the read-side
  [`deny-view-search-sensitive-projects`](../deny-view-search-sensitive-projects/policy.md) policy and the
  egress [`redact-sensitive-info`](../redact-sensitive-info/policy.md) policy for
  full read + write + leakage coverage of the same projects.

  ## Tool name matching

  Tool names on the gateway are prefixed with the configured MCP server name
  (e.g. `atlassian-jira-mcp-editjiraissue`), and that prefix is not standardized.
  The policy matches on the tool-name **suffix** (e.g. `-editjiraissue`,
  `-createjiraissue`, `-movejiraissue`) so it stays portable across naming
  conventions. Confirm the exact tool names your gateway emits with the
  dump-input debug technique, and extend the suffix sets if your JIRA MCP server
  exposes additional write tools.

  ## Target-project detection (create / move)

  Different Atlassian MCP variants ship the target project under different
  argument names. Rather than assume one shape, the policy collects every project
  key it can find and denies if any is sensitive:

  - **Create** — `fields.project.key` (REST-nested), `projectKey`,
    `projectIdOrKey`, `project_key`, and bare-string `project`.
  - **Move** — `targetProjectKey`, `targetProjectIdOrKey`, `target_project_key`,
    and `targetProject.key`.

  ## Configuration

  Edit the `sensitive_projects` set at the top of the policy. The shipped keys
  (`PROJECT_KEY1`, `PROJECT_KEY2`) are **placeholders** — replace them with your
  own project keys (uppercase). If you also run the read/search-restriction
  policy for the same projects, mirror this set there so read and write controls
  stay aligned.

  ## Examples

  ### Denied (editing a sensitive-project issue)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-jira-mcp-editjiraissue", "type": "tool" },
      "payload": {
        "name": "atlassian-jira-mcp-editjiraissue",
        "args": { "issueIdOrKey": "PROJECT_KEY1-42", "fields": { "summary": "new" } }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Modifying issues in the 'PROJECT_KEY1' project is not permitted. ..."`.

  ### Allowed (editing an issue in a non-sensitive project)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-jira-mcp-editjiraissue", "type": "tool" },
      "payload": {
        "name": "atlassian-jira-mcp-editjiraissue",
        "args": { "issueIdOrKey": "DEV-7", "fields": { "summary": "new" } }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ## Composition

  This policy covers the write surface for the configured projects. Useful
  companions in the same [`atlassian`](../../../bundles/atlassian/README.md)
  bundle:

  - [`deny-view-search-sensitive-projects`](../deny-view-search-sensitive-projects/policy.md) — ingress
    read/search restriction for the same projects.
  - [`redact-sensitive-info`](../redact-sensitive-info/policy.md) — egress
    redaction of PII/secrets in returned issue content.

  ## Known limitations

  - **Numeric issue IDs are not covered.** Project membership is derived from the
    `KEY-NNN` form of an issue identifier. A call that references an issue purely
    by numeric ID carries no project information, so it falls through to allow.
    If your callers can act on issues by numeric ID, add a complementary control.
  - **New write tools require a suffix update.** Only the tools listed in the
    suffix sets are treated as writes. If the MCP server adds a new mutating
    tool, add its suffix so it is covered.
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
package jira.ingress.protect_sensitive_projects

# Default-allow: only deny when a write tool targets a sensitive project.
default allow := true

# -----------------------------------------------------------------------------
# CONFIG: Sensitive project keys. Edit this set to add or remove projects.
# Stored UPPERCASE — all comparisons normalize input to upper case.
# -----------------------------------------------------------------------------
sensitive_projects := {
    "PROJECT_KEY1", #placeholder value, replace with your target project key
    "PROJECT_KEY2", #placeholder value, replace with your target project key
}

# -----------------------------------------------------------------------------
# WRITE TOOLS: any Atlassian tool whose name ends with one of these suffixes is
# treated as a write operation. Suffix matching makes this work regardless of
# the MCP server name on the gateway (atlassian-, atlassian-jira-mcp-, etc.).
# -----------------------------------------------------------------------------
write_tool_suffixes := {
    "-editjiraissue",
    "-updatejiraissue",
    "-transitionjiraissue",
    "-assignjiraissue",
    "-deletejiraissue",
    "-archivejiraissue",
    "-unarchivejiraissue",
    "-movejiraissue",
    "-setjiraissuepriority",
    "-setjiraissuelabels",
    "-addjiraissuelabel",
    "-removejiraissuelabel",
    "-addcommenttojiraissue",
    "-editcommentonjiraissue",
    "-deletecommentfromjiraissue",
    "-addjiraissueattachment",
    "-removejiraissueattachment",
    "-addworklogtojiraissue",
    "-updateworklog",
    "-deleteworklog",
    "-addjiraissuewatcher",
    "-removejiraissuewatcher",
    "-voteforjiraissue",
    "-unvotejiraissue",
}

link_tool_suffixes := {
    "-linkjiraissues",
    "-createjiraissuelink",
    "-deletejiraissuelink",
}

create_tool_suffixes := {
    "-createjiraissue",
}

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

tool_name := lower(input.resource.name)

# Extract the project key from a JIRA issue key like "HR-123" -> "HR".
# Returns undefined for numeric IDs or malformed keys (rule then falls through).
project_from_issue_key(key) := project if {
    parts := split(key, "-")
    count(parts) >= 2
    project := upper(parts[0])
    project != ""
}

issue_in_sensitive_project if {
    key := object.get(input.payload.args, "issueIdOrKey", "")
    project := project_from_issue_key(key)
    sensitive_projects[project]
}

linked_issue_in_sensitive_project if {
    key := object.get(object.get(input.payload.args, "inwardIssue", {}), "key", "")
    project := project_from_issue_key(key)
    sensitive_projects[project]
}

linked_issue_in_sensitive_project if {
    key := object.get(object.get(input.payload.args, "outwardIssue", {}), "key", "")
    project := project_from_issue_key(key)
    sensitive_projects[project]
}

# -----------------------------------------------------------------------------
# CREATE target project — set of candidate project keys.
# Different Atlassian MCP variants ship the target project under different arg
# names. Rather than guess one shape, collect any project key we find across
# every known location and let the deny rule check if any are sensitive.
# Bug fix vs v1: v1 only checked the REST-nested fields.project.key path,
# which silently failed when the tool accepts a flattened argument like
# projectKey. That allowed create calls to slip through.
# -----------------------------------------------------------------------------

# REST shape: args.fields.project.key  (e.g. {"fields": {"project": {"key": "HR"}}})
create_target_candidates contains upper(p) if {
    fields := object.get(input.payload.args, "fields", {})
    project_obj := object.get(fields, "project", {})
    p := object.get(project_obj, "key", "")
    is_string(p)
    p != ""
}

# Flattened: args.projectKey
create_target_candidates contains upper(p) if {
    p := object.get(input.payload.args, "projectKey", "")
    is_string(p)
    p != ""
}

# Flattened: args.projectIdOrKey  (mirrors issueIdOrKey naming)
create_target_candidates contains upper(p) if {
    p := object.get(input.payload.args, "projectIdOrKey", "")
    is_string(p)
    p != ""
}

# Snake-case variant: args.project_key
create_target_candidates contains upper(p) if {
    p := object.get(input.payload.args, "project_key", "")
    is_string(p)
    p != ""
}

# Bare-string variant: args.project = "HR".  is_string guard prevents collision
# with the REST shape above (where args.project is an object).
create_target_candidates contains upper(p) if {
    p := object.get(input.payload.args, "project", "")
    is_string(p)
    p != ""
}

# -----------------------------------------------------------------------------
# MOVE target project — same family of arg-shape variants as create.
# -----------------------------------------------------------------------------

move_target_candidates contains upper(p) if {
    p := object.get(input.payload.args, "targetProjectKey", "")
    is_string(p)
    p != ""
}

move_target_candidates contains upper(p) if {
    p := object.get(input.payload.args, "targetProjectIdOrKey", "")
    is_string(p)
    p != ""
}

move_target_candidates contains upper(p) if {
    p := object.get(input.payload.args, "target_project_key", "")
    is_string(p)
    p != ""
}

move_target_candidates contains upper(p) if {
    target := object.get(input.payload.args, "targetProject", {})
    p := object.get(target, "key", "")
    is_string(p)
    p != ""
}

# -----------------------------------------------------------------------------
# Deny rules
# -----------------------------------------------------------------------------

allow := false if {
    some suffix in write_tool_suffixes
    endswith(tool_name, suffix)
    issue_in_sensitive_project
}

allow := false if {
    some suffix in link_tool_suffixes
    endswith(tool_name, suffix)
    linked_issue_in_sensitive_project
}

allow := false if {
    some suffix in create_tool_suffixes
    endswith(tool_name, suffix)
    some candidate in create_target_candidates
    sensitive_projects[candidate]
}

allow := false if {
    endswith(tool_name, "-movejiraissue")
    some candidate in move_target_candidates
    sensitive_projects[candidate]
}

# -----------------------------------------------------------------------------
# Reasons
# -----------------------------------------------------------------------------

reasons contains msg if {
    some suffix in write_tool_suffixes
    endswith(tool_name, suffix)
    issue_in_sensitive_project
    key := object.get(input.payload.args, "issueIdOrKey", "")
    project := project_from_issue_key(key)
    msg := sprintf("Modifying issues in the '%s' project is not permitted. Contact your InfoSec team if this needs to change.", [project])
}

reasons contains "Linking to or from an issue in a protected project is not permitted. Contact your InfoSec team if this needs to change." if {
    some suffix in link_tool_suffixes
    endswith(tool_name, suffix)
    linked_issue_in_sensitive_project
}

reasons contains msg if {
    some suffix in create_tool_suffixes
    endswith(tool_name, suffix)
    some project in create_target_candidates
    sensitive_projects[project]
    msg := sprintf("Creating issues in the '%s' project is not permitted. Contact your InfoSec team if this needs to change.", [project])
}

reasons contains msg if {
    endswith(tool_name, "-movejiraissue")
    some project in move_target_candidates
    sensitive_projects[project]
    msg := sprintf("Moving issues into the '%s' project is not permitted. Contact your InfoSec team if this needs to change.", [project])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
