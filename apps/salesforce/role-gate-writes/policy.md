---
name: Salesforce Role-Gated Writes
tags:
  - salesforce
  - role-gate-writes
  - access-control
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
  - crm
publishedAt: 2026-07-12
description: |
  # salesforce / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny unrecognized Salesforce tools; allow reads for everyone; allow create/update writes only for approved groups
  **Package:** `salesforce.ingress.role_gate_writes`

  ## What it does

  The PF-12 least-privilege baseline for Salesforce. Read tools pass for everyone,
  create/update tools pass only when the caller's IdP `groups` claim includes an
  approved placeholder group (`sales` or `support`), and any other tool under the
  Salesforce server prefix fails closed (denied).

  - **Reads** (`soql_query`/`executeQuery`/`querySobjects`, `find`/`executeSearch`/
    `searchSobjects`, `getObjectSchema`/`getSchema`, `getUser`, `getRecentItems`,
    `getRelatedRecords`, and the community read names) are allowed regardless of
    group — this policy does not restrict read access.
  - **Create/update writes** are allowed only for members of the approved groups.
    A non-member's write is denied with an actionable reason; a caller with no
    subject, no claims, or no `groups` claim fails closed (denied).
  - **Deletes** (`deleteSobjectRecord`, `deleteSobjectRecordByRelationship`,
    `deleteChildRecord`, `delete_record`, `bulk_delete_records`) are recognized and
    **passed through unchanged** — they are intentionally left to the stricter
    [`salesforce/freeze-record-deletes`](../freeze-record-deletes/policy.md)
    companion, which gates them by admin group. Attach both for full write
    governance.
  - **Unknown Salesforce tools** — anything under the Salesforce server prefix that
    is not a recognized read, create/update, or delete tool (escape hatches,
    schema/FLS-management tools not listed here, future tools) — fail closed.
  - **Non-Salesforce tools** pass through untouched.

  This differs from [`salesforce/read-only`](../read-only/policy.md), which denies
  **all** writes unconditionally. This policy instead enables gated write access for
  approved teams — pick this one when trusted groups need to create and update
  records over the agent channel, and `read-only` when no one should.

  ## Compliance alignment

  - **SOC 2 CC6.1** — logical access security over Salesforce data on the agent
    channel: only recognized tools reach the org, unknown tools fail closed;
    **CC6.3** — role-based least privilege and separation of duties: create/update
    is confined to the `sales`/`support` groups, not every authenticated agent
    session; **CC6.2** — supports authorization tied to live IdP `groups` claims, so
    de-provisioning at the IdP removes write capability.
  - **HIPAA §164.308(a)(4)** — information access management: write access to
    Contacts and custom objects that may carry PHI is limited to approved groups;
    **§164.312(a)(1)/(a)(2)(i)** — technical access control keyed to the per-call
    identity; **§164.502(b) / §164.514(d)** — supports minimum-necessary by
    narrowing who can mutate records over MCP.
  - **PCI DSS 7.2.1/7.2.2** — least-privilege access model for cardholder-adjacent
    CRM data; **7.2.5** — application/system-account least privilege: write
    capability is gated regardless of the OAuth token's underlying Salesforce
    permissions.
  - **GDPR Art. 25** — data protection by default on the agent channel (unknown
    Salesforce tools fail closed); **Art. 29 / Art. 32(4)** — processing kept within
    the controller's instructions (only approved groups mutate personal-data
    records); **Art. 5(1)(b)** — supports purpose limitation by role.
  - **SOX ITGC (access to programs & data)** — least-privilege access to records
    (Opportunity, Order, Contract) feeding financial reporting; **SoD (COSO P10)** —
    supports separation of initiate-vs-approve by confining write initiation to
    named groups.

  ## Why ingress

  Create and update calls have permanent side effects — a record write can fire
  workflow/Flow automations that email customers or sync to downstream systems.
  Whether a call mutates is fully determined by which tool is invoked, so gating at
  ingress (before the call reaches Salesforce) is the only way to actually prevent
  an unauthorized write.

  ## Tool name matching

  Reads, writes, and deletes are matched case-insensitively on the **suffix** of
  `input.resource.name`. The DTwo gateway prefixes tool names with the configured
  MCP server name (e.g. `salesforce-createSobjectRecord` for a server registered as
  `salesforce`), and that prefix is not standardized — suffix matching keeps the
  policy portable across the hosted and community dialects.

  **Create/update writes** (group-gated):

  - Hosted `sobject-all`: `createSobjectRecord`, `updateSobjectRecord`,
    `updateSobjectRecordByRelationship`
  - Hosted `sobject-mutations`: `createRecord`, `updateRecord`, `updateRelatedRecord`
  - Community smn2gnt: `create_record`, `update_record`, `bulk_create_records`,
    `bulk_update_records`
  - Community tsmztech: `salesforce_dml_records` (fronts all DML verbs),
    `salesforce_manage_object`, `salesforce_manage_field`

  **Reads** (allowed for everyone): `soql_query`, `executeQuery`, `querySobjects`,
  `find`, `executeSearch`, `searchSobjects`, `getObjectSchema`, `getSchema`,
  `getUser`, `getRecentItems`, `getRelatedRecords`, plus community reads
  `run_sosl_search`, `get_object_fields`, `list_sobjects`, `get_record`,
  `salesforce_search_objects`, `salesforce_describe_object`,
  `salesforce_query_records`, `salesforce_aggregate_query`, `salesforce_search_all`,
  `salesforce_read_apex`, `salesforce_read_apex_trigger` (the hosted `soql_query`
  suffix also covers smn2gnt's `run_soql_query`).

  **Deletes** (recognized, passed through to the freeze companion):
  `deleteSobjectRecord`, `deleteSobjectRecordByRelationship`, `deleteChildRecord`,
  `delete_record`, `bulk_delete_records`.

  The Salesforce server scope is any tool whose name starts with `salesforce-` or
  matches one of the recognized read/write/delete suffixes above. Verify the exact
  names your gateway sends with the dump-input debug technique before relying on
  this in production.

  ## Identity / argument shape

  - The write exemption reads `input.subject.claims.groups` via
    `object.get(input, "subject", {})` → `"claims"` → `"groups"` chains defaulting
    to `[]`, so a missing subject, missing claims, or missing `groups` claim
    deterministically fails closed (write denied). Group names are matched
    case-insensitively.
  - Classification is by tool name only — no argument keys are inspected. In
    particular, `salesforce_dml_records` is gated as a write on its **name**; this
    policy does not read its `operation` argument. A group member could therefore
    delete via `salesforce_dml_records` with `operation: "delete"` — the
    `freeze-record-deletes` companion is what inspects `operation` and gates the
    delete verb. Attach it alongside this policy.

  ## Examples

  ### Allowed — read tool, no group needed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-soql_query", "type": "tool" },
      "payload": { "name": "salesforce-soql_query", "args": { "query": "SELECT Id FROM Account" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — create tool for a member of an approved group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-createSobjectRecord", "type": "tool" },
      "subject": { "sub": "auth0|rep@example.com", "claims": { "groups": ["sales"] } },
      "payload": {
        "name": "salesforce-createSobjectRecord",
        "args": { "sobject-name": "Contact", "body": { "LastName": "Doe" } }
      }
    }
  }
  ```

  `allow = true` — the caller is in `sales`.

  ### Denied — create tool for a caller outside the approved groups

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-createSobjectRecord", "type": "tool" },
      "subject": { "sub": "auth0|intern@example.com", "claims": { "groups": ["marketing"] } },
      "payload": {
        "name": "salesforce-createSobjectRecord",
        "args": { "sobject-name": "Opportunity", "body": { "Amount": 50000 } }
      }
    }
  }
  ```

  `allow = false`, reason names the tool and the approved groups.

  ### Denied — unknown Salesforce tool fails closed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-apex_execute", "type": "tool" },
      "payload": { "name": "salesforce-apex_execute", "args": { "code": "delete [SELECT Id FROM Contact];" } }
    }
  }
  ```

  `allow = false` — not a recognized read, write, or delete tool.

  ## Composition

  Single-purpose: this policy gates create/update writes by group and fails closed
  on unknown Salesforce tools. Companions:

  - [`salesforce/freeze-record-deletes`](../freeze-record-deletes/policy.md) —
    **required companion** to govern deletes, which this policy passes through.
  - [`salesforce/deny-escape-hatches`](../deny-escape-hatches/policy.md) —
    portable deny for `apex_execute`, `execute_anonymous`, `tooling_execute`,
    `restful`, and FLS/schema-management tools. This policy already fails those
    closed **when they carry the `salesforce-` prefix**, but the dedicated
    escape-hatch policy matches them by suffix regardless of prefix.
  - [`salesforce/read-only`](../read-only/policy.md) — the mutually-exclusive
    alternative for orgs that block all writes; do not attach both.

  ## Known limitations

  - **Group names are placeholders — replace `sales` / `support` with your IdP's
    group names at import time.** The exemption reads `input.subject.claims.groups`
    (array of strings) and fails closed via an `is_array` guard: no IdP, no claim,
    or any non-array `groups` value — a bare string, `null`, or a JSON object/map
    such as `{"0": "sales"}` — means no one may write. (Without the guard, an
    object-shaped claim would be iterated by value and a value of `"sales"` would
    have granted the write; the guard blocks that.)
  - **`sobject-reads` tool names are unverified.** The hosted `sobject-reads`
    variant's exact tool names were not confirmed against a live `tools/list` in the
    landscape research; the read suffixes here cover the verified `sobject-all` /
    `sobject-mutations` and community names. If your gateway exposes `sobject-reads`
    with different read names, they will fail closed (denied) until added to
    `read_suffixes`. Validate against your deployed server's `tools/list`.
  - **Argument-blind classification.** `salesforce_dml_records` is gated as a write
    by name and its `operation` is not inspected here; a group member can delete
    through it unless `freeze-record-deletes` is also attached. Likewise the
    object being written (`sobject-name`) is not restricted — pair with an
    object-allowlist policy if agents should only touch specific objects.
  - **Scope is prefix + suffix.** A Salesforce server registered under a name that
    does not produce the `salesforce-` prefix, exposing a tool whose name matches
    none of the recognized suffixes, is treated as a non-Salesforce tool and passes
    through. Confirm your server's prefix, or extend the scope, before relying on
    the fail-closed behavior for that server.
  - **Generic suffix collision.** Short community suffixes (`find`, `get_record`,
    `create_record`) are unprefixed and may match tools of other MCP servers on the
    same gateway. The failure mode for reads is over-allow (they are allowed
    anyway); for writes it is over-gating (another server's `create_record` would
    also require `sales`/`support`), never under-gating.
  - **Beta-era hosted names are not matched.** Late-2025 beta writeups showed
    snake_case hosted names (`create_records`, `run_soql_query`); the GA references
    use the camelCase names matched here. Validate against the deployed server.
  - **The Salesforce DX MCP server (`@salesforce/mcp`) is not covered** — it is
    developer tooling with its own 60+ tool surface; govern it separately.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - crm
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package salesforce.ingress.role_gate_writes

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Create/update tools, matched case-insensitively by suffix. The gateway
# prefixes tool names with the configured MCP server name, which is not
# standardized, so suffix matching keeps the policy portable across dialects.
# Verified against the Salesforce Hosted MCP GA references (sobject-all,
# sobject-mutations) and the smn2gnt / tsmztech community servers.
write_suffixes := [
    # Hosted sobject-all
    "createsobjectrecord",
    "updatesobjectrecord",
    "updatesobjectrecordbyrelationship",
    # Hosted sobject-mutations
    "createrecord",
    "updaterecord",
    "updaterelatedrecord",
    # Community smn2gnt
    "create_record",
    "update_record",
    "bulk_create_records",
    "bulk_update_records",
    # Community tsmztech — one tool fronts all DML verbs (operation not inspected
    # here; the freeze-record-deletes companion gates the delete verb)
    "salesforce_dml_records",
    "salesforce_manage_object",
    "salesforce_manage_field",
]

# Read tools, allowed for everyone. `soql_query` also covers smn2gnt's
# `run_soql_query` via the suffix match.
read_suffixes := [
    # Hosted sobject-all / sobject-mutations
    "soql_query",
    "executequery",
    "querysobjects",
    "find",
    "executesearch",
    "searchsobjects",
    "getobjectschema",
    "getschema",
    "getuser",
    "getrecentitems",
    "getrelatedrecords",
    # Community smn2gnt
    "run_sosl_search",
    "get_object_fields",
    "list_sobjects",
    "get_record",
    # Community tsmztech
    "salesforce_search_objects",
    "salesforce_describe_object",
    "salesforce_query_records",
    "salesforce_aggregate_query",
    "salesforce_search_all",
    "salesforce_read_apex",
    "salesforce_read_apex_trigger",
]

# Delete tools. Recognized so they pass through unchanged and are governed by the
# stricter freeze-record-deletes companion, not denied here as unknown.
delete_suffixes := [
    "deletesobjectrecord",
    "deletesobjectrecordbyrelationship",
    "deletechildrecord",
    "delete_record",
    "bulk_delete_records",
]

# Placeholder IdP groups permitted to create/update — replace `sales` / `support`
# with your IdP's group names at import time.
write_groups := {"sales", "support"}

# Case-insensitive tool name; missing fields resolve to "" (never matches).
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

is_read_tool if {
    some suffix in read_suffixes
    endswith(tool_name, suffix)
}

is_write_tool if {
    some suffix in write_suffixes
    endswith(tool_name, suffix)
}

is_delete_tool if {
    some suffix in delete_suffixes
    endswith(tool_name, suffix)
}

# The Salesforce server scope: the configured `salesforce-` prefix, or any
# recognized read/write/delete suffix (portable across community prefixes).
is_salesforce_tool if startswith(tool_name, "salesforce-")

is_salesforce_tool if is_read_tool

is_salesforce_tool if is_write_tool

is_salesforce_tool if is_delete_tool

# Approved-group membership. Read fail-closed: missing subject/claims/groups → []
# → no membership. The `is_array` guard makes every non-array `groups` value fail
# closed — including a JSON object/map (e.g. `{"0": "sales"}`), which `some ... in`
# would otherwise iterate by value and treat "sales" as a match. Only a genuine
# JSON array of group-name strings can grant the write.
caller_in_write_group if {
    groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])
    is_array(groups)
    some group in groups
    write_groups[lower(group)]
}

# Pass through anything that isn't a Salesforce tool.
allow if {
    not is_salesforce_tool
}

# Reads are allowed for everyone.
allow if {
    is_read_tool
}

# Deletes pass through — governed by the freeze-record-deletes companion.
allow if {
    is_delete_tool
}

# Create/update writes are allowed only for approved-group members.
allow if {
    is_write_tool
    caller_in_write_group
}

# Deny a create/update write from a caller outside the approved groups.
reasons contains msg if {
    is_write_tool
    not caller_in_write_group
    msg := sprintf("The tool '%s' creates or updates Salesforce records, which is limited to members of the sales or support groups on this channel. Ask an approved team member to make the change, or request membership in the appropriate group. Contact your InfoSec team if this block is a false positive.", [tool_name])
}

# Deny an unrecognized Salesforce tool (fail closed).
reasons contains msg if {
    is_salesforce_tool
    not is_read_tool
    not is_write_tool
    not is_delete_tool
    msg := sprintf("The Salesforce tool '%s' is not on this gateway's recognized read, create/update, or delete list, so it is denied by default (fail closed). If this is a legitimate Salesforce tool, add its name suffix to the policy's read or write list. Contact your InfoSec team to review.", [tool_name])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
