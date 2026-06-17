---
name: Salesforce Protect Contact Fields
tags:
  - salesforce
  - contacts
  - pii
  - access-control
  - governance
  - ingress
publishedAt: 2026-06-16
description: |
  # salesforce / protect-contact-fields

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `salesforce.ingress.protect_contact_fields`

  ## What it does

  Blocks Salesforce Contact updates that modify protected fields — ownership,
  account linkage, contact PII, name, and consent flags. Any
  `*-updatesobjectrecord` call targeting the `Contact` sobject whose request body
  includes one of the protected fields is denied, with a reason naming the
  offending fields. Updates to other Contact fields, updates to other sobjects,
  and all other tools pass through unchanged.

  ## Why ingress

  Field updates are writes with permanent side effects (ownership reassignment,
  consent/opt-out changes, PII edits). The violation is fully determined by the
  request body, so denying at ingress prevents the change from ever reaching
  Salesforce.

  ## How it matches

  All of the following must hold for a call to be denied:

  - **Tool match.** The (lowercased) tool name ends with `-updatesobjectrecord`
    (suffix matching keeps the policy portable regardless of the MCP server name
    prefix the gateway adds).
  - **Contact sobject.** The `sobject-name` argument is `contact`
    (case-insensitive).
  - **Protected field present.** The `body` argument contains at least one
    protected field (case-insensitive): `OwnerId`, `AccountId`, `Email`, `Phone`,
    `MobilePhone`, `HomePhone`, `OtherPhone`, `Fax`, `FirstName`, `LastName`,
    `DoNotCall`, `HasOptedOutOfEmail`, `HasOptedOutOfFax`.

  ## Tool naming on the gateway

  DTwo prefixes tool names with the MCP server name configured on the gateway, so
  a Salesforce server registered as `salesforce` surfaces
  `salesforce-updatesobjectrecord`. This policy matches on the **suffix**
  (`-updatesobjectrecord`) so it stays portable across naming conventions.
  Confirm the exact tool name with the dump-input debug technique before
  deploying.

  ## Examples

  ### Allowed (non-protected field)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-updatesobjectrecord", "type": "tool" },
      "payload": {
        "name": "salesforce-updatesobjectrecord",
        "args": {
          "sobject-name": "Contact",
          "record-id": "003xx",
          "body": { "Description": "Met at conference" }
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (protected field)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-updatesobjectrecord", "type": "tool" },
      "payload": {
        "name": "salesforce-updatesobjectrecord",
        "args": {
          "sobject-name": "Contact",
          "record-id": "003xx",
          "body": { "Email": "new@example.com", "Description": "..." }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Updating these protected fields on a Contact is not permitted through this gateway: email."`.

  ## Known limitations

  - **`updatesobjectrecord` only.** The `updaterelatedrecord` tool (which updates
    a child record reached via a parent + relationship path) is not covered,
    because the target object isn't directly identifiable from its arguments. Add
    a companion policy if that path must also be restricted.
  - **Suffix tool-name match.** The policy matches any tool ending in
    `-updatesobjectrecord`. If a non-Salesforce MCP server exposed a tool with
    that same suffix, it would also be inspected — narrow the match if that is a
    concern in your environment.
  - **No identity-based exemptions.** All callers are treated the same. To allow a
    break-glass role to edit protected fields, add an `allow if` branch gated on
    `input.subject.claims`.
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
package salesforce.ingress.protect_contact_fields

default allow := false

# Contact fields that may not be modified through this gateway (compared case-insensitively).
protected_fields := {
    "ownerid", "accountid", "email", "phone", "mobilephone",
    "homephone", "otherphone", "fax", "firstname", "lastname",
    "donotcall", "hasoptedoutofemail", "hasoptedoutoffax",
}

# True when this call is a Contact update via updatesobjectrecord.
is_contact_update if {
    endswith(lower(input.resource.name), "-updatesobjectrecord")
    lower(object.get(input.payload.args, "sobject-name", "")) == "contact"
}

# Pass through anything that is not a Contact update.
allow if {
    not is_contact_update
}

# Allow a Contact update only when it touches none of the protected fields.
allow if {
    is_contact_update
    count(offending_fields) == 0
}

# The protected fields present in the update body.
offending_fields := {lower(k) |
    some k in object.keys(object.get(input.payload.args, "body", {}))
    protected_fields[lower(k)]
}

reason := sprintf("Updating these protected fields on a Contact is not permitted through this gateway: %s.", [concat(", ", sort([f | some f in offending_fields]))]) if {
    is_contact_update
    count(offending_fields) > 0
}
```
