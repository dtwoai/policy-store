---
name: Freeze Destructive Gmail Operations
tags:
  - gmail
  - freeze-destructive-ops
  - record-integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # gmail / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `gmail.ingress.freeze_destructive_ops`

  ## What it does

  Denies the irreversible destruction surface that community Gmail MCP servers expose — permanent email deletion, label deletion, and filter deletion — for **every** caller. All other tool calls pass through unchanged.

  The community servers are where the risk lives. GongRzhe/Gmail-MCP-Server ships `delete_email` and `batch_delete_emails` (both **permanent** — they bypass the trash entirely, and the batch variant destroys up to 50 messages per call), plus `delete_label` and `delete_filter`. taylorwilsdon/google_workspace_mcp folds destruction into `manage_gmail_label` and `manage_gmail_filter` behind an `action` argument — this policy denies those two tools **only** when `action` is `delete`, so their `list`/`get`/`create`/`update` actions pass through for other policies to govern.

  There is deliberately **no identity exemption**: a mailbox record must survive agent error and prompt injection regardless of who is driving the agent. The deny reason steers the agent to the reversible alternatives — archive via label modification (`modify_email` / `batch_modify_gmail_message_labels`) or move the message to trash — and points legitimate deletion needs at InfoSec, outside the agent channel.

  The official Google remote Gmail MCP server (the surface behind Anthropic's Claude Gmail connector) has **no delete tools of any kind** — no message, label, or filter deletion. On that surface this policy matches nothing and is inert **by design**; that is the expected state, not a coverage gap. Attach it anyway: it costs nothing there and becomes load-bearing the moment a tenant swaps in a community server, which is exactly the migration that silently adds permanent-delete primitives.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports integrity of stored records by removing the agent's unilateral ability to destroy messages, labels, and filters.
  - **HIPAA §164.312(c)** — supports the integrity standard (protection of ePHI in patient email from improper destruction); **§164.530(c)** — supports privacy safeguards over records held in mailboxes.
  - **GDPR Art. 5(1)(d)** — supports accuracy by preventing mass-deletion/corruption of personal-data records through the agent channel (one `batch_delete_emails` call can permanently destroy 50 messages).

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g. `gmail-delete_email` for a server named `gmail`), and that prefix is deployment-specific, so the policy matches case-insensitively by suffix:

  - `*delete_email` — GongRzhe single-message permanent delete
  - `*batch_delete_emails` — GongRzhe batch permanent delete (up to 50 IDs per call)
  - `*delete_label` — GongRzhe label deletion
  - `*delete_filter` — GongRzhe filter deletion
  - `*manage_gmail_label` — taylorwilsdon, denied **only** when `args.action == "delete"`
  - `*manage_gmail_filter` — taylorwilsdon, denied **only** when `args.action == "delete"`

  Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production. If the community server you use exposes a different delete-tool name, add its suffix to the matching rules in `policy.md`.

  ## Argument shape

  Only the two `manage_gmail_*` tools have their arguments inspected, and every read goes through `object.get`:

  - `args.action` is read as `object.get(object.get(input.payload, "args", {}), "action", "")`, then trimmed and lowercased before comparison, so `Delete`/`DELETE` and whitespace-padded variants (` delete `, `delete\n`) cannot slip past a server that strips/normalizes the action before dispatch.
  - A `manage_gmail_*` call with **no `args` object or no `action` key is not treated as a delete** and passes through — the server itself will reject the malformed call; this policy only freezes confirmed deletions.
  - A non-string `action` value (array, object, number) does not compare equal to `"delete"` and passes through; the upstream server's schema validation rejects such calls anyway.

  The plain suffix-matched tools (`delete_email`, `batch_delete_emails`, `delete_label`, `delete_filter`) are denied on tool name alone — no argument can make a permanent delete safe.

  ## Examples

  ### Allowed — archiving via label modification (the recommended alternative)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-modify_email", "type": "tool" },
      "payload": {
        "name": "gmail-modify_email",
        "args": { "messageId": "18f3a2", "removeLabelIds": ["INBOX"] }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — batch permanent deletion

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-batch_delete_emails", "type": "tool" },
      "payload": {
        "name": "gmail-batch_delete_emails",
        "args": { "messageIds": ["18f3a2", "18f3a3"], "batchSize": 50 }
      }
    }
  }
  ```

  `allow = false`, `reason = "Permanent email deletion is blocked (...)"`.

  ### Allowed — manage_gmail_label with a non-delete action

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-manage_gmail_label", "type": "tool" },
      "payload": {
        "name": "gmail-manage_gmail_label",
        "args": { "action": "create", "name": "audit-hold" }
      }
    }
  }
  ```

  `allow = true` — create/update/list/get actions are left for other policies to govern.

  ## Composition

  This policy is single-purpose: it freezes confirmed deletion operations and nothing else. Pair it with:

  - a **filter-creation guard** on `create_filter` / `create_filter_from_template` / `manage_gmail_filter` with `create`/`update` actions — filter *creation* is the auto-forward persistence/exfiltration primitive, and it is intentionally out of scope here,
  - an **external-send guard** on `send_email` / `send_gmail_message` — externally visible and unrecallable, a different risk family,
  - an **egress redaction** policy on the read surface (`get_thread` / `read_email` / `get_gmail_*_content*`) for regulated data leaving the mailbox.

  ## Known limitations

  - **Inert on the official Google/Claude connector surface — by design.** The official remote Gmail MCP server exposes no delete tools, so this policy never fires there. That is the documented, expected state: the policy exists to hold the line when a community server (with its delete primitives) is introduced.
  - **No identity exemption — by design.** There is no admin group that may delete through the agent channel; records must survive agent error and prompt injection for every caller. Legitimate deletions belong outside the agent channel (Gmail UI or Google Admin console) via your InfoSec team. If your organization truly requires an agent-channel break-glass, add a `groups`-gated `allow` branch per the identity-placeholder conventions — but understand it reopens the injection surface this policy closes.
  - **Trash is a delayed-deletion path, not permanence.** Moving a message to trash (via label modification) starts Gmail's ~30-day auto-purge clock. The policy guarantees a recovery window, not indefinite retention — pair with Google Vault or retention holds for true immutability.
  - **Destruction by overwrite/renaming is not covered.** `update_label` and `manage_gmail_label` with `action: "update"` can rename labels and disturb mailbox organization without deleting anything; that belongs to a label-governance companion policy, not this one.
  - **`manage_gmail_*` action vocabulary is source-verified as of July 2026.** The `action` argument key and its `delete` value are verified from taylorwilsdon's `gmail_tools.py`. If a future version adds another destructive action value (e.g. `purge`), it would pass this policy until the matcher is extended.
  - **Malformed `manage_gmail_*` calls fail open here.** A call with a missing or non-string `action` passes the policy and is left for the server's own schema validation to reject. This is intentional (`object.get` defaults), so a benign call without an `action` argument is never misclassified as a delete.
  - **Action normalization covers case + surrounding whitespace only.** The `action` value is `trim_space`-d and lowercased, which defeats casing (`DELETE`) and padding (` delete `, `delete\n`). It does **not** normalize Unicode homoglyphs, zero-width characters, or interior whitespace (e.g. `de lete`, or a fullwidth `ｄelete`). Such a value would pass this policy — but it would also fail the upstream server's own exact-string dispatch, so no deletion occurs. If a future server variant does fuzzy/normalized action matching, extend `requested_action` accordingly.
  - **Suffix matching assumes the three verified snake_case vocabularies.** All destructive tool names in the landscape note (GongRzhe `delete_email`/`batch_delete_emails`/`delete_label`/`delete_filter`, taylorwilsdon `manage_gmail_*`) are snake_case, and the `endswith` suffixes match them. A community server that renamed a hard-delete tool to camelCase (`batchDeleteEmails`) or another shape would not match — add its suffix per the Tool name matching section before relying on the policy against that server.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - gmail
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gmail.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rule below permits the request.
default allow := false

# --- Destructive tool matching ---
# Only community Gmail MCP servers expose deletion; the official Google/Claude
# connector has no delete tools at all, so this policy is inert there by
# design. The gateway prepends the configured MCP server name (e.g. `gmail-`),
# so match by suffix, case-insensitively. Verify the exact names your gateway
# sends with the dump-input debug technique.

# GongRzhe delete_email — permanent single-message deletion, bypasses trash.
is_message_hard_delete if {
    endswith(lower(input.resource.name), "delete_email")
}

# GongRzhe batch_delete_emails — permanent deletion of up to 50 IDs per call.
is_message_hard_delete if {
    endswith(lower(input.resource.name), "batch_delete_emails")
}

# GongRzhe delete_label — destroys the label across the whole mailbox.
is_label_delete if {
    endswith(lower(input.resource.name), "delete_label")
}

# taylorwilsdon manage_gmail_label — destructive only when action == "delete";
# list/get/create/update actions pass through for other policies to govern.
is_label_delete if {
    endswith(lower(input.resource.name), "manage_gmail_label")
    requested_action == "delete"
}

# GongRzhe delete_filter — silently removes mail-routing rules.
is_filter_delete if {
    endswith(lower(input.resource.name), "delete_filter")
}

# taylorwilsdon manage_gmail_filter — destructive only when action == "delete".
is_filter_delete if {
    endswith(lower(input.resource.name), "manage_gmail_filter")
    requested_action == "delete"
}

# Safe read of the manage_* `action` argument: a missing args object or a
# missing action key yields "" (never treated as a delete). The value is
# trimmed and lowercased before comparison, so `Delete`, `DELETE`, or a
# whitespace-padded ` delete `/`delete\n` cannot slip past a server that
# strips/normalizes the action before dispatch. A non-string action leaves
# requested_action undefined, which also means "not a delete" — the upstream
# server's schema validation rejects such calls.
requested_action := lower(trim_space(action_value)) if {
    action_value := object.get(object.get(input.payload, "args", {}), "action", "")
    is_string(action_value)
}

is_destructive_call if is_message_hard_delete

is_destructive_call if is_label_delete

is_destructive_call if is_filter_delete

# Allow every tool call that is not a confirmed deletion.
allow if {
    not is_destructive_call
}

reasons contains "Permanent email deletion is blocked: delete_email and batch_delete_emails bypass the trash and cannot be undone, and records must survive agent error and prompt injection. Archive by modifying labels (modify_email / batch_modify_gmail_message_labels) or move the message to trash instead. Contact your InfoSec team if a record legitimately must be destroyed." if {
    is_message_hard_delete
}

reasons contains "Deleting Gmail labels is blocked: removing a label silently strips it from every message that carries it and breaks retention and archiving workflows. Keep the label; create/update/list label actions remain available. Contact your InfoSec team if a label legitimately must be removed." if {
    is_label_delete
}

reasons contains "Deleting Gmail filters is blocked: filters control mail routing and their removal is silent and hard to audit. Leave the filter in place; list/get/create/update filter actions remain available. Contact your InfoSec team if a filter legitimately must be removed." if {
    is_filter_delete
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
