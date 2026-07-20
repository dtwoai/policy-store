---
name: "Box: Role-Gated Writes (Read-Only Default)"
tags:
  - box
  - role-gate-writes
  - access-control
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # box / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny writes unless the caller is in the writer group; allow reads for everyone
  **Package:** `box.ingress.role_gate_writes`

  ## What it does

  Makes Box read-only by default on the MCP path. Every mutating Box tool — uploads, folder
  creation, copies, moves, renames, metadata and property updates, comments, hub and docgen
  writes, collaboration grants, shared links, locks, retention dates, and deletes — is denied
  unless the caller's IdP `groups` claim contains the placeholder group `box-writers`. Read and
  search tools (`who_am_i`, `get_file_content`, `get_file_details`, `list_*`, `search_*`,
  `ai_qa_*`, `ai_extract_*`, community `box_file_info_tool`, `box_search_tool`, and the other
  read-only tools of both server dialects) pass for everyone.

  Unknown tools whose names *look* mutating (any `create`/`update`/`set`/`add`/`upload`/`move`/
  `copy`/`delete`/`remove`/`rename`/`lock`/`unlock`/`clear` verb segment) are also gated, so new
  upstream write tools fail closed instead of slipping through until someone classifies them.

  The check runs at ingress, before the call reaches the Box MCP server, so a denied write never
  executes and has no side effects.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets: Box content cannot
    be mutated over the agent channel without an explicit role grant. **CC6.3** — supports
    role-based access and least privilege: write capability is tied to a live IdP group, and
    removing the group in the IdP removes write access on the next call.
  - **HIPAA §164.308(a)(4)** — supports information access management for Box tenants holding
    ePHI: write authorization is role-scoped. **§164.312(a)(1)** — supports technical access
    control with per-call identity from the caller's JWT.
  - **GDPR Art. 25** — supports data protection by design/default on the agent channel: the
    default posture is read-only. **Art. 29** — supports processing only on the controller's
    instructions: unauthorized principals cannot alter personal data in Box through the agent.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `box-remote-upload_file`), and the prefix is not standardized — so all matching is
  case-insensitive and by suffix or name segment, covering both Box MCP dialects:

  1. **Official remote server (mcp.box.com), verified suffixes:** `upload_file`,
     `upload_file_version`, `get_upload_url`, `create_folder`, `copy_file`, `copy_folder`,
     `move_file`, `move_folder`, `update_file_properties`, `update_folder_properties`,
     `set_file_metadata`, `set_folder_metadata`, `create_metadata_template`,
     `update_metadata_template`, `create_file_comment`, `create_hub`, `copy_hub`, `update_hub`,
     `add_items_to_hub`, `create_docgen_template`, `create_docgen_batch`, plus the sharing tools
     `create_collaboration`, `update_collaboration`, `add_file_shared_link`,
     `add_folder_shared_link`.
  2. **Community server (box-community/mcp-server-box), verified suffixes:**
     `box_file_upload_tool`, `box_file_copy_tool`, `box_file_move_tool`, `box_file_rename_tool`,
     `box_file_delete_tool`, `box_file_lock_tool`, `box_file_unlock_tool`,
     `box_file_retention_date_set_tool`, `box_file_retention_date_clear_tool`,
     `box_file_set_download_open_tool`, `box_folder_create_tool`, `box_folder_move_tool`,
     `box_folder_delete_tool`, `box_folder_set_collaboration_tool`,
     `box_folder_set_upload_email_tool`.
  3. **Community collaboration stem:** any tool name containing `box_collaboration_` is treated
     as a write — the collaboration-create variants (`box_collaboration_file_user_by_user_login_tool`
     and its by-id/group/folder siblings) carry no mutating verb in their names, so the whole stem
     is gated. The official read `list_item_collaborations` does not contain this stem and stays
     allowed.
  4. **Mutating-verb net:** any remaining tool whose hyphen/underscore-separated name segments
     include a mutation verb (`create`, `update`, `set`, `add`, `upload`, `move`, `copy`,
     `delete`, `remove`, `rename`, `lock`, `unlock`, `clear`) is gated. This is what catches the
     community shared-link writes (`box_shared_link_*_create_or_update_tool`,
     `box_shared_link_*_remove_tool`) while their `_get_`/`_find_by_shared_link_url_` read
     variants pass, and what keeps future upstream write tools fail-closed.

  Verify the exact names your gateway sends with the dump-input debug technique before relying on
  this in production; if your Box server exposes a write tool whose name carries none of the
  verbs above, add it to the suffix lists in `policy.md`.

  ## Argument shape

  The decision uses only the tool name (`input.resource.name`) and the caller's identity
  (`input.subject.claims.groups`). Tool arguments are not inspected, so the policy cannot be
  bypassed by unusual argument keys, nesting, or encodings — and it works identically whether or
  not a tool's argument schema is documented.

  ## Identity

  Group membership is read fail-closed via
  `object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])`:
  a missing subject, missing claims, a missing `groups` claim, or a `groups` claim that is not an
  array all mean "not a writer", and every write is denied. Reads are unaffected by identity.

  ## Examples

  ### Allowed — read tool, no identity required

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "box-remote-get_file_content", "type": "tool" },
      "payload": { "name": "box-remote-get_file_content", "args": { "file_id": "12345" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — write tool, caller not in the writer group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "box-remote-upload_file", "type": "tool" },
      "subject": { "sub": "auth0|alice", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "box-remote-upload_file",
        "args": { "parent_folder_id": "0", "name": "report.pdf" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Box write tools are restricted to members of the 'box-writers' group ..."`.

  ## Composition

  This policy is the Box least-privilege baseline; it gates *who* may write, not *what* they may
  write. Useful companions:

  - An external-sharing guard that inspects `create_collaboration` / `add_*_shared_link`
    arguments (collaborator domain, `access: open`) so that even authorized writers cannot share
    content outside the organization.
  - A destructive-op gate that keeps the community server's `box_file_delete_tool` /
    `box_folder_delete_tool` (especially `recursive: true`) behind a stricter admin group than
    ordinary writes.
  - An egress PII/PHI redaction policy on `get_file_content`, `ai_qa_*`, `ai_extract_*`, and
    search responses, since this policy leaves the read path open.

  ## Known limitations

  - **Group names are placeholders** — replace `box-writers` with your IdP's group name at import
    time. The policy expects `groups` to be an array claim in the caller's JWT; if your IdP emits
    roles under a different or namespaced claim (e.g. `https://acme.com/groups`), update
    `caller_groups` in `policy.md`.
  - **Reads are open to everyone**, including Box AI tools (`ai_qa_*`, `ai_extract_*`) that send
    file content through Box AI, and content egress tools like `get_file_content`. Pair with a
    read fence and/or egress redaction if your Box tenant holds regulated content.
  - **Verb-net over-matching on shared pipelines.** The mutating-verb net inspects every tool
    name on the pipeline, so non-Box tools with mutating-looking names (including management
    tools such as `dtwo-create-policy`) are gated too when this policy is attached to a pipeline
    that fronts more than the Box server. Attach it to a Box-scoped pipeline, or add an explicit
    passthrough `allow if` rule for your management prefix.
  - **Verb-net under-matching.** A write tool whose name carries none of the listed verbs and is
    not on a verified list slips through as a "read". Known candidates: the community server's
    tag tools, whose exact names the landscape research could not verify — verify with a live
    `tools/list` and add them to the suffix lists if present in your deployment.
  - **Unverified community names.** The folder variants of the community collaboration-create
    tools are gated via the `box_collaboration_` stem because their exact names are unverified;
    the community tag-tool names are likewise unverified (see above).
  - **A server named with a mutating verb** (e.g. an MCP server configured as `box-uploads`)
    would make every one of its tools match the verb net and require the writer group — a
    fail-closed false positive; rename the server or add a passthrough.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on
  > the MCP path only**. No policy or bundle makes an organization compliant with any framework;
  > web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate
  > against your own compliance program before relying on it.
direction: ingress
apps:
  - box
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package box.ingress.role_gate_writes

# Deny-by-default: reads are explicitly allowed below; every write requires
# membership in the writer group.
default allow := false

# Placeholder IdP group permitted to perform Box writes.
# Replace "box-writers" with your IdP's group name at import time.
writer_group := "box-writers"

# Lowercased tool name. The gateway prefixes tool names with the configured
# MCP server name (e.g. `box-remote-upload_file`), so matching below is
# case-insensitive and suffix/segment based to stay portable.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Raw (un-lowercased) name, kept so camelCase tool names can be split on their
# case boundaries by the mutating-verb net below.
raw_tool_name := object.get(object.get(input, "resource", {}), "name", "")

# Separator-normalized name: every run of non-alphanumerics collapses to a
# single `_`, so stem matching fires whether a server uses `_` or `-`.
normalized_tool_name := lower(regex.replace(raw_tool_name, `[^A-Za-z0-9]+`, "_"))

# --- Identity (fail closed) ---
# Missing subject, missing claims, a missing groups claim, or a groups claim
# that is not an array all yield "not a writer" — writes then deny.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# `is_array` guard is load-bearing: `some group in caller_groups` iterates the
# *values* of an object, so a groups claim shaped as `{"x": "box-writers"}`
# would otherwise match and fail OPEN. Requiring an array keeps every non-array
# shape (object, string, number) fail-closed, as the Identity section promises.
caller_is_writer if {
    is_array(caller_groups)
    some group in caller_groups
    group == writer_group
}

# --- Write-tool detection ---

# Verified write tools on the official remote server (mcp.box.com), matched by
# suffix so any gateway server-name prefix still matches.
official_write_suffixes := [
    "upload_file",
    "upload_file_version",
    "get_upload_url",
    "create_folder",
    "copy_file",
    "copy_folder",
    "move_file",
    "move_folder",
    "update_file_properties",
    "update_folder_properties",
    "set_file_metadata",
    "set_folder_metadata",
    "create_metadata_template",
    "update_metadata_template",
    "create_file_comment",
    "create_hub",
    "copy_hub",
    "update_hub",
    "add_items_to_hub",
    "create_docgen_template",
    "create_docgen_batch",
    "create_collaboration",
    "update_collaboration",
    "add_file_shared_link",
    "add_folder_shared_link",
]

# Verified write tools on the community server (box-community/mcp-server-box).
community_write_suffixes := [
    "box_file_upload_tool",
    "box_file_copy_tool",
    "box_file_move_tool",
    "box_file_rename_tool",
    "box_file_delete_tool",
    "box_file_lock_tool",
    "box_file_unlock_tool",
    "box_file_retention_date_set_tool",
    "box_file_retention_date_clear_tool",
    "box_file_set_download_open_tool",
    "box_folder_create_tool",
    "box_folder_move_tool",
    "box_folder_delete_tool",
    "box_folder_set_collaboration_tool",
    "box_folder_set_upload_email_tool",
]

is_write_tool if {
    some suffix in official_write_suffixes
    endswith(tool_name, suffix)
}

is_write_tool if {
    some suffix in community_write_suffixes
    endswith(tool_name, suffix)
}

# Community collaboration tools (grant/update/delete collaborations) share the
# `box_collaboration_` stem, and the create variants carry no mutating verb in
# their names, so the whole stem is gated. The official read
# `list_item_collaborations` does not contain this stem and stays allowed.
is_write_tool if {
    contains(normalized_tool_name, "box_collaboration_")
}

# Fail-closed net for unknown mutating-looking tools: if any name segment is a
# mutation verb, treat the tool as a write so new upstream write tools are
# gated before anyone classifies them. Also catches the community shared-link
# create/update/remove tools, while their get/find read variants pass.
mutating_verbs := {
    "create", "update", "set", "add", "upload",
    "move", "copy", "delete", "remove", "rename",
    "lock", "unlock", "clear",
}

# Split the tool name into segments. First insert a boundary at every
# lowercase/digit -> uppercase transition so camelCase names (`uploadFile`)
# split into verb segments (`upload`, `file`); snake_case and ALL-CAPS names
# are unaffected. Then lowercase and split on any run of non-alphanumeric
# characters (covers both the gateway's `-` prefixing and Box's `_` naming).
name_segments := {segment |
    some segment in regex.split(`[^a-z0-9]+`, lower(regex.replace(raw_tool_name, `([a-z0-9])([A-Z])`, `$1 $2`)))
    segment != ""
}

is_write_tool if {
    some segment in name_segments
    mutating_verbs[segment]
}

# --- Decision ---

# Reads (and anything that is not a verified or mutating-looking write) pass
# for everyone.
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
    msg := sprintf("Box write tools are restricted to members of the '%s' group — this account has read-only Box access through the gateway. Ask your identity admin to add you to '%s', or hand this step to a teammate with Box write access. If this tool is actually read-only, contact your InfoSec team to update the policy.", [writer_group, writer_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
