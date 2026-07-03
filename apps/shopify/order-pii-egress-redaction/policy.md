---
name: Shopify Redact Buyer PII from Order and Checkout Responses
tags:
  - shopify
  - ucp
  - agentic-commerce
  - pii
  - dlp
  - redaction
  - egress
publishedAt: 2026-06-27
description: |
  # shopify / order-pii-egress-redaction

  **Direction:** egress (`tool_post_invoke`, `input.mode == "output"`)
  **Default:** allow (transform-only — never denies)
  **Package:** `shopify.egress.order_pii_redaction`

  ## What it does

  Redacts buyer personal information from Shopify UCP (Universal Commerce
  Protocol) `get_order` and `get_checkout` tool responses before they reach the
  agent you are running. It is transform-only — it never denies a call, it only
  rewrites matching fields in the response body to `[REDACTED]`. Any other tool,
  and any request that is not on the output path, passes through untouched.

  This is **buyer-side egress governance**: it governs the agents *you* run
  against a merchant's MCP endpoint, masking buyer PII that flows back through
  the gateway before your agent (and your logs, traces, and downstream tooling)
  can see it. It is complementary to UCP and to Shopify's own controls — it is
  not a competing trust referee for the merchant.

  ## Why egress

  Buyer PII lives in the order and checkout records on the merchant side; it
  exists regardless of this gateway. There is nothing to block at ingress — the
  exposure happens when `get_order` / `get_checkout` return that content to the
  MCP client. Masking on the egress (response) path is the only place to catch
  it on the MCP path.

  ## Scope / tool matching

  The tool name is read from `input.resource.name`, lowercased, and matched
  against hyphenated (`-get-order`), underscored (`-get_order`), and collapsed
  (`-getorder`) suffix shapes of the UCP OpenRPC op names `get_order` and
  `get_checkout`, plus the bare un-prefixed names. The DTwo gateway prepends a
  non-standard server prefix and commonly slugifies underscores to hyphens
  when federating tool names (`ucp-shop-get-order`), so the underscored form
  alone would never match there. Confirm the exact tool names your gateway
  sends with the dump-input debug technique before relying on this in
  production.

  This policy intentionally does **not** read `input.payload.name` for the tool
  name — the canonical PARC source is `input.resource.name`.

  ## What gets redacted

  Redaction is **by field name** within `input.payload.result`. The gateway
  replaces the value of any of these keys, wherever they appear in the response
  body, with `[REDACTED]`:

  - **Buyer contact** (`$.buyer`, flat snake_case): `email`, `phone_number`.
    `first_name` and `last_name` are intentionally left intact so the order
    stays identifiable — add them to `redact_fields` if full-PII masking is
    required.
  - **Fulfillment destination postal address** (schema.org field names under
    `$.fulfillment.methods[].destinations[]`): `street_address`,
    `extended_address`, `address_locality`, `address_region`,
    `address_country`, `postal_code`.

  No regex patterns are used (`redact_patterns` is empty): the UCP field names
  above are distinctive, so field-name redaction is precise and avoids the
  over-/under-matching of free-text scanning.

  ## What is NOT touched

  - **Order economics.** `totals[]` (the signed-integer minor-unit amounts,
    including the `type == "total"` grand total), `currency`, and `line_items[]`
    are not PII and are returned unchanged so the agent can still reason about
    the order.
  - **`continue_url`.** The top-level checkout `continue_url` is a handoff URI,
    not buyer PII, and is left intact. Note that what the buyer does *after*
    following `continue_url` in a browser is off the MCP path and is not visible
    to this gateway at all (see Known limitations).

  ## A note on `input.context.mandate`

  This policy does not read any spending, budget, velocity, or allowlist fields,
  because **those do not exist as UCP fields.** A buyer's constraints live only
  inside the opaque AP2 SD-JWT at `checkout.ap2.checkout_mandate`. Where another
  DTwo policy needs caps or allowlists, they are supplied by the gateway as
  policy input at `input.context.mandate.*` — that is DTwo-supplied policy
  input, **not** a UCP field. This redaction policy needs none of it.

  ## Examples

  ### Redacted (`get_order` / `get_checkout` response)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "shopify-mcp-server-get_order", "type": "tool" }
    }
  }
  ```

  `allow = true`, with a `transform` supplying `redact_fields`,
  `replacement = "[REDACTED]"`, and an empty `redact_patterns`, for the gateway
  to apply to the response body.

  ### Passed through (other tool, or not output path)

  A response from any tool whose name does not suffix-match `get_order` /
  `get_checkout` (e.g. `search_catalog`, `get_product`), or any request not on
  the output path, returns `allow = true` with no `transform` — unchanged.

  ## Known limitations

  - **Structured-result redaction only.** The transform rewrites the structured
    tool result; the same JSON serialized into the MCP `content[].text` channel
    is not rewritten. Redact or suppress the text channel at the gateway, or
    treat this policy as structured-result-only.
  - **MCP path only.** This sees the response that returns through the gateway.
    The browser `continue_url` handoff — and anything the buyer enters there — is
    not visible to DTwo and is not governed by this policy.
  - **Field-name scoped.** Redaction keys on the UCP field names listed above. A
    merchant MCP server that returns buyer PII under different keys, or nests it
    elsewhere, won't be covered until `redact_fields` is adjusted. Confirm the
    response shape with dump-input before relying on it.
  - **Suffix-scoped tool match.** Matching covers the known name shapes of
    `get_order` / `get_checkout` only. It will not cover other read ops; extend
    `target_tool_shapes` if your deployment surfaces buyer PII through
    additional UCP reads.
  - **No identity-based exemptions.** All callers get the same redaction. Add an
    `input.subject.claims`-gated branch (using IdP-supplied claims, never
    stripped `is_admin` / `teams` / `user`) if a break-glass role needs raw
    values.
direction: egress
apps:
  - shopify
industries:
  - retail
bundles:
  - agentic-commerce
schemaVersion: "1.0.0"
minimumGatewayVersion: 1.0.0
---

```rego
package shopify.egress.order_pii_redaction

# Buyer-side egress governance for Shopify UCP order/checkout reads.
# Transform-only — never blocks. Redacts buyer PII from the response body
# of get_order / get_checkout before it reaches the agent you run.
default allow := true

# UCP OpenRPC op names this policy applies to, in hyphenated, underscored,
# and collapsed shape. The gateway prepends a non-standard server prefix and
# commonly slugifies underscores to hyphens when federating tool names
# ("ucp-shop-get-order"), so the underscored form alone would never match
# there. Shapes are matched as suffixes anchored at a "-"/"_" separator,
# plus the bare un-prefixed name for direct deployments.
target_tool_shapes := {
    "get_order",
    "get-order",
    "getorder",
    "get_checkout",
    "get-checkout",
    "getcheckout",
}

tool_matches(shapes) if {
    shapes[lower(object.get(input.resource, "name", ""))]
}

tool_matches(shapes) if {
    name := lower(object.get(input.resource, "name", ""))
    some shape in shapes
    endswith(name, sprintf("-%s", [shape]))
}

tool_matches(shapes) if {
    name := lower(object.get(input.resource, "name", ""))
    some shape in shapes
    endswith(name, sprintf("_%s", [shape]))
}

# In scope when on the egress/output path AND the tool name matches a target
# op shape.
in_scope if {
    input.mode == "output"
    tool_matches(target_tool_shapes)
}

transform := {
    # No free-text scanning — UCP field names are distinctive, so redact by name.
    "redact_patterns": [],
    "redact_fields": [
        # Buyer contact (flat snake_case under $.buyer).
        # first_name / last_name left intact so the order stays identifiable.
        "email",
        "phone_number",
        # Fulfillment destination postal address (schema.org field names under
        # $.fulfillment.methods[].destinations[]).
        "street_address",
        "extended_address",
        "address_locality",
        "address_region",
        "address_country",
        "postal_code",
    ],
    "replacement": "[REDACTED]",
} if {
    in_scope
}
```
