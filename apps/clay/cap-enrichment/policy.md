---
name: Clay Cap Enrichment
tags:
  - clay
  - cost-control
  - governance
  - enrichment
  - bulk-data
  - ingress
publishedAt: 2026-10-03
description: |
  # clay / cap-enrichment

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `clay.ingress.cap_enrichment`

  ## What it does

  Keeps any single Clay enrichment call to 50 records and 5 data points, so
  one bad prompt can't burn through the team's credits or pull contact data
  for a thousand people at once. The agent works in batches of 50 instead.

  - **Function runs on given inputs** (`run-subroutine-direct`): at most 50
    input sets. Clay accepts up to 1,000, and each one costs credits.
  - **Function runs on search results** (`run-subroutine`,
    `run-subroutine-no-mapping`): at most 50 `entityIds` when IDs are given.
  - **Data points on search results** (`add-company-data-points`,
    `add-contact-data-points`): at most 50 `entityIds` and at most 5 data
    points per call. Custom data points are AI research runs on every record,
    so they add up quickly.

  Calls over a limit are denied with a reason that tells the agent to split
  the batch. Nothing is trimmed silently, so the agent never thinks it
  enriched a whole list when it only did part of it.

  ## Compliance alignment

  - **SOC 2 CC6.1** — least privilege on the volume of personal data the
    agent can pull per call.
  - **GDPR Art. 5(1)(c)** — data minimisation: contact enrichment happens in
    bounded batches rather than whole lists at once.
  - **ISO 27001 A.5.15** — access control: enforces a per-call volume limit
    at a technical control point.

  ## Why ingress

  Credits are spent and contact data is fetched as soon as Clay runs the
  call. The size of the call is fully visible in the request, so denying at
  ingress stops an oversized call before it costs anything.

  ## How it matches

  A tool is in scope when its (lowercased, `-` → `_`) name starts with
  `clay` and ends with `run_subroutine_direct`, `run_subroutine`,
  `run_subroutine_no_mapping`, `add_company_data_points` or
  `add_contact_data_points`. The policy counts `inputs`, `entityIds` and
  `dataPoints` when they are arrays.

  Calls without `entityIds` run on every result in one search page. Clay
  returns search results about 20 at a time, so those calls stay under the
  cap without an extra rule.

  Change `max_records` and `max_data_points` at the top of the policy to fit
  your team.

  ## Examples

  ### Allowed (20 work-email lookups)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "clay-run-subroutine-direct", "type": "tool" },
      "payload": { "args": { "subroutine_id": "t_…", "inputs": [ /* 20 objects */ ] } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (300 lookups in one call)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "clay-run-subroutine-direct", "type": "tool" },
      "payload": { "args": { "subroutine_id": "t_…", "inputs": [ /* 300 objects */ ] } }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: Clay enrichment is limited to 50 records per call (this call has 300). Split the list into batches of 50."`.

  ## Composition

  Pairs with `clay/subroutine-allowlist`, which controls *which* functions
  can run; this one controls *how much* each call does. Overall spend is
  better handled by Clay's own workspace and per-rep credit budgets — this
  policy guards against one runaway call, not a long series of small ones.

  ## Known limitations

  - **Per call, not per session.** An agent can make many calls of 50. Use
    Clay's credit budgets for total spend.
  - **Credits vary by function.** The cap counts records, not credits. A
    mobile-number lookup costs more than an industry lookup.
  - **Prefix scope.** Only tools whose name starts with `clay` are in scope.
    Change the prefix if your gateway registers the server under another name.

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
package clay.ingress.cap_enrichment

import future.keywords.contains
import future.keywords.if
import future.keywords.in

# Allow broadly; deny only oversized Clay enrichment calls.
default allow := true

# Records per call (inputs or entityIds).
max_records := 50

# Data points per add-*-data-points call.
max_data_points := 5

_tool := replace(lower(input.resource.name), "-", "_")

_args := object.get(object.get(input, "payload", {}), "args", {})

_is_clay if startswith(_tool, "clay")

_is_direct if {
    _is_clay
    endswith(_tool, "run_subroutine_direct")
}

_is_on_search if {
    _is_clay
    some suffix in ["run_subroutine", "run_subroutine_no_mapping", "add_company_data_points", "add_contact_data_points"]
    endswith(_tool, suffix)
}

_is_data_points if {
    _is_clay
    some suffix in ["add_company_data_points", "add_contact_data_points"]
    endswith(_tool, suffix)
}

_count(key) := n if {
    v := object.get(_args, key, [])
    is_array(v)
    n := count(v)
}

reasons contains sprintf("Blocked: Clay enrichment is limited to %d records per call (this call has %d). Split the list into batches of %d.", [max_records, n, max_records]) if {
    _is_direct
    n := _count("inputs")
    n > max_records
}

reasons contains sprintf("Blocked: Clay enrichment is limited to %d records per call (this call has %d). Split the list into batches of %d.", [max_records, n, max_records]) if {
    _is_on_search
    n := _count("entityIds")
    n > max_records
}

reasons contains sprintf("Blocked: add at most %d data points per call (this call has %d). Split them across calls.", [max_data_points, n]) if {
    _is_data_points
    n := _count("dataPoints")
    n > max_data_points
}

allow := false if count(reasons) > 0

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
