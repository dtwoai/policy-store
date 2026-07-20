---
name: Gate Google Drive Writes to an Authorized IdP Group
tags:
  - google-drive
  - role-gate-writes
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # google-drive / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny; reads pass through, writes require group membership
  **Package:** `google_drive.ingress.role_gate_writes`

  ## What it does

  Baseline least-privilege policy for Google Drive MCP traffic. Read-class tools
  (search, list, metadata, content reads, downloads) pass through freely for every
  caller. Every write-class tool **on the covered suffix list** — file/folder
  creation, uploads, doc/sheet edits, moves, renames, copies, and comments — is
  denied unless the caller's IdP-issued `groups` claim contains `drive-writers`.
  This is a blocklist of known write suffixes: a write tool whose name is *not* on
  the list (see Known limitations) is not classified as a write and passes through,
  so pair this with a default-deny-unknown-tools policy for a strict posture.

  A caller with a missing `subject`, missing `claims`, or missing/empty `groups`
  claim **fails closed**: no group, no write. The check runs at ingress, so a denied
  write never reaches the Drive MCP server and never creates, modifies, or comments
  on anything.

  Why gate writes: Drive writes let an agent plant prompt-injection payloads in
  documents other agents and users will later read, and stage data into broadly
  shared folders as a pre-exfiltration step. Comments additionally notify
  collaborators — including external ones — so even "small" writes are externally
  visible actions.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets by
    restricting Drive modification to an authorized group on the agent channel;
    **CC6.3** — supports role-based access and least privilege: write access is
    tied to live IdP group membership, read access is the default posture.
  - **HIPAA §164.502(b)/§164.514(d)** — supports minimum-necessary, role-based
    limits on a store that routinely holds PHI exports; **§164.308(a)(4)** —
    information access management; **§164.312(a)(1)** — access control enforced
    per call against the caller's identity.
  - **GDPR Art. 25** — supports data protection by design/default on the agent
    channel (write capability off by default); **Art. 29 / 32(4)** — supports
    processing only on the controller's instructions: unauthorized principals
    cannot direct the agent to alter Drive data.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `gdrive-mcp-create_file`), so this policy matches case-insensitive
  **suffixes** to stay portable across deployments. Classification reads both the
  PARC `input.resource.name` field and its co-populated legacy alias
  `input.payload.name`: a call is write-class if *either* ends with a covered
  suffix, so the gate still fires if one field is absent. Write-class suffixes
  covered:

  - **Google official Drive MCP server / Claude connector:** `create_file`,
    `copy_file` (the official server exposes no delete/move/rename/permission
    tools).
  - **isaacphi/mcp-gdrive:** `gsheets_update_cell`.
  - **piotr-agier/google-drive-mcp:** `createtextfile`, `updatetextfile`,
    `uploadfile`, `createfolder`, `moveitem`, `renameitem`, `copyfile`,
    `creategoogledoc`, `updategoogledoc`, `inserttext`, `appendspreadsheetrows`,
    `updategooglesheet`, `addcomment`, `replytocomment`.

  Anything not on the write list — including all read tools and unknown tools —
  passes through. Verify the exact names your gateway sends with the dump-input
  debug technique before relying on this in production, and add suffixes here if
  your Drive server exposes additional write tools.

  ## Identity shape

  The policy reads `input.subject.claims.groups` and expects an **array of group
  name strings** (the common IdP shape). Membership is checked with an exact,
  case-sensitive string match against `drive-writers`. All lookups use
  `object.get` chains, so a missing `subject`, `claims`, or `groups` resolves to
  an empty list and the write is denied. The membership check additionally
  requires `groups` to be a JSON **array** (`is_array`): a `groups` value that
  arrives as a single string or as an object map fails the array check and is
  denied (fail closed), so it cannot grant a write by value collision.

  ## Argument shape

  This policy decides on the tool name and the caller's identity only; it does not
  inspect tool arguments, so it is insensitive to argument-name differences across
  Drive server implementations.

  ## Examples

  ### Allowed — read tool, no identity needed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gdrive-mcp-search_files", "type": "tool" },
      "payload": { "name": "gdrive-mcp-search_files", "args": { "query": "quarterly report" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — write tool, caller is in `drive-writers`

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "subject": { "sub": "google-apps|ana@acme.com", "claims": { "groups": ["drive-writers"] } },
      "resource": { "name": "gdrive-mcp-create_file", "type": "tool" },
      "payload": { "name": "gdrive-mcp-create_file", "args": { "name": "notes.txt" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — write tool, caller has no `groups` claim

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "subject": { "sub": "google-apps|bob@acme.com", "claims": { "email": "bob@acme.com" } },
      "resource": { "name": "gdrive-mcp-create_file", "type": "tool" },
      "payload": { "name": "gdrive-mcp-create_file", "args": { "name": "notes.txt" } }
    }
  }
  ```

  `allow = false`, `reason = "Google Drive write tools are restricted to members of the 'drive-writers' group. ..."`.

  ## Composition

  This policy is single-purpose: it gates write-class tools by group. Useful
  companions:

  - [`freeze-destructive-ops`](../freeze-destructive-ops/policy.md) — handles the
    destructive tier (`deleteItem`, `deleteSheet`, `deleteRange`, ...); this
    policy deliberately does not cover deletes.
  - An egress PII/secret redaction policy on Drive content-returning tools
    (`read_file_content`, `download_file_content`, `gdrive_read_file`), since bulk
    read is Drive's primary exfiltration risk.

  ## Known limitations

  - **Group name is an import-time placeholder.** Replace `drive-writers` with
    your IdP's real group name (in `authorized_write_group` and the deny reason)
    when importing. The match is exact and case-sensitive.
  - **`groups` must be an array of strings under the `groups` claim key.** IdPs
    that emit the claim as a single space- or comma-separated string, as an object
    map, or under a namespaced key (e.g. `https://acme.com/groups`) will never
    match, so **all writes are denied (fail closed)** — a safe direction, but it
    locks out legitimate writers until you adjust. If your IdP uses a namespaced
    or differently named group claim, change the `object.get(claims, "groups", [])`
    key in `caller_may_write` to match. Confirm your IdP's claim shape and key with
    `dtwo-list-claims` or the dump-input technique.
  - **Official-server argument field names are unverified.** Google's reference
    does not publish per-tool parameter schemas; this policy avoids argument
    inspection for that reason, but companions that inspect Drive arguments should
    verify shapes via `tools/list` first.
  - **Claude connector write-tool suffixes are unverified.** The landscape note
    flags that the Anthropic-hosted "Google Drive" connector's tool suffixes are
    not verified against official Anthropic docs and diverge between write-ups
    (e.g. `get_metadata` vs `get_file_metadata`). This policy assumes the connector's
    create tool matches the Google-server suffix `create_file`; if it instead ships
    the write under a different suffix, that write passes through ungated (the same
    blocklist residual described below). Confirm the connector's live write-tool
    names with `tools/list` and add any divergent suffix to `write_suffixes`.
  - **Generic suffixes can over-match on shared pipelines.** Suffixes like
    `uploadfile`, `copyfile`, or `addcomment` may also match similarly named tools
    from non-Drive MCP servers attached to the same pipeline, gating them too.
    That failure mode is deny-for-non-members (safe direction), but scope the
    pipeline or tighten the suffixes if it bites.
  - **Destructive tools are out of scope.** Deletes are governed by the companion
    `freeze-destructive-ops` policy, not here.
  - **Blocklist residual — unlisted write tools pass through ungated.** Enforcement
    is a curated allowlist of *write suffixes*; any write tool whose name is not on
    that list is treated as a read and passes through for every caller. Concrete
    residuals on real servers: the multi-product `piotr-agier/google-drive-mcp`
    server also exposes Slides content writes and calendar writes
    (`createCalendarEvent`, `updateCalendarEvent`) that this Drive-scoped policy does
    **not** gate, and any newly added, renamed, or preview upstream write tool is
    ungated until its suffix is added here. This is the standard blocklist weakness
    and the reason the coverage matrix pairs PF-12 with **PF-28
    (`default-deny-unknown-tools`)**: attach a default-deny-unknown-tools companion
    (and route calendar/Slides writes through their own app policies) if you need a
    guarantee that *no* unrecognized write reaches Drive. Verify your gateway's live
    tool inventory with `tools/list` and extend `write_suffixes` accordingly.
  - **A call with no resolvable tool name at all passes through.** Classification
    reads both `input.resource.name` and its legacy alias `input.payload.name`; a
    call is only unclassifiable (and therefore allowed) when **both** fields are
    absent or empty — fail-open on classification, not on identity. The gateway
    populates both for every dispatched tool call, so this is not reachable by a
    normal caller, and a companion default-deny-unknown-tools policy also closes it.

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
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_drive.ingress.role_gate_writes

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# IdP group whose members may call Google Drive write tools.
# PLACEHOLDER — replace with your IdP's real group name at import time
# (and update the deny reason below to match).
authorized_write_group := "drive-writers"

# Write-class tool suffixes across the Drive MCP servers in real use.
# The gateway prefixes tool names with the configured server name, so we
# match case-insensitive suffixes for portability. Read-class tools are
# intentionally absent — anything not listed here passes through.
write_suffixes := [
    # Google official Drive MCP server / Claude connector
    "create_file",
    "copy_file",
    # isaacphi/mcp-gdrive
    "gsheets_update_cell",
    # piotr-agier/google-drive-mcp (camelCase upstream; compared lowercased)
    "createtextfile",
    "updatetextfile",
    "uploadfile",
    "createfolder",
    "moveitem",
    "renameitem",
    "copyfile",
    "creategoogledoc",
    "updategoogledoc",
    "inserttext",
    "appendspreadsheetrows",
    "updategooglesheet",
    "addcomment",
    "replytocomment",
]

# Candidate tool-name fields, lowercased. `resource.name` is the PARC field;
# `payload.name` is its co-populated legacy alias (both are set on tool hooks).
# Classifying on either means a write is still caught if one field is absent —
# this only ever moves a call toward the write class (deny for non-members),
# never the reverse, so it cannot introduce a new allow.
tool_name_candidates contains lower(n) if {
    n := object.get(object.get(input, "resource", {}), "name", "")
    n != ""
}

tool_name_candidates contains lower(n) if {
    n := object.get(object.get(input, "payload", {}), "name", "")
    n != ""
}

# A tool call is write-class when any candidate name ends with a listed suffix.
is_drive_write_tool if {
    some name in tool_name_candidates
    some suffix in write_suffixes
    endswith(name, suffix)
}

# Caller is authorized to write: the IdP-issued `groups` claim contains the
# authorized group. object.get chains make missing subject/claims/groups
# resolve to an empty list, so absent identity fails closed (no group, no write).
caller_may_write if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    # Require the documented array-of-strings shape. Without this guard a
    # `groups` object map whose *value* equals the group name (e.g.
    # {"role": "drive-writers"}) would satisfy `some group in groups`
    # (which iterates object values) and grant the write. is_array makes
    # every non-array shape (single string, object map) fail closed, matching
    # the Identity-shape contract documented above.
    is_array(groups)
    some group in groups
    group == authorized_write_group
}

# Read-class and unknown tools pass through freely.
allow if {
    not is_drive_write_tool
}

# Write-class tools require membership in the authorized group.
allow if {
    is_drive_write_tool
    caller_may_write
}

reasons contains "Google Drive write tools are restricted to members of the 'drive-writers' group. Ask a user who is in that group to make this change for you, or request 'drive-writers' membership from your identity administrator. If this tool call was wrongly classified as a write, ask your InfoSec team to review this policy's suffix list." if {
    is_drive_write_tool
    not caller_may_write
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
