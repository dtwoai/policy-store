---
name: Freeze Destructive Linear Operations
tags:
  - linear
  - freeze-destructive-ops
  - record-integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # linear / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `linear.ingress.freeze_destructive_ops`

  ## What it does

  Denies destructive Linear tool calls — the **delete**, **archive**, and **session-logout** classes — unless the caller's IdP token carries the placeholder group `linear-admins`. Every read tool and every non-destructive write passes through unchanged.

  The destructive set is the community `tacticlaunch/mcp-linear` sidecar's destructive surface. Explicitly covered:

  - **`linear_deleteComment`, `linear_deleteInitiative`** — permanent deletes (Linear's *delete* is trash-then-permanent, distinct from recoverable *archive*).
  - **`linear_archiveIssue`, `linear_archiveDocument`, `linear_archiveTeam`** — archives (archiving a team removes a whole team's workspace).
  - **`linear_removeUserFromTeam`** — a membership-destruction verb that does not begin with delete/archive/logout, so it is matched explicitly.
  - **`linear_logoutAllSessions`, `linear_logoutOtherSessions`, `linear_logoutSession`** — session revocation. `logoutAllSessions` logs the user out of Linear everywhere — an account-level denial-of-service an agent should never be able to trigger.

  Matching is by **verb class**, not by an enumerated list: any community tool whose verb segment is `delete`/`archive`/`logout` (anchored on the tacticlaunch `linear_` tool prefix) is gated, plus `removeUserFromTeam` by name. So future community destructive tools (`linear_deleteWebhook`, `linear_deleteCustomer`, `linear_archiveProject`, `linear_archiveMilestone`, …) are frozen without a policy update.

  The **official** Linear remote server (`mcp.linear.app`) exposes **no delete/archive/logout verbs** as of the last verified enumeration — its verbs are `list_`/`get_`/`create_`/`update_`. So on the official path this policy is a **safe no-op** that costs nothing; its job is to **fence the community sidecar**, where an agent acting on a hallucinated "cleanup" step or a prompt-injection payload could otherwise destroy records or lock a user out of Linear. The check runs at ingress, before the call reaches the MCP server, so a blocked delete/archive/logout never executes.

  `default allow := false` here bites **only** on the matched destructive tools — the deny-by-default is neutralized for every other tool by an explicit pass-through `allow` branch (`not is_destructive_tool`). Reads (`get_issue`, `linear_getIssues`, `linear_searchDocuments`, …) and non-destructive writes (`create_issue`, `linear_createIssue`, `linear_updateIssue`, `linear_createComment`, …) are never touched by this policy.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports integrity of stored records by removing the agent's unilateral ability to destroy them (comments, issues, initiatives, documents, and team workspaces cannot be permanently deleted or archived by a non-admin caller over the agent channel, whether by agent error or injected instruction); the admin-group exemption keeps the destructive verbs under least-privilege control (aligns with the RBAC posture of CC6.3). The session-logout freeze additionally supports availability of the record system by preventing an agent-triggered account lockout.

  ## Tool name matching

  The community `tacticlaunch/mcp-linear` server prefixes every tool with `linear_` and uses camelCase verbs (`linear_deleteComment`, `linear_archiveIssue`, `linear_logoutAllSessions`). Behind a DTwo gateway the tool additionally receives the configured server-name prefix (e.g. `linear-linear_deleteComment`). The verb sits **between** the `linear_` prefix and the object noun, so matching is done on the verb segment, case-insensitively, after normalizing underscores to hyphens:

  - **`linear-delete` / `linear-archive` / `linear-logout` (substring match).** These anchor on the tacticlaunch tool's **own** `linear_` prefix (normalized to `linear-`), which the tool keeps regardless of the gateway server-name prefix. So `linear_deleteComment`, `linear-linear_deleteComment` (gateway-prefixed), and `foo-linear_deleteComment` (any server name) all match, and the match does not depend on knowing the gateway's server name.
  - **`removeuserfromteam` (substring match).** `linear_removeUserFromTeam` is a destructive membership verb outside the three verb classes, so it is caught by an explicit `contains` (same operator as the verb-class markers, so it is robust to a trailing-decorated name).

  Underscores are normalized to hyphens before matching, so a snake_case-named destructive variant (e.g. a hypothetical `linear_delete_comment`) is gated too. The name is read from both the PARC field (`input.resource.name`) and the legacy alias (`input.payload.name`) via `object.get` chains, and the two are matched **independently** — as long as **at least one** of the two fields still carries the real tool name, a request that garbles or omits the *other* field cannot skip the match. Each field is coerced to a lowercased, whitespace-trimmed string (a number, null, array, or object resolves to the empty string), so a non-string value in one field can never suppress a genuine destructive verb in the other. `trim_space` strips leading/trailing whitespace (spaces, tabs, newlines) so padding the verb with a trailing space or newline (`linear_deleteComment\n`) does not evade the match. Note the corollary: if the **only** populated name field is a non-string (or both are), it coerces to the empty string and the call is treated as non-destructive and passes through — harmless because such a malformed PARC cannot route to a real destructive tool at the MCP server (see Known limitations).

  The official server exposes no delete/archive/logout verbs and its tool set drifts (catalogs count 23 → 31), and the community set is ~150 tools. Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  None. The decision uses only the tool name (`input.resource.name`, with the legacy `input.payload.name` as fallback) and the caller's identity (`input.subject.claims.groups`); arguments are not inspected. A delete/archive/logout call takes only a record or session identifier, so there is nothing in the arguments to distinguish a safe destructive call from a dangerous one — the whole verb class is frozen.

  Group membership is read via an `object.get(input.subject, "claims", {})` chain and fails closed: a missing subject, missing claims, missing `groups`, or a non-array `groups` value all mean "not admin", so the destructive call is denied.

  ## Examples

  ### Allowed — read tool, any caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "linear-linear_getIssues", "type": "tool" },
      "payload": { "name": "linear-linear_getIssues", "args": { "teamId": "T1" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — archiveIssue by an admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "linear-linear_archiveIssue", "type": "tool" },
      "subject": { "sub": "admin@example.com", "claims": { "groups": ["linear-admins"] } },
      "payload": { "name": "linear-linear_archiveIssue", "args": { "id": "ISS-1" } }
    }
  }
  ```

  `allow = true`.

  ### Denied — logoutAllSessions by a non-admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "linear-linear_logoutAllSessions", "type": "tool" },
      "subject": { "sub": "user@example.com", "claims": { "groups": ["engineering"] } },
      "payload": { "name": "linear-linear_logoutAllSessions", "args": {} }
    }
  }
  ```

  `allow = false`, `reason = "This destructive Linear operation is blocked (...)"`.

  ## Composition

  This policy is single-purpose: it freezes the delete/archive/logout classes plus `removeUserFromTeam`, and nothing else. Pair it with:

  - a **webhook lockdown** (ingress deny of `*createWebhook`/`*deleteWebhook`/`*updateWebhook`) — a standing webhook is out-of-band exfiltration and is intentionally out of scope here,
  - a **membership + impersonation deny** on `*addUserToTeam`/`*updateTeamMembership` (grants) — this policy only freezes the *removal* verb,
  - a **destructive-edit guard** on `update_issue`/`linear_updateIssue` if silent overwrite of a security ticket's description is in scope (see Known limitations),
  - an **egress redaction / roadmap-egress gate** on the read tools that leak initiatives, customer data, and audit events.

  ## Known limitations

  - **Group names are placeholders — replace `linear-admins` with your IdP's group name at import time.** The gate reads `input.subject.claims.groups`; confirm your IdP actually emits a `groups` claim (Auth0 and most IdPs require explicit configuration) before relying on the admin exemption. With no `groups` claim the policy still fails closed: destructive calls are denied for everyone.
  - **Destructive *edits* are out of scope.** This policy freezes delete/archive/logout verbs; it does **not** stop a destructive *update* — e.g. `update_issue` / `linear_updateIssue` overwriting a description, silently closing a security ticket, or `linear_updateIssueCustomField` clearing a value. Linear deliberately flattens its API so an update can blank fields. Guard those with a separate write/field-scope policy.
  - **Community-prefix assumption.** Matching anchors on the tacticlaunch `linear_` tool prefix and specifically on the `linear`→verb boundary being an **underscore** (normalized to `linear-<verb>`). Three ways a name could slip the delete/archive/logout markers, all requiring a differently-named upstream tool: (a) a community server drops the `linear_` prefix entirely and the gateway server name does not contain `linear` (a bare `delete_comment` → `lin-delete-comment`, no `linear-delete`); (b) a server glues the prefix without a separator (`linearDeleteComment` → `lineardeletecomment`, no hyphen); (c) a destructive verb outside `delete`/`archive`/`logout` and not containing `removeUserFromTeam` (e.g. a `purge*` or `destroy*` verb). In every case the name the gateway routes on differs from a real tacticlaunch tool, so a *real* `linear_delete*`/`archive*`/`logout*` call is still frozen — these are gaps against hypothetical differently-named servers, not evasions of the enumerated destructive set. The official server has no delete/archive/logout verbs, so this is a fence for community traffic; for a hard guarantee against unknown tools, compose the PF-28 `default-deny-unknown-tools` allowlist alongside this policy.
  - **Verb-class matching is broad by design.** It catches the whole community delete/archive/logout class (including tools not enumerated above, such as `linear_deleteWebhook` or `linear_archiveMilestone`). For a record-integrity freeze, over-matching is the safe direction. A read tool is not caught because the anchor is `linear-delete`/`linear-archive`/`linear-logout`: a read like `linear_getDocumentContentHistory` or `linear_getInitiatives` contains no such segment.
  - **Substring matching is exact apart from surrounding whitespace.** Matching is on the lowercased, `trim_space`d, underscore-normalized name, so leading/trailing spaces, tabs, and newlines are handled, and a trailing-decorated verb (extra chars after `deleteComment` / `removeUserFromTeam`) is still caught because every marker uses `contains`. It does **not** normalize other characters: a name carrying an invisible non-whitespace code point *inside* the verb (e.g. U+200B zero-width space) or a Unicode homoglyph of the verb would not match and would pass through. Likewise, a call whose only populated name field is a non-string (array/object/number/null) coerces to the empty string and passes through as non-destructive. These are not real evasions on a correctly configured gateway — the gateway routes on the exact server-registered tool name, so a padded/homoglyph/malformed name does not resolve to the real destructive tool at the MCP server — but if you cannot rely on that invariant, compose the PF-28 `default-deny-unknown-tools` allowlist alongside this policy.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - linear
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package linear.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit the request.
# Note: the pass-through allow branch (`not is_destructive_tool`) neutralizes
# this default for every non-destructive tool, so the default-deny bites only
# on the matched destructive verbs.
default allow := false

# Placeholder IdP group allowed to run destructive Linear operations.
# Replace "linear-admins" with your IdP's group name at import time.
admin_group := "linear-admins"

# --- Destructive verb matching ---
# The community tacticlaunch/mcp-linear server prefixes tools with `linear_`
# and uses camelCase verbs (linear_deleteComment, linear_archiveIssue,
# linear_logoutAllSessions). Behind a DTwo gateway the tool also gets the
# configured server-name prefix (e.g. linear-linear_deleteComment). The verb
# sits BETWEEN the `linear_` prefix and the object noun, so we match on the
# verb segment (not a clean suffix), anchored on the tool's own `linear_`
# prefix so the gateway server name is irrelevant. The official Linear server
# has no delete/archive/logout verbs, so this is a no-op there.
# Verify the exact names on your gateway with the dump-input debug technique.

# Verb-class markers (underscores normalized to hyphens before matching):
# any tool whose verb segment after the community `linear_` prefix is
# delete/archive/logout is destructive.
destructive_markers := [
    "linear-delete",
    "linear-archive",
    "linear-logout",
]

# Explicit destructive verbs outside the three classes. removeUserFromTeam is
# membership-destruction that does not start with delete/archive/logout, so it
# is matched as a substring (contains, not endswith) — consistent with the
# verb-class markers above and, since over-match is the safe direction for a
# record-integrity freeze, it also catches any trailing-decorated variant.
destructive_substrings := ["removeuserfromteam"]

# Tool name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), so a
# request that somehow omits the resource block still cannot skip matching
# (red-team hardening: missing resource must not fail open).
# name_of coerces to a lowercased, whitespace-trimmed, underscore-normalized
# string. A missing OR non-string value (number, null, array, object) resolves
# to "" rather than leaving the rule undefined — an undefined name would make
# the match checks undefined and skip matching entirely (fail-open).
# trim_space strips leading/trailing whitespace so a padded name like
# "linear_deleteComment\n" cannot slip past. Underscores are normalized to
# hyphens so the markers match camelCase (linear_deleteComment) and any
# snake_case variant (linear_delete_comment) alike.
name_of(key) := replace(trim_space(lower(v)), "_", "-") if {
    v := object.get(object.get(input, key, {}), "name", "")
    is_string(v)
}

name_of(key) := "" if {
    v := object.get(object.get(input, key, {}), "name", "")
    not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

# A single name is destructive if it contains a verb-class marker OR contains
# an explicit destructive verb.
name_is_destructive(n) if {
    some marker in destructive_markers
    contains(n, marker)
}

name_is_destructive(n) if {
    some sub in destructive_substrings
    contains(n, sub)
}

# Both names are checked independently. Keeping separate branches means a
# malformed (non-string) value in one field cannot suppress a real destructive
# verb in the other.
is_destructive_tool if {
    name_is_destructive(resource_name)
}

is_destructive_tool if {
    name_is_destructive(payload_name)
}

# --- Admin gate ---
# Reads the groups claim through object.get chains so a missing subject,
# missing claims, missing groups, or non-array groups value fails closed:
# the caller is simply not an admin and the destructive call is denied.
# The is_array guard is load-bearing: without it, a groups claim that is an
# OBJECT whose values happen to include "linear-admins" (e.g. {"0":"linear-admins"})
# would satisfy `some group in groups` and fail OPEN. Requiring an array means
# any non-array groups shape (string, object, number) fails closed.
caller_is_admin if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some group in groups
    group == admin_group
}

# Allow any tool outside the destructive set.
allow if {
    not is_destructive_tool
}

# Allow destructive tools only for members of the admin group.
allow if {
    is_destructive_tool
    caller_is_admin
}

reasons contains "This destructive Linear operation is blocked. Delete and archive tools permanently remove records (comments, issues, initiatives, documents, teams) with no agent-side undo, and the session-logout tools can lock a user out of Linear entirely, so a hallucinated cleanup step or a prompt-injection payload could destroy work or trigger an account denial-of-service. Route this request through a member of your Linear admin group (placeholder: linear-admins) instead. If you believe this block is a false positive, ask your InfoSec team to add you to that group." if {
    is_destructive_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
