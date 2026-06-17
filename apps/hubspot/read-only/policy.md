---
name: HubSpot Read-Only
tags:
  - hubspot
  - access-control
  - governance
  - read-only
  - ingress
publishedAt: 2026-06-16
description: |
  # hubspot / read-only

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.readonly`

  ## What it does

  Makes the HubSpot connection read-only by blocking the write tool. Any call to
  `hubspot-manage-crm-objects` — the create/update tool exposed by the HubSpot MCP
  server — is denied. Every other HubSpot tool (search, list, read) passes
  through unchanged.

  ## Why ingress

  Writes have permanent side effects on the CRM. The connection's read/write
  posture is fully determined by the tool being called, so denying the write tool
  at ingress guarantees no mutation reaches HubSpot regardless of the payload.

  ## How it matches

  The policy is `default allow := false` and re-allows every tool **except** the
  one whose (lowercased) name ends with `-manage-crm-objects`. Suffix matching
  keeps the policy portable regardless of the MCP server name prefix the gateway
  adds (`hubspot-`, `hubspot-mcp-`, etc.). Confirm the exact tool name with the
  dump-input debug technique before deploying.

  ## Examples

  ### Allowed (read tool)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-list-objects", "type": "tool" },
      "payload": { "name": "hubspot-list-objects", "args": { "objectType": "deals" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (write tool)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-manage-crm-objects", "type": "tool" },
      "payload": {
        "name": "hubspot-manage-crm-objects",
        "args": { "updateRequest": { "objects": [ { "objectType": "deals", "id": "12345" } ] } }
      }
    }
  }
  ```

  `allow = false`, `reason = "HubSpot write operations are disabled on this gateway. This connection is read-only."`.

  ## Known limitations

  - **Single write tool.** This assumes `hubspot-manage-crm-objects` is the only
    write tool exposed by the HubSpot MCP server on the gateway. If your server
    exposes other mutating tools (e.g. dedicated association or engagement
    endpoints), add their suffixes to the deny condition.
  - **Suffix tool-name match.** The policy allows any tool that does *not* end in
    `-manage-crm-objects`. If a non-HubSpot MCP server exposed a tool with that
    same suffix, it would also be blocked — narrow the match if that is a concern.
  - **No identity-based exemptions.** All callers are read-only. To allow a
    break-glass writer, add an `allow if` branch gated on `input.subject.claims`.
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
package hubspot.ingress.readonly

default allow := false

allow if {
    not endswith(lower(input.resource.name), "-manage-crm-objects")
}

reason := "HubSpot write operations are disabled on this gateway. This connection is read-only." if not allow
```
