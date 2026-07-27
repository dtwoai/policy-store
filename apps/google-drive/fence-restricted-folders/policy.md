---
name: Fence Restricted Google Drive Files and Folders
tags:
  - google-drive
  - fence-restricted-folders
  - sensitive-scopes
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # google-drive / fence-restricted-folders

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on restricted-ID match, allow otherwise
  **Package:** `google_drive.ingress.fence_restricted_folders`

  ## What it does

  Fences an admin-maintained denylist of restricted Google Drive file and folder
  IDs — HR records, M&A deal rooms, board packs, payroll — off the agent channel:

  1. **Read fence.** Drive read/metadata tools (content reads, downloads, file
     metadata, file permissions) are denied when the file ID they address is on
     the restricted list. The blocked call never reaches the Drive MCP server.
  2. **Write fence (staging-for-exfil).** Any tool call whose destination
     folder targets a restricted folder is denied, so an agent cannot stage
     files into — or move content through — a fenced location. Two destination
     shapes are checked: the scalar `parentFolderId` (piotr-agier) and the
     `parents` array (the Drive REST API v3 convention the official Google
     server mirrors), plus the shape-drift variants a server may send —
     `parents` as a bare string, `parents` as an array of v2
     `{"id": ...}` objects, and `parentFolderId` as an array.
  3. **Copy-out fence.** A `copy_file` / `copyFile` call whose *source* ID is on
     the restricted list is denied, so an agent cannot duplicate fenced content
     into an unrestricted, agent-readable location and then read the copy.

  Members of a placeholder `hr` IdP group are exempt from both fences via the
  caller's `groups` claim. A caller with a missing `subject`, missing `claims`,
  or missing/empty `groups` claim **fails closed**: no claims, no exemption.

  The restricted-ID list ships with obvious placeholders. **Pin your tenant's
  real Drive IDs at import time** — grab them from each folder's URL
  (`https://drive.google.com/drive/folders/<ID>`) and replace every
  `REPLACE-WITH-…` entry.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identification and protection of confidential
    information: the tenant names its confidential Drive locations and the
    gateway refuses agent access to them; **P4.1** — supports limiting personal
    information use to identified purposes by keeping HR and payroll folders
    out of general-purpose agent workflows.
  - **HIPAA §164.502(b)/§164.514(d)** — supports minimum-necessary, role-based
    limits on folders that hold employee health, leave, and benefits records;
    **§164.308(a)(4)** — information access management on the agent channel;
    **§164.522(a)** — supports honoring agreed-to restrictions by expressing
    them as denylist predicates.
  - **GDPR Art. 9** — supports special-category protection: HR folders routinely
    hold health, absence, and union-membership data, which this fence keeps away
    from agents; **Art. 5(1)(b)** — purpose limitation; **CPRA §1798.121** —
    supports the right to limit use of sensitive personal information. Fencing
    HR folders also supports **GDPR Art. 22 / 11 CCR §7200** by keeping
    employment records out of automated agent decision flows.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `gdrive-mcp-read_file_content`), so this policy matches case-insensitive
  **suffixes** to stay portable across deployments. Read/metadata suffixes fenced:

  - **Google official Drive MCP server / Claude connector:** `read_file_content`,
    `download_file_content`, `get_file_metadata`, `get_file_permissions`.
  - **isaacphi/mcp-gdrive:** `gdrive_read_file`, `gsheets_read`.
  - **piotr-agier/google-drive-mcp:** `downloadfile`, `readgoogledoc`,
    `readgoogledocpaginated`, `getgooglesheetcontent`, `getgoogleslidescontent`.

  The write fence is deliberately **not** tool-scoped — any call carrying a
  restricted destination folder (in `parentFolderId` or the `parents` array)
  is denied, whichever write tool carries it. The copy-out fence is tool-scoped to the verified copy suffixes
  `copy_file` (Google) and `copyFile` (piotr-agier), matched case-insensitively;
  the source ID itself is compared exactly (case-sensitive) against the
  denylist, as Drive IDs are case-sensitive. Verify the exact names your gateway sends with the
  dump-input debug technique before relying on this in production.

  ## Argument shape

  The read fence looks up the target file ID with `object.get` across four
  candidate argument names, matching the community-documented Drive server
  schemas: `fileId`, `documentId`, `spreadsheetId`, `presentationId` (exact,
  case-sensitive JSON keys). The write fence reads the destination folder from
  either `parentFolderId` (scalar, piotr-agier) or `parents` (array, the Drive
  REST API v3 shape the official Google server mirrors). The
  copy-out fence reuses the same four `id_arg_keys` to find the copy's source
  ID. Each key is read in both shapes: the scalar string (the common case) and
  an **array** of ID strings (single-parent SDK wrappers / batch-style callers);
  the read and copy-out fences are therefore array-tolerant, matching the write
  fence's own shape tolerance. ID comparison against the denylist is exact and
  case-sensitive, as Drive IDs are. A fenced tool call that carries none of the
  candidate keys passes through (there is no ID to check — see Known
  limitations).

  ## Examples

  ### Allowed — read of a file that is not on the list

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gdrive-mcp-read_file_content", "type": "tool" },
      "payload": {
        "name": "gdrive-mcp-read_file_content",
        "args": { "fileId": "1a2B3c4D5e6F7g8H9i0J" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — read of a restricted file

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gdrive-mcp-read_file_content", "type": "tool" },
      "payload": {
        "name": "gdrive-mcp-read_file_content",
        "args": { "fileId": "REPLACE-WITH-HR-FOLDER-ID" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This file or folder is on the organization's restricted Google Drive list (...)"`.

  ### Denied — upload staged into a restricted folder

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gdrive-mcp-uploadFile", "type": "tool" },
      "payload": {
        "name": "gdrive-mcp-uploadFile",
        "args": { "name": "notes.txt", "parentFolderId": "REPLACE-WITH-PAYROLL-FOLDER-ID" }
      }
    }
  }
  ```

  `allow = false`, `reason = "The destination folder is on the organization's restricted Google Drive list (...)"`.

  ## Composition

  This policy is single-purpose: it fences a named set of Drive IDs. Useful
  companions in this app directory:

  - [`role-gate-writes`](../role-gate-writes/policy.md) — gates *all* Drive
    write tools by IdP group; covers edits addressed by file ID, which this
    fence deliberately leaves to it.
  - [`freeze-destructive-ops`](../freeze-destructive-ops/policy.md) — blocks
    the destructive tier (`deleteItem`, `deleteSheet`, ...).
  - [`guard-acl-recon`](../guard-acl-recon/policy.md) — broader control on
    `get_file_permissions` beyond the fenced IDs.
  - [`redact-pii-egress`](../redact-pii-egress/policy.md) — egress redaction on
    content-returning tools, a second line of defense if a restricted file is
    reached under an unexpected argument name.

  ## Known limitations

  - **Restricted IDs are import-time placeholders.** Replace every
    `REPLACE-WITH-…` entry in `restricted_ids` with your tenant's real Drive
    file/folder IDs. Until you do, the policy fences nothing real.
  - **No hierarchy resolution.** The policy sees only the literal ID in the
    call; Drive IDs do not encode ancestry, and ingress cannot ask Drive who a
    file's parents are. Files *inside* a restricted folder that are addressed
    by their own ID must be listed individually (folder IDs only stop
    folder-addressed reads and `parentFolderId` writes).
  - **Official-server argument field names are unverified.** Google's MCP
    reference does not publish per-tool parameter schemas (it defers to
    `tools/list` at the live endpoint). The four candidate keys cover the
    community-documented shapes; if the official server spells the field
    differently (e.g. `file_id`), the fence silently misses. Pull `tools/list`
    through your gateway and extend `id_arg_keys` before production use. Each
    key is now read in both scalar and array shapes: a restricted
    `fileId`/`documentId`/… wrapped in a one-element array previously slipped
    the read and copy-out fences (they share `requested_ids`) even though the
    write fence was array-tolerant — that asymmetry was found and closed in
    red-team review (see the array-shaped-ID test cases).
  - **Write-fence destination field names are unverified (field NAMES, not
    shapes).** The write fence checks the scalar `parentFolderId` (piotr-agier,
    verified) and the `parents` array (the Drive REST API v3 convention the
    official Google server is expected to mirror, **unverified** pending
    `tools/list`). Shape drift on those two fields is now handled defensively:
    `parents` as a bare string, `parents` as an array of Drive API v2
    `{"id": ...}` objects, and `parentFolderId` as an array are all fenced (see
    the red-team test cases). What remains a residual is a destination carried
    under a **different field name** (e.g. `folderId`, `parentId`, `parent`): a
    write staged into a restricted folder under such a name would slip the
    fence. The `parents`-array gap and these shape variants were both found and
    closed during red-team review. Pull `tools/list` through your gateway and
    extend the write fence with whatever destination field your deployment
    actually sends before production use.
  - **Search and listing results can still reveal restricted-file titles.**
    Search tools (`search_files`, `gdrive_search`, `search`) and listing tools
    (`list_recent_files`, `listFolder`) are not fenced, so an agent can still
    see names and snippets of restricted files in search/list results even
    though it cannot read them. These tools take a query or paging arguments
    rather than a file ID, so there is nothing for the ID fence to match on.
    Query rewriting to append `not '<id>' in parents` to Drive queries is
    documented as future work and is **not** implemented here. This
    enumeration residual was noted in red-team review (see the
    `list_recent_files` test case).
  - **Edits and moves addressed by file ID are not fenced.** In-place write
    tools that take a `documentId`/`fileId` (e.g. `updateGoogleDoc`,
    `gsheets_update_cell`) are outside this policy's suffix lists by design —
    compose with [`role-gate-writes`](../role-gate-writes/policy.md) for write
    control. **`copy_file`/`copyFile` *are* fenced on their source ID** (see
    the copy-out fence above), but **`moveItem`/`renameItem` are not**: a move
    of a restricted file out of a fenced folder is an exfil-and-remove route
    that this policy does not catch, because those tools' source-ID argument
    names are not verified in the landscape note. Compose with
    [`role-gate-writes`](../role-gate-writes/policy.md) and
    [`freeze-destructive-ops`](../freeze-destructive-ops/policy.md) to close it,
    and extend `copy_source_suffixes`/`id_arg_keys` once you confirm the field
    names via `tools/list`.
  - **Anthropic connector and legacy suffixes may diverge.** The Google-server
    suffixes above are the canonical match target. The Anthropic-hosted "Google
    Drive" connector's tool names are **not verified against official docs** and
    reportedly diverge (e.g. `get_metadata` rather than `get_file_metadata`); a
    metadata read via such a variant would slip the read fence. The dead legacy
    claude.ai integration's `google_drive_search`/`google_drive_fetch` names are
    likewise not covered. Pull `tools/list` through your gateway and extend
    `fenced_read_suffixes` with whatever your deployment actually sends before
    relying on this in production.
  - **Group name is an import-time placeholder.** Replace `hr` with your IdP's
    real group name (in `exempt_group`) when importing. The match is exact and
    case-sensitive, and `groups` must be an array of strings: any non-array
    shape (a single delimited string, an object/map, a number, or null) is
    rejected by the `is_array` guard, so nobody is exempt (fail closed). This
    closes a placeholder-claim spoofing surface found in red-team review — an
    object-shaped `groups` claim like `{"role": "hr"}` would otherwise have let
    `some group in groups` iterate the map's values and fail OPEN. Confirm the
    claim shape with `dtwo-list-claims` or the dump-input technique.
  - **Generic suffixes can over-match on shared pipelines.** Suffixes like
    `downloadfile` may also match similarly named tools from non-Drive MCP
    servers on the same pipeline. Those calls are only denied when they carry
    a restricted ID, so collisions are effectively harmless — but scope the
    pipeline if it bites.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are outside
  > the gateway's reach by design. Validate against your own compliance program
  > before relying on it.
direction: ingress
apps:
  - google-drive
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_drive.ingress.fence_restricted_folders

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Admin-maintained denylist of restricted Drive file/folder IDs.
# PLACEHOLDERS — pin your tenant's real IDs at import time (HR records,
# M&A deal rooms, board packs, payroll — whatever must stay off the agent
# channel). IDs come from the Drive URL, e.g.
# https://drive.google.com/drive/folders/<ID>. Matching is exact and
# case-sensitive, as Drive IDs are.
restricted_ids := {
    "REPLACE-WITH-HR-FOLDER-ID",
    "REPLACE-WITH-MA-DEAL-ROOM-ID",
    "REPLACE-WITH-BOARD-PACK-ID",
    "REPLACE-WITH-PAYROLL-FOLDER-ID",
}

# IdP group whose members bypass the fence (e.g. the HR team itself).
# PLACEHOLDER — replace with your IdP's real group name at import time.
exempt_group := "hr"

# Read/metadata tool suffixes across the Drive MCP servers in real use.
# The gateway prefixes tool names with the configured server name, so we
# match case-insensitive suffixes for portability.
fenced_read_suffixes := [
    # Google official Drive MCP server / Claude connector
    "read_file_content",
    "download_file_content",
    "get_file_metadata",
    "get_file_permissions",
    # isaacphi/mcp-gdrive
    "gdrive_read_file",
    "gsheets_read",
    # piotr-agier/google-drive-mcp (camelCase upstream; compared lowercased)
    "downloadfile",
    "readgoogledoc",
    "readgoogledocpaginated",
    "getgooglesheetcontent",
    "getgoogleslidescontent",
]

# Candidate argument names carrying the target file ID (exact, case-sensitive
# JSON keys, per the community-documented server schemas). The official
# Google server's field names are unverified pending tools/list — see Known
# limitations in the description.
id_arg_keys := ["fileId", "documentId", "spreadsheetId", "presentationId"]

# Copy-tool suffixes. A copy duplicates a source file into a new (agent-
# readable) location, so a copy whose SOURCE is a restricted file would
# exfiltrate fenced content out of the fence in a single hop — read the copy,
# not the original. These tool names are verified in the landscape note
# (Google `copy_file`, piotr-agier `copyFile`); the source-ID argument name is
# assumed to be one of `id_arg_keys` (unverified for the official server — see
# Known limitations).
copy_source_suffixes := [
    "copy_file", # Google official Drive MCP server
    "copyfile", # piotr-agier copyFile (compared lowercased)
]

# A tool call is a fenced read when its lowercased name ends with any suffix.
is_fenced_read_tool if {
    name := lower(input.resource.name)
    some suffix in fenced_read_suffixes
    endswith(name, suffix)
}

# A tool call is a copy when its lowercased name ends with a copy suffix.
is_copy_tool if {
    name := lower(input.resource.name)
    some suffix in copy_source_suffixes
    endswith(name, suffix)
}

# Every non-empty target ID found under a candidate argument name.
# Scalar form: the field carries the ID directly (the common case).
requested_ids contains id if {
    some key in id_arg_keys
    id := object.get(input.payload.args, key, "")
    id != ""
}

# Shape-tolerant form: an id arg arrives as an ARRAY of ID strings
# (single-parent SDK wrappers and batch-style callers do this). Without this
# rule the read and copy-out fences — which both consume requested_ids — would
# fail OPEN when a restricted `fileId`/`documentId`/… is wrapped in a
# one-element array, even though the write fence is already array-tolerant.
# is_array guards against iterating the characters of a scalar string; each
# extracted element is only ever compared for an exact restricted-ID match, so
# this can never cause a false allow — it strictly hardens the fence.
requested_ids contains id if {
    some key in id_arg_keys
    arr := object.get(input.payload.args, key, [])
    is_array(arr)
    some id in arr
    is_string(id)
    id != ""
}

# Read fence: a fenced read/metadata tool addresses a restricted ID.
targets_restricted_file if {
    is_fenced_read_tool
    some id in requested_ids
    restricted_ids[id]
}

# Write fence: any tool stages content into a restricted folder.
# Deliberately not tool-scoped — whichever write tool carries the argument,
# a restricted destination is denied (staging-for-exfil).
# Two destination shapes are checked:
#   1. `parentFolderId` (scalar) — piotr-agier's field name.
#   2. `parents` (array) — the Drive REST API v3 convention that the official
#      Google server / Claude connector mirrors (`parents: ["<folderId>"]`).
# Field names are unverified for the official MCP server pending tools/list
# (see Known limitations); each rule is harmless if its field is absent,
# because it only fires when a restricted ID is actually present.
targets_restricted_parent if {
    parent := object.get(input.payload.args, "parentFolderId", "")
    restricted_ids[parent]
}

targets_restricted_parent if {
    some parent in object.get(input.payload.args, "parents", [])
    restricted_ids[parent]
}

# Shape-tolerant destination checks. Field NAMES are unverified for the
# official MCP server (see Known limitations), but the shape a given field
# arrives in also varies across servers/SDK wrappers. Each rule below only
# ever fires on an exact restricted-ID match, so it can never cause a false
# allow — it strictly hardens the write fence against shape drift.
#   3. `parents` sent as a scalar string (single-parent / SDK-wrapper form)
#      instead of the v3 array.
targets_restricted_parent if {
    parents := object.get(input.payload.args, "parents", [])
    is_string(parents)
    restricted_ids[parents]
}

#   4. `parents` array whose elements are Drive API v2 parentReference OBJECTS
#      (`{"id": "<folderId>"}`) rather than bare v3 ID strings.
targets_restricted_parent if {
    some p in object.get(input.payload.args, "parents", [])
    is_object(p)
    restricted_ids[object.get(p, "id", "")]
}

#   5. `parentFolderId` sent as an array rather than the piotr-agier scalar.
targets_restricted_parent if {
    some parent in object.get(input.payload.args, "parentFolderId", [])
    is_string(parent)
    restricted_ids[parent]
}

# Copy-out fence: a copy tool whose source ID is restricted would duplicate
# fenced content into an unrestricted, agent-readable location. Denied on the
# source ID (the destination is separately covered by targets_restricted_parent).
targets_restricted_source if {
    is_copy_tool
    some id in requested_ids
    restricted_ids[id]
}

# Exemption: the caller's IdP-issued `groups` claim contains the exempt
# group. object.get chains make missing subject/claims/groups resolve to an
# empty list, so absent identity fails closed (no claims, no exemption).
# The `is_array(groups)` guard is load-bearing: without it, `some group in
# groups` would iterate the *values* of a `groups` claim shaped as an
# object/map, so a claim like {"groups": {"role": "hr"}} would fail OPEN and
# grant the exemption. Requiring an array forces every non-array shape
# (string, object, number, null) to fail closed, matching the documented
# guarantee.
caller_is_exempt if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some group in groups
    group == exempt_group
}

# Calls that touch nothing restricted pass through freely.
allow if {
    not targets_restricted_file
    not targets_restricted_parent
    not targets_restricted_source
}

# Exempt-group members bypass both fences.
allow if {
    caller_is_exempt
}

reasons contains "This file or folder is on the organization's restricted Google Drive list (HR, M&A, board, or payroll material). Agents may not read its content, metadata, or permissions. Work from an approved copy stored outside the restricted folders, or contact your InfoSec team if you believe this is a false positive." if {
    targets_restricted_file
    not caller_is_exempt
}

reasons contains "The destination folder is on the organization's restricted Google Drive list. Agents may not create, upload, copy, or move files into it. Choose a destination outside the restricted folders, or contact your InfoSec team if you believe this is a false positive." if {
    targets_restricted_parent
    not caller_is_exempt
}

reasons contains "This file is on the organization's restricted Google Drive list (HR, M&A, board, or payroll material). Copying it out of the restricted folders is not allowed, because the copy would carry the same content into an unrestricted location. Work from an approved copy, or contact your InfoSec team if you believe this is a false positive." if {
    targets_restricted_source
    not caller_is_exempt
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
