---
name: "JIRA: Role-Gated Writes (Read-Only Default)"
tags:
  - jira
  - atlassian
  - role-gate-writes
  - access-control
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # jira / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny writes unless the caller is in the writer group; allow reads for everyone
  **Package:** `jira.ingress.role_gate_writes`

  ## What it does

  Makes Jira read-only by default on the MCP path. Every Jira **write** tool —
  creating an issue, editing an issue, transitioning an issue, commenting on an
  issue, logging work against an issue, and creating an issue link — is denied
  unless the caller's IdP `groups` claim contains the placeholder group
  `jira-writers`. Read and search tools (`getJiraIssue`,
  `searchJiraIssuesUsingJql`, and the project/issue-type metadata lookups) pass
  for everyone.

  This is the per-app least-privilege baseline (family PF-12). It complements the
  project-scoped
  [`deny-write-sensitive-projects`](../deny-write-sensitive-projects/policy.md)
  policy: where that one keeps *specific* projects unwritable by anyone, this one
  makes mutation the **exception org-wide** rather than the default. A
  prompt-injected agent operating as an ordinary read-only user cannot create,
  edit, transition, comment on, log work against, or link any issue — in any
  project — because it is not in the writer group. (Community servers ship
  additional write tools outside these six operation classes; those are
  intentionally out of this baseline's scope — see Known limitations.)

  The check runs at ingress, before the call reaches the Jira MCP server, so a
  denied write never executes and has no side effects.

  ## Compliance alignment

  This policy instantiates least-privilege write-gating (family PF-12) on Jira's
  write path, and supports alignment with:

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    Jira issues cannot be mutated over the agent channel without an explicit role
    grant. **CC6.3** — supports role-based access and least privilege: write
    capability is tied to a live IdP group, so removing the group in the IdP
    removes write access on the caller's next request.
  - **HIPAA §164.308(a)(4)** — supports information access management for Jira
    tenants that track PHI-adjacent work: write authorization is role-scoped.
    **§164.312(a)(1)** — supports technical access control with per-call identity
    taken from the caller's JWT.
  - **GDPR Art. 25** — supports data protection by design/default on the agent
    channel: the default posture is read-only. **Art. 29 / Art. 32(4)** —
    supports processing only on the controller's instructions: an unauthorized
    principal cannot alter personal data held in Jira through the agent.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `atlassian-jira-mcp-createjiraissue`), and that prefix is not standardized. All
  matching is therefore **case-insensitive and by suffix** on
  `lower(input.resource.name)`, covering both Jira MCP dialects at once:

  | Operation | Official Rovo suffix (camelCase, lowercased) | Community suffix (snake_case) |
  |---|---|---|
  | Create issue | `createjiraissue` | `jira_create_issue` |
  | Edit / update issue | `editjiraissue` | `jira_update_issue` |
  | Transition issue | `transitionjiraissue` | `jira_transition_issue` |
  | Comment on issue | `addcommenttojiraissue` | `jira_add_comment` |
  | Log work | `addworklogtojiraissue` | `jira_add_worklog` |
  | Create issue link | `createissuelink` | `jira_create_issue_link` |

  These six operations are the **complete `write_jira` tool group** of the
  official Atlassian Rovo server (which ships no delete tools at all), plus the
  community `sooperset/mcp-atlassian` equivalents of the same operations. Three
  community-only tools are also gated because they are variants of the same
  operation classes — leaving any of them open would let a non-writer perform a
  gated operation under a different name:

  - `jira_batch_create_issues` — issue creation in bulk;
  - `jira_edit_comment` — rewrites an existing comment (the comment surface the
    single-op suffixes gate);
  - `jira_link_to_epic` — links an issue to an epic (the linking surface the
    issue-link suffixes gate).

  Read and search tools carry none of these suffixes and pass. The tool name is
  taken from the PARC field `input.resource.name`, falling back to the legacy
  alias `input.payload.name` when the PARC field is missing, null, or not a
  string — so a degenerate tool hook cannot present a write as a read. Verify
  the exact names your gateway emits with the dump-input debug technique before
  relying on this in production, and extend `write_suffixes` in `policy.md` if
  your server exposes a write tool under a different name.

  ## Argument shape

  The decision uses only the tool name (`input.resource.name`, with a legacy
  `input.payload.name` fallback) and the caller's identity
  (`input.subject.claims.groups`). Tool arguments are not inspected, so
  the policy cannot be bypassed by unusual argument keys, nesting, or encodings —
  and it behaves identically whether or not a tool's argument schema is
  documented.

  ## Identity

  Group membership is read fail-closed via
  `object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])`:
  a missing subject, missing claims, a missing `groups` claim, or a `groups` claim
  that is not an array all mean "not a writer", and every write is denied. The
  `is_array` guard is load-bearing — `some group in caller_groups` iterates the
  *values* of an object, so a `groups` claim shaped as `{"role": "jira-writers"}`
  would otherwise match and fail **open**; requiring an array keeps every
  non-array shape (object, string, number) fail-closed. Reads are unaffected by
  identity.

  ## Examples

  ### Allowed — read tool, no identity required

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-getjiraissue", "type": "tool" },
      "payload": { "name": "atlassian-getjiraissue", "args": { "issueIdOrKey": "DEV-7" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — write tool, caller in the writer group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createjiraissue", "type": "tool" },
      "subject": { "sub": "auth0|alice", "claims": { "groups": ["jira-writers"] } },
      "payload": {
        "name": "atlassian-createjiraissue",
        "args": { "projectKey": "DEV", "summary": "New task" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — write tool, caller not in the writer group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-editjiraissue", "type": "tool" },
      "subject": { "sub": "auth0|bob", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "atlassian-editjiraissue",
        "args": { "issueIdOrKey": "DEV-7", "fields": { "summary": "changed" } }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Jira write tools are restricted to members of the 'jira-writers' group ..."`.

  ## Composition

  This policy is the Jira least-privilege baseline; it gates *who* may write, not
  *what* they may write. Useful companions in the same
  [`atlassian`](../../../bundles/atlassian/README.md) bundle:

  - [`deny-write-sensitive-projects`](../deny-write-sensitive-projects/policy.md)
    — even for authorized writers, keeps designated projects (HR, LEGAL, SEC)
    unwritable.
  - [`deny-view-search-sensitive-projects`](../deny-view-search-sensitive-projects/policy.md)
    — read/search fence for the same projects (this policy leaves reads open).
  - [`redact-sensitive-info`](../redact-sensitive-info/policy.md) — egress
    redaction of PII/secrets in returned issue content.

  ## Known limitations

  - **Group names are placeholders** — replace `jira-writers` with your IdP's
    group name at import time. The policy expects `groups` to be an array claim in
    the caller's JWT; if your IdP emits roles under a different or namespaced claim
    (e.g. `https://acme.com/groups` or `roles`), update `caller_groups` in
    `policy.md`.
  - **Reads are open to everyone.** `searchJiraIssuesUsingJql` and `getJiraIssue`
    (especially with `fields:["*all"]`) remain a broad egress channel — a
    read-only agent can still trawl issues across projects the user can see. Pair
    with a read/search fence (`deny-view-search-sensitive-projects`) and/or egress
    redaction if your Jira tenant holds regulated content.
  - **Closed write set — community write tools outside the gated operation
    classes are not gated.** The suffix list is the complete official Rovo
    `write_jira` group, its community equivalents, and the three community-only
    variants of the same operation classes (`jira_batch_create_issues`,
    `jira_edit_comment`, `jira_link_to_epic`). The community
    `sooperset/mcp-atlassian` server ships *additional* write and destructive
    tools that carry none of the gated suffixes and therefore pass as "reads":
    e.g. `jira_delete_issue`, `jira_remove_issue_link`, `jira_add_watcher`,
    `jira_create_remote_issue_link` (attaches an external URL, a different
    operation from the gated issue-to-issue `createissuelink`),
    `jira_update_proforma_form_answers` (updates issue-attached ProForma form
    answers — issue-adjacent data this baseline does not treat as an issue
    edit), and the sprint/version tools. This is intentional scope for the
    baseline; gate those with the destructive-op / sensitive-project companions,
    or add their suffixes to `write_suffixes`. The `jira_delete_issue`,
    `jira_create_remote_issue_link`, and `jira_update_proforma_form_answers`
    residuals are each covered by a documenting test case.
  - **Official non-`write_jira` write groups are not gated.** The official Rovo
    server also exposes write tools in permission groups outside `write_jira` —
    JSM Ops (e.g. `updateJsmOpsAlert`) and Compass (e.g.
    `createCompassComponent`); the landscape note lists these groups for
    completeness and notes JSM/Bitbucket tools run in API-token mode. They are
    not issue writes and are outside this baseline's scope, but if your tenant
    exposes them, gate them separately or extend `write_suffixes`. Covered by a
    documenting test case (`updatejsmopsalert` passes).
  - **Confluence is out of scope.** This is a Jira-only policy. Confluence writes
    (`createConfluencePage`, `updateConfluencePage`, comments) are handled by the
    separate `confluence` app policies.
  - **`groups`-claim spoofing is out of the gateway's hands.** The policy trusts
    the IdP-asserted `groups` claim; if a caller can mint tokens with arbitrary
    claims, that is an IdP/JWT-validation problem, not a policy one.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - jira
industries: []
bundles:
  - atlassian
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package jira.ingress.role_gate_writes

# Deny-by-default: reads are explicitly allowed below; every write requires
# membership in the writer group.
default allow := false

# Placeholder IdP group permitted to perform Jira writes.
# Replace "jira-writers" with your IdP's group name at import time.
writer_group := "jira-writers"

# Lowercased tool name. The gateway prefixes tool names with the configured MCP
# server name (e.g. `atlassian-jira-mcp-createjiraissue`), so matching below is
# case-insensitive and suffix-based to stay portable across naming conventions.
#
# PARC-first with a legacy fallback (red-team hardening): `resource.name` is the
# unified PARC field, but if a tool hook ever arrived with it missing, null, or
# non-string while the legacy alias `payload.name` still identified the tool,
# the write would otherwise look like a read and fail OPEN. The fallback keeps
# the gate on the legacy alias too. If neither field names the tool, there is no
# tool name to gate on and the non-write branch applies.
resource_name := object.get(object.get(input, "resource", {}), "name", "")

payload_name := object.get(object.get(input, "payload", {}), "name", "")

has_resource_name if {
    is_string(resource_name)
    resource_name != ""
}

tool_name := lower(resource_name) if {
    has_resource_name
}

tool_name := lower(payload_name) if {
    not has_resource_name
    is_string(payload_name)
}

# --- Write-tool detection ---
# The complete official Atlassian Rovo `write_jira` group (camelCase names,
# lowercased) plus the community sooperset/mcp-atlassian equivalents of the same
# six operations, plus the community-only variants of those same operation
# classes (batch create, comment rewrite, epic linking). Matched by suffix so
# any gateway server-name prefix still matches. endswith is exact at the tail,
# so read tools whose names merely contain "jiraissue" (getJiraIssue,
# getTransitionsForJiraIssue, getJiraIssueRemoteIssueLinks, ...) do not match
# any of these full suffixes.
write_suffixes := [
    # create issue
    "createjiraissue", # official Rovo
    "jira_create_issue", # community
    "jira_batch_create_issues", # community batch-create — same create operation in bulk
    # edit / update issue
    "editjiraissue", # official Rovo
    "jira_update_issue", # community
    # transition issue
    "transitionjiraissue", # official Rovo
    "jira_transition_issue", # community
    # comment on issue
    "addcommenttojiraissue", # official Rovo
    "jira_add_comment", # community
    "jira_edit_comment", # community — rewrites an existing comment; same comment surface
    # log work
    "addworklogtojiraissue", # official Rovo
    "jira_add_worklog", # community
    # create issue link
    "createissuelink", # official Rovo
    "jira_create_issue_link", # community
    "jira_link_to_epic", # community — links an issue to an epic; same linking surface
]

is_write_tool if {
    some suffix in write_suffixes
    endswith(tool_name, suffix)
}

# --- Identity (fail closed) ---
# Missing subject, missing claims, a missing groups claim, or a groups claim that
# is not an array all yield "not a writer" — writes then deny.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# The is_array guard is load-bearing: `some group in caller_groups` iterates the
# *values* of an object, so a groups claim shaped as {"role": "jira-writers"}
# would otherwise match and fail OPEN. Requiring an array keeps every non-array
# shape (object, string, number) fail-closed, as the Identity section promises.
caller_is_writer if {
    is_array(caller_groups)
    some group in caller_groups
    group == writer_group
}

# --- Decision ---

# Reads (and anything that is not one of the six gated write tools) pass for
# everyone.
allow if {
    not is_write_tool
}

# Writes pass only for members of the writer group.
allow if {
    is_write_tool
    caller_is_writer
}

reasons contains msg if {
    is_write_tool
    not caller_is_writer
    msg := sprintf("Jira write tools are restricted to members of the '%s' group — this account has read-only Jira access through the gateway. Ask your identity admin to add you to '%s', or hand this write (create, edit, transition, comment, worklog, or issue link) to a teammate with Jira write access. If this tool is actually read-only, contact your InfoSec team to update the policy.", [writer_group, writer_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
