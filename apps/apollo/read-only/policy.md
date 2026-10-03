---
name: Apollo Read-Only
tags:
  - apollo
  - access-control
  - governance
  - read-only
  - outreach
  - ingress
publishedAt: 2026-10-03
description: |
  # apollo / read-only

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `apollo.ingress.readonly`

  ## What it does

  Makes the Apollo connection read-only for agents. The agent can search
  people and companies, enrich them, look up contacts, sequences, lists,
  tasks and analytics — but it can't change anything in Apollo or send
  anything from it.

  - **Reads pass.** Search, match/enrich, index, show, and report tools are
    untouched.
  - **Writes are denied.** Any Apollo tool whose name contains a mutating
    verb is blocked: creating or updating contacts, accounts, deals, lists,
    tasks, labels and custom objects; adding or removing contacts from
    sequences; sending emails; importing or connecting data sources; and
    buying sending domains or mailboxes.

  The outreach tools are the main reason this exists. A sequence enrollment
  or a one-off email reaches a real person outside the company and can't be
  taken back.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.3** — logical access restriction and least privilege:
    the agent channel gets read access to prospecting data and nothing more.
  - **GDPR Art. 25** — data protection by default: no agent-initiated
    outreach to, or edits of, personal data through the gateway.
  - **ISO 27001 A.5.15** — access control: enforces the read-only decision
    at a technical control point.

  ## Why ingress

  Every Apollo write has a side effect outside the gateway's reach once it
  runs — a record changes, a sequence step fires, an email goes out. Whether
  a call is a write is fully determined by the tool name, so denying at
  ingress guarantees none of them reaches Apollo.

  ## How it matches

  A tool is in scope when its (lowercased) name starts with `apollo` — the
  MCP server name configured on the gateway. It is a write when any `-` /
  `_`-separated token in its name is one of: `create`, `update`, `upsert`,
  `add`, `remove`, `stop`, `delete`, `archive`, `merge`, `send`, `complete`,
  `skip`, `import`, `connect`, `purchase`, `manage`, `assign`, `enroll`,
  `approve`, `mark`.

  Matching on verb tokens rather than a fixed tool list means new Apollo
  write tools are blocked without a policy edit. Apollo's hosted server
  (`https://mcp.apollo.io/mcp`) follows its REST API naming, e.g.
  `apollo_contacts_create` and `apollo_emailer_campaigns_add_contact_ids`,
  which a server registered as `apollo` surfaces as
  `apollo-apollo_contacts_create`. Confirm the exact names your gateway sends
  with the dump-input debug technique before deploying.

  ## Examples

  ### Allowed (people search)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "apollo-apollo_mixed_people_api_search", "type": "tool" },
      "payload": { "args": { "person_titles": ["VP Sales"], "per_page": 25 } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (add contacts to a sequence)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "apollo-apollo_emailer_campaigns_add_contact_ids", "type": "tool" },
      "payload": { "args": { "id": "seq_123", "contact_ids": ["c_1", "c_2"] } }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: Apollo is read-only through this gateway. You can search and enrich, but creating or changing records, adding people to sequences, and sending emails have to be done in Apollo by a person."`.

  ## Composition

  Pairs with the CRM write posture in the same bundle: the agent finds and
  scores prospects in Apollo, checks the CRM, and hands the list to a rep,
  who decides who gets contacted.

  ## Known limitations

  - **Enrichment is allowed.** Apollo bills people/company match and enrich
    calls against your credits and can return work emails and phone numbers.
    They don't change Apollo records, so this policy lets them through. Cap
    volume and mask contact details with separate policies.
  - **Name-based detection.** A write tool whose name carries none of the
    verbs above would pass. Check the tool list on your gateway and add a
    verb if Apollo introduces one.
  - **Prefix scope.** Only tools whose name starts with `apollo` are in
    scope. If your gateway registers the server under another name, change
    the prefix.
  - **No identity-based exemptions.** All callers are read-only. To let a
    specific group write, add an exception gated on `input.subject.claims`.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - apollo
industries: []
bundles:
  - gtm-stack-hubspot
  - gtm-stack-salesforce
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package apollo.ingress.readonly

import future.keywords.if
import future.keywords.in

# Allow broadly; deny only Apollo write tools.
default allow := true

_tool := lower(input.resource.name)

_write_verbs := {
    "create", "update", "upsert", "add", "remove", "stop", "delete",
    "archive", "merge", "send", "complete", "skip", "import", "connect",
    "purchase", "manage", "assign", "enroll", "approve", "mark",
}

_is_apollo_tool if startswith(_tool, "apollo")

_is_write_tool if {
    _is_apollo_tool
    some token in regex.split(`[-_]`, _tool)
    token in _write_verbs
}

allow := false if _is_write_tool

reason := "Blocked: Apollo is read-only through this gateway. You can search and enrich, but creating or changing records, adding people to sequences, and sending emails have to be done in Apollo by a person." if _is_write_tool
```
