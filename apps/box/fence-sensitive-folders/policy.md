---
name: Fence Sensitive Box Folders by IdP Group
tags:
  - box
  - fence-sensitive-scopes
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # box / fence-sensitive-folders

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny fenced targets for callers outside the mapped group, allow otherwise
  **Package:** `box.ingress.fence_sensitive_folders`

  ## What it does

  Fences pinned sensitive Box subtrees (HR, Finance, Legal, …) by ID. The policy carries two
  placeholder maps — `fenced_folders` and `fenced_files` — that pair Box folder/file IDs with the
  IdP group required to touch them (e.g. folder `1234567890` → `finance`). At ingress it denies:

  - **File reads, moves, and copies** — `get_file_content`, `get_download_url`, `get_file_preview`,
    `ai_qa_single_file`, `ai_qa_multi_file`, `ai_extract_*`, `move_file`, `copy_file` (official
    server) and `box_file_download_tool` / `box_file_text_extract_tool` / `box_file_copy_tool`
    (community server) — when the target `file_id` (or any `items[].id` / `file_ids[]` entry on
    multi-file AI tools) appears in `fenced_files` and the caller lacks the mapped group.
  - **Folder listings, details, moves, and copies** — `list_folder_content_by_folder_id`,
    `get_folder_details`, `move_folder`, `copy_folder` (official) and `box_folder_items_list_tool`
    / `box_folder_move_tool` (community) — when the target `folder_id` appears in `fenced_folders`
    and the caller lacks the mapped group.
  - **Search** — community `box_search_tool` is denied for non-privileged callers unless
    `ancestor_folder_ids` is present and every fenced ID in it maps to a group the caller holds
    (an unscoped search is allowed only for callers holding **every** fenced group, since it can
    surface content from any tree). Official `search_files_keyword` / `search_files_metadata`
    folder-scoping is checked the same way where the scoping argument is present.

  Group membership is read from `input.subject.claims.groups` via `object.get` chains and fails
  closed: a missing, empty, or malformed `groups` claim never grants access to a fenced target.
  All tools this policy does not inspect pass through untouched.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identification and protection of confidential information by gating
    agent access to designated confidential Box trees to their mapped groups; **P4.1** — supports
    limiting personal-information use to identified purposes by keeping PI-bearing folders behind
    role fences on the agent channel.
  - **HIPAA §164.308(a)(4)** — supports information access management: access to PHI-bearing Box
    folders is authorized by IdP group on the MCP path; **§164.522(a)** — fenced file IDs can
    encode agreed-to restrictions on specific patient records.
  - **GDPR Art. 9** — supports special-category protection by fencing folders holding health, HR,
    or other Art. 9 data; **CPRA §1798.121** — supports the right to limit use of sensitive
    personal information by fencing SPI folders to a minimal group.

  ## Tool name matching

  Tool names are matched case-insensitively as an exact name or by `-`/`_`-separated suffix, so
  the policy tolerates any gateway server-name prefix (e.g. `box-remote-get_file_content`):

  - Official (mcp.box.com): `get_file_content`, `get_download_url`, `get_file_preview`,
    `ai_qa_single_file`, `ai_qa_multi_file`, `move_file`, `copy_file`,
    `list_folder_content_by_folder_id`, `get_folder_details`, `move_folder`, `copy_folder`,
    `search_files_keyword`, `search_files_metadata`; any tool whose name contains `ai_extract_`
    (covers all six `ai_extract_*` variants).
  - Community (box-community/mcp-server-box): `box_file_download_tool`,
    `box_file_text_extract_tool`, `box_file_copy_tool`, `box_folder_items_list_tool`,
    `box_folder_move_tool`, `box_search_tool`.

  Verify the exact names your gateway sends with the dump-input debug technique before relying on
  this in production.

  ## Argument shape

  - File tools: `file_id` (string or number). Multi-file AI tools: `items[].id`; a flat
    `file_ids[]` array is also checked defensively.
  - Folder tools: `folder_id` (string or number).
  - Search tools: `ancestor_folder_ids` as an array of IDs or a comma-separated string. On the
    official server the exact scoping field name is partially unverified (see Known limitations).

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "box-remote-get_file_content", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "box-remote-get_file_content",
        "args": { "file_id": "5550001111" }   // not in fenced_files
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
      "resource": { "name": "box-remote-get_file_content", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "box-remote-get_file_content",
        "args": { "file_id": "9876543210" }   // fenced_files → finance
      }
    }
  }
  ```

  `allow = false`, `reason = "Box file 9876543210 is fenced as sensitive and requires the 'finance' IdP group. (...)"`.

  ## Composition

  This policy is single-purpose: it fences reads/moves/search of pinned sensitive IDs. Useful
  companions:

  - An external-sharing guard on `create_collaboration` / `*shared_link*` tools, so fenced content
    that an authorized caller reads cannot be re-shared outward.
  - An egress PII/PHI redaction policy on `get_file_content`, `ai_qa_*`, and search responses —
    it also mops up snippets an unscoped official search may surface (see Known limitations).
  - A destructive-op gate for the community server's `box_file_delete_tool` /
    `box_folder_delete_tool`.

  ## Known limitations

  - **Literal-ID matching only — no ancestry resolution.** The policy matches the exact IDs in
    its maps and cannot resolve Box folder ancestry statelessly. A file reached through an
    unlisted descendant ID is **not** fenced. Customers must pin the sensitive subtree's folder
    IDs (the root and any high-value descendant folders/files) at import time; the shipped ID
    lists are placeholders.
  - **Broad operations can still surface fenced descendants.** The same statelessness means an
    operation whose *own* target is an **unfenced ancestor** of a fenced tree is not caught:
    a recursive community listing of a parent folder (`box_folder_items_list_tool` with
    `is_recursive: true`, e.g. `folder_id: "0"`) enumerates items inside fenced subtrees, and a
    community search scoped to an unfenced ancestor (`ancestor_folder_ids: ["0"]`, or a malformed
    non-comma scope string that parses to a single non-fenced token) reads into fenced subtrees —
    both satisfy the "scoped is safe" allow rule and thereby sidestep the unscoped-search
    restriction. The scoped checks only test whether the *literal* ancestor IDs supplied are
    themselves fenced. Mitigate by pinning the sensitive **root** folder IDs (so a recursive
    listing or scoped search of the root itself is denied), pairing with an egress redaction
    policy (see Composition), and/or restricting recursive listing and root-scoped search
    operationally.
  - **Move/copy argument names partially unverified.** The `copy_file` / `box_file_copy_tool`
    fences read `file_id`, and `move_folder` / `copy_folder` / `box_folder_move_tool` read
    `folder_id`, matching the underlying Box API and the move/read tools already covered. Box does
    not publish these schemas; if a live tool names the moved/copied source item differently, that
    fence silently does not fire. Confirm against a live `tools/list`.
  - **Placeholder configuration.** Folder/file IDs and group names are placeholders — replace
    `finance` with your IdP's group name at import time, and replace the IDs with your real Box
    folder/file IDs.
  - **Official search scoping is partially unverified.** Box's docs do not publish the official
    server's full argument schemas; this policy assumes the scoping argument is named
    `ancestor_folder_ids` (matching the underlying Box Search API). If the live tool uses a
    different field name, the scoping check silently never fires. Confirm against a live
    `tools/list` before relying on it.
  - **Unscoped official search passes.** Per the design, `search_files_keyword` /
    `search_files_metadata` are only checked when the scoping argument is present — an unscoped
    official search can still surface fenced-tree snippets (Box enforces the caller's own Box
    permissions, but not this policy's group fence). Pair with an egress redaction policy, or
    tighten this policy to deny unscoped official search if that residual is unacceptable.
  - **AI-extract argument shapes are partially unverified.** The `ai_extract_*` and
    `ai_qa_multi_file` checks read `file_id`, `items[].id`, and `file_ids[]`; if the live schema
    nests file references elsewhere, those calls pass unchecked.
  - **Metadata reads are not fenced.** `get_file_details`, `list_file_comments`, and community
    `box_file_info_tool` can still reveal fenced item names/metadata; this policy targets content
    reads, listings, moves, and search only.
  - **`groups` claim must be an array of strings.** A string-valued or otherwise malformed claim
    fails closed (fenced targets deny). If your IdP emits groups under a different claim name
    (e.g. a namespaced custom claim), update `caller_groups` in the Rego.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - box
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package box.ingress.fence_sensitive_folders

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# ---------------------------------------------------------------------------
# Fence configuration — PLACEHOLDERS, replace at import time.
#
# The policy matches literal IDs and cannot resolve Box folder ancestry
# statelessly, so pin the folder IDs of every sensitive subtree root AND any
# high-value descendant folders here. Group names must match your IdP's
# `groups` claim values (compared case-insensitively).

# Box folder ID -> IdP group required to list/read/search inside it.
fenced_folders := {
    "1234567890": "finance", # e.g. /Finance subtree root
    "1234567891": "hr",      # e.g. /HR subtree root
    "1234567892": "legal",   # e.g. /Legal subtree root
}

# Box file ID -> IdP group required to read or move it. Use for pinned
# high-value documents (payroll exports, cap tables, case files).
fenced_files := {
    "9876543210": "finance", # e.g. payroll-2026.xlsx
    "9876543211": "hr",      # e.g. employee-roster.xlsx
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
# them may run unscoped community searches (they could read every tree anyway).
fence_groups contains group if {
    some _, group in fenced_folders
}

fence_groups contains group if {
    some _, group in fenced_files
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

# File-targeting tools (official server) — content reads, previews, AI Q&A,
# and moves of a specific file ID.
is_file_tool if tool_matches("get_file_content")

is_file_tool if tool_matches("get_download_url")

is_file_tool if tool_matches("get_file_preview")

is_file_tool if tool_matches("ai_qa_single_file")

is_file_tool if tool_matches("ai_qa_multi_file")

is_file_tool if tool_matches("move_file")

# Copying a fenced file duplicates its content into a caller-chosen (unfenced)
# location, from which it can be read freely — so fence copy like move/read.
is_file_tool if tool_matches("copy_file")

# All six official ai_extract_* variants send file content through Box AI.
is_file_tool if contains(tool_name, "ai_extract_")

# File-targeting tools (community box-community/mcp-server-box).
is_file_tool if tool_matches("box_file_download_tool")

is_file_tool if tool_matches("box_file_text_extract_tool")

is_file_tool if tool_matches("box_file_copy_tool")

# Folder-targeting tools — listings, details, and moves/copies of a specific
# folder ID. Relocating or duplicating a fenced folder by its literal ID is
# fenced too (symmetric with move_file); reaching a fenced tree through an
# UNFENCED ancestor ID cannot be caught statelessly — see Known limitations.
is_folder_tool if tool_matches("list_folder_content_by_folder_id")

is_folder_tool if tool_matches("get_folder_details")

is_folder_tool if tool_matches("move_folder")

is_folder_tool if tool_matches("copy_folder")

is_folder_tool if tool_matches("box_folder_items_list_tool")

is_folder_tool if tool_matches("box_folder_move_tool")

# Search tools.
is_community_search_tool if tool_matches("box_search_tool")

is_official_search_tool if tool_matches("search_files_keyword")

is_official_search_tool if tool_matches("search_files_metadata")

is_search_tool if is_community_search_tool

is_search_tool if is_official_search_tool

# Any tool this policy inspects.
is_fenced_scope_tool if is_file_tool

is_fenced_scope_tool if is_folder_tool

is_fenced_scope_tool if is_search_tool

# ---------------------------------------------------------------------------
# Argument extraction — object.get everywhere; Box IDs may arrive as strings
# or numbers, so normalize both to a trimmed string.

args := object.get(object.get(input, "payload", {}), "args", {})

to_id(x) := trim_space(x) if is_string(x)

to_id(x) := sprintf("%v", [x]) if is_number(x)

# Target file IDs: single `file_id`, multi-file `items[].id`, and a flat
# `file_ids[]` array (defensive — multi-file AI schemas are partially
# unverified).
requested_file_ids contains id if {
    id := to_id(object.get(args, "file_id", ""))
    id != ""
}

requested_file_ids contains id if {
    some item in object.get(args, "items", [])
    id := to_id(object.get(item, "id", ""))
    id != ""
}

requested_file_ids contains id if {
    some raw in object.get(args, "file_ids", [])
    id := to_id(raw)
    id != ""
}

requested_folder_id := to_id(object.get(args, "folder_id", ""))

# Search folder scoping: `ancestor_folder_ids` as an array of IDs or a
# comma-separated string (the official server's exact field name is partially
# unverified — see Known limitations).
ancestor_ids contains id if {
    raw := object.get(args, "ancestor_folder_ids", [])
    is_array(raw)
    some x in raw
    id := to_id(x)
    id != ""
}

ancestor_ids contains id if {
    raw := object.get(args, "ancestor_folder_ids", "")
    is_string(raw)
    some part in split(raw, ",")
    id := trim_space(part)
    id != ""
}

# ---------------------------------------------------------------------------
# Fence checks.

blocked_file_access if {
    some id in requested_file_ids
    group := object.get(fenced_files, id, "")
    group != ""
    not caller_has_group(group)
}

blocked_folder_access if {
    group := object.get(fenced_folders, requested_folder_id, "")
    group != ""
    not caller_has_group(group)
}

blocked_ancestor if {
    some id in ancestor_ids
    group := object.get(fenced_folders, id, "")
    group != ""
    not caller_has_group(group)
}

# ---------------------------------------------------------------------------
# Allow rules.

# Any tool this policy does not inspect passes through untouched.
allow if {
    not is_fenced_scope_tool
}

allow if {
    is_file_tool
    not blocked_file_access
}

allow if {
    is_folder_tool
    not blocked_folder_access
}

# Scoped community search: allowed when every fenced ancestor ID maps to a
# group the caller holds (or no fenced ID is present).
allow if {
    is_community_search_tool
    count(ancestor_ids) > 0
    not blocked_ancestor
}

# Unscoped community search can surface content from any fenced tree, so it
# is reserved for callers holding every fenced group.
allow if {
    is_community_search_tool
    count(ancestor_ids) == 0
    privileged_search_caller
}

# Official search: fence check applies only when the scoping argument is
# present (unscoped official search passes — documented residual).
allow if {
    is_official_search_tool
    not blocked_ancestor
}

# ---------------------------------------------------------------------------
# Deny reasons.

reasons contains msg if {
    is_file_tool
    some id in requested_file_ids
    group := object.get(fenced_files, id, "")
    group != ""
    not caller_has_group(group)
    msg := sprintf("Box file %s is fenced as sensitive and requires the '%s' IdP group. Ask your Box administrator for access, or contact InfoSec if this fence looks wrong.", [id, group])
}

reasons contains msg if {
    is_folder_tool
    group := object.get(fenced_folders, requested_folder_id, "")
    group != ""
    not caller_has_group(group)
    msg := sprintf("Box folder %s is a fenced sensitive tree and requires the '%s' IdP group. Ask your Box administrator for access, or contact InfoSec if this fence looks wrong.", [requested_folder_id, group])
}

reasons contains msg if {
    is_search_tool
    some id in ancestor_ids
    group := object.get(fenced_folders, id, "")
    group != ""
    not caller_has_group(group)
    msg := sprintf("Searching inside Box folder %s requires the '%s' IdP group. Remove it from ancestor_folder_ids, or ask your Box administrator for access.", [id, group])
}

reasons contains "Unscoped Box search is restricted while sensitive folders are fenced. Re-run the search with ancestor_folder_ids scoped to folders you may access, or ask your Box administrator for the fenced groups." if {
    is_community_search_tool
    count(ancestor_ids) == 0
    not privileged_search_caller
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
