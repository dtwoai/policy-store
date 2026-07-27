---
name: Freeze Salesforce Record Deletes
tags:
  - salesforce
  - freeze-destructive-ops
  - ingress
  - crm
  - soc2
publishedAt: 2026-07-12
description: |
  # salesforce / freeze-record-deletes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny record-delete capability, allow everything else
  **Package:** `salesforce.ingress.freeze_record_deletes`

  ## What it does

  Denies all Salesforce record-deletion capability on the agent channel unless the
  caller's IdP `groups` claim contains the placeholder group `sf-admins`. Salesforce
  deletes are only recycle-bin recoverable for roughly 15 days, and deletes cascade to
  master-detail child records — an injected or erroneous agent delete is effectively
  irreversible. This policy makes a human-approved path (a Salesforce admin) the only
  way records get deleted through MCP.

  Three delete surfaces are covered:

  - **Salesforce Hosted MCP servers** (`sobject-all` / `sobject-deletes`):
    `deleteSobjectRecord`, `deleteSobjectRecordByRelationship`, and `deleteChildRecord`
    — denied by tool-name suffix for callers outside `sf-admins`.
  - **Community smn2gnt/MCP-Salesforce:** `delete_record` and `bulk_delete_records` —
    denied by tool-name suffix for callers outside `sf-admins`.
  - **Community tsmztech/mcp-server-salesforce:** `salesforce_dml_records` fronts every
    DML verb through one tool, so the policy reads `arguments.operation` (via
    `object.get`) and treats the call as safe **only** when the verb is one of the
    verified non-destructive operations (`insert`/`update`/`upsert`), compared
    case- and whitespace-insensitively. Anything else — `delete`, a whitespace-padded
    `delete `, an unrecognized verb, or a missing/empty/non-string value — **fails
    closed and is denied**, since a call whose verb cannot be confirmed non-destructive
    must be assumed delete-capable.

  All other tools — reads, searches, creates, updates, and non-Salesforce tools — pass
  through unchanged.

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519** — anti-destruction/alteration of records: an agent
    cannot delete Opportunity, Order, Contract, or any other record feeding financial
    reporting on the MCP path; **§802 / SEC Rule 2-06** — supports retention and
    legal-hold posture by keeping agent-driven deletion off evidence paths.
  - **SOC 2 PI1.5** — supports integrity of stored records by preventing
    agent-initiated destruction of CRM data.
  - **HIPAA §164.312(c)** — integrity (anti-alteration/destruction) on the agent
    channel for health-cloud orgs whose Contacts and custom objects carry PHI;
    **§164.530(c)** — administrative safeguard limiting who can destroy records
    containing PHI.
  - **GDPR Art. 5(1)(d)** — accuracy (anti-mass-corruption): stops an errant or
    injected agent from bulk-erasing personal-data records (`bulk_delete_records`
    included).

  ## Tool name matching

  Matches case-insensitively on the **suffix** of `input.resource.name`. The DTwo
  gateway prefixes tool names with the configured MCP server name (e.g.
  `salesforce-deleteSobjectRecord` for a server registered as `salesforce`), and that
  prefix is not standardized — suffix matching keeps the policy portable across the
  hosted and community dialects. Suffixes matched:

  - `deletesobjectrecord`, `deletesobjectrecordbyrelationship` (hosted `sobject-all`)
  - `deletesobjectrecord`, `deletechildrecord` (hosted `sobject-deletes`)
  - `delete_record`, `bulk_delete_records` (smn2gnt)
  - `salesforce_dml_records` (tsmztech) — argument-gated, see below

  Verify the exact names your gateway sends with the dump-input debug technique before
  relying on this in production.

  ## Argument shape

  - `salesforce_dml_records` (tsmztech) takes `operation` (enum:
    insert/update/upsert/delete), `objectName`, and `records[]`. The policy reads
    `operation` with `object.get(input.payload.args, "operation", "")`, trims and
    lowercases it, and treats the call as safe **only** when the result is in the
    allowlist `{insert, update, upsert}`. Everything else — `delete`, a
    whitespace-padded `delete `, a case variant, an unrecognized/future verb, or a
    missing, empty, or non-string `operation` — **fails closed** (denied for
    non-admins). One tool fronts all DML verbs, so any verb not confirmed
    non-destructive is assumed destructive. The failure direction is over-block, never
    under-block.
  - The `sf-admins` exemption reads `input.subject.claims.groups` via `object.get`
    chains with an empty-array default, so a missing subject, missing claims, or
    missing `groups` claim deterministically fails closed (deny).
  - The suffix-matched delete tools are denied on name alone; their `sobject-name` /
    `id` / `object_type` arguments are not inspected.

  ## Examples

  ### Allowed — read tool, untouched

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soql_query", "type": "tool" },
      "payload": { "name": "salesforce-soql_query", "args": { "query": "SELECT Id FROM Account" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — hosted delete tool without the sf-admins group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-deleteSobjectRecord", "type": "tool" },
      "subject": { "sub": "auth0|rep@example.com", "claims": { "groups": ["sales"] } },
      "payload": {
        "name": "salesforce-deleteSobjectRecord",
        "args": { "sobject-name": "Contact", "id": "0035g00000XyZzAAA" }
      }
    }
  }
  ```

  `allow = false`, reason names the tool and points to a Salesforce admin.

  ### Denied — DML tool with the operation argument missing (fail closed)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "sf-mcp-salesforce_dml_records", "type": "tool" },
      "payload": {
        "name": "sf-mcp-salesforce_dml_records",
        "args": { "objectName": "Contact", "records": [{ "Id": "0035g00000XyZzAAA" }] }
      }
    }
  }
  ```

  `allow = false` — the verb cannot be confirmed, so the call is treated as a delete.

  ### Allowed — DML insert passes through

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "sf-mcp-salesforce_dml_records", "type": "tool" },
      "payload": {
        "name": "sf-mcp-salesforce_dml_records",
        "args": { "operation": "insert", "objectName": "Task", "records": [{ "Subject": "Call" }] }
      }
    }
  }
  ```

  `allow = true` — an explicit non-delete verb is not gated by this policy.

  ## Composition

  Single-purpose: this policy only freezes record deletion. Companions:

  - [`salesforce/read-only`](../read-only/policy.md) — for orgs that block **all**
    writes on the agent channel; this policy complements it for orgs that do allow
    writes but want deletes human-approved.
  - `salesforce/role-gate-writes` — gates create/update by IdP group and deliberately
    leaves deletes to this policy; attach both for full write governance.
  - An escape-hatch deny policy for `salesforce_execute_anonymous`, `apex_execute`,
    `tooling_execute`, and `restful` — those tools can delete records without ever
    matching a delete tool name (see Known limitations).

  ## Known limitations

  - **Group names are placeholders — replace `sf-admins` with your IdP's group name at
    import time.** The exemption reads `input.subject.claims.groups` (array of
    strings) and fails closed: no IdP, no claim, or a non-array `groups` value means
    nobody is exempt.
  - **Escape hatches are out of scope.** `salesforce_execute_anonymous` (tsmztech),
    `apex_execute`, `tooling_execute`, and `restful` (smn2gnt) can run arbitrary Apex
    or REST calls that delete records without matching any suffix here. Pair this
    policy with an escape-hatch deny — a delete freeze without it is advisory for
    those servers.
  - **SOQL/SOSL cannot delete**, so query tools are intentionally untouched.
  - **Beta-era hosted tool names are not matched.** Late-2025 beta writeups showed
    snake_case hosted names; the GA references use the camelCase names matched here,
    and no beta-era delete tool name was verified. Validate against your deployed
    server's live `tools/list`.
  - **Generic suffix collision.** smn2gnt's `delete_record` / `bulk_delete_records`
    are unprefixed snake_case and may match delete tools of *other* CRM MCP servers on
    the same gateway. The failure mode is over-blocking (those deletes also require
    `sf-admins`), never under-blocking.
  - **The Salesforce DX MCP server (`@salesforce/mcp`) is not covered** — it is
    developer tooling with its own 60+ tool surface; govern it separately.
  - **`operation` values other than plain strings fail closed.** A numeric or object
    `operation` on `salesforce_dml_records` is denied for non-admins by design; if
    your server coerces such values to a verb, confirm its behavior before relaxing
    this.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - soc2
  - crm
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package salesforce.ingress.freeze_record_deletes

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Dedicated record-delete tools, matched by suffix (the gateway prefixes tool
# names with the configured MCP server name, which is not standardized).
# Verified against the Salesforce Hosted MCP GA references (sobject-all,
# sobject-deletes) and the smn2gnt community server's documented tool set.
delete_suffixes := [
    # Hosted sobject-all / sobject-deletes — hard delete by record id
    "deletesobjectrecord",
    # Hosted sobject-all — delete via a relationship path
    "deletesobjectrecordbyrelationship",
    # Hosted sobject-deletes — delete a child record
    "deletechildrecord",
    # Community smn2gnt — single-record delete
    "delete_record",
    # Community smn2gnt — bulk delete by id list
    "bulk_delete_records",
]

# Case-insensitive tool name; missing fields resolve to "" (never matches).
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Tool arguments; {} when payload/args are absent so lookups fail closed.
args := object.get(object.get(input, "payload", {}), "args", {})

is_delete_tool if {
    some suffix in delete_suffixes
    endswith(tool_name, suffix)
}

# tsmztech's salesforce_dml_records fronts insert/update/upsert/delete through
# one tool, so the verb lives in the `operation` argument, not the tool name.
is_dml_tool if {
    endswith(tool_name, "salesforce_dml_records")
}

# The DML call is safe only when `operation` is one of tsmztech's verified
# non-destructive verbs (insert/update/upsert), compared case- and
# whitespace-insensitively. This is an allowlist, not a "not delete" denylist:
# a missing, empty, non-string, whitespace-padded ("delete "), or otherwise
# unrecognized verb (e.g. a future "hardDelete") leaves this undefined, so the
# call fails closed below — an unconfirmed verb is assumed delete-capable.
safe_dml_operations := {"insert", "update", "upsert"}

dml_operation_is_safe if {
    op := object.get(args, "operation", "")
    is_string(op)
    lower(trim_space(op)) in safe_dml_operations
}

# Record-delete capability: a dedicated delete tool, or the multi-verb DML
# tool whose operation is (or must be assumed to be) delete.
is_record_delete if {
    is_delete_tool
}

is_record_delete if {
    is_dml_tool
    not dml_operation_is_safe
}

# Placeholder IdP group — replace `sf-admins` with your IdP's group name at
# import time. Read fail-closed: missing subject/claims/groups → [] → no
# exemption. A non-array `groups` value also fails closed (no iteration).
caller_is_sf_admin if {
    groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])
    some group in groups
    lower(group) == "sf-admins"
}

# Allow any tool without record-delete capability.
allow if {
    not is_record_delete
}

# Allow record deletes only for sf-admins members.
allow if {
    is_record_delete
    caller_is_sf_admin
}

reasons contains msg if {
    is_delete_tool
    not caller_is_sf_admin
    msg := sprintf("The tool '%s' deletes Salesforce records, which is restricted to the sf-admins group on this channel. Salesforce deletes are only recycle-bin recoverable for about 15 days and cascade to master-detail child records. Ask a Salesforce admin to perform or approve the deletion. Contact your InfoSec team if this block is a false positive.", [tool_name])
}

reasons contains msg if {
    is_dml_tool
    not dml_operation_is_safe
    not caller_is_sf_admin
    msg := sprintf("The tool '%s' fronts all Salesforce DML verbs including delete, and this call's 'operation' argument is 'delete', missing, or unreadable, so it fails closed as a delete restricted to the sf-admins group. Retry with an explicit non-delete operation (insert, update, or upsert), or ask a Salesforce admin to perform or approve the deletion. Contact your InfoSec team if this block is a false positive.", [tool_name])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
