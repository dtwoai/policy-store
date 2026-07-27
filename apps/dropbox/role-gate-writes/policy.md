---
name: Role-Gate Dropbox Writes to the Writers Group
tags:
  - dropbox
  - role-gate-writes
  - rbac
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # dropbox / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny write tools without the writers group, allow everything else
  **Package:** `dropbox.ingress.role_gate_writes`

  ## What it does

  Establishes the per-app **least-privilege write floor** for Dropbox. Every
  write tool on the Dropbox MCP surface is denied at ingress unless the caller's
  IdP groups (`input.subject.claims.groups`) include the placeholder
  `dropbox-writers` group. Every read tool passes through untouched, so a caller
  with no `groups` claim — or a claim that lacks `dropbox-writers` — keeps
  **read-only** Dropbox access on the agent path.

  Write tools gated by this policy, across the three Dropbox MCP dialects:

  - **Folder / file creation** — `CreateFolder`, `CreateFile` (official);
    `create_folder`, `upload_file` (`dbx-mcp-server`); `dropbox_create_folder`,
    `dropbox_upload` (`ngs`).
  - **Copy / move (move also renames)** — `Copy`, `Move` (official); `copy_item`,
    `move_item` (`dbx`); `dropbox_copy`, `dropbox_move` (`ngs`).
  - **Restore tools** — `RestoreFileRevision`, `RestoreFolder` (official);
    `dropbox_restore_file` (`ngs`).

  The policy fails closed (`default allow := false`): the only paths to `allow`
  are (a) the tool is not a gated write, or (b) it is a gated write **and** the
  caller is in `dropbox-writers`. A missing `subject`, missing `claims`, or a
  missing / empty / non-array `groups` claim therefore never grants write access.

  This is the **RBAC baseline** that the share-link, destructive-freeze, and
  path-fencing policies layer on top of. It is kept as its own policy so a tenant
  can attach the write floor without the sharper controls — which means, by
  design, this policy does **not** gate `Delete` or the external-sharing writes
  (`CreateSharedLink` / `DownloadLink` / `CreateFileRequest`). Those pass through
  here and are governed by their companion policies (see Composition and Known
  limitations).

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets by
    restricting Dropbox writes to an authorized role on the agent path;
    **CC6.3** — supports role-based access and least privilege by granting write
    tools only to the `dropbox-writers` group; **CC6.2** — supports tying
    authorization to live IdP-issued group claims, so de-provisioning in the IdP
    removes agent write access.
  - **HIPAA §164.308(a)(4)** — supports information access management: write
    access to ePHI-bearing Dropbox content is authorized by IdP group;
    **§164.312(a)(1)/(a)(2)(i)** — supports technical access control and
    unique-user identification, since the decision is made per call against the
    caller's own JWT-derived groups; **§164.502(b)/§164.514(d)** — supports the
    minimum-necessary standard by keeping the write surface off for read-only
    roles.
  - **GDPR Art. 25** — supports data protection by design and by default: the
    agent write path is off unless a group explicitly turns it on; **Art. 29 /
    32(4)** — supports processing only on the controller's instructions by
    binding write capability to controller-managed IdP groups; **Art. 5(1)(b)**
    — supports purpose limitation; **CCPA §1798.100(e)** — supports reasonable
    security.

  ## Tool name matching

  Tool names are matched case-insensitively against `lower(input.resource.name)`,
  as an **exact name** or by a `-`/`_`-separated **suffix**, so the policy
  tolerates any gateway server-name prefix (e.g. `dropbox-CreateFile`,
  `dropbox-mcp-server-upload_file`) and resolves both the official PascalCase
  names and the community snake_case names. Requiring a separator before the
  suffix avoids over-matching (e.g. the `copy` suffix does not match `copy_item`,
  which has its own suffix entry).

  Read tools (`ListFolder`, `GetFileMetadata`, `GetFileContent`, `Search`,
  `WhoAmI`, `GetUsageAndQuota`, `CheckJobStatus`, `ListSharedLinks`,
  `GetSharedLinkMetadata`, `ListFileRequests`, `GetFileRequest`,
  `ListFileRevisions`, `ListRestoreEvents`, and the community equivalents) are
  **not** matched and always pass through. Verify the exact names your gateway
  sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  This policy inspects **no arguments** — the decision is made purely on tool
  identity and the caller's group membership. That is deliberate: Dropbox
  publishes no MCP JSON schemas, so argument names are unverified (see the
  landscape note). A write is a write regardless of its path or content, so the
  RBAC floor does not need to read arguments; path- and content-sensitive
  controls live in the companion path-fence and DLP policies.

  ## Examples

  ### Allowed — read tool passes through (no group needed)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-ListFolder", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "dropbox-ListFolder",
        "args": { "path": "/Projects" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — writers-group member uploads a file

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-CreateFile", "type": "tool" },
      "subject": { "sub": "google-apps|ops@example.com", "claims": { "groups": ["dropbox-writers"] } },
      "payload": {
        "name": "dropbox-CreateFile",
        "args": { "path": "/Projects/notes.txt", "content": "hello" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — write tool, caller not in the writers group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-CreateFolder", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "dropbox-CreateFolder",
        "args": { "path": "/Projects/new" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Dropbox tool writes to the workspace (...)"`.

  ## Composition

  This policy is single-purpose: the least-privilege **write** floor. It is
  designed to be attached alone or under the sharper Dropbox controls:

  - [`guard-share-links-external`](../guard-share-links-external/policy.md) —
    gates `CreateSharedLink` / `DownloadLink` / `CreateFileRequest`, which this
    policy deliberately leaves alone (they are externally-visible writes with
    their own group, `dropbox-sharing`).
  - A destructive-op / destructive-freeze policy for `Delete` (and, if you want a
    tighter posture, the restore tools) — this baseline lets `Delete` pass
    through so it can be governed independently.
  - [`fence-sensitive-paths`](../fence-sensitive-paths/policy.md) — adds
    path-prefix fences (by a different group per tree) on top of the write floor.
  - An egress PII/PHI/DLP redaction policy on `GetFileContent` / `download_file`
    and `Search` responses.

  ## Known limitations

  - **`Delete` and the external-sharing writes are out of scope by design.** A
    read-only caller (no `dropbox-writers`) can still call `Delete`,
    `CreateSharedLink`, `DownloadLink`, and `CreateFileRequest` as far as *this*
    policy is concerned — they are governed by the destructive-freeze and
    share-link companions. Attach those alongside this baseline for full write
    containment; this policy alone is the create/copy/move/restore floor, not a
    complete write lockdown.
  - **Group names are placeholders.** Replace `dropbox-writers` with your IdP's
    group name at import time. Callers with no `groups` claim, an empty claim, or
    a non-array claim are simply not in the group (fail-closed for the grant).
  - **`groups` claim must be an array of strings.** A string-valued or otherwise
    malformed `groups` claim makes the membership iteration fail, which fails
    closed (write tools deny). If your IdP emits group membership under a
    different claim name (e.g. `roles` or a namespaced custom claim), update
    `caller_groups` in the Rego.
  - **Suffix matching assumes a `-` or `_` prefix separator.** The DTwo gateway
    joins the configured server name to the tool name with a hyphen (e.g.
    `dropbox-mcp-server-CreateFile`), which this policy matches. If a deployment
    somehow surfaces a tool name whose prefix is joined by a different character
    (e.g. `dropbox.CreateFile`, `dropbox:CreateFile`) or with no separator at all
    (`dropboxCreateFile`), the `-`/`_` suffix test does not fire and the write
    would pass through ungated. Surrounding whitespace/newlines are handled
    (`trim_space`), but non-standard *internal* separators are not. Confirm the
    exact tool-name shape your gateway emits with the dump-input debug technique;
    the separator requirement is a deliberate trade to avoid a short suffix like
    `copy` over-matching `copy_item`.
  - **Tool names are unverified beyond the landscape note.** The official
    PascalCase names and the community snake_case names come from the Dropbox
    help docs and community READMEs, not a live `tools/list`. If your server
    exposes a write tool under a different name, add its suffix to
    `write_tool_suffixes` in the Rego and confirm with the dump-input debug
    technique before production. A write tool whose name is not in the list would
    pass through (fail-open for that specific unrecognized tool) — the flip side
    of keeping the read surface unrestricted. Pair with
    [PF-28 `default-deny-unknown-tools`](../../README.md) if you need every
    unrecognized tool denied.
  - **No argument inspection.** The decision does not depend on path or content,
    so the floor cannot express "writers may only write under `/Team`" — compose
    with `fence-sensitive-paths` for path scoping.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - dropbox
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package dropbox.ingress.role_gate_writes

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group whose members may run Dropbox write tools. Replace
# `dropbox-writers` with your IdP's group name at import time. Stored lowercase
# because the membership test lowercases each claimed group before comparing.
writers_group := "dropbox-writers"

# Normalized tool name, safe against a missing resource/name. The gateway
# prefixes tool names with the configured MCP server name (e.g.
# `dropbox-CreateFile`), so all matching below is case-insensitive and by
# `-`/`_`-separated suffix (or exact name) to stay portable across the official
# PascalCase server and both community snake_case servers. `trim_space` strips
# surrounding whitespace/newlines so a padded name (`"dropbox-CreateFile "`,
# `"dropbox-CreateFile\n"`) cannot slip past the suffix match and reach the
# server ungated.
tool_name := trim_space(lower(object.get(object.get(input, "resource", {}), "name", "")))

# Match a suffix as the exact tool name, or after a `-` or `_` separator. The
# separator requirement prevents a short suffix like `copy` from matching
# `copy_item` (which carries its own suffix entry).
tool_matches(suffix) if tool_name == suffix

tool_matches(suffix) if endswith(tool_name, sprintf("-%s", [suffix]))

tool_matches(suffix) if endswith(tool_name, sprintf("_%s", [suffix]))

# Write tools gated by the least-privilege floor, across the three dialects.
# Deliberately EXCLUDES Delete and the external-sharing writes (CreateSharedLink
# / DownloadLink / CreateFileRequest) — those are governed by the
# destructive-freeze and share-link companion policies.
write_tool_suffixes := [
	# official (PascalCase, no separator) -> lowercased
	"createfolder",
	"createfile",
	"copy",
	"move",
	"restorefilerevision",
	"restorefolder",
	# community amgadabdelhafez/dbx-mcp-server (snake_case)
	"create_folder",
	"upload_file",
	"copy_item",
	"move_item",
	# community ngs/dropbox-mcp-server (dropbox_ prefix)
	"dropbox_create_folder",
	"dropbox_upload",
	"dropbox_copy",
	"dropbox_move",
	"dropbox_restore_file",
]

is_write_tool if {
	some s in write_tool_suffixes
	tool_matches(s)
}

# Caller's IdP groups, via object.get chains so a missing subject/claims/groups
# fails closed (no group -> read-only).
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# True when the caller's groups claim (an array of strings) contains the writers
# group. A malformed (non-array/string) claim makes the iteration fail -> fail
# closed. Compared case-insensitively.
caller_in_writers_group if {
	some g in caller_groups
	lower(g) == writers_group
}

# --- Allow rules --------------------------------------------------------------

# Pass through every tool that is not a gated write (all reads, Delete, and the
# externally-visible sharing writes handled by companion policies).
allow if not is_write_tool

# Permit gated write tools only for members of the writers group.
allow if {
	is_write_tool
	caller_in_writers_group
}

# --- Deny reasons -------------------------------------------------------------

reasons contains "This Dropbox tool writes to the workspace (create, upload, copy, move, or restore) and is limited to members of the 'dropbox-writers' group; your account has read-only Dropbox access on the agent path. Ask your Dropbox administrator to add you to the 'dropbox-writers' group if you need write access. Contact your InfoSec team if this restriction looks wrong." if {
	is_write_tool
	not caller_in_writers_group
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
