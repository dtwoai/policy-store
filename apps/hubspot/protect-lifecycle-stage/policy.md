---
name: HubSpot Protect Lifecycle Stage
tags:
  - hubspot
  - contacts
  - lifecycle
  - access-control
  - governance
  - ingress
publishedAt: 2026-06-16
description: |
  # hubspot / protect-lifecycle-stage

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.protect_lifecycle_stage`

  ## What it does

  Blocks HubSpot CRM-object calls that set or change a contact's lifecycle stage.
  Any `hubspot-manage-crm-objects` call where a `contacts` object's `properties`
  include the `lifecyclestage` key — in either `createRequest` or `updateRequest`
  — is denied. Non-contact objects, contact edits that don't touch
  `lifecyclestage`, and all other tools pass through unchanged.

  ## Compliance alignment

  - **SOC 2 PI1.2** — inputs complete, accurate, and authorized: lifecycle stage
    is a processing-integrity-critical input to lead routing and funnel
    reporting; agent writes to it are unauthorized by default.
  - **GDPR Art. 5(1)(b)** — purpose limitation: lifecycle stage enrolls contacts
    in marketing automation, so an agent-set stage can repurpose personal data
    into new automated communications; blocking it keeps that a human decision.
  - **GDPR Art. 5(1)(d)** — accuracy: prevents agent mass-corruption of a field
    that drives automated outreach to data subjects.

  ## Why ingress

  Lifecycle stage drives marketing automation, lead routing, and funnel
  reporting. The violation is fully determined by the request payload, so denying
  at ingress prevents the stage change from ever reaching HubSpot.

  ## How it matches

  All of the following must hold for a call to be denied:

  - **Tool match.** The (lowercased) tool name ends with `-manage-crm-objects`
    (suffix matching keeps the policy portable regardless of the MCP server name
    prefix the gateway adds).
  - **Contact object.** An object in `createRequest.objects` or
    `updateRequest.objects` has `objectType` `contacts` (case-insensitive).
  - **Lifecycle field present.** That object's `properties` include the
    `lifecyclestage` key (presence alone triggers the deny — the value is not
    inspected).

  ## Tool naming on the gateway

  DTwo prefixes tool names with the MCP server name configured on the gateway, so
  a HubSpot server registered as `hubspot` surfaces `hubspot-manage-crm-objects`
  while one registered as `hubspot-mcp` surfaces `hubspot-mcp-manage-crm-objects`.
  This policy matches on the **suffix** (`-manage-crm-objects`) so it stays
  portable across naming conventions. Confirm the exact tool name with the
  dump-input debug technique before deploying.

  ## Examples

  ### Allowed (contact update with no lifecycle change)

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
              { "objectType": "contacts", "id": "12345",
                "properties": { "email": "lead@example.com" } }
            ]
          }
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (lifecycle stage change)

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
              { "objectType": "contacts", "id": "12345",
                "properties": { "lifecyclestage": "customer" } }
            ]
          }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Changing the lifecycle stage of a contact is not permitted through this gateway. Contact your admin to update lifecycle stages."`.

  ## Known limitations

  - **Suffix tool-name match.** The policy matches any tool ending in
    `-manage-crm-objects`. If a non-HubSpot MCP server happened to expose a tool
    with that same suffix, it would also be inspected — narrow the match if that
    is a concern in your environment.
  - **Contacts only.** Only `contacts` objects are inspected; `lifecyclestage` on
    other object types is not blocked. Extend `is_lifecycle_change` if your
    environment uses lifecycle stage on companies or custom objects.
  - **No identity-based exemptions.** All callers are treated the same. To allow a
    break-glass role to change lifecycle stages, add an `allow if` branch gated on
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
package hubspot.ingress.protect_lifecycle_stage

default allow := false

allow if {
    not is_lifecycle_change
}

is_lifecycle_change if {
    endswith(lower(input.resource.name), "-manage-crm-objects")
    some obj in object.get(object.get(input.payload.args, "updateRequest", {}), "objects", [])
    lower(object.get(obj, "objectType", "")) == "contacts"
    "lifecyclestage" in object.keys(object.get(obj, "properties", {}))
}

is_lifecycle_change if {
    endswith(lower(input.resource.name), "-manage-crm-objects")
    some obj in object.get(object.get(input.payload.args, "createRequest", {}), "objects", [])
    lower(object.get(obj, "objectType", "")) == "contacts"
    "lifecyclestage" in object.keys(object.get(obj, "properties", {}))
}

reason := "Changing the lifecycle stage of a contact is not permitted through this gateway. Contact your admin to update lifecycle stages." if not allow
```
