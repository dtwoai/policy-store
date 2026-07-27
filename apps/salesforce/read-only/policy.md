---
name: Salesforce Read-Only Access
tags:
  - salesforce
  - access-control
  - governance
  - read-only
  - ingress
  - soc2
  - gdpr-ccpa
  - iso27001-nist
publishedAt: 2026-07-12
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

  ## Compliance alignment

  - **SOC 2 CC6.1** — enforces logical access security over Salesforce data on the agent channel: only named read tools reach the org.
  - **SOC 2 CC6.3** — least privilege for the agent identity: write capability is removed regardless of the OAuth token's underlying Salesforce permissions.
  - **HIPAA §164.308(a)(4) / §164.312(a)(1)** — supports information access management and technical access control by narrowing what an authenticated agent session can do to read-only.
  - **PCI DSS 7.2.1/7.2.2, 7.2.5** — supports a least-privilege access model, including for the application/system account the MCP server runs as.
  - **GDPR Art. 25 / Art. 29** — data protection by default on the agent channel (unknown tools fail closed) and processing kept within the controller's instructions (no mutations).
  - **SOX ITGC (access to programs & data); §802 / 18 U.S.C. §1519** — supports safeguarding of financial records (Opportunity, Order, Contract) by denying create/update/delete tools, including future ones, on this path.
  - **ISO 27001 A.5.15 / NIST 800-53 AC-3** — access-control enforcement at the gateway policy enforcement point.

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

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - crm
  - soc2
  - gdpr-ccpa
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
