---
name: HubSpot Block Deal Closure
tags:
  - hubspot
  - deals
  - access-control
  - governance
  - ingress
publishedAt: 2026-06-16
description: |
  # hubspot / block-deal-closure

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.no_close_deal`

  ## What it does

  Blocks HubSpot CRM-object calls that move a deal into a closed stage
  (`closedwon` or `closedlost`). Both create and update requests are inspected.
  Every other deal change — and every other HubSpot tool — passes through
  unchanged.

  ## Why ingress

  Closing a deal is a write with permanent side effects on the CRM (revenue
  reporting, workflow automation, downstream syncs). The violation is fully
  determined by the request payload, so denying at ingress prevents the stage
  change from ever reaching HubSpot.

  ## How it matches

  Two conditions must both hold for a call to be denied:

  - **Tool match.** The (lowercased) tool name ends with `-manage-crm-objects`
    — the HubSpot MCP tool that creates and updates CRM records. Suffix matching
    keeps the policy portable regardless of the MCP server name the gateway adds
    as a prefix.
  - **Closing a deal.** Within the call's `createRequest.objects` or
    `updateRequest.objects`, an object whose `objectType` is `deals` sets
    `properties.dealstage` to `closedwon` or `closedlost` (case-insensitive).

  ## Tool naming on the gateway

  DTwo prefixes tool names with the MCP server name configured on the gateway, so
  a HubSpot server registered as `hubspot` surfaces `hubspot-manage-crm-objects`
  while one registered as `hubspot-mcp` surfaces `hubspot-mcp-manage-crm-objects`.
  This policy matches on the **suffix** (`-manage-crm-objects`) so it stays
  portable across naming conventions. Confirm the exact tool name with the
  dump-input debug technique before deploying.

  ## Configuring closed stages

  The blocked stages live in `closed_stages` at the top of the Rego
  (`closedwon`, `closedlost`). If your pipeline uses custom closed-stage internal
  names, add them there.

  ## Examples

  ### Allowed (non-closing update)

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
                "properties": { "dealstage": "qualifiedtobuy" } }
            ]
          }
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (closing a deal)

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
                "properties": { "dealstage": "closedwon" } }
            ]
          }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Closing deals is not allowed. Contact your InfoSec team to get access."`.

  ## Known limitations

  - **Suffix tool-name match.** The policy matches any tool ending in
    `-manage-crm-objects`. If a non-HubSpot MCP server happened to expose a tool
    with that same suffix, it would also be inspected — narrow the match if that
    is a concern in your environment.
  - **Custom stage names.** Only `closedwon` / `closedlost` are blocked by
    default; custom closed-stage internal names must be added to `closed_stages`.
  - **No identity-based exemptions.** All callers are treated the same. To allow a
    break-glass role to close deals, add an `allow if` branch gated on
    `input.subject.claims`.
direction: ingress
apps:
  - hubspot
industries: []
bundles:
  - hubspot
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package hubspot.ingress.no_close_deal

default allow := false

closed_stages := {"closedwon", "closedlost"}

allow if {
    not is_closing_deal
}

is_closing_deal if {
    endswith(lower(input.resource.name), "-manage-crm-objects")
    some obj in object.get(object.get(input.payload.args, "updateRequest", {}), "objects", [])
    lower(object.get(obj, "objectType", "")) == "deals"
    stage := lower(object.get(object.get(obj, "properties", {}), "dealstage", ""))
    closed_stages[stage]
}

is_closing_deal if {
    endswith(lower(input.resource.name), "-manage-crm-objects")
    some obj in object.get(object.get(input.payload.args, "createRequest", {}), "objects", [])
    lower(object.get(obj, "objectType", "")) == "deals"
    stage := lower(object.get(object.get(obj, "properties", {}), "dealstage", ""))
    closed_stages[stage]
}

reasons contains "Closing deals is not allowed. Contact your InfoSec team to get access." if {
    is_closing_deal
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
