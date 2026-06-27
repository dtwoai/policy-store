---
name: Restrict Agent Checkout to Approved Merchants
tags:
  - shopify
  - ucp
  - agentic-commerce
  - access-control
  - governance
  - merchant-allowlist
  - ingress
publishedAt: 2026-06-27
description: |
  # shopify / merchant-allowlist

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `shopify.ingress.merchant_allowlist`

  ## What it does

  Denies the UCP `complete_checkout` tool unless the merchant the checkout is
  being completed with is on a buyer-supplied allowlist. Every other UCP tool
  (`create_checkout`, `get_cart`, `search_catalog`, `get_order`, and the rest)
  passes through untouched, and so does any non-UCP tool the gateway routes.

  This is buyer-side egress governance: it constrains the agents *you* run, so
  a compromised, confused, or over-eager agent cannot push spend through a
  merchant your organization has not approved. It is not a merchant-side or
  marketplace control.

  ## Where the merchant identity comes from

  The resolved merchant identity is read from `input.context.merchant`. The
  DTwo gateway populates `input.context` as policy input *before* the OPA call
  — it is **not** a UCP field on the checkout object. The buyer's approved set
  is read from `input.context.mandate.merchant_allowlist` (also DTwo-supplied
  policy input, derived from the buyer's AP2 checkout mandate; the underlying
  AP2 SD-JWT at `checkout.ap2.checkout_mandate` is opaque to UCP and is not
  read here).

  If `input.context.merchant` is absent or empty, the call is denied — the
  policy fails closed rather than allowing an unattributed checkout.

  ## How it matches

  Two conditions must both hold for a call to be denied:

  - **Tool match.** The lowercased `input.resource.name` ends with
    `complete_checkout`. The gateway prepends a non-standard server prefix to
    the OpenRPC operation name, so the policy suffix-matches to stay portable.
    The tool name is read **only** from `input.resource.name`, never from
    `input.payload.name`.
  - **Merchant not approved.** The resolved merchant
    (`input.context.merchant`) is not present in the allowlist at
    `object.get(input.context.mandate, "merchant_allowlist", [])`.

  ## Mapping to enterprise spend programs

  The allowlist is the generic mechanism; the *meaning* of the list is set by
  the buyer mandate the gateway injects:

  - **Travel & expense (T&E).** `merchant_allowlist` is the set of approved
    carriers / booking providers an employee agent may complete a checkout
    with.
  - **Procurement.** `merchant_allowlist` is the set of approved vendors a
    procurement agent may purchase from.

  One policy, one job: it does not enforce spend caps, currencies, categories,
  or any other mandate dimension — pair it with the matching cap / currency
  policies for those.

  ## Examples

  ### Allowed (merchant on the allowlist)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "ucp-shopify-complete_checkout", "type": "tool" },
      "payload": { "name": "ucp-shopify-complete_checkout", "args": { "id": "chk_123" } },
      "context": {
        "merchant": "approved-airline",
        "mandate": { "merchant_allowlist": ["approved-airline", "approved-hotel"] }
      },
      "subject": { "claims": { "sub": "agent-7" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (merchant not on the allowlist)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "ucp-shopify-complete_checkout", "type": "tool" },
      "payload": { "name": "ucp-shopify-complete_checkout", "args": { "id": "chk_999" } },
      "context": {
        "merchant": "random-marketplace",
        "mandate": { "merchant_allowlist": ["approved-airline", "approved-hotel"] }
      },
      "subject": { "claims": { "sub": "agent-7" } }
    }
  }
  ```

  `allow = false`, `reason = "Checkout with merchant \"random-marketplace\" is not permitted; it is not on the approved-merchant allowlist for this buyer."`.

  ## Known limitations

  - **MCP path only.** This governs `complete_checkout` calls that flow through
    the DTwo-mediated MCP path. UCP also supports a browser handoff via the
    checkout `continue_url`; a completion driven by the buyer through that
    redirect is not visible to this policy and is not governed by it.
  - **`input.context` is DTwo-supplied, not UCP.** Both `input.context.merchant`
    and `input.context.mandate.merchant_allowlist` are injected by the gateway
    as policy input. They are not fields on the UCP checkout object. If the
    gateway does not populate them, the policy fails closed (denies).
  - **Identity vs. preference.** UCP namespace-binding authenticates *which*
    merchant a checkout belongs to, but it does not enforce a buyer's merchant
    *preference*. This policy supplies that buyer-side preference check; it
    trusts the gateway's resolved `input.context.merchant`, it does not
    independently re-verify the merchant's namespace binding.
  - **Exact-match allowlist.** Merchant matching is exact against the supplied
    list (no wildcards or normalization beyond what the gateway resolves). Make
    sure the mandate uses the same merchant identifiers the gateway resolves
    into `input.context.merchant`.
  - **No identity-based exemptions.** All callers get the same allowlist. To
    add a break-glass role, gate an extra `allow if` branch on
    `input.subject.claims`.
direction: ingress
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
package shopify.ingress.merchant_allowlist

default allow := false

# Pass through anything that is not the complete_checkout tool.
# The gateway prepends a non-standard server prefix to the OpenRPC op name,
# so match on the suffix and read the tool name only from input.resource.name.
allow if {
	not is_complete_checkout
}

# Allow complete_checkout only when the resolved merchant is on the allowlist.
allow if {
	is_complete_checkout
	merchant_on_allowlist
}

is_complete_checkout if {
	endswith(lower(object.get(input.resource, "name", "")), "complete_checkout")
}

# input.context.merchant is DTwo-supplied policy input (the gateway's resolved
# merchant identity), NOT a UCP checkout field. Missing/empty -> "" -> fails closed.
resolved_merchant := object.get(object.get(input, "context", {}), "merchant", "")

# input.context.mandate.merchant_allowlist is DTwo-supplied policy input derived
# from the buyer's AP2 mandate, NOT a UCP field.
merchant_allowlist := object.get(object.get(object.get(input, "context", {}), "mandate", {}), "merchant_allowlist", [])

merchant_on_allowlist if {
	resolved_merchant != ""
	some allowed in merchant_allowlist
	allowed == resolved_merchant
}

reason := sprintf("Checkout with merchant %q is not permitted; it is not on the approved-merchant allowlist for this buyer.", [resolved_merchant]) if {
	is_complete_checkout
	not allow
	resolved_merchant != ""
}

reason := "Checkout is not permitted: no merchant identity was resolved for this request, so it cannot be matched against the approved-merchant allowlist." if {
	is_complete_checkout
	not allow
	resolved_merchant == ""
}
```
