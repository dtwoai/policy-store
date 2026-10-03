---
name: Apollo Cap Search
tags:
  - apollo
  - data-protection
  - governance
  - bulk-data
  - ingress
publishedAt: 2026-10-03
description: |
  # apollo / cap-search

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only)
  **Package:** `apollo.ingress.cap_search`

  ## What it does

  Limits every Apollo search to 50 results per page, so a prospecting search
  can't turn into a dump of Apollo's contact database. Apollo allows up to
  100 per page. The agent still gets results; it just pages through them in
  smaller batches.

  This is a transform, not a block: the policy rewrites `per_page` before the
  call reaches Apollo and never denies.

  - `per_page` above 50 → set to 50.
  - `per_page` missing, zero, negative or not a number → set to 50, so every
    search has a known page size rather than relying on Apollo's default.
  - `per_page` from 1 to 50 → untouched.

  ## Compliance alignment

  - **SOC 2 CC6.1** — limits the volume of personal data the agent channel
    can pull per call.
  - **GDPR Art. 5(1)(c)** — data minimisation: prospect searches return
    bounded pages.
  - **ISO 27001 A.5.15** — access control: enforces a per-call volume limit
    at a technical control point.

  ## Why ingress

  The page size is a request argument. Rewriting it before the call means
  Apollo never returns more than the cap, rather than returning 100 records
  that then have to be cut down in the response.

  ## How it matches

  A tool is in scope when its (lowercased) name starts with `apollo` and has
  `search` as one of its `-` / `_`-separated tokens — for example
  `apollo-apollo_mixed_people_api_search`,
  `apollo-apollo_mixed_companies_search` and
  `apollo-apollo_contacts_search`. Change `max_per_page` at the top of the
  policy to fit your team.

  ## Examples

  ### Clamped

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "apollo-apollo_mixed_people_api_search", "type": "tool" },
      "payload": { "args": { "person_titles": ["VP Sales"], "per_page": 100 } }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload` = the same args with
  `per_page: 50`.

  ### Untouched

  The same call with `per_page: 25` passes through unchanged.

  ## Composition

  Pairs with the CRM `cap-bulk-export` policy in the same bundle, which caps
  search pages the same way on the CRM side. Apollo's bulk enrich
  calls already take at most 10 records, so they need no cap.

  ## Known limitations

  - **Per page, not per session.** The agent can still page through a large
    result set. This policy bounds each call, not the total.
  - **Argument name.** Assumes Apollo's `per_page` argument, as in its REST
    API. Confirm against the tool schema on your gateway.
  - **Prefix scope.** Only tools whose name starts with `apollo` are in
    scope. Change the prefix if your gateway registers the server under
    another name.

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
package apollo.ingress.cap_search

import future.keywords.if
import future.keywords.in

# Transform-only policy — never denies, only clamps search page size.
default allow := true

max_per_page := 50

_tool := lower(input.resource.name)

_args := object.get(object.get(input, "payload", {}), "args", {})

_is_search_tool if {
    startswith(_tool, "apollo")
    "search" in regex.split(`[-_]`, _tool)
}

_per_page := object.get(_args, "per_page", null)

_needs_clamp if _per_page == null

_needs_clamp if {
    is_number(_per_page)
    _per_page > max_per_page
}

_needs_clamp if {
    is_number(_per_page)
    _per_page < 1
}

_needs_clamp if {
    _per_page != null
    not is_number(_per_page)
}

transform := {"transformed_payload": object.union(_args, {"per_page": max_per_page})} if {
    input.action == "tool_pre_invoke"
    _is_search_tool
    _needs_clamp
}
```
