---
name: Freeze Destructive Box Operations
tags:
  - box
  - freeze-destructive-ops
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # box / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny destructive tools, allow everything else
  **Package:** `box.ingress.freeze_destructive_ops`

  ## What it does

  Freezes deletes and retention tampering on the **community self-hosted Box MCP server**
  (`box-community/mcp-server-box`). That server — unlike the official remote server at
  `mcp.box.com`, which is verified delete-free — exposes destructive tools and commonly
  runs under a JWT/CCG **service account** with no per-user Box permission checks. In that
  deployment, the DTwo gateway is the only control layer between the agent and destruction
  of records.

  The policy denies, by tool-name suffix:

  - `box_file_delete_tool` — file deletion
  - `box_folder_delete_tool` — folder deletion; **denied unconditionally when
    `recursive == true`**, the single most destructive call in either Box server
  - `box_collaboration_delete_tool` — revokes a collaborator (sharing-state destruction)
  - `box_shared_link_file_remove_tool` / `box_shared_link_folder_remove_tool` /
    `box_shared_link_web_link_remove_tool` — shared-link removal (sharing-state destruction)
  - `box_file_retention_date_clear_tool` — clears a file's retention date (retention tampering)

  All other tools pass through unchanged. Non-recursive destructive calls are exempt
  **only** for callers whose IdP `groups` claim contains the placeholder group
  `box-admins`, read fail-closed from `input.subject.claims.groups` — no claim means no
  exemption. Recursive folder deletion is denied for everyone, including `box-admins`.

  Box's trash makes most deletions recoverable for a window, but bulk deletion and
  retention tampering by an automated agent are out of policy here regardless: the deny
  reasons say so and point the caller to a human-driven path (do it in the Box web app,
  or ask a `box-admins` member).

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519** — anti-destruction/alteration of records: an agent
    cannot delete files/folders or clear retention dates on the MCP path, supporting the
    record-preservation obligation on financial and audit evidence stored in Box.
  - **SOC 2 PI1.5** — supports integrity of stored records by preventing agent-initiated
    destruction of stored content and its sharing/retention state.
  - **HIPAA §164.312(c)** — integrity (anti-alteration/destruction of ePHI) on the agent
    channel; **§164.530(c)** — administrative safeguard limiting who can destroy records
    containing PHI.
  - **GDPR Art. 5(1)(d)** — accuracy: supports the anti-mass-corruption posture by
    stopping an errant or injected agent from bulk-erasing personal-data records.

  ## Tool name matching

  Matches case-insensitively on the **suffix** of `input.resource.name`. The DTwo gateway
  prefixes tool names with the configured MCP server name (e.g.
  `box-mcp-box_file_delete_tool`), and that prefix is not standardized — suffix matching
  keeps the policy portable. Verify the exact names your gateway sends with the dump-input
  debug technique before relying on this in production.

  The community server names all tools `box_<domain>_<action>_tool`, so these suffixes are
  specific to that dialect. **Official-server deployments (`mcp.box.com`) see no effect**:
  the official server exposes no delete/remove/retention tools and none of its tool names
  match these suffixes. That is expected — there is nothing for this policy to block there.

  ## Argument shape

  - `box_folder_delete_tool` takes `folder_id` and `recursive` (boolean). The policy
    treats the delete as recursive when either the documented `recursive` key **or** the
    `is_recursive` alias (used by the folder-listing tool in the same server family) holds
    a truthy value — a JSON boolean `true`, **any non-zero number**, or a string the
    server's bool parser coerces to true (`true`/`t`/`yes`/`y`/`on`/`1`, case-insensitive,
    surrounding whitespace trimmed). Absent, `false`, `0`, and any falsey or unrecognized
    value mean non-recursive. Checking both keys and every truthy encoding closes the
    admin-only bypass where an alternate key, a numeric flag, or a string value would
    otherwise route a recursive delete into the exemption branch.
  - The `box-admins` exemption reads `input.subject.claims.groups` via `object.get`
    chains with an empty-array default, so a missing subject, missing claims, or missing
    `groups` claim deterministically fails closed (deny).
  - No other arguments are inspected; the remaining destructive tools are denied on name
    alone.

  ## Examples

  ### Allowed — read tool, untouched

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "box-mcp-box_file_info_tool", "type": "tool" },
      "payload": { "name": "box-mcp-box_file_info_tool", "args": { "file_id": "1234" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — single file delete by a box-admins member

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "box-mcp-box_file_delete_tool", "type": "tool" },
      "subject": { "sub": "auth0|admin", "claims": { "groups": ["box-admins"] } },
      "payload": { "name": "box-mcp-box_file_delete_tool", "args": { "file_id": "1234" } }
    }
  }
  ```

  `allow = true` — group-based exemption.

  ### Denied — recursive folder delete, even for box-admins

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "box-mcp-box_folder_delete_tool", "type": "tool" },
      "subject": { "sub": "auth0|admin", "claims": { "groups": ["box-admins"] } },
      "payload": {
        "name": "box-mcp-box_folder_delete_tool",
        "args": { "folder_id": "9876", "recursive": true }
      }
    }
  }
  ```

  `allow = false`, reason explains that recursive deletion is blocked for every caller
  and points to the Box web app.

  ## Composition

  Single-purpose: this policy only freezes destruction. Useful companions for the same
  self-hosted deployment:

  - A Box **external-sharing guard** (deny/downgrade `open` shared links and external
    collaborations) — destruction and exfiltration are separate jobs.
  - An **upload/version guard** denying `box_file_upload_tool` overwrites outside an
    agent-workspace subtree (silent full-content overwrite is destruction this policy
    does not cover).
  - An egress **PII/PHI redaction** policy on Box read tools.

  ## Known limitations

  - **Group names are placeholders — replace `box-admins` with your IdP's group name at
    import time.** The exemption reads `input.subject.claims.groups` (array of strings)
    and fails closed: no IdP, no claim, or a non-array `groups` value means nobody is
    exempt.
  - **Community-server dialect only.** On official `mcp.box.com` deployments these tool
    names never appear, so the policy is a no-op there (the official server is verified
    delete-free, so nothing is lost).
  - **Shared-link removal is treated as destruction of sharing state**, not of content.
    If your workflow legitimately unshares links via agents, exempt those callers through
    the group or remove those suffixes.
  - The `box_shared_link_folder_remove_tool` and `box_shared_link_web_link_remove_tool`
    names follow the module's documented `file`/`folder`/`web_link` mirror pattern but
    were **not individually verified** against a live `tools/list`; confirm with the
    dump-input technique.
  - **Recursion detection is hardened but denylist-shaped.** The policy treats a folder
    delete as recursive when `recursive` or `is_recursive` holds `true`, any non-zero
    number, or a truthy string (`true`/`t`/`yes`/`y`/`on`/`1`, case-insensitive), so no
    alternate key, numeric flag, or string-coerced value bypasses the unconditional
    block — including for `box-admins`. If your fork accepts a different recursion flag
    (e.g. `deep`, `cascade`) or a truthy encoding outside that set, add it to
    `is_recursive_value` / `recursive_requested`; verify the exact argument with the
    dump-input technique.
  - **Overwrites and retention shortening are out of scope.** `box_file_upload_tool`
    version overwrites and `box_file_retention_date_set_tool` (which can move a retention
    date) are not blocked — only the clear tool is. Pair with an upload guard if you need
    overwrite protection.
  - Trash purge/emptying is not exposed by the community server's documented tool set; if
    your fork adds one, add its suffix to `destructive_suffixes`.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - box
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package box.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Destructive tool suffixes in the box-community/mcp-server-box dialect
# (`box_<domain>_<action>_tool`). The gateway prefixes tool names with the
# configured MCP server name (e.g. `box-mcp-box_file_delete_tool`), so we
# match on the suffix to stay portable. The official mcp.box.com server has
# no tools matching these suffixes — this policy is a no-op there.
destructive_suffixes := [
    # File deletion (trash-recoverable, but agent deletion is out of policy)
    "box_file_delete_tool",
    # Folder deletion; recursive == true is denied unconditionally below
    "box_folder_delete_tool",
    # Collaboration revocation — destroys sharing state
    "box_collaboration_delete_tool",
    # Shared-link removal (file + folder/web-link mirrors) — destroys sharing state
    "box_shared_link_file_remove_tool",
    "box_shared_link_folder_remove_tool",
    "box_shared_link_web_link_remove_tool",
    # Retention tampering — clears a file's retention date
    "box_file_retention_date_clear_tool",
]

# Case-insensitive tool name; missing fields resolve to "" (never matches).
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Tool arguments; {} when payload/args are absent so lookups fail closed.
args := object.get(object.get(input, "payload", {}), "args", {})

is_destructive_tool if {
    some suffix in destructive_suffixes
    endswith(tool_name, suffix)
}

# A value that requests recursion. Fail closed on the most destructive op:
# every encoding the server's bool parser coerces to true counts. Absent,
# false, 0, and any falsey/unrecognized value do not.
is_recursive_value(v) if v == true

# Any non-zero number. The server coerces a numeric flag (`recursive: 1`) to
# true, so a JSON number must not slip past into the admin-exemption branch.
is_recursive_value(v) if {
    is_number(v)
    v != 0
}

# Truthy string tokens — the full set the server's bool parser (pydantic)
# coerces to true: "true"/"t"/"yes"/"y"/"on"/"1", case-insensitive, with
# surrounding whitespace trimmed. Falsey tokens ("false"/"f"/"no"/"n"/"off"/
# "0"/"") and any other string are treated as non-recursive (the server
# rejects unrecognized strings, so they cannot delete either).
is_recursive_value(v) if {
    is_string(v)
    lower(trim_space(v)) in {"true", "t", "yes", "y", "on", "1"}
}

# Recursion is requested under either the documented `recursive` key or the
# `is_recursive` alias the same server family uses for folder listing
# (`box_folder_items_list_tool`). We check both so an alternate-key or
# string-coerced call cannot slip a recursive delete past the unconditional
# block below.
recursive_requested if {
    some key in {"recursive", "is_recursive"}
    is_recursive_value(object.get(args, key, false))
}

# The single most destructive call in either Box server: recursive folder
# delete. Denied for everyone, including box-admins.
is_recursive_folder_delete if {
    endswith(tool_name, "box_folder_delete_tool")
    recursive_requested
}

# Placeholder IdP group — replace `box-admins` with your IdP's group name at
# import time. Read fail-closed: missing subject/claims/groups → [] → no
# exemption. A non-array `groups` value also fails closed (no iteration).
caller_is_box_admin if {
    groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])
    some group in groups
    lower(group) == "box-admins"
}

# Allow any tool that isn't on the destructive list.
allow if {
    not is_destructive_tool
}

# Allow non-recursive destructive calls only for box-admins members.
# Recursive folder deletion has no exemption — not even for box-admins.
allow if {
    is_destructive_tool
    not is_recursive_folder_delete
    caller_is_box_admin
}

reasons contains "Recursive folder deletion is the most destructive Box operation and is blocked for every caller, including box-admins. Box trash makes deletions recoverable, but bulk deletion by an agent is out of policy. If the folder tree must go, delete it manually in the Box web app so a human owns the decision. Contact your InfoSec team if this block is a false positive." if {
    is_recursive_folder_delete
}

reasons contains "Deleting Box files, folders, or collaborations, removing shared links, and clearing retention dates are restricted to the box-admins group. Box trash makes deletions recoverable, but content destruction and retention tampering by an agent are out of policy. Perform the action manually in the Box web app, or ask a box-admins member. Contact your InfoSec team if this block is a false positive." if {
    is_destructive_tool
    not is_recursive_folder_delete
    not caller_is_box_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
