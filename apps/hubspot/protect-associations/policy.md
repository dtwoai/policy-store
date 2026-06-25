---
name: HubSpot Protect Associations
tags:
  - hubspot
  - associations
  - access-control
  - governance
  - ingress
publishedAt: 2026-06-16
description: |
  # hubspot / protect-associations

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.protect_associations`

  ## What it does

  Blocks HubSpot CRM-object calls that create or change associations between
  objects (deal↔company, contact↔company, etc.). Any `hubspot-manage-crm-objects`
  call carrying a non-empty `associations` array on one or more objects — in
  either `createRequest` or `updateRequest` — is denied. Every other call,
  including object create/update with no association payload, passes through
  unchanged.

  ## Why ingress

  Associations are structural CRM relationships with downstream effects
  (reporting rollups, workflow enrollment, record visibility). The violation is
  fully determined by the request payload, so denying at ingress prevents the
  association change from ever reaching HubSpot.

  ## How it matches

  Two conditions must both hold for a call to be denied:

  - **Tool match.** The (lowercased) tool name ends with `-manage-crm-objects`
    — the HubSpot MCP tool that creates and updates CRM records. Suffix matching
    keeps the policy portable regardless of the MCP server name the gateway adds
    as a prefix.
  - **Association payload present.** Within the call's `createRequest.objects` or
    `updateRequest.objects`, at least one object has a non-empty `associations`
    array (`count(...) > 0`).

  ## Tool naming on the gateway

  DTwo prefixes tool names with the MCP server name configured on the gateway, so
  a HubSpot server registered as `hubspot` surfaces `hubspot-manage-crm-objects`
  while one registered as `hubspot-mcp` surfaces `hubspot-mcp-manage-crm-objects`.
  This policy matches on the **suffix** (`-manage-crm-objects`) so it stays
  portable across naming conventions. Confirm the exact tool name with the
  dump-input debug technique before deploying.

  ## Examples

  ### Allowed (object update with no associations)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-manage-crm-objects", "type": "tool" },
      "payload": {
        "name": "hubspot-manage-crm-objects",
        "args": {
          "updateRequest": {
            "objects": [
              { "objectType": "deals", "id": "12345",
                "properties": { "amount": "500" } }
            ]
          }
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (association change)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-manage-crm-objects", "type": "tool" },
      "payload": {
        "name": "hubspot-manage-crm-objects",
        "args": {
          "updateRequest": {
            "objects": [
              { "objectType": "deals", "id": "12345",
                "associations": [
                  { "to": { "id": "67890" },
                    "types": [ { "associationCategory": "HUBSPOT_DEFINED",
                                 "associationTypeId": 5 } ] }
                ] }
            ]
          }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Modifying associations is not permitted through this gateway. Contact your admin to manage object associations."`.

  ## Known limitations

  - **Suffix tool-name match.** The policy matches any tool ending in
    `-manage-crm-objects`. If a non-HubSpot MCP server happened to expose a tool
    with that same suffix, it would also be inspected — narrow the match if that
    is a concern in your environment.
  - **Presence-based, not value-aware.** The policy denies whenever a non-empty
    `associations` array is present; it does not distinguish which objects are
    being linked. Narrow the rule if you need to allow specific association types.
  - **No identity-based exemptions.** All callers are treated the same. To allow a
    break-glass role to manage associations, add an `allow if` branch gated on
    `input.subject.claims`.
direction: ingress
apps:
  - hubspot
industries: []
bundles:
  - crm
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package hubspot.ingress.protect_associations

default allow := false

allow if {
    not is_association_change
}

is_association_change if {
    endswith(lower(input.resource.name), "-manage-crm-objects")
    some obj in object.get(object.get(input.payload.args, "updateRequest", {}), "objects", [])
    count(object.get(obj, "associations", [])) > 0
}

is_association_change if {
    endswith(lower(input.resource.name), "-manage-crm-objects")
    some obj in object.get(object.get(input.payload.args, "createRequest", {}), "objects", [])
    count(object.get(obj, "associations", [])) > 0
}

reason := "Modifying associations is not permitted through this gateway. Contact your admin to manage object associations." if not allow
```
