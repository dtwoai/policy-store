---
name: Lock Direct Journal-Entry Ledger Writes
tags:
  - quickbooks
  - protect-closed-periods
  - ingress
  - sox
publishedAt: 2026-07-12
description: |
  # quickbooks / protect-closed-periods-journal-entries

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny direct journal-entry writes unless the caller is in the `controller` group; allow everything else
  **Package:** `quickbooks.ingress.protect_closed_periods_journal_entries`

  ## What it does

  Denies the QuickBooks Online tools `create_journal_entry` and
  `update_journal_entry` at ingress for **every** caller except those whose IdP
  claims include the `controller` group. It also denies the archived
  `hvkshetry` mega-tools `transaction` and `reference` when their
  `operation` argument is `create` or `update` against a journal-entry
  `entity_type`. All other create/update tools, all reads, and all deletes pass
  through unchanged.

  A direct journal entry restates the general ledger without flowing through a
  normal transaction workflow (invoice, bill, payment, etc.). It is the single
  write external auditors scrutinize first and the classic vector for period-end
  manipulation — a manual debit/credit that moves numbers between accounts with
  no operational document behind it. Because the check runs at ingress, a
  blocked entry never reaches QuickBooks and never posts to the ledger, so an
  over-broad OAuth grant, an agent error, or a prompt-injection attempt cannot
  restate the books on behalf of a caller who is not a controller.

  Separating who may post a manual journal entry from everyone else is core
  segregation-of-duties (SoD) territory: the caller's IdP group, not the breadth
  of their QuickBooks role, decides whether a direct ledger restatement is
  permitted over MCP.

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519 (anti-destruction/alteration of records)** —
    supports the prohibition on altering financial records by blocking
    agent-driven manual journal entries — the most direct ledger-alteration
    surface — for everyone outside the controller role.
  - **SOC 2 PI1.5 (integrity of stored records)** — supports processing
    integrity by keeping the agent channel from restating posted ledger balances
    through direct journal entries.
  - Reinforces the **segregation-of-duties** posture behind **SOX COSO
    Principle 10** and **SOC 2 CC6.3** (role-based access / least privilege /
    SoD): manual journal entries — the write most associated with period-end
    manipulation — are confined to a named controller role rather than every
    OAuth-connected user.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `qbo-mcp-create_journal_entry`), and that prefix is not standardized, so all
  matching is on the `_journal_entry` **entity suffix** of `lower(input.resource.name)`:

  - `*create_journal_entry` — Intuit official server (snake_case `verb_entity`)
    and the LibreChat raw-QBO build (same `verb_entity` tool names, PascalCase
    *arguments*). The Intuit-published Claude connector's tool names are
    **unverified** (not published on the connector page — see the landscape
    note); given Intuit's OSS server they are expected to use the same
    vocabulary, but confirm with the dump-input debug technique before relying
    on this in production.
  - `*update_journal_entry` — the matching update tool on the same servers.

  The entity suffix is matched together with the `create`/`update` verb, so
  `delete_journal_entry` (a destructive op — see **Composition**, PF-06) and the
  read tools `get_journal_entry` / `search_journal_entries` are deliberately
  **not** caught by this policy.

  For the archived `hvkshetry/quickbooks-mcp` server, which collapses the API
  into six mega-tools with an `operation` argument, the policy matches tool
  names ending in `transaction` or `reference` and denies only when the request
  is a journal-entry create/update (see Argument shape).

  ## Argument shape

  - **Direct tools** (`create_journal_entry` / `update_journal_entry`) — the
    policy keys only on the tool name; it does not inspect the entry's line
    items. Denying the whole tool is the intended behavior.
  - **Mega-tools** (`transaction` / `reference`) — the verb lives in an
    argument, not the tool name. The policy reads `operation` and `entity_type`
    from `input.payload.args`, matching case-insensitively: both the `operation`
    and `entity_type` values are normalized (stringified, lowercased, and with
    **every non-alphanumeric character** stripped — not merely
    spaces/underscores/hyphens). The `operation` is caught when its normalized
    form contains the `create` or `update` token, and the `entity_type` when its
    normalized form contains `journalentry`, so `JournalEntry`, `journal_entry`,
    `journal entry`, and even a punctuated `Journal.Entry` all match. Substring —
    not exact — matching is deliberate:
    it keeps a value smuggled as a wrapped or decorated shape (e.g.
    `entity_type: ["JournalEntry"]`, which normalizes to `journalentry`, or
    `operation: ["create"]`) from slipping past the gate, while non-journal-entry
    entities and non-write operations (delete/void/deactivate) contain neither
    token and pass through. The
    argument container is also read from `input.payload.arguments` and merged, so
    the gate works whichever key the gateway populates; each is coerced to `{}`
    when a gateway supplies a scalar, so a non-object container can neither fail
    the merge open nor evade the gate.

  A mega-tool call with no readable `operation`, a non-create/update
  `operation`, or a non-journal-entry `entity_type` is **not** a direct
  journal-entry restatement and passes through this policy (a `delete`/`void`
  operation is out of scope here — see PF-06 under Composition).

  ## Identity

  The controller gate reads `claims := object.get(input.subject, "claims", {})`
  through `object.get` chains, so a missing subject, missing `claims`, or empty
  `groups` deterministically **fails closed**: no `controller` group → the
  caller is not exempt → the journal-entry write is denied. Group membership is
  compared case-insensitively and requires the exact group name `controller`;
  near-misses such as `controllers` or `financial-controller` do not match.

  ## Examples

  ### Allowed — controller posts a journal entry

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "qbo-mcp-create_journal_entry", "type": "tool" },
      "subject": { "claims": { "groups": ["controller"] } },
      "payload": {
        "name": "qbo-mcp-create_journal_entry",
        "args": { "line_items": [{ "amount": 500, "detail_type": "JournalEntryLineDetail" }] }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — a non-journal-entry create tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "qbo-mcp-create_invoice", "type": "tool" },
      "subject": { "claims": { "groups": ["ap"] } },
      "payload": {
        "name": "qbo-mcp-create_invoice",
        "args": { "customer_ref": "12" }
      }
    }
  }
  ```

  `allow = true` — creating an invoice is outside this policy's scope.

  ### Denied — non-controller creates a journal entry

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "qbo-mcp-create_journal_entry", "type": "tool" },
      "subject": { "claims": { "groups": ["ap"] } },
      "payload": {
        "name": "qbo-mcp-create_journal_entry",
        "args": { "line_items": [{ "amount": 999999 }] }
      }
    }
  }
  ```

  `allow = false`, `reason = "Direct journal-entry writes to the QuickBooks general ledger are restricted to the controller role. ..."`.

  ### Denied — mega-tool journal-entry create by a non-controller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "qbo-mcp-transaction", "type": "tool" },
      "subject": { "claims": { "groups": ["ap"] } },
      "payload": {
        "name": "qbo-mcp-transaction",
        "args": { "operation": "create", "entity_type": "JournalEntry" }
      }
    }
  }
  ```

  `allow = false`, same reason.

  ## Composition

  This policy is single-purpose (lock the manual journal-entry surface). Useful
  companions for QuickBooks:

  - **`freeze-destructive-ops`** (PF-06) — deny `delete_*` (QBO transaction
    deletes are hard deletes) and mega-tool `delete`/`void` operations, which
    this policy deliberately leaves alone.
  - **`role-gate-writes`** (PF-12) — read-only-by-default per app; gate the
    remaining `create_*`/`update_*` tools (invoice, bill, payment, etc.) that
    are out of scope here.
  - **`gate-money-movement`** (PF-09) — cap/deny `create_payment`,
    `create_bill_payment`, `create_transfer`, `create_refund_receipt`.
  - **`guard-vendor-banking`** (PF-10) — deny vendor bank/payment-detail
    mutations (anti-BEC).
  - **`default-deny-unknown-tools`** (PF-28) — for the Intuit connector, whose
    exact tool names are unverified, and for any future upstream tool drift.

  ## Known limitations

  - **No period-state check — this locks the journal-entry *tool*, not a
    *closed period*.** Editing posted transactions inside an accounting-closed
    period cannot be detected from tool arguments: no MCP implementation surveyed
    exposes a period-status field over the wire. This policy approximates
    closed-period protection by confining the highest-risk restatement surface —
    manual journal entries — to the controller role. A controller can still post
    a journal entry into a genuinely closed period, and edits to *other* posted
    transaction types (invoices, bills, payments) are out of scope here. Pair
    with in-QuickBooks period-close/closing-date-password locking for the true
    control, and with PF-12/PF-09 for the other write surfaces.
  - **Group name is a placeholder — replace `controller` with your IdP's group
    name at import time.** It is matched against `input.subject.claims.groups`;
    if your IdP emits roles under a different claim (e.g. `roles`, or a
    namespaced claim like `https://acme.com/roles`), adjust the
    `caller_in_controller_group` rule accordingly. Many IdPs (including Auth0)
    require explicit configuration before group information reaches the token; if
    the claim never arrives, every caller fails closed and is denied.
  - **Intuit connector tool names are unverified.** The Claude connector
    directory does not publish the connector's tool names; this policy assumes
    the Intuit OSS server's `verb_entity` vocabulary (`create_journal_entry` /
    `update_journal_entry`). Capture the live `tools/list` through the gateway
    and confirm before relying on it, and layer `default-deny-unknown-tools`
    (PF-28) to catch names that don't match the `_journal_entry` suffix.
  - **Mega-tool argument path assumption.** For the archived `hvkshetry` server
    the verb lives in an argument. The DTwo gateway surfaces tool arguments under
    `input.payload.args`; the upstream MCP wire shape nests them under
    `params.arguments`. This policy reads `payload.args` (merged with
    `payload.arguments` for portability). If your gateway populates a different
    key, capture it with the dump-input technique and extend the accessor.
  - **Mega-tool name match is broad by design.** `transaction`/`reference` are
    matched by suffix, but the deny fires only when `operation` is create/update
    **and** `entity_type` normalizes to `journalentry`, so a same-named tool on
    an unrelated server without those arguments is not affected.
  - **Mega-tool with no readable `operation` passes through (documented
    residual).** The deny fires only when a write-class `operation` token is
    present *and* the entity normalizes to a journal entry. A `transaction`/
    `reference` call that carries `entity_type: JournalEntry` but no `operation`
    at all cannot be classified as a create/update and is allowed. On the
    hvkshetry server `operation` is a required discriminator, so such a call
    fails at the server rather than posting a ledger write; if a future
    implementation defaults a missing `operation` to a write, tighten this rule.
  - **Ingress write-gate only.** This policy does not restrict *reading* journal
    entries or other ledger data; use egress redaction policies for that.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - quickbooks
industries: []
bundles:
  - sox
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package quickbooks.ingress.protect_closed_periods_journal_entries

# Deny-by-default: direct journal-entry writes are blocked unless the caller is
# explicitly in the controller group. Every non-journal-entry call is allowed by
# the first `allow` rule below.
default allow := false

# IdP group permitted to post/alter manual journal entries. Placeholder —
# remap to the tenant's IdP group name at import time. Compared case-insensitively.
controller_groups := {"controller"}

# Tool name, lowercased and defensively defaulted. The gateway prefixes the
# configured server name, so we match on the _journal_entry entity suffix.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Coerce a value to an object, defaulting to {} when it is not one. Keeps
# object.union below from type-erroring (which would leave `qb_args` undefined
# and silently disable the gate — a fail-open) if a gateway populates an
# argument container with a scalar instead of an object.
as_object(x) := x if is_object(x)

as_object(x) := {} if not is_object(x)

# Argument container: merge the generic gateway key (`args`, which the DTwo
# gateway schema documents and which the mega-tool verb lands in) with the
# `arguments` key some gateways populate, `arguments` winning on conflict. Only
# the mega-tool branch reads arguments; the direct tools key on name alone.
qb_args := object.union(
	as_object(object.get(object.get(input, "payload", {}), "args", {})),
	as_object(object.get(object.get(input, "payload", {}), "arguments", {})),
)

# --- Direct journal-entry write tools (Intuit official / LibreChat) ---
# Match the _journal_entry entity suffix together with the create/update verb,
# so delete_journal_entry (PF-06) and get_/search_ reads are NOT caught.
is_direct_je_write if {
	endswith(tool_name, "create_journal_entry")
}

is_direct_je_write if {
	endswith(tool_name, "update_journal_entry")
}

# --- hvkshetry mega-tools (transaction / reference) ---
# The verb lives in the `operation` argument; the entity in `entity_type`.
is_mega_tool if {
	endswith(tool_name, "transaction")
}

is_mega_tool if {
	endswith(tool_name, "reference")
}

# operation argument: stringified, lowercased, and with every non-alphanumeric
# character stripped. Stripping all punctuation/whitespace (not just spaces) so a
# verb split or decorated with separators — "cre-ate", "cre ate", "create " —
# still exposes the "create"/"update" token to the substring check below and
# cannot slip past the gate. "" when absent.
mega_operation := regex.replace(lower(sprintf("%v", [object.get(qb_args, "operation", "")])), `[^a-z0-9]`, "")

# entity_type argument normalized: stringified, lowercased, and with every
# non-alphanumeric character stripped (not merely spaces/underscores/hyphens) so
# JournalEntry, journal_entry, "journal entry", a punctuated "Journal.Entry", and
# a wrapped ["JournalEntry"] all normalize to a string containing "journalentry".
mega_entity := regex.replace(lower(sprintf("%v", [object.get(qb_args, "entity_type", "")])), `[^a-z0-9]`, "")

# Write-class operation. Substring match (not equality) so an operation smuggled
# as a wrapped/decorated value still trips the gate: an array ["create"] renders
# via sprintf as `["create"]`, an object {"op":"create"} as `{"op": "create"}`,
# and "createdraft" all contain the "create" token. Non-write ops (delete, void,
# deactivate, get, search) contain neither "create" nor "update" and pass through.
mega_op_is_write if contains(mega_operation, "create")

mega_op_is_write if contains(mega_operation, "update")

# Journal-entry entity discriminator, likewise substring not equality so a wrapped
# value — e.g. ["JournalEntry"] which normalizes to `["journalentry"]`, or an
# object carrying the name — still matches. No other QBO entity name contains the
# "journalentry" token, so this does not over-catch.
mega_entity_is_je if contains(mega_entity, "journalentry")

# A mega-tool journal-entry create/update = a direct ledger restatement.
is_mega_je_write if {
	is_mega_tool
	mega_op_is_write
	mega_entity_is_je
}

# Any direct journal-entry restatement, via either server style.
is_journal_entry_write if {
	is_direct_je_write
}

is_journal_entry_write if {
	is_mega_je_write
}

# True only when the caller carries the controller group claim. Reads claims via
# object.get chains so a missing subject/claims/groups fails closed (not-a-controller).
caller_in_controller_group if {
	claims := object.get(object.get(input, "subject", {}), "claims", {})
	some group in object.get(claims, "groups", [])
	is_string(group)
	controller_groups[lower(group)]
}

# Allow anything that isn't a direct journal-entry write.
allow if {
	not is_journal_entry_write
}

# Allow journal-entry writes only for controller callers.
allow if {
	is_journal_entry_write
	caller_in_controller_group
}

# Deny a journal-entry write when the caller is not a controller.
reasons contains "Direct journal-entry writes to the QuickBooks general ledger are restricted to the controller role. A manual journal entry restates the ledger without flowing through a normal transaction workflow, so it is gated for segregation of duties. Ask a controller to post the entry, or request the controller group from your finance systems administrator if you believe this is a false positive." if {
	is_journal_entry_write
	not caller_in_controller_group
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
