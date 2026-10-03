---
name: HubSpot Read-Only Except Call Notes
tags:
  - hubspot
  - access-control
  - governance
  - read-only
  - call-notes
  - ingress
publishedAt: 2026-10-03
description: |
  # hubspot / read-only-except-call-notes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.readonly_except_call_notes`

  ## What it does

  Keeps the HubSpot connection read-only for agents, with one exception: the
  agent can log a call note against a contact. Reps get an assistant that can
  look anything up in the CRM and write up the call afterwards, without being
  able to change deals, contacts, campaigns, or anything else.

  - **Reads pass.** Search, get, query, schema discovery, properties, owners,
    and reports are untouched.
  - **Writes are denied.** Any HubSpot tool whose name contains a mutating verb
    (`create`, `update`, `manage`, `delete`, `archive`, `merge`, `submit`,
    `unsubscribe`, …) is blocked.
  - **Call notes on contacts are allowed.** A *create* of a Note or Call
    record whose associations all point at contacts goes through. Editing or
    deleting an existing note is still blocked.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.3** — logical access restriction and least privilege:
    the agent channel gets read access plus the single write the workflow
    needs (logging a call on a contact).
  - **ISO 27001 A.5.15** — access control: enforces the narrowed write
    decision at a technical control point.

  ## Why ingress

  Writes have permanent side effects on the CRM (workflow automation,
  reporting, downstream syncs). Whether a call is a permitted call note is
  fully determined by the tool name and its arguments, so denying at ingress
  guarantees no other mutation reaches HubSpot.

  ## How it matches

  **Write detection.** A tool is in scope when its (lowercased) name starts
  with `hubspot` — the MCP server name configured on the gateway. It is a
  write when any `-` / `_`-separated token in its name is a mutating verb.
  Matching on verb tokens rather than a fixed tool list means new HubSpot
  write tools (the remote server keeps adding `manage-*` tools) are blocked
  without a policy edit.

  **The call-note exception.** "Call note" means either a Note (`notes`,
  `0-46`) or a Call (`calls`, `0-48`) engagement record. It is allowed when:

  - **Remote server (`manage_crm_objects` / `-manage-crm-objects`):** the
    request carries only a `createRequest` (no non-empty `updateRequest` or
    other request block); every object is a note or call; every object has at
    least one association; and every association targets a contact —
    `targetObjectType` of `CONTACT` (the remote server's shape), or, when
    HubSpot v4 association `types` are given, only HubSpot-defined type `202`
    (note→contact) or `194` (call→contact).
  - **`@hubspot/mcp-server` local beta (`-create-engagement`):** `type` is
    `NOTE` or `CALL`, `associations.contactIds` is non-empty, and no company,
    deal, or ticket ids are attached.

  Any argument shape the policy doesn't recognise is denied.

  ## Examples

  ### Allowed (call note on a contact)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-manage-crm-objects", "type": "tool" },
      "payload": {
        "args": {
          "createRequest": {
            "objects": [
              { "objectType": "notes",
                "properties": { "hs_note_body": "Call recap…", "hs_timestamp": "2026-10-03T14:20:00Z" },
                "associations": [ { "targetObjectType": "CONTACT", "targetObjectId": 546680647389 } ] }
            ]
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
      "resource": { "name": "hubspot-manage-crm-objects", "type": "tool" },
      "payload": {
        "args": {
          "updateRequest": {
            "objects": [ { "objectType": "contacts", "objectId": 1, "properties": { "jobtitle": "VP" } } ]
          }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: HubSpot is read-only through this gateway. The only change allowed is adding a call note (a new note or call record) to a contact. Ask your admin if you need anything else changed in HubSpot."`.

  ## Composition

  Attach this **instead of** [`hubspot/read-only`](../read-only/policy.md) or
  [`hubspot/role-gate-writes`](../role-gate-writes/policy.md) — `read-only`
  would also block the call note. It composes cleanly with
  [`hubspot/redact-pii`](../redact-pii/policy.md) (egress) and
  [`hubspot/cap-bulk-export`](../cap-bulk-export/policy.md) (ingress
  transform on reads).

  ## Known limitations

  - **Server name prefix.** Scope is tools whose name starts with `hubspot`.
    If your HubSpot MCP server is registered under a name that doesn't start
    with `hubspot`, change `_is_hubspot`.
  - **Verb-token heuristic.** A future HubSpot tool that mutates data without a
    verb from `_write_verbs` in its name would pass. Add the verb if that
    happens.
  - **Note content is not inspected.** The body of an allowed note is free
    text; pair with an egress or DLP policy if what gets written matters.
  - **Not exactly-once.** Each create is judged on its own; the policy does
    not limit how many notes an agent writes.
  - **Community servers.** shinzo's `notes_create` / `calls_create` are
    denied (they're writes, and not on the exception path).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - hubspot
industries: []
bundles:
  - gtm-stack-hubspot
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package hubspot.ingress.readonly_except_call_notes

# Allow by default; deny HubSpot write tools, except a create that logs a
# call note (a Note or Call record) associated only with contacts.
# Non-HubSpot tools are never touched.
default allow := true

_tool := lower(object.get(input.resource, "name", ""))

_args := object.get(input.payload, "args", {})

# Scope: tools served by an MCP server whose gateway name starts with "hubspot".
_is_hubspot if startswith(_tool, "hubspot")

# A tool is a write if any `-`/`_`-separated token in its name is a mutating verb.
_write_verbs := {
    "create", "update", "manage", "delete", "archive", "upsert", "merge",
    "subscribe", "unsubscribe", "submit", "associate", "void", "purge",
    "set", "add", "remove", "move", "patch", "write", "send", "import",
    "restore", "cancel", "enroll", "unenroll", "publish", "clone",
}

_is_write_tool if {
    _is_hubspot
    some t in regex.split(`[-_]`, _tool)
    _write_verbs[t]
}

# --- The exception: a call note on a contact ---

_note_types := {"notes", "note", "calls", "call", "0-46", "0-48"}

_contact_words := {"contact", "contacts", "0-1"}

# HubSpot-defined association type ids: note -> contact (202), call -> contact (194).
_contact_assoc_type_ids := {202, 194}

_has_types(a) if count(object.get(a, "types", [])) > 0

# When association types are given, every one must be a contact association.
_assoc_targets_contact(a) if {
    _has_types(a)
    every t in object.get(a, "types", []) {
        _contact_assoc_type_ids[to_number(object.get(t, "associationTypeId", -1))]
        upper(object.get(t, "associationCategory", "HUBSPOT_DEFINED")) == "HUBSPOT_DEFINED"
    }
}

# Otherwise fall back to an explicit target object type.
_assoc_targets_contact(a) if {
    not _has_types(a)
    _contact_words[lower(object.get(a, "targetObjectType", ""))]
}

_assoc_targets_contact(a) if {
    not _has_types(a)
    _contact_words[lower(object.get(object.get(a, "to", {}), "objectType", ""))]
}

_assoc_targets_contact(a) if {
    not _has_types(a)
    _contact_words[lower(object.get(a, "toObjectType", ""))]
}

# Remote HubSpot MCP server: manage_crm_objects with createRequest only.
_is_manage_tool if endswith(_tool, "manage_crm_objects")

_is_manage_tool if endswith(_tool, "manage-crm-objects")

_create_objs := object.get(object.get(_args, "createRequest", {}), "objects", [])

_empty_request(v) if v == null

_empty_request(v) if {
    is_object(v)
    count(object.get(v, "objects", [])) == 0
}

# Any non-empty request block other than createRequest (updateRequest, etc.).
_other_requests contains k if {
    some k, v in _args
    k != "createRequest"
    endswith(lower(k), "request")
    not _empty_request(v)
}

_is_remote_call_note if {
    _is_manage_tool
    count(_other_requests) == 0
    count(_create_objs) > 0
    every obj in _create_objs {
        _note_types[lower(object.get(obj, "objectType", ""))]
        count(object.get(obj, "associations", [])) > 0
        every a in object.get(obj, "associations", []) {
            _assoc_targets_contact(a)
        }
    }
}

# @hubspot/mcp-server local beta: create-engagement of type NOTE or CALL,
# associated with contacts only.
_is_local_call_note if {
    endswith(_tool, "create-engagement")
    upper(object.get(_args, "type", "")) in {"NOTE", "CALL"}
    assoc := object.get(_args, "associations", {})
    count(object.get(assoc, "contactIds", [])) > 0
    count(object.get(assoc, "companyIds", [])) == 0
    count(object.get(assoc, "dealIds", [])) == 0
    count(object.get(assoc, "ticketIds", [])) == 0
}

_is_call_note if _is_remote_call_note

_is_call_note if _is_local_call_note

# --- Decision ---

allow := false if {
    _is_write_tool
    not _is_call_note
}

reason := "Blocked: HubSpot is read-only through this gateway. The only change allowed is adding a call note (a new note or call record) to a contact. Ask your admin if you need anything else changed in HubSpot." if {
    _is_write_tool
    not _is_call_note
}
```
