---
name: Freeze Destructive Dropbox Operations
tags:
  - dropbox
  - freeze-destructive-ops
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # dropbox / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny destructive tools, allow everything else
  **Package:** `dropbox.ingress.freeze_destructive_ops`

  ## What it does

  Freezes the irreversible and bulk-mutation Dropbox tools on the agent channel,
  regardless of path. At ingress it denies, by tool-name suffix:

  - **Deletion** — `Delete` (official `mcp.dropbox.com`), `safe_delete_item`
    (`dbx-mcp-server`), `dropbox_delete` (`ngs`). A prompt-injected or mistaken
    agent can use these to mass-delete files; Dropbox moves deletes to *Deleted
    files*, recoverable **only within the plan's retention window**, so a bulk
    agent delete can become permanent.
  - **Folder rewind** — `RestoreFolder` (official). Rewinds an entire folder to an
    earlier point in time, silently reverting every file in a shared tree.
  - **Revision resurrection** — `RestoreFileRevision` (official),
    `dropbox_restore_file` (`ngs`). Resurfaces content that was deliberately
    removed by restoring an older file revision.

  All other tools pass through unchanged. There is **no identity carve-out by
  default**: destructive storage actions belong to a human working in the Dropbox
  UI, not to an autonomous agent. `Move` (rename/relocate) is intentionally **not**
  frozen here — renames and moves are common and legitimate; scope them with the
  companion path-fencing and role-gate policies instead. The deny reasons tell the
  caller to perform the deletion or restore manually and note the retention-window
  caveat on deletes.

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519** — anti-destruction/alteration of records: an
    agent cannot delete files or roll a folder/file back to an earlier state on the
    MCP path, supporting the record-preservation obligation for financial and audit
    evidence stored in Dropbox; **§802 / Rule 2-06** — supports retention and
    legal-hold posture by keeping agent-initiated deletion off evidence paths.
  - **SOC 2 PI1.5** — supports integrity of stored records by preventing
    agent-initiated destruction and silent rollback of stored content.
  - **HIPAA §164.312(c)** — integrity (anti-alteration/destruction of ePHI) on the
    agent channel; **§164.530(c)** — administrative safeguard limiting who can
    destroy or roll back records containing PHI.
  - **GDPR Art. 5(1)(d)** — accuracy: supports the anti-mass-corruption posture by
    stopping an errant or injected agent from bulk-erasing or silently rewinding
    personal-data records.

  ## Tool name matching

  Matches case-insensitively on `input.resource.name` as an exact name or by a
  `-`/`_`-separated suffix, so the policy tolerates any gateway server-name prefix
  (e.g. `dropbox-Delete`, `dbx-mcp-safe_delete_item`). The DTwo gateway prefixes
  tool names with the configured MCP server name, and that prefix is not
  standardized — suffix matching keeps the policy portable. Verify the exact names
  your gateway sends with the dump-input debug technique before relying on this in
  production.

  Frozen suffixes:

  - **Deletion:** `delete` (official `Delete`; also catches `dropbox_delete` via the
    `_delete` boundary), `safe_delete_item` (dbx), `dropbox_delete` (ngs, listed
    explicitly).
  - **Folder rewind:** `restorefolder` (official `RestoreFolder`).
  - **Revision resurrection:** `restorefilerevision` (official `RestoreFileRevision`),
    `dropbox_restore_file` (ngs).

  The read-only `ListRestoreEvents` tool (official) is deliberately **not** matched —
  it enumerates restore history and mutates nothing. `Move`, `Copy`, `CreateFolder`,
  `CreateFile`, share-link and file-request tools, and every read tool pass through.

  ## Argument shape

  This policy decides purely on the **tool name** — it inspects no arguments, so a
  call with missing, empty, or malformed `args` is still denied on name alone
  (fail-closed for destructive tools). Because Dropbox does not publish MCP JSON
  schemas, name-only matching also sidesteps the unverified argument-key problem
  entirely. `input.resource.name` is read via `object.get`, defaulting to `""`
  (which matches nothing) when absent.

  ## Examples

  ### Allowed — read tool, untouched

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-GetFileContent", "type": "tool" },
      "payload": { "name": "dropbox-GetFileContent", "args": { "path": "/Projects/roadmap.pdf" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — Move (rename/relocate is not frozen here)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-Move", "type": "tool" },
      "payload": { "name": "dropbox-Move", "args": { "from_path": "/a/x.txt", "to_path": "/b/x.txt" } }
    }
  }
  ```

  `allow = true` — moves are gated by the path-fencing and role-gate policies, not frozen.

  ### Denied — file deletion

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-Delete", "type": "tool" },
      "payload": { "name": "dropbox-Delete", "args": { "path": "/Finance/2026/ledger.xlsx" } }
    }
  }
  ```

  `allow = false`, reason points to a manual delete in the Dropbox UI and the retention-window caveat.

  ### Denied — folder rewind

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-RestoreFolder", "type": "tool" },
      "payload": { "name": "dropbox-RestoreFolder", "args": { "path": "/Shared/Team", "rev": "2026-01-01T00:00:00Z" } }
    }
  }
  ```

  `allow = false`, reason explains folder rewind / revision restore is frozen on the agent channel.

  ## Composition

  Single-purpose: this policy only freezes destruction and rollback. Useful
  companions for Dropbox:

  - [`fence-sensitive-paths`](../fence-sensitive-paths/policy.md) — role-gates
    reads/listings/moves/copies/search of sensitive path prefixes (this policy leaves
    `Move`/`Copy` to it).
  - [`guard-share-links-external`](../guard-share-links-external/policy.md) — stops
    the exfiltration surface (public links, file requests) that destruction does not
    cover.
  - An egress PII/PHI redaction policy on `GetFileContent` / `download_file` and
    `Search` responses.

  ## Known limitations

  - **No identity carve-out.** Every caller is denied the frozen tools; there is no
    break-glass group by design. If your workflow needs an admin bypass, add an
    `allow if` branch gated on `input.subject.claims.groups` (read fail-closed via
    `object.get` chains) — see the sibling `box/freeze-destructive-ops` policy for
    that pattern. Group names would be placeholders to replace at import time.
  - **Community-server coverage is dialect-specific.** Only the tool names listed
    are matched. The `dbx-mcp-server` exposes only `safe_delete_item` (no restore
    tool) and `ngs` exposes `dropbox_delete` + `dropbox_restore_file`; folder rewind
    (`RestoreFolder`) exists **only** on the official server. If your fork names a
    delete/restore tool differently, add its suffix to `delete_suffixes` or
    `restore_suffixes` (the two arrays at the top of the Rego); confirm names with
    the dump-input technique against a live `tools/list`.
  - **Matching is a full-token suffix, not a substring.** A frozen suffix only fires
    when the tool name *ends* in it (as an exact name or after a `-`/`_` boundary),
    so a destructive tool with a trailing qualifier after the verb is **not** caught
    by the generic `delete` suffix — e.g. `delete_batch` (the Dropbox HTTP API has a
    real `/files/delete_batch`), `delete_file`, `delete_folder`, or `PermanentlyDelete`
    would pass through. This is deliberate — it keeps the generic `delete` token from
    over-matching benign names like `undelete` — but it means the suffix list is an
    allowlist of exact endings, **not** a semantic "anything that deletes" filter.
    None of the three dialects in scope expose such a tool today (official `Delete`,
    dbx `safe_delete_item`, ngs `dropbox_delete` are all matched); if a fork or a
    future server surfaces a batch/qualified variant, add its full suffix to
    `delete_suffixes`/`restore_suffixes`, or pair this policy with a
    `default-deny-unknown-tools` (PF-28) allowlist so drift fails closed instead of open.
  - **`Move` is intentionally out of scope.** A folder-level `Move` can restructure a
    shared tree, but renames/moves are routine, so they are left to the path-fencing
    and role-gate policies rather than frozen here. Attach those alongside this policy
    if you need move containment.
  - **Overwrites are not deletion.** Re-uploading over an existing file
    (`CreateFile` / `upload_file` / `dropbox_upload`) replaces content without a
    delete call and is **not** blocked here. Pair with an upload/version guard if you
    need overwrite protection; Dropbox keeps prior revisions, but the agent could then
    use a (blocked) restore tool to recover — hence freezing restore too.
  - **Name-only matching.** The policy does not inspect arguments, so it cannot
    distinguish, say, a single-file delete from a bulk one — all deletes are frozen.
    This is deliberate: agent-initiated deletion has no routine Cowork use.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - dropbox
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package dropbox.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rule below permits the request.
default allow := false

# Destructive / bulk-mutation tool suffixes across the three Dropbox dialects.
# The gateway prefixes tool names with the configured MCP server name
# (separator not standardized), so we match the exact name or a `-`/`_`-
# separated suffix, case-insensitively, to stay portable.
delete_suffixes := [
    # Official mcp.dropbox.com `Delete`. Also catches ngs `dropbox_delete`
    # via the `_delete` boundary; listed there too for clarity.
    "delete",
    # dbx-mcp-server community soft-delete
    "safe_delete_item",
    # ngs community delete (also matched by `delete` above)
    "dropbox_delete",
]

# Folder rewind + file-revision resurrection. `RestoreFolder` rewinds a whole
# folder to a point in time; `RestoreFileRevision` / `dropbox_restore_file`
# resurface a previous revision of a single file.
restore_suffixes := [
    "restorefolder",
    "restorefilerevision",
    "dropbox_restore_file",
]

# Case-insensitive tool name; missing fields resolve to "" (never matches).
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Match the exact tool name, or a `-`/`_`-separated suffix so any gateway
# server-name prefix is tolerated (e.g. `dropbox-Delete`, `dbx-mcp-dropbox_delete`).
tool_matches(suffix) if tool_name == suffix

tool_matches(suffix) if endswith(tool_name, sprintf("-%s", [suffix]))

tool_matches(suffix) if endswith(tool_name, sprintf("_%s", [suffix]))

is_delete_tool if {
    some suffix in delete_suffixes
    tool_matches(suffix)
}

is_restore_tool if {
    some suffix in restore_suffixes
    tool_matches(suffix)
}

is_destructive_tool if is_delete_tool

is_destructive_tool if is_restore_tool

# Allow any tool that isn't on the frozen list. There is no identity carve-out.
allow if {
    not is_destructive_tool
}

reasons contains "Deleting Dropbox files through an agent is frozen. Delete the item yourself in the Dropbox web or desktop app so a human owns the decision. Deleted files are recoverable only within your plan's retention window, so a mistaken or bulk agent delete may be permanent. Contact your InfoSec team if this block is a false positive." if {
    is_delete_tool
}

reasons contains "Rewinding a Dropbox folder to an earlier point in time, or restoring a previous file revision, is frozen on the agent channel — it can silently revert an entire shared folder or resurface content that was deliberately removed. Perform the restore yourself in the Dropbox web app so a human owns the decision. Contact your InfoSec team if this block is a false positive." if {
    is_restore_tool
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
