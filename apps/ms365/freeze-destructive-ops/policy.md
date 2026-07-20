---
name: Freeze Destructive Microsoft 365 Operations
tags:
  - ms365
  - freeze-destructive-ops
  - record-integrity
  - ingress
  - sox
  - soc2
publishedAt: 2026-07-12
description: |
  # ms365 / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `ms365.ingress.freeze_destructive_ops`

  ## What it does

  Denies every Microsoft 365 tool call whose verb segment is `delete-` or `cancel-` unless the caller's IdP token carries the placeholder group `m365-admin`. All other tool calls pass through unchanged.

  Deletes and cancels are the irreversible-leaning end of the M365 tool surface: a deleted mail message, OneDrive file, group, Excel range, or SharePoint list item may be unrecoverable, and a cancelled calendar event notifies every attendee. An agent acting on a hallucinated instruction or an injected prompt must not be able to destroy records — so the destructive verb family is frozen for everyone except an explicitly designated admin group. The check runs at ingress, before the call reaches the MCP server, so a blocked delete never executes.

  Verified tools this catches (softeria `ms-365-mcp-server`, observed live behind a gateway with the `ms365-` prefix): `delete-mail-message`, `delete-mail-folder`, `delete-onedrive-file`, `delete-drive-item-permission`, `delete-excel-range`, `delete-excel-table-row`, `delete-sharepoint-list-item`, `delete-sharepoint-list-column`, `delete-group`, `delete-team-channel`, `delete-calendar`, `delete-calendar-event`, `delete-online-meeting`, `delete-subscription`, `delete-mail-rule`, `delete-onenote-page`, `delete-todo-task`, `cancel-calendar-event`. The verb matcher is deliberately broader than this list: any current or future tool whose verb segment is `delete-` or `cancel-` (e.g. `delete-outlook-contact`, `delete-planner-bucket`, `delete-contact-folder`) is gated without a policy update.

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519** — supports the anti-destruction/alteration-of-records requirement: financial records on the agent channel cannot be deleted by a non-admin caller, whether by agent error or by injected instruction. **Rule 2-06** — supports retention and legal-hold posture on the same paths.
  - **SOX EUC/spreadsheet integrity** — `delete-excel-range` and `delete-excel-table-row` on SOX-critical workbooks are admin-gated.
  - **SOC 2 PI1.5** — supports integrity of stored records by removing the agent's unilateral ability to destroy them.
  - **HIPAA §164.312(c)** — supports the integrity standard (protection of ePHI from improper destruction); **§164.530(c)** — supports privacy safeguards over records held in mailboxes and drives.
  - **GDPR Art. 5(1)(d)** — supports accuracy by preventing mass-deletion/corruption of personal-data records through the agent channel.

  ## Tool name matching

  The softeria server names tools verb-first (`delete-mail-message`, `cancel-calendar-event`), and the DTwo gateway prepends the configured MCP server name (observed live as `ms365-`). Because the prefix is deployment-specific, the policy matches the verb segment rather than exact names, case-insensitively:

  - contains `-delete-` or `-cancel-` (prefixed deployments, e.g. `ms365-delete-mail-message`)
  - starts with `delete-` or `cancel-` (unprefixed/local deployments)

  Underscores in the tool name are normalized to hyphens before matching, so a snake_case-named variant (`delete_mail_message`) is gated too. The name is read from both the PARC field (`input.resource.name`) and the legacy alias (`input.payload.name`) via `object.get` chains, and the two are matched **independently** — a request missing the `resource` block, or one carrying a malformed (non-string) value in either field, still cannot skip the match. Each field is coerced to a lowercased string (a number, null, array, or object resolves to the empty string), so a non-string value in one field can never suppress a genuine `delete-`/`cancel-` verb in the other.

  Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production. The match is substring-based, so a hypothetical tool with `delete`/`cancel` in a noun position would also be gated — for a record-integrity policy, over-matching is the safe direction.

  ## Argument shape

  None. The decision uses only the tool name (`input.resource.name`, with the legacy `input.payload.name` as fallback) and the caller's identity (`input.subject.claims.groups`); arguments are not inspected.

  Group membership is read via `object.get`-chained access to `input.subject.claims.groups` and fails closed: a missing subject, missing claims, missing `groups`, or a non-array `groups` value all mean "not admin", so the destructive call is denied.

  ## Examples

  ### Allowed — read tool, any caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-list-mail-messages", "type": "tool" },
      "payload": { "name": "ms365-list-mail-messages", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — delete by an admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-delete-mail-message", "type": "tool" },
      "subject": { "sub": "admin@example.com", "claims": { "groups": ["m365-admin"] } },
      "payload": { "name": "ms365-delete-mail-message", "args": { "messageId": "AAMk..." } }
    }
  }
  ```

  `allow = true`.

  ### Denied — delete by a non-admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-delete-onedrive-file", "type": "tool" },
      "subject": { "sub": "user@example.com", "claims": { "groups": ["finance"] } },
      "payload": { "name": "ms365-delete-onedrive-file", "args": { "driveId": "b!x", "driveItemId": "01A" } }
    }
  }
  ```

  `allow = false`, `reason = "This delete/cancel operation is blocked because it is irreversible (...)"`.

  ## Composition

  This policy is single-purpose: it freezes the `delete-`/`cancel-` verb family and nothing else. Pair it with:

  - a role-gate policy for the wider write surface (`remove-group-member`, `remove-team-member`, `add-group-owner`, `upload-file-content` overwrites, `clear-excel-range`) — those verbs are destructive-adjacent but intentionally out of scope here,
  - an ingress deny on `graph-batch` (and, for Lokka deployments, on non-GET `Lokka-Microsoft` calls) — arbitrary Graph passthrough can issue DELETE requests without ever touching a `delete-*` tool name,
  - a mail-rule/subscription tampering policy (`create-mail-rule`, `update-mail-rule`, `create-subscription`).

  ## Known limitations

  - **Group names are placeholders — replace `m365-admin` with your IdP's group name at import time.** The gate reads `input.subject.claims.groups`; confirm your IdP actually emits a `groups` claim (Auth0 and Entra ID both require explicit configuration) before relying on the admin exemption. With no `groups` claim, the policy still fails closed: destructive calls are denied for everyone.
  - **`graph-batch` and Lokka bypass name matching.** A batched Graph request or Lokka's single passthrough tool can perform DELETE operations without a `delete-*` tool name. Gate those tools with the companion policies above.
  - **Destruction by overwrite is not covered.** `update-*` tools and `upload-file-content` can effectively destroy content by replacing it; `clear-excel-range` and `remove-*` membership tools are also out of scope. Those belong to the write-gating companion policy — this policy stays single-job on the delete/cancel verb family.
  - **Anthropic's hosted M365 connector is out of reach.** It runs Anthropic-hosted and does not traverse a customer gateway, so no gateway policy applies to it.
  - **Recoverability varies by workload.** Some deletes go to recoverable-items/recycle-bin stages with retention windows; others (permission deletes, Excel ranges, subscriptions) are effectively immediate. The policy treats the whole verb family as irreversible rather than modeling per-workload recovery.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - ms365
industries: []
bundles:
  - sox
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package ms365.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group allowed to run delete/cancel operations.
# Replace "m365-admin" with your IdP's group name at import time.
admin_group := "m365-admin"

# --- Destructive verb matching ---
# The softeria ms-365-mcp-server names tools verb-first (delete-mail-message,
# cancel-calendar-event) and the gateway prepends the configured MCP server
# name (observed live as `ms365-`), so the verb segment appears after a
# hyphen in prefixed deployments and at the start in unprefixed ones.
# Verify the exact names on your gateway with the dump-input debug technique.

# Tool name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), so a
# request that somehow omits the resource block still cannot skip matching
# (red-team hardening: missing resource must not fail open).
# name_of coerces to a lowercased string. A missing OR non-string value
# (number, null, array, object) resolves to "" rather than leaving the rule
# undefined — critical, because an undefined name would make the set literal
# in is_destructive_tool undefined and skip matching entirely (fail-open).
name_of(key) := lower(v) if {
    v := object.get(object.get(input, key, {}), "name", "")
    is_string(v)
}

name_of(key) := "" if {
    v := object.get(object.get(input, key, {}), "name", "")
    not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

# Both names are checked independently. Reading the two fields into a set and
# iterating would re-couple them; keeping separate branches means a malformed
# (non-string) value in one field cannot suppress a real delete/cancel verb in
# the other.
is_destructive_tool if {
    # Normalize underscores to hyphens so a snake_case-named variant of the
    # verb family (e.g. delete_mail_message) is still gated. Over-matching
    # is the safe direction for a record-integrity freeze.
    destructive_verb(replace(resource_name, "_", "-"))
}

is_destructive_tool if {
    destructive_verb(replace(payload_name, "_", "-"))
}

# Verb segment after a hyphen (prefixed deployments, e.g. ms365-delete-*).
destructive_verb(name) if contains(name, "-delete-")

destructive_verb(name) if contains(name, "-cancel-")

# Verb segment at the start (unprefixed/local deployments).
destructive_verb(name) if startswith(name, "delete-")

destructive_verb(name) if startswith(name, "cancel-")

# --- Admin gate ---
# Reads the groups claim through object.get chains so a missing subject,
# missing claims, missing groups, or non-array groups value fails closed:
# the caller is simply not an admin and the destructive call is denied.
caller_is_admin if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    some group in groups
    group == admin_group
}

# Allow any tool outside the delete/cancel verb family.
allow if {
    not is_destructive_tool
}

# Allow delete/cancel tools only for members of the admin group.
allow if {
    is_destructive_tool
    caller_is_admin
}

reasons contains "This delete/cancel operation is blocked because it is irreversible: records must survive agent error and prompt injection. Move the item to another folder or archive it instead of deleting. For legitimate admin cleanup, ask a member of your Microsoft 365 admin group (placeholder: m365-admin) to run it, or ask your InfoSec team to add you to that group." if {
    is_destructive_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
