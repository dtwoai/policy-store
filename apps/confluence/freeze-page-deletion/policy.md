---
name: "Confluence: Freeze Page & Attachment Deletion"
tags:
  - confluence
  - atlassian
  - freeze-destructive-ops
  - data-protection
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # confluence / freeze-page-deletion

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on the frozen delete tools, allow everything else
  **Package:** `confluence.ingress.freeze_page_deletion`

  ## What it does

  Freezes the two irreversible Confluence deletion tools on the agent channel:
  `confluence_delete_page` and `confluence_delete_attachment`. Any tool call
  whose name ends with one of those suffixes is denied for all callers, with an
  optional break-glass exemption for a placeholder `confluence-admins` group.
  Every other Confluence tool — reads, searches, page creates/updates, comment
  and label writes, attachment uploads — passes through untouched.

  The check runs at ingress, before the call reaches the Confluence MCP server,
  so a frozen deletion never executes: the page or attachment survives an
  injected prompt or an erring agent. When a human genuinely needs to delete
  wiki content, they do it through the Confluence UI (or, for maintenance, from
  an account in the break-glass group).

  These two tools exist only on the community **sooperset/mcp-atlassian** server.
  The official Atlassian **Rovo** MCP server exposes **no delete tools at all**
  (verified in the app landscape note — it cannot delete pages, attachments,
  issues, or comments). So on official-connector deployments this policy is a
  zero-cost safety net that never fires; on community deployments it is the
  control that actually stops destructive agent behaviour.

  ## Compliance alignment

  This policy instantiates the record-freeze family (PF-06,
  `freeze-destructive-ops`) on Confluence's deletion surface, and supports
  alignment with:

  - **SOX §802 / 18 U.S.C. §1519** — anti-destruction/alteration of records: the
    agent cannot destroy wiki pages or attachments that may be relied on as
    business records over the MCP path (Enforceable in the coverage matrix).
    Also supports **§802 / Rule 2-06** retention/legal-hold on evidence paths by
    keeping the agent from purging preserved content.
  - **SOC 2 PI1.5** — integrity of stored records: denies agent-driven deletion
    that would compromise the completeness of stored wiki content.
  - **HIPAA §164.312(c)** — integrity (anti-alteration) of ePHI that may live in
    Confluence pages/attachments; **§164.530(c)** — privacy safeguards, by
    removing an irreversible destruction path from the agent channel.
  - **GDPR Art. 5(1)(d)** — accuracy: prevents mass agent-driven loss of records
    (an accuracy/availability failure) by freezing bulk deletion over MCP.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `mcp-atlassian-confluence_delete_page`), and that prefix is not standardized.
  The policy matches on the tool-name **suffix** so it stays portable across
  server-name conventions, and lowercases the name first so casing never causes
  a silent miss:

  - `*confluence_delete_page`
  - `*confluence_delete_attachment`

  These are the community sooperset/mcp-atlassian names (verified in the
  landscape note). The official Rovo server has no delete tools, so there is no
  official-naming variant to add. If your community deployment renames these
  tools, add the new suffixes to `destructive_tool_suffixes` in `policy.md`.

  The name is read from **both** the PARC field (`input.resource.name`) and the
  legacy alias (`input.payload.name`) via `object.get` chains, and the two are
  matched **independently** — a request that omits the `resource` block, or one
  carrying a malformed (non-string) value in either field, still cannot skip the
  match. Each field is coerced to a lowercased, **whitespace-trimmed** string (a
  number, null, array, or object resolves to the empty string), so a non-string
  value in one field can never suppress a genuine delete suffix in the other,
  and a name padded with trailing spaces/newlines (`"confluence_delete_page \n"`)
  still matches the frozen suffix.

  ## Argument shape

  This policy makes its decision purely from the tool **name** and the caller's
  identity — it does not read `input.payload.args` at all. That means a frozen
  delete call is denied even if it arrives with missing, empty, or unexpected
  arguments; there is no arg shape an attacker can craft to slip past it.

  ## Identity / break-glass

  An optional `allow if` branch exempts members of a placeholder
  `confluence-admins` group, read from the caller's IdP-issued `groups` claim via
  `object.get(object.get(input.subject, "claims", {}), "groups", [])`. This lets a
  designated maintenance account perform deletions through the agent during
  planned cleanup without detaching the policy. The check fails closed: a caller
  with no `subject`, no `claims`, no `groups`, or no matching group is **not**
  exempt and the deletion is denied. The `groups` claim is honored **only when
  it is a JSON array** (`is_array` guard): a bare string, or an object/map shape
  such as `{"role": "confluence-admins"}`, is rejected — without that guard a
  Rego `some group in groups` would iterate an object's *values* and let a
  map-shaped claim satisfy the grant.

  To freeze deletions for *everyone* (including admins), delete the break-glass
  `allow if` branch — the `default allow := false` then denies all callers on the
  two frozen tools.

  ## Examples

  ### Denied (agent tries to delete a page)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "mcp-atlassian-confluence_delete_page", "type": "tool" },
      "subject": { "sub": "google-apps|agent@acme.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "mcp-atlassian-confluence_delete_page",
        "args": { "page_id": "123456" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Deleting Confluence pages or attachments is frozen on the agent channel. ..."`.

  ### Allowed (non-destructive Confluence write)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "mcp-atlassian-confluence_update_page", "type": "tool" },
      "payload": {
        "name": "mcp-atlassian-confluence_update_page",
        "args": { "page_id": "123456", "title": "Runbook", "body": "..." }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed (break-glass admin deletes during maintenance)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "mcp-atlassian-confluence_delete_page", "type": "tool" },
      "subject": { "sub": "google-apps|admin@acme.com", "claims": { "groups": ["confluence-admins"] } },
      "payload": {
        "name": "mcp-atlassian-confluence_delete_page",
        "args": { "page_id": "123456" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ## Composition

  Single-purpose by design. Useful companions in the
  [`atlassian`](../../../bundles/atlassian/README.md) bundle:

  - A parallel Jira freeze policy for `jira_delete_issue` /
    `jira_remove_issue_link` (this policy allows those through — it only fences
    Confluence deletion).
  - [`jira/deny-write-sensitive-projects`](../../jira/deny-write-sensitive-projects/policy.md)
    — write-side fencing for designated Jira projects.
  - A publication-control policy on `*confluence_create_page` /
    `*confluence_update_page` to keep drafts from publishing org-wide.

  ## Known limitations

  - **Exact-suffix match only.** The rule fires on names ending in
    `confluence_delete_page` / `confluence_delete_attachment`. A future community
    tool with a different name (e.g. `confluence_delete_pages` or
    `confluence_purge_page`) would not be covered — add its suffix if your server
    exposes one. It does not fire on names where the delete verb is embedded
    mid-string (e.g. `confluence_delete_page_tree`).
  - **Invisible-character padding is not normalized.** Names are lowercased and
    whitespace-trimmed before matching, so trailing spaces/newlines cannot dodge
    the suffix — but a name padded with a non-whitespace invisible character
    (e.g. a zero-width space, U+200B) does evade the match. This is not an
    exploitable deletion path: MCP servers dispatch tools by exact name, so the
    padded name is an unknown tool and the call fails at the server rather than
    deleting anything. Recorded here so the residual is explicit.
  - **Content blanking and moves are not deletion.** `confluence_update_page` /
    `confluence_update_page_section` can overwrite or empty a page's body, and
    `confluence_move_page` can relocate a page — all pass through this policy.
    Those edits are versioned and recoverable from page history (unlike the
    frozen delete tools, which are irreversible), which is why they are out of
    scope; pair with a publication-control or write-fencing policy if edit-level
    protection is needed.
  - **Group names are placeholders — replace `confluence-admins` with your IdP's
    group name at import time.** The break-glass branch is only as trustworthy as
    the `groups` claim your IdP issues; if callers can self-assert group
    membership, remap it to a claim your IdP controls, or remove the branch
    entirely to freeze deletions for all callers.
  - **Break-glass requires an array-valued `groups` claim.** The exemption only
    honors `groups` when it is a JSON array (`is_array` guard). An IdP that
    flattens a single group into a bare string (`"groups":
    "confluence-admins"`), or emits an object/map shape, will **not** satisfy
    the break-glass branch, so that admin is denied — a fail-closed, safe-side
    outcome, but if your IdP emits string-valued groups, normalize the claim to
    an array before relying on break-glass.
  - **Community-server-specific.** These tool names exist only on
    sooperset/mcp-atlassian. On official Rovo deployments the policy is inert (no
    delete tools exist), which is intended defense-in-depth, not a gap.
  - **Deletion via other paths is out of reach.** This only covers the MCP
    channel. A user deleting a page in the Confluence web UI or via the REST API
    is outside the gateway's scope by design.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - confluence
industries: []
bundles:
  - atlassian
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package confluence.ingress.freeze_page_deletion

# Deny-by-default: only the explicit allow rules below permit a request. Every
# non-destructive tool is allowed; the two frozen delete tools are allowed only
# for the break-glass admin group.
default allow := false

# -----------------------------------------------------------------------------
# FROZEN TOOLS: irreversible Confluence deletion tools. These names exist only
# on the community sooperset/mcp-atlassian server; the official Rovo server has
# no delete tools, so the rule simply never fires there. Suffix matching keeps
# the policy portable across gateway server-name prefixes (e.g.
# `mcp-atlassian-confluence_delete_page`).
# -----------------------------------------------------------------------------
destructive_tool_suffixes := {
    "confluence_delete_page",
    "confluence_delete_attachment",
}

# -----------------------------------------------------------------------------
# BREAK-GLASS: members of this IdP group may still delete (planned maintenance).
# Placeholder — remap to your IdP's group name at import time. Delete the
# `allow if { is_destructive_tool; is_admin }` branch below to freeze deletion
# for everyone, including admins.
# -----------------------------------------------------------------------------
admin_group := "confluence-admins"

# Tool name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), so a request
# that somehow omits the resource block still cannot skip matching (red-team
# hardening: missing resource must not fail open). name_of coerces to a
# lowercased, whitespace-trimmed string: a missing OR non-string value (number,
# null, array, object) resolves to "" rather than leaving the rule undefined —
# a non-string resource.name must never suppress a real delete suffix in
# payload.name — and trim_space stops trailing-space/newline padding
# ("confluence_delete_page \n") from dodging the suffix match (red-team fix).
name_of(key) := trim_space(lower(v)) if {
    v := object.get(object.get(input, key, {}), "name", "")
    is_string(v)
}

name_of(key) := "" if {
    v := object.get(object.get(input, key, {}), "name", "")
    not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

# The two names are matched independently. Keeping separate branches means a
# malformed (non-string) value in one field cannot suppress a real delete
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
# admin", so the frozen deletion is denied.
is_admin if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    # Only honor an array-shaped groups claim. `some g in obj` iterates an
    # object's VALUES, so without this guard an object-shaped claim such as
    # {"role": "confluence-admins"} would silently satisfy the break-glass
    # grant. is_array forces every non-array shape (string, object, number,
    # null) to fail closed — no exemption.
    is_array(groups)
    some g in groups
    g == admin_group
}

# Allow everything that is not a frozen deletion tool.
allow if {
    not is_destructive_tool
}

# Break-glass: allow a frozen deletion for members of the admin group.
allow if {
    is_destructive_tool
    is_admin
}

# Deny reason for a non-admin caller hitting a frozen deletion tool.
reasons contains "Deleting Confluence pages or attachments is frozen on the agent channel. Deletions are irreversible, so a human must perform them in the Confluence UI. Contact your Confluence admins if this deletion is required." if {
    is_destructive_tool
    not is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
