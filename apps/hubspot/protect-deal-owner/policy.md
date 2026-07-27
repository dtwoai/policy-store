---
name: HubSpot Protect Deal Owner
tags:
  - hubspot
  - deals
  - access-control
  - governance
  - ingress
publishedAt: 2026-06-16
description: |
  # hubspot / protect-deal-owner

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.protect_deal_owner`

  ## What it does

  Blocks HubSpot CRM-object update calls that set or change a deal's owner. Any
  `hubspot-manage-crm-objects` update whose deal `properties` include the
  `hubspot_owner_id` key is denied — this covers both initial owner assignment
  and reassignment. Deal creates, other update fields, and all other tools pass
  through unchanged.

  ## Compliance alignment

  - **SOC 2 CC6.3** — role-based access and least privilege: reassigning deal
    ownership (quota attribution, territory routing) is reserved for humans with
    CRM admin rights; the agent channel cannot do it.

  ## Why ingress

  Deal ownership drives quota attribution, territory routing, and reporting. The
  violation is fully determined by the request payload, so denying at ingress
  prevents the ownership change from ever reaching HubSpot.

  ## How it matches

  All of the following must hold for a call to be denied:

  - **Tool match.** The (lowercased) tool name ends with `-manage-crm-objects`
    (suffix matching keeps the policy portable regardless of the MCP server name
    prefix the gateway adds).
  - **Deal update.** An object in `updateRequest.objects` has `objectType` `deals`
    (case-insensitive).
  - **Owner field present.** That object's `properties` include the
    `hubspot_owner_id` key (presence alone triggers the deny — the value is not
    inspected).

  Only `updateRequest` is inspected; deal creates are intentionally not blocked.

  ## Tool naming on the gateway

  DTwo prefixes tool names with the MCP server name configured on the gateway, so
  a HubSpot server registered as `hubspot` surfaces `hubspot-manage-crm-objects`
  while one registered as `hubspot-mcp` surfaces `hubspot-mcp-manage-crm-objects`.
  This policy matches on the **suffix** (`-manage-crm-objects`) so it stays
  portable across naming conventions. Confirm the exact tool name with the
  dump-input debug technique before deploying.

  ## Examples

  ### Allowed (deal update with no owner change)

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

  ### Denied (owner reassignment)

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
                "properties": { "hubspot_owner_id": "99887766" } }
            ]
          }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Changing the owner of a deal is not permitted through this gateway. Contact your admin to reassign deals."`.

  ## Known limitations

  - **Suffix tool-name match.** The policy matches any tool ending in
    `-manage-crm-objects`. If a non-HubSpot MCP server happened to expose a tool
    with that same suffix, it would also be inspected — narrow the match if that
    is a concern in your environment.
  - **Updates only.** Deal creates that set `hubspot_owner_id` are not blocked by
    design. Add a `createRequest` branch if you also want to fix owner at creation.
  - **No identity-based exemptions.** All callers are treated the same. To allow a
    break-glass role to reassign deals, add an `allow if` branch gated on
    `input.subject.claims`.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
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
package hubspot.ingress.protect_deal_owner

default allow := false

allow if {
    not is_owner_update
}

is_owner_update if {
    endswith(lower(input.resource.name), "-manage-crm-objects")
    some obj in object.get(object.get(input.payload.args, "updateRequest", {}), "objects", [])
    lower(object.get(obj, "objectType", "")) == "deals"
    "hubspot_owner_id" in object.keys(object.get(obj, "properties", {}))
}

reasons contains "Changing the owner of a deal is not permitted through this gateway. Contact your admin to reassign deals." if {
    is_owner_update
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
