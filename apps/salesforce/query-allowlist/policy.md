---
name: Salesforce Query Allowlist
tags:
  - salesforce
  - access-control
  - data-protection
  - governance
  - ingress
  - soc2
  - pci-dss
  - gdpr-ccpa
  - iso27001-nist
publishedAt: 2026-07-12
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

  ## Compliance alignment

  - **SOC 2 C1.1 / P4.1** — supports protection of confidential information and limits personal-information use to identified purposes by scoping agent queries to three business objects.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary access: agents cannot query objects (e.g. `Case`, `User`, health-cloud or custom objects) outside the approved set.
  - **HIPAA §164.308(a)(4)** — supports information access management by defining which record classes the agent channel may read at all.
  - **PCI DSS 7.2.6** — restricts programmatic query access to stored data: SOQL against objects that may hold account data is denied unless the object is explicitly allowlisted.
  - **GDPR Art. 5(1)(b)** — supports purpose limitation: the queryable surface matches the CRM purpose the agent was granted, not the whole org.
  - **CCPA/CPRA §1798.121** — supports limiting access to sensitive personal information held in non-allowlisted objects.
  - **ISO 27001 A.8.3** — information access restriction on the SOQL read path.

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

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - crm
  - soc2
  - pci-dss
  - gdpr-ccpa
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
