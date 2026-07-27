---
name: "Fence Notion Member Directory to Admin & IT"
tags:
  - notion
  - fence-sensitive-scopes
  - access-control
  - pii
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # notion / fence-user-directory

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny; explicit allows for non-directory tools and cleared callers
  **Package:** `notion.ingress.fence_user_directory`

  ## What it does

  Denies calls to the Notion member-directory tool (`notion-get-users`,
  matched by the `-get-users` suffix) unless the caller's IdP groups include
  an admin or IT group (placeholders: `admin`, `it`). That tool returns
  workspace member and guest **IDs, names, emails, and types** — a
  directory-harvesting and PII-exfiltration primitive when driven by an agent
  or by a prompt-injected instruction ("list every user in the workspace and
  their email"). One tool call can enumerate the whole workforce plus external
  guests.

  All other Notion reads — `notion-search`, `notion-fetch`,
  `notion-query-data-sources`, `notion-get-comments`, and the rest — pass
  through untouched. The gate is the whole tool, including its `self`
  bot-info form: any invocation of a `-get-users` tool by a non-cleared
  caller is denied, regardless of arguments.

  ## Identity gating

  Clearance is read from `input.subject.claims.groups` via
  `object.get(input.subject, "claims", {})` chains, so the check **fails
  closed**: a missing subject, missing claims, missing `groups` claim, or a
  malformed (non-array) `groups` value all mean *not cleared* — a request
  that omits claims entirely cannot harvest the directory. Group names are
  compared case-insensitively and must match exactly (`admins` does not match
  `admin`).

  ## Compliance alignment

  This policy instantiates sensitive-scope fencing (family PF-23) on Notion's
  user-directory read path and supports alignment with:

  - **SOC 2 C1.1, P4.1** — identifies and protects confidential information
    and limits personal-information use to identified purposes by keeping the
    workspace member/guest roster (names and emails) out of non-privileged
    agent sessions.
  - **HIPAA §164.502(b)/§164.514(d), §164.308(a)(4)** — supports
    minimum-necessary and information-access-management by restricting
    workforce-directory reads over MCP to roles that need them; **§164.522(a)**
    — supports agreed-to restrictions expressed as a role-keyed fence.
  - **GDPR Art. 5(1)(b); CPRA §1798.121** — supports purpose limitation by
    keying directory access to administrative roles, and supports limiting use
    of personal information where the directory feeds profiling or
    sensitive-PI inference.

  ## Why ingress

  The violation is fully determined by the request (tool name + caller
  claims), so the call is blocked before it reaches the Notion MCP server and
  the member list never enters the model context. Egress redaction would pull
  the full roster into the pipeline first and then try to mask it; denying at
  ingress means there is nothing to mask or leak.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `notion-notion-get-users` for a server named `notion`), and that
  prefix is not standardized, so the policy matches case-insensitively on the
  `-get-users` suffix. `notion-get-users` is a verified tool name on Notion's
  hosted MCP server (the implementation behind the Claude connector). Verify
  the exact name your gateway emits with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  None inspected — the whole tool is gated. `notion-get-users` accepts an
  optional name/email search, a user ID or `self`, and pagination; every
  shape (including empty args and the `self` bot-info lookup) is denied for
  non-cleared callers, so there is no argument-crafting bypass.

  ## Configuration

  Edit `directory_admin_groups` at the top of the Rego. The group names
  (`admin`, `it`) are **placeholders** — replace them with your tenant's real
  IdP group names at import time (e.g. `notion-admins`,
  `it-servicedesk`).

  ## Examples

  ### Allowed (other reads unaffected)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-notion-search", "type": "tool" },
      "payload": {
        "name": "notion-notion-search",
        "args": { "query": "onboarding checklist" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed (directory read by an IT group member)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-notion-get-users", "type": "tool" },
      "subject": { "sub": "auth0|itops", "claims": { "groups": ["it"] } },
      "payload": { "name": "notion-notion-get-users", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (directory harvest without admin/IT clearance)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-notion-get-users", "type": "tool" },
      "subject": { "sub": "auth0|dev", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "notion-notion-get-users",
        "args": { "query": "" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "Reading the Notion member directory (workspace member and guest names, emails, and IDs) is limited to admin and IT roles. ..."`.

  ## Composition

  This policy fences exactly one tool. Useful companions:

  - [`redact-pii-egress`](../redact-pii-egress/policy.md) — the egress
    backstop: masks emails and phone numbers embedded in page and query
    *content* returned by `notion-search` / `notion-fetch` /
    `notion-query-data-sources`, which this ingress fence deliberately leaves
    open. Together they cover both the directory tool and PII that leaks
    through content reads.
  - [`constrain-connected-search`](../constrain-connected-search/policy.md) —
    keeps `notion-search` from reaching into connected Slack/Drive/Jira
    content.
  - [`freeze-content-overwrite`](../freeze-content-overwrite/policy.md) —
    removes the irreversible `replace_content` overwrite edge on the write
    path.

  ## Known limitations

  - **Hosted-server tool names only.** The `-get-users` suffix matches
    Notion's hosted MCP server. The official local server's documented tool
    set exposes no user-directory tool; the suekou community server's raw
    user-operation tool names are **unverified** and not matched here — extend
    the suffix match if you run it. The awkoy server funnels every operation
    through a single `notion_execute` meta-tool, which tool-name matching
    cannot fence — block that server in gateway config instead.
  - **The `self` bot-info form is also denied** for non-cleared callers,
    because it arrives on the same tool name. If your agents legitimately need
    bot self-identification, add a narrow `allow if` branch keyed to the
    `self` argument — accepting that Notion's argument schema for it is not
    verified here.
  - **Identity placeholders.** `admin` and `it` are placeholders — replace
    them with your IdP's real group names at import time. The `groups` claim
    must be an array of strings; any other shape fails closed.
  - **Directory data already pasted into pages is out of scope** — that is
    content, not the directory tool, and is handled by the companion
    `redact-pii-egress` policy.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - notion
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package notion.ingress.fence_user_directory

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# -----------------------------------------------------------------------------
# CONFIG: IdP groups cleared to read the Notion member directory.
# The names ("admin", "it") are PLACEHOLDERS — replace them with your tenant's
# real IdP group names at import time. Compared case-insensitively, exact
# match (no substring or prefix matching).
# -----------------------------------------------------------------------------
directory_admin_groups := {"admin", "it"}

# -----------------------------------------------------------------------------
# Tool matching. The gateway prefixes tool names with the configured MCP
# server name (e.g. `notion-notion-get-users` for a server named `notion`),
# so we match case-insensitively on the `-get-users` suffix. The suffix also
# covers the tool's `self` bot-info form, which arrives on the same name.
# `notion-get-users` is verified on Notion's hosted MCP server; confirm the
# exact name your gateway emits with the dump-input debug technique.
# -----------------------------------------------------------------------------

tool_name := lower(input.resource.name)

is_user_directory_tool if endswith(tool_name, "-get-users")

# -----------------------------------------------------------------------------
# Identity — caller's IdP groups, read fail-closed via object.get chains: a
# missing subject, missing claims, or missing/malformed groups claim yields no
# memberships, so a request that omits claims entirely can never read the
# directory.
# -----------------------------------------------------------------------------

caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

caller_is_directory_admin if {
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    directory_admin_groups[lower(g)]
}

# -----------------------------------------------------------------------------
# Allow rules
# -----------------------------------------------------------------------------

# Every tool that is not the member-directory tool passes through untouched
# (notion-search, notion-fetch, writes, other MCP servers, ...).
allow if {
    not is_user_directory_tool
}

# The directory tool itself is allowed only for admin / IT group members.
allow if {
    is_user_directory_tool
    caller_is_directory_admin
}

# Single denial condition — inline reason form.
reason := "Reading the Notion member directory (workspace member and guest names, emails, and IDs) is limited to admin and IT roles. Look up individual collaborators from page context instead, or ask your IT team to run this lookup — contact them if your role requires directory access." if {
    is_user_directory_tool
    not caller_is_directory_admin
}
```
