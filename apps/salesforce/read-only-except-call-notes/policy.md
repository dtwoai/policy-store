---
name: Salesforce Read-Only Except Call Notes
tags:
  - salesforce
  - access-control
  - governance
  - read-only
  - call-notes
  - ingress
publishedAt: 2026-10-03
description: |
  # salesforce / read-only-except-call-notes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `salesforce.ingress.readonly_except_call_notes`

  ## What it does

  Keeps the Salesforce connection read-only for agents, with one exception:
  the agent can log a call note against a contact. Reps get an assistant that
  can look anything up in the CRM and write up the call afterwards, without
  being able to change opportunities, contacts, accounts, or anything else.

  - **Reads pass.** SOQL queries, SOSL search, schema, related records, recent
    items, and user info are untouched.
  - **Everything else in Salesforce is denied.** Creates, updates, deletes,
    the community raw-code/raw-API tools, and any Salesforce tool the policy
    doesn't recognise as a read (fail closed).
  - **Call notes on contacts are allowed.** A create of a call `Task` (or a
    classic `Note`) attached to a Contact goes through. Editing or deleting an
    existing Task or Note is still blocked.

  This is the Salesforce counterpart of
  [`hubspot/read-only-except-call-notes`](../../hubspot/read-only-except-call-notes/policy.md).

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.3** — logical access restriction and least privilege:
    the agent channel gets read access plus the single write the workflow
    needs (logging a call on a contact).
  - **ISO 27001 A.5.15** — access control: enforces the narrowed write
    decision at a technical control point.

  ## Why ingress

  Writes have permanent side effects on the CRM (flows, triggers, reporting,
  downstream syncs). Whether a call is a permitted call note is fully
  determined by the tool name and its arguments, so denying at ingress
  guarantees no other mutation reaches Salesforce.

  ## How it matches

  **Scope.** A tool is in scope when its (lowercased) name starts with
  `salesforce` — the MCP server name configured on the gateway — or ends with
  a known Salesforce write, delete, or escape-hatch suffix (so community
  servers registered under another name are still covered).

  **Reads.** In-scope tools ending with a recognised read suffix pass:
  hosted `soqlQuery` / `executeQuery` / `querySobjects`, `find` /
  `executeSearch` / `searchSobjects`, `getObjectSchema` / `getSchema`,
  `getUser` / `getUserInfo`, `getRecentItems` / `listRecentSobjectRecords`,
  `getRelatedRecords`; plus the smn2gnt and tsmztech community read tools.

  **The call-note exception.** Allowed on create tools only — hosted
  `createSobjectRecord` / `createRecord` (`sobject-name` + `body`), smn2gnt
  `create_record` (`object_type` + `data`), and tsmztech
  `salesforce_dml_records` with `operation: insert` (`objectName` +
  `records`). Every record in the request must be one of:

  - **A logged call:** object `Task`, with `TaskSubtype` or `Type` equal to
    `Call`, `WhoId` set to a Contact Id (15/18 characters, `003` prefix), and
    no `WhatId` — so the call is attached to the contact and nothing else.
  - **A classic Note:** object `Note` with `ParentId` set to a Contact Id.

  Object and field names are matched case- and whitespace-insensitively. Any
  argument shape the policy doesn't recognise is denied.

  ## Examples

  ### Allowed (call logged on a contact)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-createSobjectRecord", "type": "tool" },
      "payload": {
        "args": {
          "sobject-name": "Task",
          "body": {
            "Subject": "Call with Jane",
            "TaskSubtype": "Call",
            "Status": "Completed",
            "WhoId": "003Ak00000Ab1CdIAJ",
            "Description": "Call recap…"
          }
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (contact edit)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-updateSobjectRecord", "type": "tool" },
      "payload": {
        "args": { "sobject-name": "Contact", "record-id": "003Ak00000Ab1CdIAJ", "body": { "Title": "VP" } }
      }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: Salesforce is read-only through this gateway. The only change allowed is logging a call note on a contact (a Task with type Call, or a Note, attached to a Contact). Ask your admin if you need anything else changed in Salesforce."`.

  ## Composition

  Attach this **instead of** [`salesforce/read-only`](../read-only/policy.md)
  or [`salesforce/role-gate-writes`](../role-gate-writes/policy.md) —
  `read-only` would also block the call note. It already denies the community
  escape hatches and deletes, so
  [`deny-escape-hatches`](../deny-escape-hatches/policy.md) and
  [`freeze-record-deletes`](../freeze-record-deletes/policy.md) are redundant
  alongside it (harmless if attached). Composes cleanly with
  [`salesforce/redact-pii`](../redact-pii/policy.md) (egress) and
  [`salesforce/cap-bulk-export`](../cap-bulk-export/policy.md) (reads).

  ## Known limitations

  - **Server name prefix.** Scope is tools starting with `salesforce` plus
    known write suffixes. If your hosted server is registered under another
    name, change `_in_scope`.
  - **Read allowlist.** A new Salesforce read tool not in `_read_suffixes` is
    denied until added — the safe failure, but it will look like a block.
  - **Enhanced Notes not covered.** Lightning `ContentNote` needs a second
    `ContentDocumentLink` insert to attach it to a contact, which this policy
    can't verify in one call — it is denied. Use a call Task or a classic Note.
  - **WhatId must be empty.** A call Task linked to an Account or
    Opportunity as well as the contact is denied, matching the HubSpot
    policy's contact-only rule. Relax `_is_blank(f, "whatid")` if you want
    calls logged against the account too.
  - **Note content is not inspected.** Pair with an egress or DLP policy if
    what gets written matters.
  - **Argument shapes.** The hosted `sobject-name` / `body` shape is
    verified for `sobject-all`; `sobject-mutations` `createRecord` is assumed
    to match. A different shape fails closed.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - gtm-stack-salesforce
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package salesforce.ingress.readonly_except_call_notes

# Allow by default; within Salesforce, allow only recognised read tools plus
# a create that logs a call note on a contact. Everything else Salesforce is
# denied (fail closed). Non-Salesforce tools are never touched.
default allow := true

_tool := lower(object.get(object.get(input, "resource", {}), "name", ""))

_args := object.get(object.get(input, "payload", {}), "args", {})

# --- Tool vocabularies (suffix-matched; the gateway prefixes the server name) ---

# Read tools across the hosted sobject-* servers and the community servers.
_read_suffixes := [
    # Hosted sobject-all / sobject-reads / sobject-mutations
    "soqlquery",
    "soql_query",
    "executequery",
    "querysobjects",
    "find",
    "executesearch",
    "searchsobjects",
    "getobjectschema",
    "getschema",
    "getuser",
    "getuserinfo",
    "getrecentitems",
    "listrecentsobjectrecords",
    "getrelatedrecords",
    # Community smn2gnt
    "run_sosl_search",
    "get_object_fields",
    "list_sobjects",
    "get_record",
    # Community tsmztech
    "salesforce_search_objects",
    "salesforce_describe_object",
    "salesforce_query_records",
    "salesforce_aggregate_query",
    "salesforce_search_all",
    "salesforce_read_apex",
    "salesforce_read_apex_trigger",
]

# Known write, delete, and escape-hatch tools. Listed so the policy recognises
# them as Salesforce even when the server is registered under another name.
_write_suffixes := [
    "createsobjectrecord",
    "updatesobjectrecord",
    "updatesobjectrecordbyrelationship",
    "createrecord",
    "updaterecord",
    "updaterelatedrecord",
    "deletesobjectrecord",
    "deletesobjectrecordbyrelationship",
    "deletechildrecord",
    "create_record",
    "update_record",
    "delete_record",
    "bulk_create_records",
    "bulk_update_records",
    "bulk_delete_records",
    "salesforce_dml_records",
    "salesforce_manage_object",
    "salesforce_manage_field",
    "execute_anonymous",
    "write_apex",
    "apex_execute",
    "tooling_execute",
    "restful",
    "manage_field_permissions",
]

_is_read_tool if {
    some s in _read_suffixes
    endswith(_tool, s)
}

_is_known_write_tool if {
    some s in _write_suffixes
    endswith(_tool, s)
}

# Scope: the configured `salesforce` server name prefix, or any known write tool.
_in_scope if startswith(_tool, "salesforce")

_in_scope if _is_known_write_tool

# --- The exception: a call note on a contact -------------------------------

# Create tools and the records each one carries, normalised to {obj, fields}.
_is_hosted_create if endswith(_tool, "createsobjectrecord")

_is_hosted_create if endswith(_tool, "-createrecord")

_is_smn2gnt_create if endswith(_tool, "-create_record")

_is_tsmztech_insert if {
    endswith(_tool, "salesforce_dml_records")
    lower(trim_space(object.get(_args, "operation", ""))) == "insert"
}

_create_records := [{"obj": object.get(_args, "sobject-name", ""), "fields": object.get(_args, "body", {})}] if _is_hosted_create

_create_records := [{"obj": object.get(_args, "object_type", ""), "fields": object.get(_args, "data", {})}] if _is_smn2gnt_create

_create_records := [{"obj": object.get(_args, "objectName", ""), "fields": r} |
    some r in object.get(_args, "records", [])
] if _is_tsmztech_insert

# Field names compared case- and whitespace-insensitively.
_fields(r) := {lower(trim_space(k)): v | some k, v in r.fields}

_obj(r) := lower(trim_space(r.obj))

# 15- or 18-character Salesforce Id with the Contact key prefix (003).
_is_contact_id(id) if {
    is_string(id)
    regex.match(`^003[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$`, trim_space(id))
}

_is_blank(f, key) if not f[key]

_is_blank(f, key) if f[key] == null

_is_blank(f, key) if f[key] == ""

_is_call(f) if lower(object.get(f, "tasksubtype", "")) == "call"

_is_call(f) if lower(object.get(f, "type", "")) == "call"

# A logged call: Task of subtype/type Call, attached to a contact and nothing else.
_is_call_note_record(r) if {
    _obj(r) == "task"
    f := _fields(r)
    _is_call(f)
    _is_contact_id(object.get(f, "whoid", ""))
    _is_blank(f, "whatid")
}

# A classic Note whose parent is a contact.
_is_call_note_record(r) if {
    _obj(r) == "note"
    f := _fields(r)
    _is_contact_id(object.get(f, "parentid", ""))
}

_is_call_note if {
    count(_create_records) > 0
    every r in _create_records {
        _is_call_note_record(r)
    }
}

# --- Decision ---------------------------------------------------------------

_blocked if {
    _in_scope
    not _is_read_tool
    not _is_call_note
}

allow := false if _blocked

reason := "Blocked: Salesforce is read-only through this gateway. The only change allowed is logging a call note on a contact (a Task with type Call, or a Note, attached to a Contact). Ask your admin if you need anything else changed in Salesforce." if _blocked
```
