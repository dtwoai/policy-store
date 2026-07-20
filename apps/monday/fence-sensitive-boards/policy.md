---
name: Fence Sensitive monday Boards by IdP Group
tags:
  - monday
  - fence-sensitive-scopes
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # monday / fence-sensitive-boards

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny fenced targets for callers outside the mapped group, allow otherwise
  **Package:** `monday.ingress.fence_sensitive_boards`

  ## What it does

  monday boards are schemaless business databases: HR/recruiting boards (candidate PII), CRM/deal
  boards (financial), and IT/security trackers routinely live in the same account behind a single
  flat API token. Sensitivity is a property of the **board / workspace ID**, not the tool. This
  policy converts that flat single-token scope into per-team least-privilege scoping by pinning
  sensitive board and workspace IDs to the IdP group required to touch them.

  The policy carries two placeholder maps — `fenced_boards` and `fenced_workspaces` — that pair a
  monday board/workspace ID with a group (e.g. board `1111111111` → `hr`, CRM board → `sales`,
  security-tracker board → `infosec`). At ingress it reads the target scope from `boardId`,
  `boardIds[]`, and `workspaceIds[]` on the inspected tools and denies the call when a requested ID
  is in a fenced set and the caller lacks the mapped group. Inspected tools:

  - **Reads** — `get_board_items_page`, `get_full_board_data`, `board_insights`, `get_updates`,
    `get_board_activity`, `read_docs`, `fetch_file_content`, and `search`.
  - **Writes** — `create_item`, `create_items` (batch), and `change_item_column_values`.

  `search` is special: it is monday's account-wide discovery surface. A `search` call that carries
  **no** `boardIds` and **no** `workspaceIds` filter is treated as account-wide discovery and is
  denied for non-privileged callers, so it cannot be used to enumerate around the fence. A scoped
  `search` is allowed only when none of its `boardIds`/`workspaceIds` are fenced away from the
  caller; an unscoped `search` is reserved for a caller who holds **every** fenced group (they could
  reach any fenced board anyway).

  Group membership is read from `input.subject.claims.groups` via `object.get` chains and fails
  closed: a missing, empty, or malformed `groups` claim never grants access to a fenced target — no
  group means not permitted. All tools this policy does not inspect pass through untouched.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identification and protection of confidential information by gating
    agent access to designated confidential boards to their mapped groups; **P4.1** — supports
    limiting personal-information use to identified purposes by keeping PI-bearing boards (HR/CRM)
    behind role fences on the agent channel.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary / role-based-limit
    standard by scoping agent access to PHI-bearing boards to the mapped group;
    **§164.308(a)(4)** — supports information access management: access to sensitive boards is
    authorized by IdP group on the MCP path; **§164.522(a)** — fenced board IDs can encode
    agreed-to restrictions on specific record sets.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored cardholder data by
    role: fence the CRM/deal or finance board so only the mapped group can pull it through an agent.
  - **GDPR Art. 9** — supports special-category protection by fencing boards holding health, HR, or
    other Art. 9 data; **Art. 5(1)(b)** — supports purpose limitation by keeping sensitive boards
    scoped to the team whose purpose they serve; **CPRA §1798.121** — supports the right to limit
    use of sensitive personal information by fencing SPI boards to a minimal group.

  ## Tool name matching

  Tool names are matched case-insensitively as an exact name or by `-`/`_`-separated suffix, so the
  policy tolerates any gateway server-name prefix (e.g. `monday-mcp_get_board_items_page`). The
  official monday server (`https://mcp.monday.com/mcp`) exposes these tools **unprefixed**:

  - Reads: `get_board_items_page`, `get_full_board_data`, `board_insights`, `get_updates`,
    `get_board_activity`, `read_docs`, `fetch_file_content`, `search`.
  - Writes: `create_item`, `create_items`, `change_item_column_values`.

  Suffix matching also catches the community `sakce/mcp-server-monday` `monday_`-prefixed spellings.
  Some share a suffix with the official names (`monday_create_item` matches `create_item`), but the
  sakce write-update and its board-content read are named differently and do **not** overlap, so the
  policy matches them explicitly: `update_item` (sakce's coarser equivalent of official
  `change_item_column_values`) and `list_items_in_groups` (its board-content read). That server's
  tool set is otherwise coarser and does not expose `board_insights`, `search`, `read_docs`, or
  `fetch_file_content`; its remaining reads are item-ID-scoped and cannot be fenced by board ID (see
  Known limitations). Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  - `get_board_items_page`, `get_full_board_data`, `board_insights`, `create_item`,
    `change_item_column_values`: scalar `boardId` (number or string).
  - `search`: `boardIds[]` and/or `workspaceIds[]` (arrays); absent → account-wide.
  - IDs are normalized to a trimmed string, so numeric and string encodings both match.

  The policy also reads a `boardIds[]` array and a `workspaceIds[]` array on **every** inspected
  tool defensively, so a tool that carries the scope under those keys is fenced the same way. See
  Known limitations for `read_docs` / `fetch_file_content`, whose real schemas name their targets
  differently.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-mcp_get_board_items_page", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "monday-mcp_get_board_items_page",
        "args": { "boardId": 9999999999 }   // not in fenced_boards
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-mcp_get_board_items_page", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "monday-mcp_get_board_items_page",
        "args": { "boardId": 1111111111 }   // fenced_boards → hr
      }
    }
  }
  ```

  `allow = false`, `reason = "monday board 1111111111 is fenced as sensitive and requires the 'hr' IdP group. (...)"`.

  ## Composition

  This policy is single-purpose: it fences reads/writes/search of pinned sensitive board and
  workspace IDs. Useful companions:

  - **`apps/monday/deny-graphql-escape-hatch`** (or equivalent) — deny `all_monday_api` /
    `all_api_read` / `all_api_write` / `manage_tools`. Without it, every fence here is bypassable
    via one raw GraphQL `query` string (see Known limitations).
  - An **egress PII/PHI redaction** policy on `get_board_items_page`, `get_full_board_data`,
    `read_docs`, and `get_updates` responses, to mop up regulated values that an authorized caller
    reads back (and to cover the reads this ingress policy does not scope by ID).
  - A **directory guard** denying `list_users_and_teams` for non-admin callers, since it returns
    account-wide names/emails independent of any board fence.

  ## Known limitations

  - **Literal, canonical-ID matching only.** The policy matches the exact board/workspace IDs in its
    maps. A board reached by an ID not on the list is not fenced. IDs are compared as trimmed strings
    after `sprintf` normalization of numbers, so `1111111111` (number) and `"1111111111"` (string)
    both match — but a non-canonical spelling that monday still resolves (e.g. a leading-zero
    `"01111111111"`, or an ID carrying surrounding formatting the API tolerates) will **not** match
    the fence key. Pin every sensitive board's exact canonical ID (and the enclosing workspace ID) at
    import time; the shipped IDs are placeholders.
  - **`read_docs` and `fetch_file_content` scope by item, not board.** In the real monday schema
    `read_docs` targets `ids[]` (+ a `type` of `ids|object_ids|workspace_ids`) and
    `fetch_file_content` targets `item_id` + `column_id` — neither carries a `boardId`. This policy
    fences them only when a `boardId` / `boardIds[]` / `workspaceIds[]` scope key is present (which
    `read_docs` does supply when `type` is `workspace_ids`). A doc or file fetched by a bare
    item/object ID is **not** fenced by this policy. Pair with the egress redaction companion, and
    fence the workspace IDs so `read_docs` with `type: workspace_ids` is caught.
  - **`create_items` (batch) arg shape is unverified.** The batch-create tool is fenced the
    same way as `create_item`, and the policy reads a board ID both from a top-level `boardId`
    and from a per-item `boardId` inside an `items[]` array. monday's exact `create_items` schema
    was not verified against source; if your server nests the board target under a different key
    (or accepts a `boardIds[]` on the batch call), confirm with the dump-input debug technique and
    extend `requested_board_ids`. A batch write that names no board ID the policy can see is not
    fenced (same residual as the account-wide-read limitation below).
  - **GraphQL escape hatch bypasses this policy.** `all_monday_api` / `all_api_read` /
    `all_api_write` reduce every board read/write to one opaque GraphQL string with no `boardId`
    argument to inspect. This policy does not cover them — attach the escape-hatch deny companion
    (see Composition), or every fence here is defeatable.
  - **Account-wide reads that name no board are not fenced.** `get_full_board_data` and friends are
    only fenced by the IDs supplied; a broad discovery path that returns a board without ever
    passing its ID as an argument cannot be caught statelessly. The `search` unscoped-discovery
    deny is the guard for the main enumeration surface; other account-wide readers should be paired
    with egress redaction. In particular, a board-scoped tool called with **no** board/workspace ID
    argument at all (e.g. a malformed or exploratory `get_board_items_page` with empty args) names
    no fenced target and so passes through — the fence only fires on a fenced ID it can see.
  - **Not every board-reading tool is inspected.** This policy fences the content-bearing reads
    (`get_board_items_page`, `get_full_board_data`, `board_insights`, `get_updates`,
    `get_board_activity`, `read_docs`, `fetch_file_content`). Other `boardId`-scoped readers on the
    official server — `get_board_info`, `get_board_schema`, `get_assets`, `fetch_custom_activity`,
    and the monday-dev sprint readers — are **not** fenced, so a caller can still learn a fenced
    board's structure/metadata or list its assets. Add the ones that matter for your data model to
    `is_board_scope_tool`, and rely on the egress redaction companion for the content itself.
  - **Workspace-scoped `search` can still cross the board fence.** A scoped `search` is allowed when
    none of its `boardIds`/`workspaceIds` are themselves fenced. If a fenced board lives inside a
    workspace that is **not** in `fenced_workspaces`, a `search` scoped to that (unfenced) workspace
    reaches the fenced board's items. Fence the **enclosing workspace ID** of every fenced board (add
    it to `fenced_workspaces`) so workspace-scoped discovery is caught too.
  - **Unscoped `search` is reserved for fully-privileged callers.** A caller holding every fenced
    group may run an unscoped account-wide `search`. If even that is unacceptable, tighten the
    unscoped-search allow rule to deny outright.
  - **`groups` claim must be an array of strings.** A string-valued or otherwise malformed claim
    fails closed (fenced targets deny). If your IdP emits groups under a different claim name (e.g.
    a namespaced custom claim), update `caller_groups` in the Rego.
  - **Community (sakce) item-ID-scoped tools are not fenced.** The policy fences the two sakce
    board-ID-scoped tools (`monday_update_item`, `monday_list_items_in_groups`). Its other sakce
    tools — `monday_get_items_by_id`, `monday_get_item_updates`, `monday_list_subitems_in_items`,
    and `monday_create_update` — address items by `itemId` with no board argument, so a stateless
    ingress policy cannot map them to a fenced board and they pass through. `monday_get_board_groups`
    / `monday_get_board_columns` return board structure/metadata and are treated like the official
    metadata readers below (uninspected). Pair with the egress redaction companion.
  - **A decoy scope downgrades the account-wide `search` guard.** The unscoped-`search` deny fires
    only when a call carries **no** `boardIds`/`workspaceIds` filter. A caller can make an otherwise
    account-wide search count as "scoped" by adding any non-fenced (even nonexistent) board ID, e.g.
    `boardIds: [1]`. This is allowed — but because a scoped search only returns the boards it names,
    a decoy ID reaches only that decoy board's data, not any fenced board. The guard stops blind
    account-wide enumeration, not a search a caller deliberately narrows to boards they may access.
  - **Placeholder configuration.** Board IDs, workspace IDs, and group names (`hr`, `sales`,
    `infosec`) are placeholders — replace them with your deployment's real monday IDs and IdP group
    names at import time.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - monday
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package monday.ingress.fence_sensitive_boards

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# ---------------------------------------------------------------------------
# Fence configuration — PLACEHOLDERS, replace at import time.
#
# monday sensitivity is a property of the board/workspace ID, not the tool.
# Pin each sensitive board's ID (and the enclosing workspace ID) to the IdP
# group required to touch it. Group names are compared case-insensitively
# against the caller's `groups` claim.

# monday board ID -> IdP group required to read/write/search it.
fenced_boards := {
    "1111111111": "hr",      # e.g. Recruiting / candidate pipeline board
    "2222222222": "sales",   # e.g. CRM / deal board
    "3333333333": "infosec", # e.g. Security-incident tracker board
}

# monday workspace ID -> IdP group required to read/search inside it.
fenced_workspaces := {
    "4444444444": "hr",      # e.g. People-ops workspace
    "5555555555": "infosec", # e.g. Security workspace
}

# ---------------------------------------------------------------------------
# Identity — read groups via object.get chains so a missing subject/claims/
# groups fails closed (no group -> no access to fenced targets).

caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# True when the caller's groups claim (an array of strings) contains `group`.
# A malformed (non-array) claim makes the iteration fail -> fail closed.
caller_has_group(group) if {
    some g in caller_groups
    lower(g) == lower(group)
}

# Every distinct group referenced by the fence maps. A caller holding all of
# them may run unscoped account-wide searches (they could reach any board).
fence_groups contains group if {
    some _, group in fenced_boards
}

fence_groups contains group if {
    some _, group in fenced_workspaces
}

privileged_search_caller if {
    every group in fence_groups {
        caller_has_group(group)
    }
}

# ---------------------------------------------------------------------------
# Tool matching. The gateway prefixes tool names with the configured MCP
# server name (separator not standardized), so match the exact name or a
# `-`/`_`-separated suffix, case-insensitively. Verify the exact names your
# gateway sends with the dump-input debug technique.

tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

tool_matches(suffix) if {
    tool_name == suffix
}

tool_matches(suffix) if {
    endswith(tool_name, sprintf("-%s", [suffix]))
}

tool_matches(suffix) if {
    endswith(tool_name, sprintf("_%s", [suffix]))
}

# Board-scoped reads and writes (scope arrives on boardId / boardIds[] /
# workspaceIds[]).
is_board_scope_tool if tool_matches("get_board_items_page")

is_board_scope_tool if tool_matches("get_full_board_data")

is_board_scope_tool if tool_matches("board_insights")

# get_updates returns item comments/updates (free-text, the richest PII surface
# on a board) and get_board_activity returns the board's change log; both are
# scoped by `boardId` in the monday schema, so a caller denied
# get_board_items_page could otherwise read the same fenced board's content
# through them. Fence them the same way. (Arg-shape unverified — see Known
# limitations; if either omits boardId the call passes through untouched.)
is_board_scope_tool if tool_matches("get_updates")

is_board_scope_tool if tool_matches("get_board_activity")

is_board_scope_tool if tool_matches("read_docs")

is_board_scope_tool if tool_matches("fetch_file_content")

is_board_scope_tool if tool_matches("create_item")

# Batch create. Distinct suffix from `create_item`, so it must be matched
# explicitly or the write fence is bypassable by creating items in bulk.
is_board_scope_tool if tool_matches("create_items")

is_board_scope_tool if tool_matches("change_item_column_values")

# Community sakce/mcp-server-monday board-scoped tools. Their suffixes do NOT
# overlap the official names, so suffix matching alone misses them: the sakce
# write-update tool is `monday_update_item` (verified boardId/itemId/columnValues
# args; coarser equivalent of official change_item_column_values) and its
# board-content read is `monday_list_items_in_groups` (takes a boardId). Match
# both so a sakce deployment's fenced-board write/read is not a free bypass.
# (list_items_in_groups arg shape is unverified — if it omits boardId the call
# passes through untouched, same posture as get_updates. sakce item-id-scoped
# tools — get_items_by_id, get_item_updates, list_subitems_in_items,
# create_update — carry no boardId and cannot be fenced statelessly; see Known
# limitations.)
is_board_scope_tool if tool_matches("update_item")

is_board_scope_tool if tool_matches("list_items_in_groups")

# Account-wide discovery surface.
is_search_tool if tool_matches("search")

# Any tool this policy inspects.
is_fenced_scope_tool if is_board_scope_tool

is_fenced_scope_tool if is_search_tool

# ---------------------------------------------------------------------------
# Argument extraction — object.get everywhere; monday IDs may arrive as
# numbers or strings, so normalize both to a trimmed string.

args := object.get(object.get(input, "payload", {}), "args", {})

to_id(x) := trim_space(x) if is_string(x)

to_id(x) := sprintf("%v", [x]) if is_number(x)

# Requested board IDs: scalar `boardId` plus a `boardIds[]` array (checked on
# every inspected tool defensively).
requested_board_ids contains id if {
    id := to_id(object.get(args, "boardId", ""))
    id != ""
}

requested_board_ids contains id if {
    some raw in object.get(args, "boardIds", [])
    id := to_id(raw)
    id != ""
}

# Batch tools (e.g. create_items) may carry a per-item boardId inside an
# `items[]` array rather than a top-level `boardId`. Pull those too so a bulk
# write cannot slip a fenced board past the top-level scalar check. `items`
# schema for create_items is unverified — see Known limitations.
requested_board_ids contains id if {
    some item in object.get(args, "items", [])
    id := to_id(object.get(item, "boardId", ""))
    id != ""
}

# Requested workspace IDs: a `workspaceIds[]` array.
requested_workspace_ids contains id if {
    some raw in object.get(args, "workspaceIds", [])
    id := to_id(raw)
    id != ""
}

# For search, "scoped" means at least one board or workspace filter is present.
search_scope_count := count(requested_board_ids) + count(requested_workspace_ids)

# ---------------------------------------------------------------------------
# Fence checks.

blocked_board if {
    some id in requested_board_ids
    group := object.get(fenced_boards, id, "")
    group != ""
    not caller_has_group(group)
}

blocked_workspace if {
    some id in requested_workspace_ids
    group := object.get(fenced_workspaces, id, "")
    group != ""
    not caller_has_group(group)
}

# ---------------------------------------------------------------------------
# Allow rules.

# Any tool this policy does not inspect passes through untouched.
allow if {
    not is_fenced_scope_tool
}

# Board-scoped reads/writes: allowed when no requested board/workspace ID is
# fenced away from the caller (or none is fenced at all).
allow if {
    is_board_scope_tool
    not blocked_board
    not blocked_workspace
}

# Scoped search: allowed when a board/workspace filter is present and none of
# its IDs are fenced away from the caller.
allow if {
    is_search_tool
    search_scope_count > 0
    not blocked_board
    not blocked_workspace
}

# Unscoped (account-wide) search can surface content from any fenced board, so
# it is reserved for callers holding every fenced group.
allow if {
    is_search_tool
    search_scope_count == 0
    privileged_search_caller
}

# ---------------------------------------------------------------------------
# Deny reasons.

reasons contains msg if {
    is_fenced_scope_tool
    some id in requested_board_ids
    group := object.get(fenced_boards, id, "")
    group != ""
    not caller_has_group(group)
    msg := sprintf("monday board %s is fenced as sensitive and requires the '%s' IdP group. Ask your monday admin for access, or contact InfoSec if this fence looks wrong.", [id, group])
}

reasons contains msg if {
    is_fenced_scope_tool
    some id in requested_workspace_ids
    group := object.get(fenced_workspaces, id, "")
    group != ""
    not caller_has_group(group)
    msg := sprintf("monday workspace %s is fenced as sensitive and requires the '%s' IdP group. Ask your monday admin for access, or contact InfoSec if this fence looks wrong.", [id, group])
}

reasons contains "Account-wide monday search is restricted while sensitive boards are fenced. Re-run the search with boardIds or workspaceIds scoped to boards you may access, or ask your monday admin for the fenced groups." if {
    is_search_tool
    search_scope_count == 0
    not privileged_search_caller
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
