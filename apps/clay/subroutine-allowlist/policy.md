---
name: Clay Subroutine Allowlist
tags:
  - clay
  - access-control
  - governance
  - enrichment
  - ingress
publishedAt: 2026-10-03
description: |
  # clay / subroutine-allowlist

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `clay.ingress.subroutine_allowlist`

  ## What it does

  Lets the agent run Clay's built-in enrichment functions (Work Email, Person
  Job Title, Enrich Company, Tech Stack and the rest) and blocks every other
  Clay function.

  Clay's `run-subroutine` tools run *any* function in the workspace, not just
  enrichment. A workspace can hold custom functions that push data out — add
  contacts to a Salesforce campaign, update a HubSpot record, send a webhook.
  Those writes come from Clay, so the CRM policies on the gateway never see
  them. This policy closes that path: only functions on the allowlist run.

  - **Search and data-point tools pass.** `search-*`, `query-objects`,
    `add-company-data-points`, `add-contact-data-points`, `get-task*` and the
    rest are untouched.
  - **Subroutine calls are checked.** `run-subroutine`,
    `run-subroutine-direct` and `run-subroutine-no-mapping` are allowed only
    when `subroutine_id` is on the allowlist. A missing or unknown ID is
    denied.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.3** — least privilege: the agent gets enrichment, not
    arbitrary workspace automation.
  - **SOC 2 CC8.1** — change management: CRM changes can't be made through a
    side channel that bypasses the CRM's own controls.
  - **ISO 27001 A.5.15** — access control: enforces which Clay functions the
    agent channel can invoke.

  ## Why ingress

  A custom function's side effects (CRM writes, outbound webhooks) happen
  inside Clay once it runs. The function is fully identified by
  `subroutine_id` in the request, so denying at ingress stops it before it
  starts.

  ## How it matches

  A tool is in scope when its (lowercased) name starts with `clay` and
  contains `run-subroutine` or `run_subroutine`. For those calls,
  `payload.args.subroutine_id` must be one of the IDs in `_allowed_ids`.

  The default list holds the 19 built-in enrichment functions as Clay
  returned them from `list-subroutines` on 2026-10-03: Company Industry,
  Company Domain, Company Address, Company Employee Count, Company Latest
  Funding, Company News, Company Revenue (Exact), Enrich Company, Company Job
  Openings, Person Full Name, Enrich Person, Find People at Company, Mobile
  Phone Number, Enrich Person and Find Contact Details, Person Location,
  Website Traffic, Website Technology Stack, Person Job Title, Work Email.

  **Check the IDs against your workspace before deploying.** Call
  `list-subroutines` through the gateway and compare. If your IDs differ,
  replace the list; until you do, the policy fails closed and blocks those
  functions with a clear reason, rather than letting anything through.

  ## Examples

  ### Allowed (Work Email on given inputs)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "clay-run-subroutine-direct", "type": "tool" },
      "payload": {
        "args": {
          "subroutine_id": "t_0tm6n9mtip5BqhnMv5d",
          "inputs": [ { "Full Name": "Jane Doe", "Company Domain": "acme.com" } ]
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (custom function)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "clay-run-subroutine", "type": "tool" },
      "payload": {
        "args": {
          "subroutine_id": "t_custom_push_to_sfdc",
          "taskId": "mcp-task-123",
          "inputs": { "Salesforce Campaign ID": "7018b00000ABCDEF" }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: only Clay's built-in enrichment functions can run through this gateway. Custom Clay functions can push data into other systems, so ask your admin to add this one to the allowlist if you need it."`.

  ## Composition

  Pairs with the CRM write posture in the same bundle. The CRM policies
  control what the agent can change in Salesforce or HubSpot directly; this
  one stops the agent from changing it indirectly through Clay. Volume and
  credit spend are a separate concern — cap them with a separate policy.

  ## Known limitations

  - **IDs are workspace data.** The default list comes from one Clay
    workspace. Confirm yours with `list-subroutines`.
  - **Contact details are allowed.** Mobile Phone Number, Work Email and
    Enrich Person and Find Contact Details return personal contact data.
    Remove their IDs if the agent shouldn't fetch them, or mask the values
    with an egress redaction policy.
  - **Prefix scope.** Only tools whose name starts with `clay` are in scope.
    Change the prefix if your gateway registers the server under another name.
  - **No identity-based exemptions.** To let RevOps admins run custom
    functions, add an exception gated on `input.subject.claims`.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - clay
industries: []
bundles:
  - gtm-stack-hubspot
  - gtm-stack-salesforce
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package clay.ingress.subroutine_allowlist

import future.keywords.if
import future.keywords.in

# Allow broadly; deny only Clay subroutine runs that aren't on the list.
default allow := true

# Clay's built-in enrichment functions. Confirm against `list-subroutines`
# in your workspace and replace if the IDs differ.
_allowed_ids := {
    "t_0tm6n9dEsVBMcS7oBvc", # Company Industry
    "t_0tm6n9dFNTJjpVjZaYT", # Company Domain
    "t_0tm6n9dG96YSDVGRXfM", # Company Address
    "t_0tm6n9dVqh5MuXB9EXk", # Company Employee Count
    "t_0tm6n9hMMAfCCgSJwgV", # Company Latest Funding
    "t_0tm6n9hpQ5EmoAreRds", # Company News
    "t_0tm6n9hWiPpnUCkZMax", # Company Revenue (Exact)
    "t_0tm6n9hxVZpR4Cy6eYh", # Enrich Company
    "t_0tm6n9hirHaxjjwgksd", # Company Job Openings
    "t_0tm6n9iAu7KzcRycseU", # Person Full Name
    "t_0tm6n9i5AtDR7HatCyJ", # Enrich Person
    "t_0tm6n9iWQEKDYvceygd", # Find People at Company
    "t_0tm6n9imvUTzmEhq997", # Mobile Phone Number
    "t_0tm6n9ifsSooEgeeMCh", # Enrich Person and Find Contact Details
    "t_0tm6n9miExJo3rhcgMf", # Person Location
    "t_0tm6n9mo9Xk2gRm8r6W", # Website Traffic
    "t_0tm6n9mKSfSitNJRCbw", # Website Technology Stack
    "t_0tm6n9mkCFSdffP4HwB", # Person Job Title
    "t_0tm6n9mtip5BqhnMv5d", # Work Email
}

_tool := lower(input.resource.name)

_is_subroutine_call if {
    startswith(_tool, "clay")
    regex.match(`run[-_]subroutine`, _tool)
}

_subroutine_id := object.get(object.get(input.payload, "args", {}), "subroutine_id", "")

_is_allowed_subroutine if {
    is_string(_subroutine_id)
    _subroutine_id in _allowed_ids
}

allow := false if {
    _is_subroutine_call
    not _is_allowed_subroutine
}

reason := "Blocked: only Clay's built-in enrichment functions can run through this gateway. Custom Clay functions can push data into other systems, so ask your admin to add this one to the allowlist if you need it." if {
    _is_subroutine_call
    not _is_allowed_subroutine
}
```
