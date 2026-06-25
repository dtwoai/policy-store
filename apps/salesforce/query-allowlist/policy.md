---
name: Salesforce Query Allowlist
tags:
  - salesforce
  - access-control
  - data-protection
  - governance
  - ingress
publishedAt: 2026-06-16
description: |
  # salesforce / query-allowlist

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `salesforce.ingress.query_allowlist`

  ## What it does

  Restricts Salesforce SOQL queries so only `Account`, `Contact`, and
  `Opportunity` records can be retrieved. It parses the primary object from the
  SOQL `FROM` clause and allows the call only when that object is in the
  allowlist. All other Salesforce tools and all non-Salesforce tools pass through
  untouched.

  ## Why ingress

  A query is a read whose scope is fully determined by the request (the SOQL
  string). Enforcing the allowlist at ingress prevents disallowed objects from
  ever being queried, rather than trying to filter results on the way back.

  ## How it matches

  - **Non-Salesforce tools** pass through (`not startswith("salesforce-")`).
  - **Other Salesforce tools** pass through — only `salesforce-soqlquery` is
    governed.
  - **SOQL queries** are allowed only when the primary `FROM` object (first
    `FROM` match, case-insensitive) is `account`, `contact`, or `opportunity`.

  ## Scope / tool naming

  This policy is scoped by the `salesforce-` server-name prefix and matches the
  query tool as `salesforce-soqlquery`, which assumes the Salesforce MCP server
  is registered on the gateway as `salesforce`. If your gateway registers it
  under a different name, adjust the `startswith`/tool-name checks. Confirm exact
  tool names with the dump-input debug technique before deploying.

  ## Examples

  ### Allowed (allowlisted object)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soqlquery", "type": "tool" },
      "payload": {
        "name": "salesforce-soqlquery",
        "args": { "q": "SELECT Id, Name FROM Account WHERE Industry = 'Tech'" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (non-allowlisted object)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soqlquery", "type": "tool" },
      "payload": {
        "name": "salesforce-soqlquery",
        "args": { "q": "SELECT Id, Username FROM User" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This gateway only permits querying Account, Contact, and Opportunity objects in Salesforce. Your query targets user."`.

  ## Known limitations

  - **SOQL tool only.** Only `salesforce-soqlquery` is governed — other read
    paths (`find`/SOSL, `listrecentsobjectrecords`, `getrelatedrecords`,
    `getobjectschema`) are not restricted. Add companion policies for full read
    coverage.
  - **Fail-safe parsing.** Queries whose primary object can't be parsed, and
    child-relationship subqueries in the SELECT list, are denied.
  - **No identity-based exemptions.** All callers get the same allowlist. Add an
    `input.subject.claims`-gated branch for a break-glass role.
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
package salesforce.ingress.query_allowlist

default allow := false

# Objects permitted to be queried via SOQL.
allowed_objects := {"account", "contact", "opportunity"}

# Pass through any non-Salesforce tool.
allow if {
    not startswith(lower(input.resource.name), "salesforce-")
}

# This policy only governs the SOQL query tool; all other Salesforce tools pass through.
allow if {
    startswith(lower(input.resource.name), "salesforce-")
    lower(input.resource.name) != "salesforce-soqlquery"
}

# Allow a SOQL query only when its primary FROM object is in the allowlist.
allow if {
    lower(input.resource.name) == "salesforce-soqlquery"
    allowed_objects[primary_object]
}

# Primary object = the first object named after a FROM clause (case-insensitive).
primary_object := obj if {
    q := object.get(input.payload.args, "q", "")
    matches := regex.find_all_string_submatch_n(`(?i)\bfrom\s+([a-zA-Z_][a-zA-Z0-9_]*)`, q, -1)
    count(matches) > 0
    obj := lower(matches[0][1])
}

# Human-readable target for the denial message; falls back when the query can't be parsed.
resolved_object := primary_object

resolved_object := "an unrecognized or unparseable object" if not primary_object

reason := sprintf("This gateway only permits querying Account, Contact, and Opportunity objects in Salesforce. Your query targets %s.", [resolved_object]) if {
    lower(input.resource.name) == "salesforce-soqlquery"
    not allow
}
```
