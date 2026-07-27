---
name: "JIRA: Freeze Destructive Issue Operations"
tags:
  - jira
  - atlassian
  - freeze-destructive-ops
  - record-integrity
  - data-protection
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # jira / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on the frozen destructive tools, allow everything else
  **Package:** `jira.ingress.freeze_destructive_ops`

  ## What it does

  Freezes the three irreversible Jira operations on the agent channel:
  `jira_delete_issue`, `jira_remove_issue_link`, and `jira_remove_watcher`. Any
  tool call whose lowercased name ends with one of those suffixes is denied for
  all callers, with an optional break-glass exemption for a placeholder
  `jira-admins` group. Every other Jira tool — reads, searches, issue
  creates/edits, comments, worklogs, transitions, link creation, watcher
  addition — passes through untouched.

  The check runs at ingress, before the call reaches the Jira MCP server, so a
  frozen operation never executes: the issue, link, or watcher survives an
  injected prompt or an erring agent. When destruction is genuinely required, a
  human performs it through a reviewed native Jira workflow (or, for planned
  maintenance, from an account in the break-glass group).

  These three tools exist only on the community **sooperset/mcp-atlassian**
  server. The official Atlassian **Rovo** MCP server exposes **no delete tools at
  all** (verified in the app landscape note — it cannot delete issues, links,
  pages, or comments). So on official-connector deployments this policy is a
  zero-cost safety net that never fires; on community / Data-Center deployments
  it is the control that actually stops destructive agent behaviour. Because it
  costs nothing where it cannot fire, it is worth keeping attached everywhere as
  a categorical backstop.

  ## Relationship to `deny-write-sensitive-projects`

  This policy complements
  [`jira/deny-write-sensitive-projects`](../deny-write-sensitive-projects/policy.md),
  which blocks *writes* only within a configured sensitive-project set. That
  policy leaves destruction available outside the sensitive set; this one makes
  the three irreversible operations unavailable to the agent **org-wide, on every
  project**, so records survive agent error or prompt injection regardless of
  which project they live in. Run both: sensitive-project write fencing plus a
  categorical destruction freeze.

  ## Compliance alignment

  This policy instantiates the record-freeze family (PF-06,
  `freeze-destructive-ops`) on Jira's destructive surface, and supports alignment
  with:

  - **SOC 2 PI1.5** — integrity of stored records: denies agent-driven deletion
    that would compromise the completeness of stored issue data.
  - **HIPAA §164.312(c)** — integrity (anti-alteration) of ePHI that may live in
    Jira issues; **§164.530(c)** — privacy safeguards, by removing an
    irreversible destruction path from the agent channel.
  - **GDPR Art. 5(1)(d)** — accuracy: prevents mass agent-driven loss of records
    (an accuracy/availability failure) by freezing destruction over MCP.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `mcp-atlassian-jira_delete_issue`), and that prefix is not standardized. The
  policy matches on the tool-name **suffix** so it stays portable across
  server-name conventions, and lowercases the name first so casing never causes a
  silent miss:

  - `*jira_delete_issue`
  - `*jira_remove_issue_link`
  - `*jira_remove_watcher`

  These are the community sooperset/mcp-atlassian names (verified in the
  landscape note). The official Rovo server has no delete tools, so there is no
  official-naming variant to add. If your community deployment renames these
  tools, add the new suffixes to `destructive_tool_suffixes` in `policy.md`.

  The name is read from **both** the PARC field (`input.resource.name`) and the
  legacy alias (`input.payload.name`) via `object.get` chains, and the two are
  matched **independently** — a request that omits the `resource` block, or one
  carrying a malformed (non-string) value in either field, still cannot skip the
  match. Each field is coerced to a lowercased string (a number, null, array, or
  object resolves to the empty string), so a non-string value in one field can
  never suppress a genuine destructive suffix in the other.

  `name_of` also fails closed against a **malformed container**: if `resource`
  or `payload` is itself a bare string (e.g. `"resource": "jira_delete_issue"`
  instead of `{"name": ...}`), the string is matched directly rather than lost
  to `object.get`'s default. A number/array/null container, or one with a
  non-string `name`, resolves to the empty string. The gateway always builds
  these as objects, so this is defense-in-depth, not a reachable gateway path.

  ## Argument shape

  None. The decision uses only the tool name (`input.resource.name`, with the
  legacy `input.payload.name` as fallback) and the caller's identity
  (`input.subject.claims.groups`); `input.payload.args` is never read. A frozen
  call is denied even if it arrives with missing, empty, or unexpected arguments;
  there is no arg shape an attacker can craft to slip past it.

  ## Identity / break-glass

  An optional `allow if` branch exempts members of a placeholder `jira-admins`
  group, read from the caller's IdP-issued `groups` claim via
  `object.get(object.get(input.subject, "claims", {}), "groups", [])`. This lets a
  designated maintenance account perform destruction through the agent during
  planned cleanup without detaching the policy. The check fails closed: a caller
  with no `subject`, no `claims`, no `groups`, or no matching group is **not**
  exempt and the operation is denied. The `groups` claim is honored **only when
  it is a JSON array** (`is_array` guard): a bare string, or an object/map shape
  such as `{"role": "jira-admins"}`, is rejected — without that guard a Rego
  `some group in groups` would iterate an object's *values* and let a map-shaped
  claim satisfy the grant.

  To freeze destruction for *everyone* (including admins), delete the break-glass
  `allow if { is_destructive_tool; caller_is_admin }` branch — the
  `default allow := false` then denies all callers on the three frozen tools.

  ## Examples

  ### Denied (agent tries to delete an issue)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "mcp-atlassian-jira_delete_issue", "type": "tool" },
      "subject": { "sub": "google-apps|agent@acme.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "mcp-atlassian-jira_delete_issue",
        "args": { "issue_key": "PROJ-123" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "This destructive Jira operation ... is frozen on the agent channel. ..."`.

  ### Allowed (non-destructive Jira write)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "mcp-atlassian-jira_add_watcher", "type": "tool" },
      "payload": {
        "name": "mcp-atlassian-jira_add_watcher",
        "args": { "issue_key": "PROJ-123", "account_id": "5b10..." }
      }
    }
  }
  ```

  `allow = true`, no reason. (Adding a watcher is allowed; only *removing* one is
  frozen.)

  ### Allowed (break-glass admin deletes during maintenance)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "mcp-atlassian-jira_delete_issue", "type": "tool" },
      "subject": { "sub": "google-apps|admin@acme.com", "claims": { "groups": ["jira-admins"] } },
      "payload": {
        "name": "mcp-atlassian-jira_delete_issue",
        "args": { "issue_key": "PROJ-123" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ## Composition

  Single-purpose by design. Useful companions in the
  [`atlassian`](../../../bundles/atlassian/README.md) bundle:

  - [`jira/deny-write-sensitive-projects`](../deny-write-sensitive-projects/policy.md)
    — write-side fencing for designated Jira projects (see above).
  - [`confluence/freeze-page-deletion`](../../confluence/freeze-page-deletion/policy.md)
    — the parallel freeze for `confluence_delete_page` /
    `confluence_delete_attachment` (this policy only fences Jira destruction).
  - A publication-control policy on Confluence page creates/updates to keep
    drafts from publishing org-wide.

  ## Known limitations

  - **Exact-suffix match only.** The rule fires on names ending in
    `jira_delete_issue` / `jira_remove_issue_link` / `jira_remove_watcher`. A
    future community tool with a different name (e.g. `jira_delete_issues` or
    `jira_purge_issue`) would not be covered — add its suffix if your server
    exposes one. It does not fire on names where the destructive verb is embedded
    mid-string.
  - **Suffix match assumes the literal registered tool name.** A name padded
    with surrounding whitespace or a trailing newline (e.g.
    `"jira_delete_issue\n"` or `" jira_delete_issue "`) does not end in a frozen
    suffix and would pass through. This is not reachable through the gateway: the
    upstream MCP server routes only its exactly-registered tool names, so a padded
    name never resolves to a real destructive tool and never executes. A
    `tests.yaml` case pins this behaviour so a future change to add `trim`/
    normalisation is a deliberate decision, not an accident.
  - **Group names are placeholders — replace `jira-admins` with your IdP's group
    name at import time.** The break-glass branch is only as trustworthy as the
    `groups` claim your IdP issues; Auth0 and Entra ID both require explicit
    configuration to emit `groups`. If callers can self-assert group membership,
    remap it to a claim your IdP controls, or remove the branch entirely to
    freeze destruction for all callers. With no `groups` claim the policy still
    fails closed: destruction is denied for everyone.
  - **Community-server-specific.** These tool names exist only on
    sooperset/mcp-atlassian. On official Rovo deployments the policy is inert (no
    delete tools exist), which is intended defense-in-depth, not a gap.
  - **Destruction via other paths is out of reach.** This only covers the MCP
    channel. A user deleting an issue in the Jira web UI or via the REST API is
    outside the gateway's scope by design. Destruction-by-overwrite (e.g.
    `jira_update_issue` blanking fields) is also out of scope — that belongs to a
    write-gating companion policy, not this delete/remove freeze.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - jira
industries: []
bundles:
  - atlassian
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package jira.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit a request. Every
# non-destructive tool is allowed; the three frozen tools are allowed only for
# the break-glass admin group.
default allow := false

# -----------------------------------------------------------------------------
# FROZEN TOOLS: irreversible community sooperset/mcp-atlassian Jira operations.
# These names exist only on the community server; the official Rovo server has
# no delete tools, so the rule simply never fires there. Suffix matching keeps
# the policy portable across gateway server-name prefixes (e.g.
# `mcp-atlassian-jira_delete_issue`).
# -----------------------------------------------------------------------------
destructive_tool_suffixes := {
    "jira_delete_issue",
    "jira_remove_issue_link",
    "jira_remove_watcher",
}

# -----------------------------------------------------------------------------
# BREAK-GLASS: members of this IdP group may still run destructive operations
# (planned maintenance). Placeholder — remap to your IdP's group name at import
# time. Delete the `allow if { is_destructive_tool; caller_is_admin }` branch
# below to freeze destruction for everyone, including admins.
# -----------------------------------------------------------------------------
admin_group := "jira-admins"

# Tool name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), so a request
# that somehow omits the resource block still cannot skip matching (red-team
# hardening: missing resource must not fail open). name_of coerces to a
# lowercased string and handles three container shapes so the match cannot be
# skipped by a malformed request:
#   1. normal:  input[key] is an object with a string "name".
#   2. bare-string container: input[key] is ITSELF the tool-name string (a
#      malformed request that sends `resource: "jira_delete_issue"` instead of
#      `resource: {"name": "..."}`). object.get(<string>, "name", "") returns
#      the default "" — so without this branch the destructive name would be
#      lost and the call would fail OPEN. Match the container value directly.
#   3. anything else (missing key, number, array, null, or a non-string name):
#      resolves to "" rather than leaving the rule undefined.
name_of(key) := lower(container) if {
    container := object.get(input, key, {})
    is_string(container)
}

name_of(key) := lower(v) if {
    container := object.get(input, key, {})
    not is_string(container)
    v := object.get(container, "name", "")
    is_string(v)
}

name_of(key) := "" if {
    container := object.get(input, key, {})
    not is_string(container)
    v := object.get(container, "name", "")
    not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

# The two names are matched independently. Keeping separate branches means a
# malformed (non-string) value in one field cannot suppress a real destructive
# suffix in the other.
is_destructive_tool if {
    some suffix in destructive_tool_suffixes
    endswith(resource_name, suffix)
}

is_destructive_tool if {
    some suffix in destructive_tool_suffixes
    endswith(payload_name, suffix)
}

# Groups from the caller's IdP-issued JWT. Fail closed: a missing subject,
# missing claims, missing groups, or a non-array groups value all yield "not
# admin", so the destructive call is denied.
caller_is_admin if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    # Only honor an array-shaped groups claim. `some x in obj` iterates an
    # object's VALUES, so without this guard an object-shaped claim such as
    # {"role": "jira-admins"} would silently satisfy the break-glass grant.
    # is_array forces every non-array shape (string, object, number, null) to
    # fail closed — no exemption.
    is_array(groups)
    some group in groups
    group == admin_group
}

# Allow everything that is not a frozen destructive tool.
allow if {
    not is_destructive_tool
}

# Break-glass: allow a frozen destructive operation for members of the admin group.
allow if {
    is_destructive_tool
    caller_is_admin
}

# Deny reason for a non-admin caller hitting a frozen destructive tool.
reasons contains "This destructive Jira operation (delete issue, remove issue link, or remove watcher) is frozen on the agent channel because it is irreversible: records must survive agent error and prompt injection. Perform the deletion through a human-reviewed native Jira workflow instead. For legitimate admin cleanup, ask a member of your Jira admin group (placeholder: jira-admins) to run it, or ask your InfoSec team to add you to that group." if {
    is_destructive_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
