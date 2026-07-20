---
name: Freeze Destructive QuickBooks Operations
tags:
  - quickbooks
  - freeze-destructive-ops
  - ingress
  - sox
  - soc2
publishedAt: 2026-07-12
description: |
  # quickbooks / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny destructive tool calls, allow everything else
  **Package:** `quickbooks.ingress.freeze_destructive_ops`

  ## What it does

  Denies every destructive QuickBooks Online (QBO) tool call on the agent channel
  before it reaches the MCP server. In QBO semantics a transaction delete is a
  **hard delete** — the row is gone and is recoverable only from the audit log, not
  from a recycle bin. An agent (or an agent following a poisoned instruction) must
  therefore never be allowed to consummate one. A person performs any deletion in
  the QuickBooks Online UI instead. There is no group exemption: this policy blocks
  **all callers**.

  Two destructive shapes are covered:

  - **Dedicated destructive tools (official server, LibreChat, Claude connector).**
    The official Intuit server exposes `verb_entity` tools, and the policy denies any
    tool whose name carries a destructive verb (`delete`, `void`, or `deactivate`)
    followed by an entity separator (`_` or `-`) — matched at a word boundary,
    case-insensitively — which covers all 20
    destructive tools in the official
    inventory: `delete_invoice`, `delete_payment`, `delete_bill`,
    `delete_bill_payment`, `delete_journal_entry`, `delete_deposit`,
    `delete_transfer`, `delete_credit_memo`, `delete_refund_receipt`,
    `delete_purchase`, `delete_purchase_order`, `delete_sales_receipt`,
    `delete_vendor_credit`, `delete_estimate`, `delete_time_activity`,
    `delete_customer`, `delete_vendor`, `delete_employee`, `delete_item`, and
    `delete_attachable`. (Transaction deletes are hard deletes; the name-entity
    "deletes" — customer/vendor/employee/item — are QBO deactivations, blocked here
    too for a consistent no-destruction posture.) No surveyed build exposes a
    dedicated `void_<entity>` or `deactivate_<entity>` tool — voids/deactivations
    there ride the `delete_*` name or the `operation` argument — but the name rule
    matches those verbs too, symmetric with the `operation` rule, so a dedicated
    `void_*`/`deactivate_*` tool on the unverified connector build cannot slip past.
  - **Parameterized 6-mega-tool shape (archived hvkshetry server).** That server
    hides the verb in an argument — `transaction(operation="delete"|"void")`,
    `party(operation="deactivate")`, etc. — so a tool-name match sees only
    `transaction`, `party`, `item`, etc. To cover it, the policy also denies whenever
    the `operation` argument resolves to `delete`, `void`, or `deactivate`
    (case- and whitespace-insensitive), read from **either**
    `input.payload.args.operation` **or** `input.payload.params.arguments.operation`.

  Reads (`get_*`, `search_*`), the 11 financial reports, and non-destructive
  create/update writes (`create_invoice`, `update_customer`, …) pass through
  unchanged. Because the check runs at ingress, a blocked delete never touches the
  ledger.

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519 — anti-destruction/alteration of records.** QBO is
    the general ledger for most SMBs; every transaction row is a book of record. This
    policy keeps agent-initiated destruction (and voids) of invoices, payments,
    journal entries, deposits, transfers, bills, and the rest off the MCP path, so a
    financial record cannot be erased or altered-by-deletion by an automated actor.
    **§802 / SEC Rule 2-06** — supports retention and legal-hold posture by keeping
    agent-driven deletion off evidence paths.
  - **SOC 2 PI1.5 — integrity of stored records.** Supports processing-integrity by
    preventing agent-initiated destruction of stored accounting records on the agent
    channel.

  ## Tool name matching

  Matches case-insensitively on the tool name. The DTwo gateway prefixes tool
  names with the configured MCP server name (e.g. `quickbooks-delete_invoice`), and
  that prefix is **not standardized** across the official, LibreChat, and
  Claude-connector builds — so instead of an exact name the policy matches a
  destructive verb (`delete`, `void`, or `deactivate`) at a word boundary (start of
  name, or preceded by a non-letter such as the gateway's `-`/`_` separator)
  followed by an entity separator (`_` or `-`).
  This is portable across server-name prefixes and across builds that render the
  verb/entity boundary with either `_` (`delete_invoice`) or `-` (`delete-invoice`),
  and covers every `delete_<entity>` tool — and any dedicated `void_<entity>` /
  `deactivate_<entity>` tool — without enumerating each one. It does not
  match a restore-style `undelete_*` or `reactivate_*` name, nor a read tool that
  merely contains the word "deleted"/"voided" (e.g. `get_deleted_invoices`,
  `get_voided_invoices`), nor an unrelated `avoid_*`, because in each case the
  character right after the verb is a letter (or a letter precedes it), not a
  separator at a boundary.

  The name is read from **both** the PARC field (`input.resource.name`) and the
  legacy alias (`input.payload.name`), matched independently: a request that omits
  the `resource` block cannot skip the name match by carrying the name only in
  `payload.name` (fail-open hardening). Each field is coerced to a lowercased,
  whitespace-trimmed string — a missing or non-string value (number, null, array,
  object) resolves to the empty string rather than leaving the match undefined, and
  `trim_space` strips leading/trailing spaces, tabs, and newlines so a padded name
  such as `quickbooks-delete_invoice\n` cannot slip past the boundary match.

  **Confirm the exact names your gateway sends with a live `tools/list` (or the
  dump-input debug technique) before relying on this in production** — the landscape
  note flags the Claude-connector tool names as unpublished/unverified, and the QBO
  report tool-name strings were likewise not verified from source.

  ## Argument shape

  - **`operation` verb (parameterized servers).** Read from
    `input.payload.args.operation` and `input.payload.params.arguments.operation` via
    `object.get` chains. Each value is stringified, lowercased, and whitespace-trimmed
    before comparison against the destructive set `{delete, void, deactivate}`. A
    padded `" delete "`, a case variant (`DELETE`), or the same verb delivered under
    the alternate `params.arguments` container are all caught.
  - The dedicated `delete_*` tools are denied on name alone; their `id` / entity-id
    arguments are not inspected.

  ## Examples

  ### Allowed — read tool, untouched

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-get_invoice", "type": "tool" },
      "payload": { "name": "quickbooks-get_invoice", "args": { "id": "145" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — non-destructive create write

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-create_invoice", "type": "tool" },
      "payload": {
        "name": "quickbooks-create_invoice",
        "args": { "customer_ref": "58", "line_items": [{ "item_ref": "1", "qty": 2, "unit_price": 50 }] }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — dedicated delete tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-delete_invoice", "type": "tool" },
      "payload": { "name": "quickbooks-delete_invoice", "args": { "id": "145" } }
    }
  }
  ```

  `allow = false`, reason names the tool and points to the QuickBooks Online UI.

  ### Denied — parameterized mega-tool hiding the verb in `operation`

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "qbo-transaction", "type": "tool" },
      "payload": {
        "name": "qbo-transaction",
        "args": { "operation": "void", "entity_type": "Payment", "id": "22" }
      }
    }
  }
  ```

  `allow = false`, reason names the `void` operation.

  ## Composition

  Single-purpose: this policy only freezes destruction. Useful companions:

  - **PF-09 gate-money-movement** — group-gate and cap `create_payment`,
    `create_bill_payment`, `create_refund_receipt`, and `create_transfer` so
    money-movement writes are governed even though they are not deletes.
  - **PF-12 role-gate-writes** — allow `create_*` / `update_*` only for a finance
    IdP group, leaving reads and reports open; attach both for full write governance.
  - **A journal-entry lockout** — deny `create_journal_entry` / `update_journal_entry`
    for all agents, since direct ledger restatement is the highest-risk write.

  ## Known limitations

  - **No identity exemption by design.** The spec is a hard freeze — every caller is
    denied and no group can override it through the agent. If you need a break-glass
    finance role, add a separate `allow if` branch gated on `input.subject.claims`
    (`groups`) rather than editing this policy; group names would be placeholders to
    replace with your IdP's group at import time.
  - **Tool names are unverified for two builds.** The Claude-connector tool names are
    not published, and the QBO report tool-name strings were not verified from source.
    The `delete_` verb match assumes the connector reuses the official `verb_entity`
    vocabulary. Capture the live `tools/list` and confirm before production use.
  - **Destructive-verb word-boundary match.** Matching `delete`, `void`, or
    `deactivate` at a boundary (followed by a `_` or `-` separator) over-blocks any
    future or third-party tool whose name contains a `delete_<x>` / `void-<x>` /
    `deactivate_<x>` segment (e.g. a hypothetical `soft_delete_note` on another server
    on the same gateway). The failure mode is over-blocking, never under-blocking.
    Restore-style `undelete_*`/`undelete-*` and `reactivate_*` names are **not**
    matched (the boundary requires a non-letter before the verb), a read tool whose
    name merely contains "deleted"/"voided" (e.g. `get_deleted_invoices`,
    `get_voided_invoices`) is not matched (the char after the verb is a letter, not a
    separator), and an unrelated `avoid_*` is not matched (a letter precedes `void`).
    The `void`/`deactivate` verbs are matched on the name symmetrically with the
    `operation`-argument rule: no surveyed build ships a dedicated `void_*`/
    `deactivate_*` tool, but the connector build's tool names are unverified, so the
    name rule blocks them pre-emptively rather than relying on the argument rule alone.
  - **Verb/entity separator must be `_` or `-`.** The name match requires a `_` or
    `-` between the `delete` verb and the entity (`delete_invoice`, `delete-invoice`);
    a hypothetical concatenated name with **no** separator (`deleteinvoice`) is not
    matched by the name rule. This is not a real evasion on a correctly configured
    gateway — it routes on the exact server-registered tool name, and every surveyed
    QBO build uses an underscore-separated `delete_<entity>` name — but if you cannot
    rely on that invariant, compose the PF-28 `default-deny-unknown-tools` allowlist.
  - **Reversible deactivation via `update_*` is not blocked.** In QBO, deactivating a
    name entity (customer/vendor/employee/item) can be done either by the dedicated
    `delete_<entity>` tool (blocked here) **or** by an ordinary `update_<entity>`
    write that sets `active: false` — and that update passes through, because this
    policy deliberately allows non-destructive create/update writes. The gap is
    bounded to *reversible* deactivations (they can be re-activated by another
    update); the irreversible concern — hard deletes and voids of transactions — has
    no `update_*` equivalent and is fully covered by the `delete`/`operation` rules.
    If you need to freeze `active: false` toggles too, compose **PF-12
    role-gate-writes** (or a dedicated update-guard policy) that inspects
    `update_*` argument bodies.
  - **The `operation` rule keys on exact verbs.** It denies only `delete`, `void`, and
    `deactivate`. A parameterized server that uses a different destructive verb, or a
    mega-tool call that omits `operation` entirely, is **not** caught by the argument
    rule (and, having no `delete_` tool name, would pass). Unlike a fail-closed
    allowlist, this follows the spec's explicit-deny model — confirm your server's
    `operation` vocabulary and extend `destructive_operations` if it uses other verbs.
    A **non-string** `operation` value (e.g. an array `["delete"]`) is stringified by
    `sprintf("%v", …)` to `"[delete]"`, which is not in the destructive set and so is
    not caught by the argument rule. This is not a real evasion: a typed mega-tool
    server rejects a non-string `operation`, so the call never reaches a destructive
    code path — but if you cannot rely on server-side type validation, add the PF-28
    `default-deny-unknown-tools` allowlist.
  - **Name matching is normalized apart from non-whitespace padding.** The tool name
    is lowercased and `trim_space`d before the boundary match, so casing and
    leading/trailing spaces, tabs, and newlines are handled, and both `resource.name`
    and `payload.name` are checked so a missing `resource` block cannot fail open. It
    does **not** normalize other trailing/embedded characters: a name padded with a
    non-whitespace code point (e.g. a zero-width space) or built from Unicode
    homoglyphs of `delete_` would not match. These are not real evasions on a correctly
    configured gateway — it routes on the exact server-registered tool name, so a
    padded/homoglyph name does not resolve to the real destructive tool — but if you
    cannot rely on that invariant, compose the PF-28 `default-deny-unknown-tools`
    allowlist alongside this policy.
  - **MCP path only.** Deletes performed in the QuickBooks Online web UI, via the QBO
    REST API directly, or by another integration are outside the gateway's reach.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - quickbooks
industries: []
bundles:
  - sox
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package quickbooks.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Destructive verbs that can appear in the `operation` argument of a
# parameterized (mega-tool) QuickBooks MCP server such as the archived
# hvkshetry build — transaction(operation="delete"|"void"), etc. Compared
# case- and whitespace-insensitively.
destructive_operations := {"delete", "void", "deactivate"}

# Case-insensitive tool name, read from BOTH the PARC field (resource.name) and
# the legacy alias (payload.name). name_of coerces to a lowercased,
# whitespace-trimmed string: a missing OR non-string value (number, null, array,
# object) resolves to "" rather than leaving the rule undefined (an undefined
# name would make the regex check undefined and skip matching entirely —
# fail-open). trim_space strips leading/trailing whitespace so a padded name like
# "quickbooks-delete_invoice\n" cannot slip past the boundary match.
name_of(key) := trim_space(lower(v)) if {
	v := object.get(object.get(input, key, {}), "name", "")
	is_string(v)
}

name_of(key) := "" if {
	v := object.get(object.get(input, key, {}), "name", "")
	not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

# Display name for the deny reason: the PARC name when present, else the legacy
# payload name (so the message is meaningful even if the resource block is absent).
display_name := resource_name if resource_name != ""

display_name := payload_name if resource_name == ""

# Dedicated destructive tools. The gateway prefixes the tool with the configured
# server name, which is not standardized, so we match a destructive verb
# (`delete`, `void`, or `deactivate`) at a word boundary (start of the name, or
# preceded by a non-letter such as the `-`/`_` gateway separator) followed by an
# entity separator (`_` or `-`), rather than an exact name. This covers every
# `delete_<entity>` tool in the official inventory without enumerating each one,
# and — because the separator class is `[_-]` — also catches a hyphen-cased
# `delete-<entity>` name from a server or gateway build that renders the
# verb/entity boundary with `-` instead of `_`. The `void`/`deactivate` verbs are
# matched on the NAME too (symmetric with the `operation`-argument rule below) so
# a dedicated `void_<entity>`/`deactivate_<entity>` tool — plausible on the
# Claude-connector build whose tool names the landscape note flags as unverified —
# cannot slip past a delete-only name match. It does NOT match a restore-style
# `undelete_*`/`undelete-*` or `reactivate_*` name (a letter precedes the verb),
# nor a read tool that merely contains the word "deleted"/"voided" such as
# `get_deleted_invoices`/`get_voided_invoices` (the verb is followed by a letter,
# not a separator), nor an unrelated `avoid_*` (the `void` there is preceded by a
# letter). Both names are checked independently, so a malformed value in one field
# cannot suppress a real destructive verb carried in the other.
is_destructive_tool_name if {
	regex.match(`(^|[^a-z])(delete|void|deactivate)[_-]`, resource_name)
}

is_destructive_tool_name if {
	regex.match(`(^|[^a-z])(delete|void|deactivate)[_-]`, payload_name)
}

# All `operation` argument values, read from both the generic gateway args key
# and the alternate params.arguments container, normalized (stringified,
# lowercased, whitespace-trimmed). Empty/missing values are dropped.
operation_values contains v if {
	op := object.get(object.get(object.get(input, "payload", {}), "args", {}), "operation", "")
	v := lower(trim_space(sprintf("%v", [op])))
	v != ""
}

operation_values contains v if {
	params := object.get(object.get(input, "payload", {}), "params", {})
	arguments := object.get(params, "arguments", {})
	op := object.get(arguments, "operation", "")
	v := lower(trim_space(sprintf("%v", [op])))
	v != ""
}

# A parameterized call whose `operation` verb is destructive.
destructive_operation_arg if {
	some v in operation_values
	destructive_operations[v]
}

# A destructive request: a dedicated delete_/void_/deactivate_ tool, or any tool
# carrying a destructive `operation` argument.
is_destructive if {
	is_destructive_tool_name
}

is_destructive if {
	destructive_operation_arg
}

# Allow anything that is not destructive (reads, reports, create/update writes,
# and non-QuickBooks tools).
allow if {
	not is_destructive
}

reasons contains msg if {
	is_destructive_tool_name
	msg := sprintf("The tool '%s' performs a destructive QuickBooks operation. In QuickBooks Online most transaction deletes are hard deletes, recoverable only from the audit log, so agent-initiated deletes and deactivations are blocked on this channel. A person must perform the deletion in the QuickBooks Online UI. Contact your finance or InfoSec team if this block is a false positive.", [display_name])
}

reasons contains msg if {
	destructive_operation_arg
	some v in operation_values
	destructive_operations[v]
	msg := sprintf("This QuickBooks tool call requests a destructive operation ('%s') through its 'operation' argument. Delete, void, and deactivate are blocked on the agent channel because QuickBooks transaction deletes are hard deletes, recoverable only from the audit log. Perform the change in the QuickBooks Online UI instead. Contact your finance or InfoSec team if this block is a false positive.", [v])
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
