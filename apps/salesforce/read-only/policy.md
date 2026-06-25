---
name: Salesforce Read-Only Access
tags:
  - salesforce
  - access-control
  - governance
  - read-only
  - ingress
publishedAt: 2026-06-16
description: |
  # salesforce / read-only

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `salesforce.ingress.readonly`

  ## What it does

  Restricts the Salesforce MCP server to read-only access. Non-Salesforce tools
  pass through untouched; among Salesforce tools, only the known read tools
  (`soqlquery`, `find`, `getobjectschema`, `getrelatedrecords`, `getuserinfo`,
  `listrecentsobjectrecords`) are allowed. Any other `salesforce-*` tool —
  including current and future write tools like `createsobjectrecord`,
  `updatesobjectrecord`, `updaterelatedrecord` — is denied.

  ## Why an allowlist (fail-closed)

  This is an allowlist, not a blocklist: writes are denied by default and only
  named read tools are permitted. New write tools added to the MCP server in the
  future therefore fail closed (denied) rather than slipping through until
  someone remembers to blocklist them.

  ## Why ingress

  Writes have permanent side effects. The read/write nature of a call is fully
  determined by which tool is invoked, so denying non-read tools at ingress
  guarantees no mutation reaches Salesforce.

  ## How it matches

  - **Non-Salesforce tools** pass through (`not startswith("salesforce-")`).
  - **Salesforce read tools** in the allowlist are permitted.
  - **Everything else** under the `salesforce-` prefix is denied.

  ## Scope / tool naming

  This policy is scoped by the `salesforce-` server-name prefix and lists tools
  by their full `salesforce-*` names, which assumes the Salesforce MCP server is
  registered on the gateway as `salesforce`. If your gateway registers it under a
  different name, adjust the prefix and the allowlist entries. Confirm exact tool
  names with the dump-input debug technique before deploying.

  ## Examples

  ### Allowed (read tool)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soqlquery", "type": "tool" },
      "payload": { "name": "salesforce-soqlquery", "args": { "q": "SELECT Id FROM Account" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (write tool)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-createsobjectrecord", "type": "tool" },
      "payload": { "name": "salesforce-createsobjectrecord", "args": { "sobject-name": "Account", "body": { "Name": "Acme" } } }
    }
  }
  ```

  `allow = false`, `reason = "Salesforce write operations (create/modify) are blocked on this gateway. Only read-only Salesforce tools are permitted."`.

  ## Known limitations

  - **Allowlist maintenance.** New *read* tools must be added to
    `salesforce_read_tools` or they will be denied. This is the intended
    trade-off for fail-closed behavior on writes.
  - **Prefix-scoped.** Scoping is `startswith("salesforce-")` with full tool
    names. A server registered under a different prefix won't be governed until
    the checks are adjusted.
  - **No identity-based exemptions.** All callers are read-only. To allow a
    break-glass writer, add an `allow if` branch gated on `input.subject.claims`.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - crm
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package salesforce.ingress.readonly

default allow := false

# Salesforce read-only tools that are permitted
salesforce_read_tools := {
    "salesforce-soqlquery",
    "salesforce-find",
    "salesforce-getobjectschema",
    "salesforce-getrelatedrecords",
    "salesforce-getuserinfo",
    "salesforce-listrecentsobjectrecords",
}

# This policy only governs the Salesforce MCP server.
# Any non-Salesforce tool passes through untouched.
allow if {
    not startswith(lower(input.resource.name), "salesforce-")
}

# Allow only the known Salesforce read-only tools.
allow if {
    salesforce_read_tools[lower(input.resource.name)]
}

reason := "Salesforce write operations (create/modify) are blocked on this gateway. Only read-only Salesforce tools are permitted." if not allow
```
