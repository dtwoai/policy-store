---
name: Freeze Destructive Google Drive Operations
tags:
  - google-drive
  - freeze-destructive-ops
  - integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # google-drive / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on matched delete tools, allow otherwise
  **Package:** `google_drive.ingress.freeze_destructive_ops`

  ## What it does

  Blocks Google Drive delete operations issued by agents. Any tool call whose
  name ends in one of the destructive suffixes exposed by the
  `piotr-agier/google-drive-mcp` community server — `deleteItem`,
  `deleteSheet`, `deleteRange`, `deleteGoogleSlide`, `deleteComment` — is
  denied unless the caller's IdP `groups` claim contains `drive-admins`.
  All other tool calls pass through unchanged.

  The check runs at ingress, before the call reaches the MCP server, so a
  blocked deletion never executes. This matters most for `deleteRange`,
  `deleteSheet`, and `deleteGoogleSlide`: deletions *inside* a document are
  easy to miss and effectively irreversible once they age past version
  history, unlike whole-file deletes which sit in trash for ~30 days.

  The exemption fails closed: if `input.subject`, `claims`, or the `groups`
  claim is missing (no IdP configured, audience mismatch, claim not issued),
  the caller is treated as a non-admin and the deletion is denied. The same
  holds for a malformed `groups` claim — a string, object/map, number, or null
  instead of a JSON array of strings: the policy requires an array before it
  will honor any group membership, so no non-array shape can grant the
  exemption.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports integrity of stored records by removing the
    agent's ability to destroy them.
  - **HIPAA §164.312(c)** — supports the integrity standard (protection of
    ePHI from improper alteration or destruction) for PHI stored in Drive;
    **§164.530(c)** — supports privacy safeguards over PHI records.
  - **GDPR Art. 5(1)(d)** — supports accuracy by preventing agent-driven mass
    corruption/destruction of personal-data records.

  ## Tool name matching

  The policy matches destructive tools case-insensitively by suffix:

  - `*deleteitem` — files and folders
  - `*deletesheet` — a sheet within a spreadsheet
  - `*deleterange` — a cell range within a sheet
  - `*deletegoogleslide` — a slide within a presentation
  - `*deletecomment` — a comment thread

  These are the verified destructive tool names of the
  `piotr-agier/google-drive-mcp` server (v2.2.0). The DTwo gateway prefixes
  tool names with the configured MCP server name (e.g.
  `google-drive-mcp-deleteItem`), and that prefix is not standardized, so the
  policy matches on the suffix to stay portable. Verify the exact names your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  The Google official Drive MCP server and the Anthropic-hosted Claude
  connector expose **no** delete, move, rename, or permission-editing tools at
  all — this policy chiefly hardens deployments of community servers with a
  broad write surface. It is safe to attach in front of any Drive server:
  on servers with no delete tools it simply never fires.

  ## Argument shape

  None assumed. The decision is made entirely on the tool name and the
  caller's identity claims; `input.payload.args` is not inspected.

  ## Examples

  ### Allowed — read tool passes through

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-drive-mcp-readGoogleDoc", "type": "tool" },
      "payload": { "name": "google-drive-mcp-readGoogleDoc", "args": { "documentId": "1AbC" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — delete by a drive-admins member

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "subject": { "sub": "google-apps|ops@example.com", "claims": { "groups": ["drive-admins"] } },
      "resource": { "name": "google-drive-mcp-deleteItem", "type": "tool" },
      "payload": { "name": "google-drive-mcp-deleteItem", "args": { "itemId": "1AbC" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — delete by a non-admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "subject": { "sub": "google-apps|analyst@example.com", "claims": { "groups": ["engineering"] } },
      "resource": { "name": "google-drive-mcp-deleteRange", "type": "tool" },
      "payload": { "name": "google-drive-mcp-deleteRange", "args": { "spreadsheetId": "1AbC", "range": "Sheet1!A1:C10" } }
    }
  }
  ```

  `allow = false`, `reason = "Deleting Google Drive content from an agent is blocked. ..."`.

  ## Composition

  This policy is single-purpose: it freezes deletes only. Useful companions:

  - **`apps/google-drive/role-gate-writes`** — gates the non-destructive write
    surface (create/upload/update/move/rename) by IdP group; together the two
    give a full write-side posture where deletes are frozen and other writes
    are role-gated.
  - An egress PII/secret redaction policy on content-returning read tools for
    the read side.

  ## Known limitations

  - **Group name is a placeholder.** Replace `drive-admins` with your IdP's
    real group name at import time, and confirm your IdP actually emits a
    `groups` claim in the access token (many require explicit configuration).
  - **Trash-recoverable file deletes are still denied — by design.**
    `deleteItem` sends files to trash where they are recoverable for ~30 days,
    but the policy blocks it anyway: a mass-delete still disrupts collaborators,
    and trash can be emptied. The deny reason routes the agent to a human.
  - **`deleteCalendarEvent` is out of scope.** The same piotr-agier server
    also exposes `deleteCalendarEvent`; that tool belongs to the
    `google-calendar` catalog directory, not this policy.
  - **Suffix matching can over-match.** A hypothetical tool named e.g.
    `undeleteItem` (a restore) would also end with `deleteitem` and be denied.
    No current Drive server exposes such a name; if yours does, switch the
    affected entry to an exact-name match.
  - **Only these five names are covered, and only as exact trailing tokens.**
    Because matching is `endswith`, a delete tool bypasses if its name ends in
    a *different* token (a differently-verbed `delete_file`) **or** carries a
    trailing qualifier after the token (a hard-delete named
    `deleteItemPermanently` does not end in `deleteitem`, so it is not
    matched). Trailing whitespace, a newline, or other control-character
    padding on the tool name (`deleteItem\n`, `deleteItem `) is the same class
    of trailing qualifier and likewise defeats `endswith`. No current Drive
    server (piotr-agier v2.2.0, isaacphi, Google official, Anthropic connector)
    exposes such a name, and MCP dispatches tools by their exact registered
    name — so a padded or requalified name does not resolve to the real
    destructive tool at the server and is not a live bypass. If your server
    does expose such a name, add the exact suffix to `destructive_suffixes` in
    `policy.md` for your environment.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - google-drive
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_drive.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Destructive tool-name suffixes exposed by piotr-agier/google-drive-mcp
# (v2.2.0, verified from its README). The gateway prefixes tool names with
# the configured MCP server name (e.g. `google-drive-mcp-deleteItem`), so we
# match case-insensitively on the suffix to stay portable across naming
# conventions. `deleteCalendarEvent` from the same server is deliberately
# absent — it belongs to the google-calendar catalog directory.
destructive_suffixes := [
    "deleteitem",         # files and folders (trash-recoverable ~30 days)
    "deletesheet",        # a sheet within a spreadsheet
    "deleterange",        # a cell range within a sheet
    "deletegoogleslide",  # a slide within a presentation
    "deletecomment",      # a comment thread
]

is_destructive_tool if {
    name := lower(input.resource.name)
    some suffix in destructive_suffixes
    endswith(name, suffix)
}

# Allow any tool that isn't a Drive delete operation.
allow if {
    not is_destructive_tool
}

# Allow delete operations only for members of the drive-admins IdP group.
allow if {
    is_destructive_tool
    caller_is_drive_admin
}

# `drive-admins` is a placeholder — replace it with your IdP's group name at
# import time. The object.get chain fails closed: a missing subject, claims
# object, or groups claim yields an empty list, so the caller is not exempt.
# The `is_array` guard is load-bearing: without it, `some group in groups`
# would iterate the *values* of a `groups` claim shaped as an object/map, so a
# claim like {"groups": {"role": "drive-admins"}} would fail OPEN and grant the
# exemption. Requiring an array forces every non-array shape (string, object,
# number, null) to fail closed, matching the documented guarantee.
caller_is_drive_admin if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some group in groups
    group == "drive-admins"
}

reasons contains "Deleting Google Drive content from an agent is blocked. Ask a human collaborator to perform the deletion in the Drive UI instead. If this is a false positive, ask your gateway administrator to add you to the drive-admins IdP group or contact your InfoSec team." if {
    is_destructive_tool
    not caller_is_drive_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
